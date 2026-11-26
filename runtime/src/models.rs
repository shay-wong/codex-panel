use crate::{server::codex, ApiError};
use serde_json::{json, Map, Value};
use std::{
    cmp::Ordering,
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(400, "MODEL_CONFIGURATION", message)
}
fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}
fn list(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}
async fn read_json(path: &Path, default: Value) -> Result<Value, ApiError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(default),
        Err(e) => Err(e.into()),
    }
}
async fn atomic_json(path: &Path, value: &Value) -> Result<(), ApiError> {
    atomic_bytes(path, &serde_json::to_vec(value)?).await
}
async fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), ApiError> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let result = async {
        let mut file = options.open(&temporary).await?;
        file.write_all(bytes).await?;
        file.sync_all().await?;
        if let Ok(meta) = tokio::fs::metadata(path).await {
            tokio::fs::set_permissions(&temporary, meta.permissions()).await?;
        }
        tokio::fs::rename(&temporary, path).await?;
        Ok::<_, ApiError>(())
    }
    .await;
    let _ = tokio::fs::remove_file(&temporary).await;
    result
}
fn user_layer(response: &Value) -> Result<&Value, ApiError> {
    response["layers"]
        .as_array()
        .and_then(|layers| {
            layers.iter().find(|l| {
                l["name"]["type"] == "user"
                    && l["name"]["profile"].is_null()
                    && l["name"]["file"].is_string()
                    && l["version"].is_string()
            })
        })
        .ok_or_else(|| invalid("无法定位 Codex 用户配置"))
}
fn writable(origin: &Value, layer: &Value) -> bool {
    origin.is_null()
        || origin["type"] == "system"
        || (origin["type"] == "user"
            && origin["profile"].is_null()
            && origin["file"] == layer["name"]["file"])
}

