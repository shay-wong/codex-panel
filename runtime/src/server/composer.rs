use super::{ai, codex, validate as v, AppState};
use crate::ApiError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone)]
pub struct Catalog {
    pub revision: String,
    signature: String,
    pub skills: Vec<Value>,
    pub agents: Vec<Value>,
    pub refs: HashMap<String, String>,
    pub sources: Value,
}

fn unavailable(index: usize, reason: &str) -> ApiError {
    ApiError::new(
        409,
        "COMPOSER_REFERENCE_UNAVAILABLE",
        "A selected composer reference is no longer available",
    )
    .with_details(json!({"nodeIndex":index,"reasonCode":reason}))
}
fn workspace_key(context: Option<&ai::Context>) -> String {
    context
        .map(|c| {
            format!(
                "{}\0{}",
                c.target
                    .as_ref()
                    .and_then(|t| t["codexHostId"].as_str())
                    .unwrap_or("local"),
                c.workspace
            )
        })
        .unwrap_or_else(|| "__global__".into())
}

pub async fn load(state: &AppState, context: Option<&ai::Context>) -> Result<Catalog, ApiError> {
    let mut skills = Vec::new();
    let mut skill_available = false;
    if let Some(context) = context {
        let connection = if context.target.is_none() {
            codex::executable().ok().map(|exe| async move {
                codex::Connection::start(&exe, Path::new(&context.workspace)).await
            })
        } else {
            None
        };
        let connection = match connection {
            Some(start) => start.await.ok(),
            None => None,
        };
        let result = ai::request(
            state,
            context,
            connection.as_ref(),
            "skills/list",
            json!({"cwds":[context.workspace],"forceReload":true}),
        )
        .await;
        if let Ok(result) = result {
            skill_available = true;
            for entry in result["data"].as_array().into_iter().flatten() {
                for skill in entry["skills"].as_array().into_iter().flatten() {
                    if skill["enabled"] != true {
                        continue;
                    }
                    let Some(name) = skill["name"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    else {
                        continue;
                    };
                    let Some(path) = skill["path"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| Path::new(s).is_absolute())
                    else {
                        continue;
                    };
                    let stable = name.nfc().collect::<String>();
                    let identity = format!("skill\0{name}\0{path}");
                    if skills.iter().any(|s: &Value| s["identity"] == identity) {
                        continue;
                    }
                    skills.push(json!({"identity":identity,"stableId":stable,"id":name,"name":name,"label":skill.pointer("/interface/displayName").and_then(Value::as_str).map(str::trim).filter(|s|!s.is_empty()).unwrap_or(name),"description":skill["description"].as_str().unwrap_or("").trim(),"path":path}));
                }
            }
            if context.target.is_none() {
                let mut linked = Vec::new();
                ai::include_linked_skills(&mut linked).await?;
                for skill in linked {
                    let name = skill["id"].as_str().unwrap_or("");
                    if skills.iter().any(|s| s["name"] == name) {
                        continue;
                    }
                    let path = skill["path"].as_str().unwrap_or("");
                    skills.push(json!({"identity":format!("skill\0{name}\0{path}"),"stableId":name.nfc().collect::<String>(),"id":name,"name":name,"label":skill["label"],"description":skill["description"],"path":path}));
                }
            }
        }
        if let Some(connection) = connection {
            connection.close().await;
        }
    }
    skills.sort_by(|a, b| a["label"].as_str().cmp(&b["label"].as_str()));
    let (agents, agent_available) = agents(
        &state.config.codex_home,
        context.map(|c| Path::new(&c.workspace)),
    )
    .await?;
    let sources = json!([
        {"kind":"skills","state":if skill_available{"available"}else{"unavailable"},"reasonCode":if skill_available{Value::Null}else{json!("SOURCE_UNAVAILABLE")}},
        {"kind":"agents","state":if agent_available{"available"}else{"unavailable"},"reasonCode":if agent_available{Value::Null}else{json!("SOURCE_UNAVAILABLE")}},
        {"kind":"slash","state":"available","reasonCode":null},
        {"kind":"apps","state":"unsupported","reasonCode":"INVOCATION_NAME_UNAVAILABLE"},
        {"kind":"files","state":"unsupported","reasonCode":"ENCODER_UNSUPPORTED"},
        {"kind":"plugins","state":"unsupported","reasonCode":"EXPERIMENTAL_SOURCE_NOT_ALLOWED"},
        {"kind":"customPrompts","state":"unsupported","reasonCode":"NO_STABLE_CATALOG"}
    ]);
    let signature = hex::encode(Sha256::digest(serde_json::to_vec(&json!([
        skills, agents
    ]))?));
    let key = workspace_key(context);
    let mut cache = state
        .composer
        .lock()
        .map_err(|_| ApiError::new(500, "COMPOSER_LOCK", "Composer lock was poisoned"))?;
    if let Some(catalog) = cache
        .get(&key)
        .filter(|catalog| catalog.signature == signature)
    {
        let mut catalog = catalog.clone();
        catalog.sources = sources;
        return Ok(catalog);
    }
    let refs = skills
        .iter()
        .chain(&agents)
        .filter_map(|item| {
            item["identity"]
                .as_str()
                .map(|id| (id.into(), uuid::Uuid::new_v4().to_string()))
        })
        .collect();
    let catalog = Catalog {
        revision: uuid::Uuid::new_v4().to_string(),
        signature,
        skills,
        agents,
        refs,
        sources,
    };
    cache.insert(key, catalog.clone());
    Ok(catalog)
}

async fn agents(home: &Path, workspace: Option<&Path>) -> Result<(Vec<Value>, bool), ApiError> {
    let mut layers = vec![home.to_path_buf()];
    if let Some(workspace) = workspace {
        let mut folders = Vec::new();
        let mut current = workspace.to_path_buf();
        loop {
            folders.push(current.join(".codex"));
            if current.join(".git").exists() {
                break;
            }
            if !current.pop() {
                break;
            }
        }
        folders.reverse();
        layers.extend(folders);
    }
    let mut effective = HashMap::<String, Value>::new();
    let mut available = false;
    for layer in layers {
        let source = tokio::fs::read_to_string(layer.join("config.toml"))
            .await
            .ok();
        // toml::Value::from_str 只解析单个值；配置文件必须按完整 TOML 文档读取。
        let config = source
            .as_ref()
            .and_then(|s| toml::from_str::<toml::Value>(s).ok());
        if config.is_some() {
            available = true;
        }
        let mut declared = HashSet::new();
        let mut layer_agents = HashMap::new();
        if let Some(roles) = config
            .as_ref()
            .and_then(|v| v.get("agents"))
            .and_then(toml::Value::as_table)
        {
            for (name, role) in roles {
                if !role.is_table() {
                    continue;
                }
                let mut agent = json!({"stableId":name,"name":name,"label":name,"description":role.get("description").and_then(toml::Value::as_str).map(str::trim),"developerInstructions":role.get("developer_instructions").and_then(toml::Value::as_str).map(str::trim),"sourcePath":layer.join("config.toml")});
                if let Some(file) = role
                    .get("config_file")
                    .and_then(toml::Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    let file = if Path::new(file).is_absolute() {
                        PathBuf::from(file)
                    } else {
                        layer.join(file)
                    };
                    let Some(loaded) = read_agent(&file, Some(name)).await else {
                        continue;
                    };
                    declared.insert(tokio::fs::canonicalize(&file).await.unwrap_or(file));
                    // 独立配置文件优先于角色声明，空字段才继承声明中的默认值。
                    for (key, value) in loaded.as_object().unwrap() {
                        if !value.is_null() {
                            agent[key] = value.clone();
                        }
                    }
                }
                layer_agents
                    .entry(agent["stableId"].as_str().unwrap().to_owned())
                    .or_insert(agent);
            }
        }
        let mut directories = vec![layer.join("agents")];
        let mut files = Vec::new();
        while let Some(directory) = directories.pop() {
            let mut entries = match tokio::fs::read_dir(directory).await {
                Ok(entries) => {
                    available = true;
                    entries
                }
                Err(_) => continue,
            };
            while let Some(entry) = entries.next_entry().await? {
                let kind = entry.file_type().await?;
                let file = entry.path();
                if kind.is_dir() {
                    directories.push(file);
                } else if kind.is_file() && file.extension().is_some_and(|s| s == "toml") {
                    files.push(file);
                }
            }
        }
        files.sort();
        for file in files {
            if declared.contains(&tokio::fs::canonicalize(&file).await.unwrap_or(file.clone())) {
                continue;
            }
            if let Some(agent) = read_agent(&file, None).await {
                layer_agents
                    .entry(agent["stableId"].as_str().unwrap().into())
                    .or_insert(agent);
            }
        }
        for (name, mut agent) in layer_agents {
            if let Some(previous) = effective.get(&name) {
                for key in ["description", "developerInstructions"] {
                    if agent[key].is_null() {
                        agent[key] = previous[key].clone();
                    }
                }
            }
            if agent["description"].as_str().is_some_and(|s| !s.is_empty()) {
                agent["identity"] = json!(format!("agent\0{name}"));
                agent["id"] = json!(name);
                effective.insert(name, agent);
            }
        }
    }
    let mut agents = effective.into_values().collect::<Vec<_>>();
    agents.sort_by(|a, b| a["label"].as_str().cmp(&b["label"].as_str()));
    Ok((agents, available))
}

async fn read_agent(path: &Path, hint: Option<&str>) -> Option<Value> {
    let source = tokio::fs::read_to_string(path).await.ok()?;
    let value = toml::from_str::<toml::Value>(&source).ok()?;
    let nonempty = |key: &str| {
        value
            .get(key)
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let name = nonempty("name")
        .or_else(|| nonempty("role_name"))
        .or(hint)?;
    let description = nonempty("description");
    let instructions = nonempty("developer_instructions");
    if hint.is_none() && (description.is_none() || instructions.is_none()) {
        return None;
    }
    Some(
        json!({"stableId":name,"name":name,"label":name,"description":description,"developerInstructions":instructions,"sourcePath":path}),
    )
}

fn persistence(kind: &str, id: &str, label: &str) -> Value {
    let key = URL_SAFE_NO_PAD.encode(id.as_bytes());
    let label = label
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]");
    json!({"format":"taskboard.composer-reference.v1","kind":kind,"referenceKey":key,"markdown":format!("[{label}](taskboard://composer-reference/v1/{kind}/{key})")})
}
fn score(query: &str, names: &[&str], description: &str) -> i64 {
    if query.is_empty() {
        return 0;
    }
    let names = names.iter().map(|s| s.to_lowercase()).collect::<Vec<_>>();
    if let Some(length) = names
        .iter()
        .filter(|s| s.starts_with(query))
        .map(String::len)
        .min()
    {
        1000 - length as i64
    } else if names.iter().any(|s| s.contains(query)) {
        500
    } else if description.to_lowercase().contains(query) {
        100
    } else {
        -1
    }
}

pub fn candidates(
    catalog: &Catalog,
    trigger: &str,
    query: &str,
    surface: &str,
    compact_allowed: bool,
) -> Value {
    let query = query.to_lowercase();
    let mut candidates = Vec::<(i64, Value)>::new();
    if trigger == "@" {
        for (kind, group, order, items) in [
            ("skill", "Skills", 0, &catalog.skills),
            ("agent", "Agents", 1, &catalog.agents),
        ] {
            for (index, item) in items.iter().enumerate() {
                let id = item["stableId"].as_str().unwrap_or("");
                if kind == "skill" && items.iter().filter(|s| s["stableId"] == id).count() != 1 {
                    continue;
                }
                let label = item["label"].as_str().unwrap_or(id);
                let description = item["description"].as_str().unwrap_or("");
                let rank = score(&query, &[label, id], description);
                if rank < 0 {
                    continue;
                }
                let mut candidate = json!({"kind":kind,"candidateRef":catalog.refs.get(item["identity"].as_str().unwrap_or("")),"trigger":trigger,"label":label,"description":description,"group":group,"groupOrder":order,"itemOrder":index,"selectable":true,"persistence":persistence(kind,id,label)});
                if kind == "agent" {
                    candidate["insertionText"] = json!(format!("@{id}"));
                }
                candidates.push((rank, candidate));
            }
        }
    } else if trigger == "/" && surface != "ai-chat" {
        let source: Value = serde_json::from_str(include_str!(
            "../../../server/codex-slash-commands-0.139.0.json"
        ))
        .expect("Bundled command catalog is valid JSON");
        let platform = if cfg!(windows) {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        for (index, command) in source["commands"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            let Some(id) = command["id"].as_str() else {
                continue;
            };
            let Some(description) = command["description"].as_str() else {
                continue;
            };
            if command["debugOnly"] == true
                || command
                    .get("platforms")
                    .and_then(Value::as_array)
                    .is_some_and(|v| !v.iter().any(|v| v == platform))
                || command
                    .get("excludedPlatforms")
                    .and_then(Value::as_array)
                    .is_some_and(|v| v.iter().any(|v| v == platform))
            {
                continue;
            }
            let label = format!("/{id}");
            let rank = score(&query, &[id, id], description);
            if rank < 0 {
                continue;
            }
            let insertion = format!(
                "{label}{}",
                if command["supportsInlineArgs"] == true {
                    " "
                } else {
                    ""
                }
            );
            candidates.push((rank,json!({"kind":"slashAction","candidateRef":format!("slash:insert:{id}"),"trigger":"/","label":label,"description":description,"group":"Commands","groupOrder":0,"itemOrder":index,"selectable":true,"command":label,"insertionText":insertion,"selection":{"type":"insertText","text":insertion}})));
        }
    } else if trigger == "/" && surface == "ai-chat" {
        for (index, (command, label, description, handler)) in [
            (
                "/new",
                "New conversation",
                "Start a new conversation",
                "new-conversation",
            ),
            ("/model", "Model", "Choose the model", "open-model-menu"),
            (
                "/reasoning",
                "Reasoning",
                "Choose the reasoning effort",
                "open-reasoning-menu",
            ),
            (
                "/compact",
                "Compact",
                "Compact this conversation's context",
                "compact-conversation",
            ),
        ]
        .into_iter()
        .enumerate()
        {
            if handler == "compact-conversation" && !compact_allowed {
                continue;
            }
            let rank = score(&query, &[&command[1..], label], description);
            if rank < 0 {
                continue;
            }
            candidates.push((rank,json!({"kind":"slashAction","candidateRef":format!("slash:{handler}"),"trigger":"/","label":label,"description":description,"group":"Commands","groupOrder":0,"itemOrder":index,"selectable":true,"command":command,"insertionText":command,"dispatch":{"type":"client","handlerId":handler}})));
        }
    }
    candidates.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1["groupOrder"].as_i64().cmp(&b.1["groupOrder"].as_i64()))
            .then_with(|| a.1["itemOrder"].as_u64().cmp(&b.1["itemOrder"].as_u64()))
    });
    json!({"contractVersion":"composer.v1","revision":catalog.revision,"candidates":candidates.into_iter().map(|(_,v)|v).collect::<Vec<_>>(),"sources":catalog.sources})
}

pub async fn resolve(
    state: &AppState,
    context: &ai::Context,
    revision: &str,
    nodes: &[Value],
) -> Result<Vec<Option<Value>>, ApiError> {
    let first = nodes
        .iter()
        .position(|n| n["type"] == "skill" || n["type"] == "agent")
        .unwrap_or(0);
    let key = workspace_key(Some(context));
    if !state
        .composer
        .lock()
        .map_err(|_| ApiError::new(500, "COMPOSER_LOCK", "Composer lock was poisoned"))?
        .get(&key)
        .is_some_and(|c| c.revision == revision)
    {
        return Err(unavailable(first, "SOURCE_UNAVAILABLE"));
    }
    let current = load(state, Some(context)).await?;
    if current.revision != revision {
        return Err(unavailable(first, "SOURCE_UNAVAILABLE"));
    }
    nodes
        .iter()
        .enumerate()
        .map(|(index, node)| {
            if node["type"] != "skill" && node["type"] != "agent" {
                return Ok(None);
            }
            let reference = node["candidateRef"].as_str().unwrap_or("");
            let item = current.skills.iter().chain(&current.agents).find(|item| {
                current
                    .refs
                    .get(item["identity"].as_str().unwrap_or(""))
                    .is_some_and(|r| r == reference)
            });
            item.cloned()
                .map(Some)
                .ok_or_else(|| unavailable(index, "SOURCE_UNAVAILABLE"))
        })
        .collect()
}