pub fn ultrafast_catalog(catalog: &Value) -> Result<Value, ApiError> {
    let mut result = catalog.clone();
    let models = result["models"]
        .as_array_mut()
        .ok_or_else(|| invalid("Invalid Codex model catalog"))?;
    let supported =
        regex::Regex::new(r"(?i)^(?:gpt-6[- ]astra|gpt-6\.1[- ]sol|gpt-6\.2[- ](?:astra|sol))$")
            .unwrap();
    for model in models {
        if supported.is_match(model["slug"].as_str().unwrap_or("")) {
            let mut tiers = list(&model["service_tiers"]);
            for (id, name) in [("priority", "Fast"), ("ultrafast", "Ultrafast")] {
                if !tiers.iter().any(|v| v["id"] == id) {
                    tiers.push(json!({"id":id,"name":name,"description":""}));
                }
            }
            model["service_tiers"] = json!(tiers);
        }
    }
    Ok(result)
}
fn official_models(catalog: &Value, official: &Value) -> Result<Value, ApiError> {
    let mut result = catalog.clone();
    let mut output = Vec::new();
    for model in catalog["models"]
        .as_array()
        .ok_or_else(|| invalid("Codex 模型目录格式无效"))?
    {
        let Some(native) = list(&official["models"]).into_iter().find(|m| {
            m["slug"] == model["slug"]
                && m["slug"]
                    .as_str()
                    .is_some_and(|s| s.to_lowercase().starts_with("gpt-"))
        }) else {
            continue;
        };
        let mut merged = object(&native);
        merged.extend(object(model).into_iter().filter(|(_, v)| !v.is_null()));
        let mut merged = Value::Object(merged);
        let levels = if list(&model["supported_reasoning_levels"]).is_empty() {
            native["supported_reasoning_levels"].clone()
        } else {
            model["supported_reasoning_levels"].clone()
        };
        let effort = model["default_reasoning_level"]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                native["default_reasoning_level"]
                    .as_str()
                    .map(str::to_owned)
            });
        merged["default_reasoning_level"] = if model["default_reasoning_level"]
            .as_str()
            .is_none_or(|v| v.is_empty())
            && !list(&model["supported_reasoning_levels"]).is_empty()
            && !list(&levels)
                .iter()
                .any(|l| l["effort"].as_str() == effort.as_deref())
        {
            levels[0]["effort"].clone()
        } else {
            json!(effort)
        };
        merged["supported_reasoning_levels"] = levels;
        output.push(merged);
    }
    result["models"] = json!(output);
    Ok(result)
}
fn defaults(mut catalog: Value) -> Value {
    for model in catalog["models"].as_array_mut().into_iter().flatten() {
        if model["slug"] == "gpt-6.1-sol"
            && model["context_window"] == 272000
            && model["max_context_window"] == 872000
        {
            model["context_window"] = json!(500000);
        }
    }
    catalog
}
fn natural(left: &str, right: &str) -> Ordering {
    let regex = regex::Regex::new(r"\d+|\D+").unwrap();
    let a = regex
        .find_iter(left)
        .map(|m| m.as_str())
        .collect::<Vec<_>>();
    let b = regex
        .find_iter(right)
        .map(|m| m.as_str())
        .collect::<Vec<_>>();
    for (x, y) in a.iter().zip(&b) {
        let order =
            if x.bytes().all(|c| c.is_ascii_digit()) && y.bytes().all(|c| c.is_ascii_digit()) {
                let x = x.trim_start_matches('0');
                let y = y.trim_start_matches('0');
                x.len().cmp(&y.len()).then(x.cmp(y))
            } else {
                x.to_lowercase().cmp(&y.to_lowercase())
            };
        if order != Ordering::Equal {
            return order;
        }
    }
    a.len().cmp(&b.len())
}
fn model_order(left: &Value, right: &Value) -> Ordering {
    let parts = |model: &Value| {
        let name = model["slug"]
            .as_str()
            .unwrap_or("")
            .rsplit('/')
            .next()
            .unwrap_or("")
            .to_lowercase();
        let regex = regex::Regex::new(r"^(\D*?)(\d+(?:[._-]\d+)*)").unwrap();
        let captures = regex.captures(&name);
        let family = captures
            .as_ref()
            .map(|c| c[1].trim_end_matches(['-', '_']).to_owned())
            .unwrap_or(name.clone());
        let version = captures
            .as_ref()
            .map(|c| c[2].replace('-', "."))
            .unwrap_or_default();
        (name, family, version)
    };
    let (a, af, av) = parts(left);
    let (b, bf, bv) = parts(right);
    (!af.starts_with("gpt"))
        .cmp(&!bf.starts_with("gpt"))
        .then_with(|| natural(&af, &bf))
        .then_with(|| natural(&bv, &av))
        .then_with(|| natural(&a, &b))
        .then_with(|| {
            natural(
                left["slug"].as_str().unwrap_or(""),
                right["slug"].as_str().unwrap_or(""),
            )
        })
}
pub fn context_catalog(
    catalog: &Value,
    state: &Value,
    official: &Value,
    ultrafast: bool,
) -> Result<Value, ApiError> {
    let catalog = if ultrafast {
        ultrafast_catalog(catalog)?
    } else {
        catalog.clone()
    };
    let mut result = official_models(&catalog, official)?;
    if state["useOfficialContextDefaults"] == true {
        result = defaults(result);
    }
    let selected = state.get("selectedModels");
    let mut models = list(&result["models"])
        .into_iter()
        .filter(|m| selected.is_none_or(|s| list(s).contains(&m["slug"])))
        .collect::<Vec<_>>();
    for model in &mut models {
        let slug = model["slug"].as_str().unwrap().to_owned();
        if let Some(value) = state["contextWindows"].get(&slug) {
            model["context_window"] = value.clone();
        }
        if let Some(raw) = state["autoCompactTokenLimits"].get(&slug) {
            let limit = if let Some(text) = raw.as_str() {
                if !regex::Regex::new(r"^\d+(?:\.\d+)?%$")
                    .unwrap()
                    .is_match(text)
                {
                    return Err(invalid(format!(
                        "{slug} 的自动压缩百分比必须大于 0 且不超过 90%"
                    )));
                }
                let pct = text
                    .strip_suffix('%')
                    .and_then(|s| s.parse::<f64>().ok())
                    .filter(|p| p.is_finite() && *p > 0.0 && *p <= 90.0)
                    .ok_or_else(|| {
                        invalid(format!("{slug} 的自动压缩百分比必须大于 0 且不超过 90%"))
                    })?;
                let context = model["context_window"]
                    .as_u64()
                    .or_else(|| model["max_context_window"].as_u64())
                    .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
                    .ok_or_else(|| {
                        invalid(format!(
                            "{slug} 缺少上下文大小，请先填写上下文 token 数再设置百分比"
                        ))
                    })?;
                (context as f64 * pct / 100.0).floor() as u64
            } else {
                raw.as_u64().unwrap_or(0)
            };
            if limit == 0 || limit > 9_007_199_254_740_991 {
                return Err(invalid(format!("{slug} 的自动压缩阈值必须至少为 1 token")));
            }
            model["auto_compact_token_limit"] = json!(limit);
        }
        if let Some(effort) = state["multiAgentReasoningEfforts"].get(&slug) {
            model["multi_agent_reasoning_effort"] = effort.clone();
        }
    }
    models.sort_by(model_order);
    for (index, model) in models.iter_mut().enumerate() {
        model["priority"] = json!(index);
    }
    result["models"] = json!(models);
    Ok(result)
}

pub async fn bundled_catalog(executable: &Path) -> Result<Value, ApiError> {
    let bytes = tokio::fs::read(executable).await?;
    let needle = b"\"models\"";
    let mut cursor = 0;
    while cursor + needle.len() < bytes.len() {
        let Some(relative) = bytes[cursor..]
            .windows(needle.len())
            .position(|w| w == needle)
        else {
            break;
        };
        let found = cursor + relative;
        cursor = found + needle.len();
        let Some(start) = bytes[..found].iter().rposition(|b| *b == b'{') else {
            continue;
        };
        if cursor - start > 32 {
            continue;
        }
        let prefix = &bytes[start..(cursor + 16).min(bytes.len())];
        if !regex::bytes::Regex::new(r#"^\{\s*"models"\s*:\s*\["#)
            .unwrap()
            .is_match(prefix)
        {
            continue;
        }
        let (mut depth, mut quoted, mut escaped) = (0i64, false, false);
        for end in start..bytes.len() {
            let byte = bytes[end];
            if quoted {
                if escaped {
                    escaped = false;
                } else if byte == b'\\' {
                    escaped = true;
                } else if byte == b'"' {
                    quoted = false;
                }
            } else if byte == b'"' {
                quoted = true;
            } else if byte == b'{' || byte == b'[' {
                depth += 1;
            } else if byte == b'}' || byte == b']' {
                depth -= 1;
                if depth == 0 {
                    let catalog: Value = serde_json::from_slice(&bytes[start..=end])?;
                    if list(&catalog["models"])
                        .iter()
                        .any(|m| m["slug"] == "gpt-6-astra")
                    {
                        return Ok(catalog);
                    }
                    break;
                }
            }
        }
    }
    Err(invalid("Bundled Codex model catalog is unavailable"))
}

async fn configured_agents(config_file: &Path) -> Result<Vec<Value>, ApiError> {
    let home = config_file
        .parent()
        .ok_or_else(|| invalid("无法定位 Codex 配置目录"))?;
    let source = tokio::fs::read_to_string(config_file)
        .await
        .unwrap_or_default();
    // 配置是 TOML 文档，不能用仅解析单值的 Value::from_str。
    let config: toml::Value =
        toml::from_str(&source).unwrap_or(toml::Value::Table(Default::default()));
    let config = serde_json::to_value(config)?;
    let mut agents = BTreeMap::<String, Value>::new();
    let mut declared = Vec::new();
    for (name, role) in object(&config["agents"]) {
        if !role.is_object() {
            continue;
        }
        let mut path = config_file.to_owned();
        let mut parsed = role.clone();
        if let Some(file) = role["config_file"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            path = if Path::new(file).is_absolute() {
                PathBuf::from(file)
            } else {
                home.join(file)
            };
            let Ok(source) = tokio::fs::read_to_string(&path).await else {
                continue;
            };
            let Ok(value) = toml::from_str::<toml::Value>(&source) else {
                continue;
            };
            let mut merged = object(&role);
            merged.extend(object(&serde_json::to_value(value)?));
            parsed = Value::Object(merged);
            declared.push(path.clone());
        }
        let name = parsed["name"]
            .as_str()
            .or_else(|| parsed["role_name"].as_str())
            .unwrap_or(&name)
            .trim();
        if name.is_empty()
            || parsed["description"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty())
        {
            continue;
        }
        agents.entry(name.into()).or_insert(
            json!({"name":name,"filePath":path,"model":Value::Null,"reasoningEffort":Value::Null}),
        );
    }
    let mut pending = vec![home.join("agents")];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        let mut entries = match tokio::fs::read_dir(directory).await {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        while let Some(entry) = entries.next_entry().await? {
            let kind = entry.file_type().await?;
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() && entry.path().extension().is_some_and(|e| e == "toml") {
                files.push(entry.path());
            }
        }
    }
    files.sort();
    for path in files {
        if declared.contains(&path) {
            continue;
        }
        let Ok(source) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let Ok(parsed) = toml::from_str::<toml::Value>(&source) else {
            continue;
        };
        let value = serde_json::to_value(parsed)?;
        let name = value["name"]
            .as_str()
            .or_else(|| value["role_name"].as_str())
            .unwrap_or("")
            .trim();
        if name.is_empty()
            || value["description"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty())
            || value["developer_instructions"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty())
        {
            continue;
        }
        agents.entry(name.into()).or_insert(
            json!({"name":name,"filePath":path,"model":Value::Null,"reasoningEffort":Value::Null}),
        );
    }
    let mut result = Vec::new();
    for mut agent in agents.into_values() {
        let path = Path::new(agent["filePath"].as_str().unwrap());
        if path == config_file {
            continue;
        }
        let source = tokio::fs::read_to_string(path).await?;
        let parsed: toml::Value =
            toml::from_str(&source).map_err(|e| invalid(format!("子代理配置无效：{e}")))?;
        let value = serde_json::to_value(parsed)?;
        agent["model"] = value["model"].clone();
        agent["reasoningEffort"] = value["model_reasoning_effort"].clone();
        result.push(agent);
    }
    Ok(result)
}

async fn write_agent(agent: &Value, settings: &Map<String, Value>) -> Result<(), ApiError> {
    let file = tokio::fs::canonicalize(agent["filePath"].as_str().unwrap()).await?;
    let source = tokio::fs::read_to_string(&file).await?;
    let mut updated = source.clone();
    for (key, value) in settings {
        let document =
            toml_edit::Document::parse(updated.as_str()).map_err(|e| invalid(e.to_string()))?;
        if let Some((source_key, current)) = document.as_table().get_key_value(key) {
            let span = current
                .span()
                .ok_or_else(|| invalid("无法定位子代理设置"))?;
            if updated[span.clone()].contains(['\n', '\r']) || current.as_str().is_none() {
                return Err(invalid(format!(
                    "请将子代理的 {key} 写成单行字符串后再修改"
                )));
            }
            if current.as_str() == value.as_str() {
                continue;
            }
            if value.is_null() {
                let start = source_key
                    .span()
                    .ok_or_else(|| invalid("无法定位子代理设置"))?
                    .start;
                let line = updated[..start].rfind('\n').map_or(0, |n| n + 1);
                let end = updated[span.end..]
                    .find('\n')
                    .map_or(updated.len(), |n| span.end + n);
                let comment = updated[span.end..end]
                    .trim_start_matches([' ', '\t'])
                    .to_owned();
                updated.replace_range(line..end, &comment);
            } else {
                // 只替换原值的源码范围，保留注释、换行和其他配置原文。
                updated.replace_range(span, &serde_json::to_string(value)?);
            }
        } else if value.is_null() {
            continue;
        } else {
            let newline = if updated.contains("\r\n") {
                "\r\n"
            } else {
                "\n"
            };
            updated = format!(
                "{key} = {}{newline}{updated}",
                serde_json::to_string(value)?
            );
        }
    }
    if source != updated {
        atomic_bytes(&file, updated.as_bytes()).await?;
    }
    Ok(())
}
async fn exec(executable: &Path, args: &[String], cwd: &Path) -> Result<Vec<u8>, ApiError> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(cwd)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null());
    for (name, _) in std::env::vars() {
        if name.starts_with("CODEX_PANEL_") || name.starts_with("CODEX_TASKBOARD_") {
            command.env_remove(name);
        }
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
        .await
        .map_err(|_| invalid("Codex 模型目录读取超时"))??;
    if !output.status.success() {
        return Err(invalid(String::from_utf8_lossy(&output.stderr).trim()));
    }
    if output.stdout.len() > 32 * 1024 * 1024 {
        return Err(invalid("Codex 模型目录超过大小限制"));
    }
    Ok(output.stdout)
}