pub fn rebind(catalog: &Catalog, nodes: &[Value]) -> Result<Value, ApiError> {
    let mut rebound = Vec::new();
    let mut bindings = Vec::new();
    let mut ready = true;
    for (index, node) in nodes.iter().enumerate() {
        if node["type"] == "text" {
            v::allowed(node, &["type", "text"])?;
            if !node["text"].is_string() {
                return Err(v::invalid("Composer text must be a string"));
            }
            rebound.push(node.clone());
            continue;
        }
        if node["type"] == "unsupportedReference" {
            ready = false;
            bindings.push(json!({"nodeIndex":index,"status":"unavailable","referenceKind":"unsupported","reasonCode":node["reasonCode"]}));
            continue;
        }
        if node["type"] != "persistedReference" {
            return Err(v::invalid("Unknown persisted composer node"));
        }
        v::allowed(node, &["type", "referenceKind", "referenceKey", "label"])?;
        let kind = node["referenceKind"].as_str().unwrap_or("");
        if !["skill", "agent"].contains(&kind) {
            return Err(v::invalid("Unknown composer reference kind"));
        }
        let encoded = v::required_string(node.get("referenceKey"), "referenceKey", 512)?;
        let id = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(&encoded)
                .map_err(|_| v::invalid("referenceKey must be canonical base64url"))?,
        )
        .map_err(|_| v::invalid("referenceKey must contain UTF-8"))?;
        if id.is_empty()
            || URL_SAFE_NO_PAD.encode(&id) != encoded
            || (kind == "skill" && id.nfc().collect::<String>() != id)
        {
            return Err(v::invalid("referenceKey must be canonical base64url"));
        }
        let items = if kind == "skill" {
            &catalog.skills
        } else {
            &catalog.agents
        };
        let matches = items
            .iter()
            .filter(|item| item["stableId"] == id)
            .collect::<Vec<_>>();
        let source = if kind == "skill" { 0 } else { 1 };
        let reason = if catalog.sources[source]["state"] != "available" {
            Some("SOURCE_UNAVAILABLE")
        } else if matches.is_empty() {
            Some("REFERENCE_NOT_FOUND")
        } else if matches.len() > 1 {
            Some("REFERENCE_AMBIGUOUS")
        } else {
            None
        };
        if let Some(reason) = reason {
            ready = false;
            bindings.push(json!({"nodeIndex":index,"status":"unavailable","referenceKind":kind,"reasonCode":reason}));
        } else {
            let item = matches[0];
            bindings.push(json!({"nodeIndex":index,"status":"resolved","referenceKind":kind,"label":item["label"]}));
            rebound.push(json!({"type":kind,"candidateRef":catalog.refs.get(item["identity"].as_str().unwrap_or("")),"label":item["label"]}));
        }
    }
    let mut result = json!({"contractVersion":"composer.v1","ready":ready,"revision":catalog.revision,"bindings":bindings,"sources":catalog.sources,"diagnostics":[]});
    if ready {
        result["document"] = json!({"version":1,"nodes":rebound});
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn configured_agent_file_overrides_declared_fields_and_identity() {
        let root = tempfile::tempdir().unwrap();
        tokio::fs::create_dir(root.path().join("agents"))
            .await
            .unwrap();
        tokio::fs::write(root.path().join("config.toml"),"[agents.declared]\ndescription = 'role description'\ndeveloper_instructions = 'role instructions'\nconfig_file = 'agents/actual.toml'\n").await.unwrap();
        tokio::fs::write(root.path().join("agents/actual.toml"),"name = 'actual'\ndescription = 'file description'\ndeveloper_instructions = 'file instructions'\n").await.unwrap();
        let (found, available) = agents(root.path(), None).await.unwrap();
        assert!(available);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["id"], "actual");
        assert_eq!(found[0]["description"], "file description");
        assert_eq!(found[0]["developerInstructions"], "file instructions");
    }
}