async fn provider_catalog(
    executable: &Path,
    cwd: &Path,
    config: &Value,
    provider: &str,
    source: Option<&str>,
    home: &Path,
    client: &Arc<codex::Connection>,
) -> Result<Value, ApiError> {
    let settings = &config["model_providers"][provider];
    let endpoint = source
        .map(str::to_owned)
        .or_else(|| {
            settings["base_url"]
                .as_str()
                .map(|url| format!("{}/models", url.trim_end_matches('/')))
        })
        .or_else(|| {
            (provider == "openai").then(|| "https://chatgpt.com/backend-api/codex/models".into())
        })
        .ok_or_else(|| invalid("当前 provider 未配置可直接请求的模型目录地址"))?;
    let mut url = url::Url::parse(&endpoint).map_err(|_| invalid("Provider 模型目录地址无效"))?;
    if !["http", "https"].contains(&url.scheme()) {
        return Err(invalid("Provider 模型目录地址必须使用 HTTP 或 HTTPS"));
    }
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in object(&settings["http_headers"]) {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|e| invalid(e.to_string()))?;
        let value = reqwest::header::HeaderValue::from_str(
            value
                .as_str()
                .ok_or_else(|| invalid("Provider header必须是字符串"))?,
        )
        .map_err(|e| invalid(e.to_string()))?;
        headers.insert(name, value);
    }
    for (name, variable) in object(&settings["env_http_headers"]) {
        if let Some(value) = variable
            .as_str()
            .and_then(|key| std::env::var(key).ok())
            .filter(|v| !v.trim().is_empty())
        {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|e| invalid(e.to_string()))?,
                value
                    .parse()
                    .map_err(|e: reqwest::header::InvalidHeaderValue| invalid(e.to_string()))?,
            );
        }
    }
    let mut token = if let Some(key) = settings["env_key"].as_str() {
        Some(
            std::env::var(key)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| invalid(format!("未设置 provider 的 API Key 环境变量 {key}")))?,
        )
    } else {
        settings["experimental_bearer_token"]
            .as_str()
            .map(str::to_owned)
    };
    if token.is_none()
        && !headers.contains_key("authorization")
        && provider == "openai"
        && settings["requires_openai_auth"] != false
        && url.origin().ascii_serialization() == "https://chatgpt.com"
        && url.path() == "/backend-api/codex/models"
    {
        if config["cli_auth_credentials_store"]
            .as_str()
            .unwrap_or("file")
            != "file"
        {
            return Err(invalid(
                "官方账号目录刷新目前仅支持 Codex 的 file 凭据存储，不能读取 keyring 或内存凭据",
            ));
        }
        let account = client
            .request("account/read", json!({"refreshToken":true}))
            .await?;
        let auth = read_json(&home.join("auth.json"), Value::Null).await?;
        if account["account"]["type"] == "chatgpt" {
            token = auth["tokens"]["access_token"].as_str().map(str::to_owned);
            if let Some(id) = auth["tokens"]["account_id"].as_str() {
                headers.insert(
                    "chatgpt-account-id",
                    id.parse()
                        .map_err(|e: reqwest::header::InvalidHeaderValue| invalid(e.to_string()))?,
                );
            }
        } else if account["account"]["type"] == "apiKey" {
            token = auth["OPENAI_API_KEY"].as_str().map(str::to_owned);
        }
        if token.is_none() {
            return Err(invalid("无法读取当前官方账号凭据，请先在 Codex 中登录"));
        }
    }
    if let Some(token) = token {
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {token}")
                .parse()
                .map_err(|e: reqwest::header::InvalidHeaderValue| invalid(e.to_string()))?,
        );
    } else if !headers.contains_key("authorization")
        && (settings["requires_openai_auth"] == true || !settings["auth"].is_null())
    {
        return Err(invalid(
            "当前 provider 使用原生账号或命令认证，尚不支持直接刷新其模型目录",
        ));
    }
    let output = exec(executable, &["--version".into()], cwd).await?;
    let text = String::from_utf8_lossy(&output);
    let regex = regex::Regex::new(r"\bcodex-cli\s+(\d+\.\d+\.\d+)").unwrap();
    let version = regex
        .captures(&text)
        .map(|c| c[1].to_owned())
        .ok_or_else(|| invalid("无法识别 Codex CLI 版本"))?;
    for (key, value) in object(&settings["query_params"]) {
        url.query_pairs_mut()
            .append_pair(&key, value.as_str().unwrap_or(""));
    }
    url.query_pairs_mut()
        .append_pair("client_version", &version);
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()?
        .get(url)
        .headers(headers)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(invalid(format!(
            "获取 provider 模型目录失败（HTTP {}）",
            response.status().as_u16()
        )));
    }
    Ok(response.json().await?)
}

use std::sync::Arc;
pub async fn context_settings(
    executable: &Path,
    data: &Path,
    cwd: &Path,
    refresh: bool,
    input: Option<&Value>,
    preferences: Option<&Path>,
) -> Result<Value, ApiError> {
    tokio::fs::create_dir_all(data).await?;
    let data = tokio::fs::canonicalize(data).await?;
    let client = codex::Connection::start(executable, cwd).await?;
    let result =
        context_settings_inner(executable, &data, cwd, refresh, input, preferences, &client).await;
    client.close().await;
    result
}
async fn context_settings_inner(
    executable: &Path,
    data: &Path,
    cwd: &Path,
    refresh: bool,
    input: Option<&Value>,
    preferences: Option<&Path>,
    client: &Arc<codex::Connection>,
) -> Result<Value, ApiError> {
    let response = client
        .request("config/read", json!({"includeLayers":true}))
        .await?;
    let config = &response["config"];
    let layer = user_layer(&response)?;
    let file = Path::new(layer["name"]["file"].as_str().unwrap());
    let official = bundled_catalog(executable).await?;
    let state_path = data.join("model-context.json");
    let catalog_path = data.join("model-context-catalog.json");
    let catalog_string = catalog_path.to_string_lossy().into_owned();
    let provider = config["model_provider"].as_str().unwrap_or("openai");
    let prefs = if let Some(path) = preferences {
        read_json(path, json!({})).await?
    } else {
        json!({})
    };
    let ultrafast = prefs["customProviderUltrafast"] == true
        && provider != "openai"
        && config["model_providers"][provider].is_object();
    let provider_url = config["model_providers"][provider]["model_catalog_url"].as_str();
    let adapter = read_json(&data.join("ultrafast-catalog.json"), Value::Null).await?;
    let saved = &adapter["providers"][provider];
    let source_url = if !saved.is_null() && saved["url"].as_str() == provider_url {
        saved["originalUrl"].as_str()
    } else {
        provider_url
    };
    let mut state = read_json(&state_path, Value::Null).await?;
    if state.is_null() || config["model_catalog_json"] != catalog_string {
        let mut args = vec!["debug".into(), "models".into()];
        if config["model_catalog_json"].is_null()
            && !saved.is_null()
            && saved["url"].as_str() == provider_url
        {
            if let Some(original) = saved["originalUrl"].as_str() {
                args.extend([
                    "-c".into(),
                    format!(
                        "model_providers.{}.model_catalog_url={}",
                        json!(provider),
                        json!(original)
                    ),
                ]);
            } else {
                args.push("--bundled".into());
            }
        }
        state = json!({"catalog":serde_json::from_slice::<Value>(&exec(executable,&args,cwd).await?)?,"contextWindows":{},"originalCatalog":layer["config"]["model_catalog_json"],"catalogSource":if !config["model_catalog_json"].is_null()||source_url.is_some(){"external"}else{"native"}});
    }
    if !state["catalog"]["models"].is_array() {
        return Err(invalid("Codex 模型目录格式无效"));
    }
    let mut catalog_changed = false;
    if refresh {
        if !state["selectedModels"].is_array() {
            state["selectedModels"] = json!(list(&state["catalog"]["models"])
                .iter()
                .map(|m| m["slug"].clone())
                .collect::<Vec<_>>());
        }
        let source = provider_catalog(
            executable,
            cwd,
            config,
            provider,
            source_url,
            file.parent().unwrap(),
            client,
        )
        .await?;
        let models = list(&source["models"]);
        let mut slugs = Vec::new();
        if models.is_empty()
            || models.iter().any(|m| {
                let Some(slug) = m["slug"].as_str().filter(|v| !v.trim().is_empty()) else {
                    return true;
                };
                if slugs.contains(&slug) {
                    return true;
                }
                slugs.push(slug);
                false
            })
        {
            return Err(invalid(
                "Provider 未返回有效的 Codex 完整模型目录（需要 models 数组及唯一模型 slug）",
            ));
        }
        state["catalog"] = source;
        state["catalogSource"] = json!("external");
        let mut compare_state = state.clone();
        compare_state["useOfficialContextDefaults"] = json!(false);
        let next = context_catalog(&state["catalog"], &compare_state, &official, ultrafast)?;
        let previous = read_json(&catalog_path, Value::Null).await?;
        let mut previous_models = list(&previous["models"]);
        previous_models.sort_by(model_order);
        catalog_changed = !list(&next["models"]).is_empty()
            && (config["model_catalog_json"] != catalog_string
                || previous_models != list(&next["models"]));
    } else if state["catalogSource"].is_null()
        && state["originalCatalog"].is_null()
        && source_url.is_none()
    {
        state["catalog"] = official.clone();
        state["catalogSource"] = json!("native");
    }
    for key in [
        "contextWindows",
        "autoCompactTokenLimits",
        "multiAgentReasoningEfforts",
    ] {
        if state[key].is_null() {
            state[key] = json!({});
        }
    }
    state["useOfficialContextDefaults"] = json!(state["catalogSource"] == "native");
    let official_slugs = list(&official["models"])
        .into_iter()
        .filter(|m| {
            m["slug"]
                .as_str()
                .is_some_and(|s| s.to_lowercase().starts_with("gpt-"))
        })
        .map(|m| m["slug"].clone())
        .collect::<Vec<_>>();
    if state["selectedModels"].is_array() {
        state["selectedModels"] = json!(list(&state["selectedModels"])
            .into_iter()
            .filter(|s| official_slugs.contains(s))
            .collect::<Vec<_>>());
    }
    let compatible = official_models(&state["catalog"], &official)?;
    if refresh && list(&compatible["models"]).is_empty() {
        return Err(invalid(
            "服务商目录中没有当前 Codex 支持的 GPT 模型，已保留原目录",
        ));
    }
    let defaults = if state["useOfficialContextDefaults"] == true {
        defaults(compatible.clone())
    } else {
        compatible.clone()
    };
    let slugs = list(&defaults["models"])
        .iter()
        .map(|m| m["slug"].clone())
        .collect::<Vec<_>>();
    let efforts = list(&defaults["models"])
        .iter()
        .flat_map(|m| list(&m["supported_reasoning_levels"]))
        .map(|l| l["effort"].clone())
        .collect::<Vec<_>>();
    let mut agents = configured_agents(file).await?;
    let mut default_model = config["agents"]["default_subagent_model"].clone();
    let mut default_effort = config["agents"]["default_subagent_reasoning_effort"].clone();
    if refresh
        || input
            .is_some_and(|i| i.get("contextWindows").is_some() || i.get("selectedModels").is_some())
    {
        let input = input.cloned().unwrap_or(json!({}));
        let previous = state.clone();
        for key in [
            "contextWindows",
            "autoCompactTokenLimits",
            "multiAgentReasoningEfforts",
            "selectedModels",
        ] {
            if let Some(value) = input.get(key) {
                state[key] = value.clone();
            }
        }
        if let Some(selected) = state.get("selectedModels") {
            if !selected.is_array()
                || list(selected).iter().any(|s| {
                    !s.is_string()
                        || (!slugs.contains(s) && !list(&previous["selectedModels"]).contains(s))
                })
            {
                return Err(invalid("请选择目录中有效的模型"));
            }
            if !refresh && !list(selected).iter().any(|s| slugs.contains(s)) {
                return Err(invalid("至少保留一个模型"));
            }
            let mut unique = Vec::new();
            for slug in list(selected) {
                if !unique.contains(&slug) {
                    unique.push(slug);
                }
            }
            state["selectedModels"] = json!(unique);
        }
        for (key, label) in [
            ("contextWindows", "上下文"),
            ("autoCompactTokenLimits", "自动压缩阈值"),
        ] {
            let values = state[key]
                .as_object()
                .ok_or_else(|| invalid(format!("{label}设置必须是模型 ID 与 token 数的对应表")))?;
            for (slug, size) in values {
                if !slugs.contains(&json!(slug)) {
                    if previous[key].get(slug) == Some(size) {
                        continue;
                    }
                    return Err(invalid(format!("模型目录中没有 {slug}")));
                }
                if key == "autoCompactTokenLimits" && size.is_string() {
                    continue;
                }
                if size
                    .as_u64()
                    .is_none_or(|n| n == 0 || n > 9_007_199_254_740_991)
                {
                    return Err(invalid(format!("{slug} 的{label} token 数必须为正整数")));
                }
            }
        }
        for (slug, effort) in state["multiAgentReasoningEfforts"]
            .as_object()
            .ok_or_else(|| invalid("子代理推理设置必须是模型 ID 与推理强度的对应表"))?
        {
            if effort.as_str().is_none_or(|s| s.trim().is_empty()) {
                return Err(invalid(format!("{slug} 的子代理推理强度必须为非空字符串")));
            }
            if state
                .get("selectedModels")
                .is_some_and(|s| !list(s).contains(&json!(slug)))
                && previous["multiAgentReasoningEfforts"].get(slug) == Some(effort)
            {
                continue;
            }
            let model = list(&defaults["models"])
                .into_iter()
                .find(|m| m["slug"] == *slug);
            let Some(model) = model else {
                if previous["multiAgentReasoningEfforts"].get(slug) == Some(effort) {
                    continue;
                }
                return Err(invalid(format!("模型目录中没有 {slug}")));
            };
            if !list(&model["supported_reasoning_levels"]).is_empty()
                && !list(&model["supported_reasoning_levels"])
                    .iter()
                    .any(|v| v["effort"] == *effort)
            {
                return Err(invalid(format!("{slug} 不支持子代理推理强度 {effort}")));
            }
        }
        let mut edits = Vec::new();
        let mut agent_edits = BTreeMap::<usize, Map<String, Value>>::new();
        for (key, field, setting, allowed, label) in [
            ("agentModels", "model", "model", &slugs, "模型"),
            (
                "agentReasoningEfforts",
                "reasoningEffort",
                "model_reasoning_effort",
                &efforts,
                "推理强度",
            ),
        ] {
            if let Some(values) = input.get(key) {
                for (name, value) in values
                    .as_object()
                    .ok_or_else(|| invalid(format!("子代理{label}设置必须是名称与值的对应表")))?
                {
                    let index = agents
                        .iter()
                        .position(|a| a["name"] == *name)
                        .ok_or_else(|| invalid(format!("未找到子代理 {name}")))?;
                    let text = value
                        .as_str()
                        .ok_or_else(|| invalid(format!("{name} 的{label}必须是字符串")))?
                        .trim();
                    let setting_value = if text.is_empty() {
                        Value::Null
                    } else {
                        json!(text)
                    };
                    if setting_value == agents[index][field] {
                        continue;
                    }
                    if !setting_value.is_null() && !allowed.contains(&setting_value) {
                        return Err(invalid(format!(
                            "{name} 的{label}不在当前模型目录中：{text}"
                        )));
                    }
                    agent_edits
                        .entry(index)
                        .or_default()
                        .insert(setting.into(), setting_value);
                }
            }
        }
        for (input_key, key, current, allowed, label) in [
            (
                "defaultSubagentModel",
                "agents.default_subagent_model",
                &mut default_model,
                &slugs,
                "模型",
            ),
            (
                "defaultSubagentReasoningEffort",
                "agents.default_subagent_reasoning_effort",
                &mut default_effort,
                &efforts,
                "推理强度",
            ),
        ] {
            if let Some(raw) = input.get(input_key) {
                if !raw.is_null() && !raw.is_string() {
                    return Err(invalid(format!("子代理默认{label}必须是字符串")));
                }
                let value = raw
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map_or(Value::Null, |s| json!(s));
                if value != *current {
                    if !value.is_null() && !allowed.contains(&value) {
                        return Err(invalid(format!("子代理默认{label}不在当前模型目录中")));
                    }
                    if !writable(&response["origins"][key]["name"], layer) {
                        return Err(invalid(format!(
                            "子代理默认{label}由更高优先级配置管理，请修改对应配置"
                        )));
                    }
                    edits.push(json!({"keyPath":key,"value":value,"mergeStrategy":"replace"}));
                    *current = value;
                }
            }
        }
        if !writable(&response["origins"]["model_catalog_json"]["name"], layer) {
            return Err(invalid("模型目录由更高优先级配置管理，无法保存上下文设置"));
        }
        let overrides = refresh
            || state.get("selectedModels").is_some()
            || !object(&state["contextWindows"]).is_empty()
            || !object(&state["autoCompactTokenLimits"]).is_empty()
            || !object(&state["multiAgentReasoningEfforts"]).is_empty()
            || defaults != compatible;
        let selected = state
            .get("selectedModels")
            .is_none_or(|s| list(s).iter().any(|v| slugs.contains(v)));
        let combined = context_catalog(&state["catalog"], &state, &official, ultrafast)?;
        if overrides {
            atomic_json(&state_path, &state).await?;
            if selected {
                atomic_json(&catalog_path, &combined).await?;
            }
        }
        let value = if !selected {
            config["model_catalog_json"].clone()
        } else if overrides {
            json!(catalog_string)
        } else {
            state["originalCatalog"].clone()
        };
        if config["model_catalog_json"] != value {
            edits.push(
                json!({"keyPath":"model_catalog_json","value":value,"mergeStrategy":"replace"}),
            );
        }
        if !edits.is_empty() {
            let result=client.request("config/batchWrite",json!({"edits":edits,"filePath":layer["name"]["file"],"expectedVersion":layer["version"],"reloadUserConfig":true})).await?;
            if result["status"] != "ok" {
                return Err(invalid("模型配置被更高优先级设置覆盖"));
            }
        }
        for (index, settings) in agent_edits {
            write_agent(&agents[index], &settings).await?;
            if let Some(value) = settings.get("model") {
                agents[index]["model"] = value.clone();
            }
            if let Some(value) = settings.get("model_reasoning_effort") {
                agents[index]["reasoningEffort"] = value.clone();
            }
        }
    }
    let mut models = list(&defaults["models"]);
    models.sort_by(model_order);
    Ok(
        json!({"catalogChanged":catalog_changed,"selectedModels":state.get("selectedModels").cloned().unwrap_or(json!(models.iter().map(|m|m["slug"].clone()).collect::<Vec<_>>())) ,"models":models.iter().map(|m|json!({"slug":m["slug"],"displayName":m["display_name"].as_str().unwrap_or(m["slug"].as_str().unwrap_or("")),"contextWindow":m.get("context_window").filter(|v|!v.is_null()).or_else(||m.get("max_context_window")).cloned().unwrap_or(Value::Null),"autoCompactTokenLimit":m["auto_compact_token_limit"],"multiAgentReasoningEffort":m["multi_agent_reasoning_effort"],"reasoningEfforts":list(&m["supported_reasoning_levels"]).iter().map(|v|v["effort"].clone()).collect::<Vec<_>>()})).collect::<Vec<_>>(),"contextWindows":state["contextWindows"],"autoCompactTokenLimits":state["autoCompactTokenLimits"],"multiAgentReasoningEfforts":state["multiAgentReasoningEfforts"],"defaultSubagentModel":default_model,"defaultSubagentReasoningEffort":default_effort,"agents":agents,"globalContextWindow":config["model_context_window"],"globalAutoCompactTokenLimit":config["model_auto_compact_token_limit"]}),
    )
}

pub async fn run(args: &[String]) -> Result<Value, ApiError> {
    let operation = args
        .first()
        .map(String::as_str)
        .ok_or_else(|| invalid("缺少模型配置操作"))?;
    let app = Path::new(args.get(1).ok_or_else(|| invalid("缺少 Codex 应用路径"))?);
    let executable = [
        "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        "Contents/Resources/codex",
        "resources/codex.exe",
    ]
    .iter()
    .map(|p| app.join(p))
    .find(|p| p.is_file())
    .or_else(|| codex::executable().ok())
    .ok_or_else(|| invalid("找不到 Codex 可执行文件"))?;
    let cwd = std::env::current_dir()?;
    if ["read-contexts", "write-contexts", "refresh-catalog"].contains(&operation) {
        let data = Path::new(
            args.get(2)
                .ok_or_else(|| invalid("需要绝对路径的 Panel 数据目录"))?,
        );
        if !data.is_absolute() {
            return Err(invalid("需要绝对路径的 Panel 数据目录"));
        }
        let input = if operation == "write-contexts" {
            let mut bytes = Vec::new();
            tokio::io::stdin().read_to_end(&mut bytes).await?;
            Some(serde_json::from_slice::<Value>(&bytes)?)
        } else {
            None
        };
        let preferences = std::env::var_os("CODEX_PANEL_PREFERENCES_FILE").map(PathBuf::from);
        return context_settings(
            &executable,
            data,
            &cwd,
            operation == "refresh-catalog",
            input.as_ref(),
            preferences.as_deref(),
        )
        .await;
    }
    if !["read-discovery", "enable-discovery", "remove-discovery"].contains(&operation) {
        return Err(invalid("未知模型配置操作"));
    }
    let client = codex::Connection::start(&executable, &cwd).await?;
    let result=async{let response=client.request("config/read",json!({"includeLayers":true})).await?;let layer=user_layer(&response)?;let current=&layer["config"]["features"]["api_key_model_discovery"];
        if operation=="read-discovery"{if !current.is_null()&&!current.is_boolean(){return Err(invalid("Codex 模型发现配置不是布尔值"));}return Ok(current.clone());}
        let enabled=operation=="enable-discovery";if (enabled&&current==true)||(!enabled&&current.is_null()){return Ok(Value::Null);}
        let result=client.request("config/batchWrite",json!({"edits":[{"keyPath":"features.api_key_model_discovery","value":if enabled{json!(true)}else{Value::Null},"mergeStrategy":"replace"}],"filePath":layer["name"]["file"],"expectedVersion":layer["version"],"reloadUserConfig":true})).await?;if result["status"]!="ok"{return Err(invalid("配置受更高优先级设置覆盖，请检查 Codex 配置"));}Ok(Value::Null)
    }.await;
    client.close().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_model_ids_tiers_and_percent_compaction() {
        let catalog = json!({"models":[{"slug":"gpt-6-astra","context_window":1000,"service_tiers":[{"id":"priority","name":"custom"}],"supported_reasoning_levels":[{"effort":"high"}]}]});
        let state = json!({"contextWindows":{},"autoCompactTokenLimits":{"gpt-6-astra":"80%"},"multiAgentReasoningEfforts":{}});
        let result = context_catalog(&catalog, &state, &catalog, true).unwrap();
        assert_eq!(result["models"][0]["auto_compact_token_limit"], 800);
        assert_eq!(result["models"][0]["service_tiers"][0]["name"], "custom");
        assert_eq!(
            result["models"][0]["service_tiers"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn rejects_invalid_percent_and_preserves_official_scope() {
        let catalog =
            json!({"models":[{"slug":"gpt-6-astra","context_window":1000},{"slug":"unknown"}]});
        let official = json!({"models":[{"slug":"gpt-6-astra","context_window":1000}]});
        assert_eq!(
            official_models(&catalog, &official).unwrap()["models"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let state = json!({"contextWindows":{},"autoCompactTokenLimits":{"gpt-6-astra":"100%"}});
        assert!(context_catalog(&catalog, &state, &official, false).is_err());
        for percent in ["+80%", ".5%", "8e1%"] {
            let state =
                json!({"contextWindows":{},"autoCompactTokenLimits":{"gpt-6-astra":percent}});
            assert!(context_catalog(&catalog, &state, &official, false).is_err());
        }
    }
    #[tokio::test]
    async fn updating_agent_model_preserves_comments_and_unrelated_settings() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("agent.toml");
        tokio::fs::write(&file,"# Custom agent\nmodel = \"old\" # Keep this note\nmodel_reasoning_effort = \"high\"\n[tools]\ncommand = \"echo unchanged\"\n").await.unwrap();
        write_agent(
            &json!({"filePath":file}),
            &Map::from_iter([("model".into(), json!("gpt-6-astra"))]),
        )
        .await
        .unwrap();
        let updated = tokio::fs::read_to_string(&file).await.unwrap();
        assert!(updated.contains("# Keep this note"));
        assert!(updated.contains("# Custom agent"));
        assert!(updated.contains("command = \"echo unchanged\""));
        write_agent(
            &json!({"filePath":file}),
            &Map::from_iter([("model".into(), Value::Null)]),
        )
        .await
        .unwrap();
        let cleared = tokio::fs::read_to_string(file).await.unwrap();
        assert!(cleared.contains("# Keep this note"));
    }
    #[tokio::test]
    async fn reads_declared_and_discovered_agent_models_from_toml_documents() {
        let directory = tempfile::tempdir().unwrap();
        tokio::fs::create_dir(directory.path().join("agents"))
            .await
            .unwrap();
        let config = directory.path().join("config.toml");
        tokio::fs::write(&config,"[agents.declared]\ndescription = 'declared agent'\nconfig_file = 'agents/declared.toml'\n").await.unwrap();
        tokio::fs::write(directory.path().join("agents/declared.toml"),"name = 'configured'\ndescription = 'configured agent'\nmodel = 'gpt-6-astra'\nmodel_reasoning_effort = 'high'\n").await.unwrap();
        tokio::fs::write(directory.path().join("agents/discovered.toml"),"name = 'discovered'\ndescription = 'discovered agent'\ndeveloper_instructions = 'inspect files'\nmodel = 'gpt-6.1-sol'\nmodel_reasoning_effort = 'medium'\n").await.unwrap();
        let agents = configured_agents(&config).await.unwrap();
        assert_eq!(agents.len(), 2);
        let configured = agents.iter().find(|a| a["name"] == "configured").unwrap();
        assert_eq!(configured["model"], "gpt-6-astra");
        assert_eq!(configured["reasoningEffort"], "high");
        let discovered = agents.iter().find(|a| a["name"] == "discovered").unwrap();
        assert_eq!(discovered["model"], "gpt-6.1-sol");
        assert_eq!(discovered["reasoningEffort"], "medium");
    }
}
