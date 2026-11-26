use crate::{models, server::codex, ApiError};
use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use tokio::{net::TcpListener, sync::Mutex, task::JoinHandle};

struct Inner {
    state: Value,
    sessions: BTreeMap<String, Value>,
    catalog: Option<Value>,
    server: Option<JoinHandle<()>>,
}
pub struct CatalogAdapter {
    executable: PathBuf,
    data: PathBuf,
    preferences: PathBuf,
    inner: Mutex<Inner>,
    gate: Mutex<()>,
}

async fn read(path: &std::path::Path, fallback: Value) -> Result<Value, ApiError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(fallback),
        Err(e) => Err(e.into()),
    }
}
async fn save(path: &std::path::Path, value: &Value) -> Result<(), ApiError> {
    use tokio::io::AsyncWriteExt;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let result = async {
        let mut file = options.open(&temporary).await?;
        file.write_all(&serde_json::to_vec(value)?).await?;
        file.sync_all().await?;
        tokio::fs::rename(&temporary, path).await?;
        Ok::<_, ApiError>(())
    }
    .await;
    let _ = tokio::fs::remove_file(temporary).await;
    result
}

impl CatalogAdapter {
    pub fn new(executable: PathBuf, data: PathBuf, preferences: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            executable,
            data,
            preferences,
            inner: Mutex::new(Inner {
                state: Value::Null,
                sessions: BTreeMap::new(),
                catalog: None,
                server: None,
            }),
            gate: Mutex::new(()),
        })
    }
    pub async fn sync(self: &Arc<Self>) -> Result<(), ApiError> {
        let _gate = self.gate.lock().await;
        let preferences = read(&self.preferences, json!({})).await?;
        let path = self.data.join("ultrafast-catalog.json");
        {
            let mut inner = self.inner.lock().await;
            if inner.state.is_null() {
                inner.state = read(&path, json!({"providers":{}})).await?;
                if let Some(entries) = inner.state["providers"].as_object() {
                    let entries = entries.clone();
                    for (name, entry) in entries {
                        inner.sessions.insert(name, entry);
                    }
                }
            }
        }
        let enabled = preferences["customProviderUltrafast"] == true;
        let contexts = read(&self.data.join("model-context.json"), Value::Null).await?;
        let no_saved_catalog = {
            let inner = self.inner.lock().await;
            inner.state["providers"]
                .as_object()
                .is_none_or(|v| v.is_empty())
                && inner.state["official"].is_null()
        };
        if !enabled && no_saved_catalog && contexts.is_null() {
            return Ok(());
        }
        let cwd = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir()?);
        let client = codex::Connection::start(&self.executable, &cwd).await?;
        let result = self
            .sync_config(&client, enabled, &contexts, &path, &cwd)
            .await;
        client.close().await;
        result
    }
    async fn sync_config(
        self: &Arc<Self>,
        client: &Arc<codex::Connection>,
        enabled: bool,
        contexts: &Value,
        path: &std::path::Path,
        cwd: &std::path::Path,
    ) -> Result<(), ApiError> {
        let response = client
            .request("config/read", json!({"includeLayers":true}))
            .await?;
        let config = &response["config"];
        let layer = response["layers"]
            .as_array()
            .and_then(|a| {
                a.iter()
                    .find(|v| v["name"]["type"] == "user" && v["name"]["profile"].is_null())
            })
            .ok_or_else(|| ApiError::new(409, "MODEL_CONFIGURATION", "无法定位 Codex 用户配置"))?;
        let provider = config["model_provider"].as_str().unwrap_or("openai");
        let mut active =
            enabled && (provider == "openai" || config["model_providers"][provider].is_object());
        tokio::fs::create_dir_all(&self.data).await?;
        let data = tokio::fs::canonicalize(&self.data).await?;
        let catalog_path = data.join("model-context-catalog.json");
        if !contexts.is_null() && config["model_catalog_json"].as_str() == catalog_path.to_str() {
            let catalog = self.catalog().await?;
            let combined =
                models::context_catalog(&contexts["catalog"], contexts, &catalog, active)?;
            if combined["models"].as_array().is_some_and(|a| !a.is_empty()) {
                save(&catalog_path, &combined).await?;
            }
            active = false;
        }
        let official_active = active && provider == "openai";
        active = active && !official_active;
        let official = self.inner.lock().await.state["official"].clone();
        let owns_official =
            official["path"].is_string() && config["model_catalog_json"] == official["path"];
        if active
            && !config["model_catalog_json"].is_null()
            && !(owns_official && official["restoreValue"].is_null())
        {
            return Err(ApiError::new(
                409,
                "MODEL_CONFIGURATION",
                "Ultrafast requires service_tiers in your existing model_catalog_json",
            ));
        }
        if active {
            let origin = &response["origins"]
                [format!("model_providers.{provider}.model_catalog_url")]["name"];
            if !origin.is_null()
                && !(origin["type"] == "system"
                    || (origin["type"] == "user"
                        && origin["profile"].is_null()
                        && origin["file"] == layer["name"]["file"]))
            {
                return Err(ApiError::new(
                    409,
                    "MODEL_CONFIGURATION",
                    "Ultrafast catalog URL is controlled by a higher-priority config layer",
                ));
            }
            self.catalog().await?;
            self.start_server().await?;
        }
        let official_source = if official_active {
            let origin = &response["origins"]["model_catalog_json"]["name"];
            if !origin.is_null()
                && !(origin["type"] == "system"
                    || (origin["type"] == "user"
                        && origin["profile"].is_null()
                        && origin["file"] == layer["name"]["file"]))
            {
                return Err(ApiError::new(
                    409,
                    "MODEL_CONFIGURATION",
                    "Ultrafast model catalog is controlled by a higher-priority config layer",
                ));
            }
            Some(if owns_official {
                official["sourceCatalog"].clone()
            } else {
                // 官方 provider 无需创建自定义 provider；保留 Codex 当前认证对应的完整目录。
                models::native_catalog(&self.executable, cwd).await?
            })
        } else {
            None
        };
        let mut edits = Vec::new();
        let mut inner = self.inner.lock().await;
        if let Some(source) = official_source {
            let entry = if owns_official {
                official.clone()
            } else {
                json!({"path":data.join("ultrafast-openai-catalog.json"),
                    "restoreValue":layer["config"]["model_catalog_json"],"sourceCatalog":source,
                    "catalogSource":if config["model_catalog_json"].is_null(){"native"}else{"external"}})
            };
            inner.state["official"] = entry.clone();
            // 恢复信息先落盘，再切换唯一的目录字段；不写 model_provider 或认证配置。
            save(path, &inner.state).await?;
            save(
                std::path::Path::new(entry["path"].as_str().unwrap()),
                &models::ultrafast_catalog(&entry["sourceCatalog"])?,
            )
            .await?;
            if config["model_catalog_json"] != entry["path"] {
                edits.push(json!({"keyPath":"model_catalog_json","value":entry["path"],"mergeStrategy":"replace"}));
            }
        } else if official["path"].is_string() {
            // 已运行的 Codex 可能仍持有旧路径，关闭开关也要让该文件恢复原始 tiers。
            save(
                std::path::Path::new(official["path"].as_str().unwrap()),
                &official["sourceCatalog"],
            )
            .await?;
            if layer["config"]["model_catalog_json"] == official["path"] {
                edits.push(json!({"keyPath":"model_catalog_json","value":official["restoreValue"],"mergeStrategy":"replace"}));
            }
        }
        for (name, entry) in inner.state["providers"]
            .as_object()
            .cloned()
            .unwrap_or_default()
        {
            if active && name == provider {
                continue;
            }
            if layer["config"]["model_providers"][&name]["model_catalog_url"] == entry["url"] {
                edits.push(json!({"keyPath":format!("model_providers.{}.model_catalog_url",json!(name)),"value":entry["restoreValue"],"mergeStrategy":"replace"}));
            }
        }
        if active {
            let current = config["model_providers"][provider]["model_catalog_url"].clone();
            let entry = inner.state["providers"][provider].clone();
            let entry = if entry.is_null() || entry["url"] != current {
                let previous = inner.sessions.get(provider);
                let route = previous
                    .filter(|p| p["originalUrl"] == current)
                    .and_then(|v| v["route"].as_str())
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("/models/{}", uuid::Uuid::new_v4()));
                let entry = json!({"originalUrl":current,"restoreValue":layer["config"]["model_providers"][provider]["model_catalog_url"],"url":format!("http://127.0.0.1:{}{}",inner.state["port"].as_u64().unwrap(),route),"route":route});
                inner.state["providers"][provider] = entry.clone();
                inner.sessions.insert(provider.into(), entry.clone());
                // 必须先保存恢复信息，随后才能把用户配置切换到本地目录地址。
                tokio::fs::create_dir_all(&self.data).await?;
                save(path, &inner.state).await?;
                entry
            } else {
                entry
            };
            if current != entry["url"] {
                edits.push(json!({"keyPath":format!("model_providers.{}.model_catalog_url",json!(provider)),"value":entry["url"],"mergeStrategy":"replace"}));
            }
        }
        if !edits.is_empty() {
            let response=client.request("config/batchWrite",json!({"edits":edits,"filePath":layer["name"]["file"],"expectedVersion":layer["version"],"reloadUserConfig":true})).await?;
            if response["status"] != "ok" {
                return Err(ApiError::new(
                    409,
                    "MODEL_CONFIGURATION",
                    "Ultrafast catalog config is overridden by another layer",
                ));
            }
        }
        inner.state["providers"]
            .as_object_mut()
            .ok_or_else(|| {
                ApiError::new(
                    400,
                    "MODEL_CONFIGURATION",
                    "Invalid Ultrafast catalog state",
                )
            })?
            .retain(|name, _| active && name == provider);
        if !official_active {
            inner.state.as_object_mut().unwrap().remove("official");
        }
        tokio::fs::create_dir_all(&self.data).await?;
        save(path, &inner.state).await?;
        Ok(())
    }
    async fn catalog(&self) -> Result<Value, ApiError> {
        let mut inner = self.inner.lock().await;
        if inner.catalog.is_none() {
            inner.catalog = Some(models::bundled_catalog(&self.executable).await?);
        }
        Ok(inner.catalog.clone().unwrap())
    }
    async fn start_server(self: &Arc<Self>) -> Result<(), ApiError> {
        let mut inner = self.inner.lock().await;
        if inner.server.is_some() {
            return Ok(());
        }
        let port = inner.state["port"].as_u64().unwrap_or(0);
        let port = u16::try_from(port)
            .map_err(|_| ApiError::new(400, "MODEL_CONFIGURATION", "Invalid catalog port"))?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
        inner.state["port"] = json!(listener.local_addr()?.port());
        let app = Router::new()
            .fallback(catalog_request)
            .with_state(Arc::downgrade(self));
        inner.server = Some(tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("Ultrafast catalog service: {e}");
            }
        }));
        tokio::fs::create_dir_all(&self.data).await?;
        save(&self.data.join("ultrafast-catalog.json"), &inner.state).await?;
        Ok(())
    }
    pub async fn close(&self) {
        let _gate = self.gate.lock().await;
        let mut inner = self.inner.lock().await;
        if let Some(server) = inner.server.take() {
            server.abort();
        }
    }
}

async fn catalog_request(
    State(weak): State<std::sync::Weak<CatalogAdapter>>,
    request: Request<Body>,
) -> Response {
    let Some(adapter) = weak.upgrade() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let (parts, _) = request.into_parts();
    let result=async{
        if parts.method!=axum::http::Method::GET{return Ok(None);}
        let (entry,catalog,active)={let inner=adapter.inner.lock().await;let Some((name,entry))=inner.sessions.iter().find(|(_,e)|e["route"]==parts.uri.path())else{return Ok(None)};(entry.clone(),inner.catalog.clone().ok_or_else(||ApiError::new(503,"MODEL_CONFIGURATION","Catalog unavailable"))?,inner.state["providers"].get(name)==Some(entry))};
        let source=if let Some(original)=entry["originalUrl"].as_str(){let mut url=url::Url::parse(original).map_err(|_|ApiError::new(400,"MODEL_CONFIGURATION","Invalid provider catalog URL"))?;if let Some(query)=parts.uri.query(){for(k,v)in url::form_urlencoded::parse(query.as_bytes()){let pairs=url.query_pairs().filter(|(key,_)|key!=&k).map(|(k,v)|(k.into_owned(),v.into_owned())).collect::<Vec<_>>();url.set_query(None);url.query_pairs_mut().extend_pairs(pairs).append_pair(&k,&v);}}
            let mut headers:HeaderMap=parts.headers.clone();headers.remove("host");headers.remove("connection");
            // 该请求会携带服务商凭据，只转发到原先明确配置的目录，不输出请求头。
            let response=reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build()?.get(url).headers(headers).send().await?;if !response.status().is_success(){return Err(ApiError::new(502,"MODEL_CATALOG_UNAVAILABLE","Provider catalog request failed"));}response.json::<Value>().await?
        }else{catalog.clone()};
        let compatible=models::context_catalog(&source,&json!({"contextWindows":{},"autoCompactTokenLimits":{},"multiAgentReasoningEfforts":{}}),&catalog,false)?;
        Ok::<_,ApiError>(Some(if active{models::ultrafast_catalog(&compatible)?}else{compatible}))
    }.await;
    match result {
        Ok(Some(value)) => {
            let mut response = axum::Json(value).into_response();
            response
                .headers_mut()
                .insert("cache-control", "no-store".parse().unwrap());
            response
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => (StatusCode::BAD_GATEWAY, "Model catalog unavailable").into_response(),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, Write},
        os::unix::fs::PermissionsExt,
    };

    #[test]
    fn mock_app_server() {
        let Ok(root) = std::env::var("PANEL_ADAPTER_FIXTURE") else {
            return;
        };
        let config = std::path::Path::new(&root).join("config.json");
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else {
                break;
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(id) = message.get("id") else {
                continue;
            };
            let result = match message["method"].as_str().unwrap_or("") {
                "initialize" => json!({}),
                "config/read" => {
                    serde_json::from_slice::<Value>(&std::fs::read(&config).unwrap()).unwrap()
                }
                "config/batchWrite" => {
                    let mut current: Value =
                        serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
                    assert_eq!(message["params"]["expectedVersion"], "v1");
                    let edits = message["params"]["edits"].as_array().unwrap();
                    for edit in edits {
                        match edit["keyPath"].as_str().unwrap() {
                            "model_catalog_json" => {
                                for key in ["config", "user"] {
                                    let target = if key == "config" {
                                        &mut current["config"]
                                    } else {
                                        &mut current["layers"][0]["config"]
                                    };
                                    if edit["value"].is_null() {
                                        target
                                            .as_object_mut()
                                            .unwrap()
                                            .remove("model_catalog_json");
                                    } else {
                                        target["model_catalog_json"] = edit["value"].clone();
                                    }
                                }
                            }
                            "model_providers.\"custom\".model_catalog_url" => {
                                current["config"]["model_providers"]["custom"]
                                    ["model_catalog_url"] = edit["value"].clone();
                                current["layers"][0]["config"]["model_providers"]["custom"]
                                    ["model_catalog_url"] = edit["value"].clone();
                            }
                            key => panic!("Unexpected config mutation {key}"),
                        }
                    }
                    std::fs::write(&config, serde_json::to_vec(&current).unwrap()).unwrap();
                    json!({"status":"ok"})
                }
                method => panic!("Unexpected mock request {method}"),
            };
            println!("{}", json!({"id":id,"result":result}));
            std::io::stdout().flush().unwrap();
        }
    }

    #[tokio::test]
    async fn adapter_restores_only_owned_setting_and_serves_old_session() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let data = root.join("data");
        tokio::fs::create_dir(&data).await.unwrap();
        let preferences = root.join("preferences.json");
        save(&preferences, &json!({"customProviderUltrafast":true}))
            .await
            .unwrap();
        let catalog =
            json!({"models":[{"slug":"gpt-6-astra","context_window":1000,"service_tiers":[]}]});
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let served = catalog.clone();
        let upstream = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().fallback(move || {
                    let catalog = served.clone();
                    async move { axum::Json(catalog) }
                }),
            )
            .await
            .unwrap()
        });
        let original = format!("http://{address}/models");
        let config = json!({"config":{"model_provider":"custom","unrelated":"keep","model_providers":{"custom":{"model_catalog_url":original}}},"layers":[{"name":{"type":"user","file":root.join("config.toml")},"version":"v1","config":{"model_providers":{"custom":{"model_catalog_url":original}}}}]});
        save(&root.join("config.json"), &config).await.unwrap();
        let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
        let binary = root.join("codex-mock");
        let script=format!("#!/bin/sh\nPANEL_ADAPTER_FIXTURE={}\nexport PANEL_ADAPTER_FIXTURE\nexec {} --exact models_adapter::tests::mock_app_server --nocapture --format terse\n# {}\n",quote(&root.to_string_lossy()),quote(&std::env::current_exe().unwrap().to_string_lossy()),catalog);
        tokio::fs::write(&binary, script).await.unwrap();
        tokio::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .await
            .unwrap();
        let adapter = CatalogAdapter::new(binary, data.clone(), preferences.clone());
        adapter.sync().await.unwrap();
        let active = read(&root.join("config.json"), Value::Null).await.unwrap();
        let url = active["config"]["model_providers"]["custom"]["model_catalog_url"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(url.starts_with("http://127.0.0.1:"));
        assert_ne!(url, original);
        assert_eq!(active["config"]["unrelated"], "keep");
        let stored = read(&data.join("ultrafast-catalog.json"), Value::Null)
            .await
            .unwrap();
        assert_eq!(stored["providers"]["custom"]["restoreValue"], original);
        let value: Value = reqwest::get(&url).await.unwrap().json().await.unwrap();
        assert!(value["models"][0]["service_tiers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tier| tier["id"] == "ultrafast"));
        save(&preferences, &json!({"customProviderUltrafast":false}))
            .await
            .unwrap();
        adapter.sync().await.unwrap();
        let restored = read(&root.join("config.json"), Value::Null).await.unwrap();
        assert_eq!(
            restored["config"]["model_providers"]["custom"]["model_catalog_url"],
            original
        );
        assert_eq!(restored["config"]["unrelated"], "keep");
        let value: Value = reqwest::get(&url).await.unwrap().json().await.unwrap();
        assert!(value["models"][0]["service_tiers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|tier| tier["id"] != "ultrafast"));
        save(&preferences, &json!({"customProviderUltrafast":true}))
            .await
            .unwrap();
        adapter.sync().await.unwrap();
        let mut edited = read(&root.join("config.json"), Value::Null).await.unwrap();
        edited["config"]["model_providers"]["custom"]["model_catalog_url"] =
            json!("https://user-changed.invalid/models");
        edited["layers"][0]["config"]["model_providers"]["custom"]["model_catalog_url"] =
            json!("https://user-changed.invalid/models");
        save(&root.join("config.json"), &edited).await.unwrap();
        save(&preferences, &json!({"customProviderUltrafast":false}))
            .await
            .unwrap();
        adapter.sync().await.unwrap();
        assert_eq!(
            read(&root.join("config.json"), Value::Null).await.unwrap()["config"]
                ["model_providers"]["custom"]["model_catalog_url"],
            "https://user-changed.invalid/models"
        );
        adapter.close().await;
        upstream.abort();
    }

    #[tokio::test]
    async fn official_catalog_preserves_auth_metadata_and_restores_owned_global_setting() {
        for (auth, explicit_provider, external) in [
            ("chatgpt", false, false),
            ("apiKey", true, false),
            ("chatgpt", true, true),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path();
            let data = root.join("data");
            tokio::fs::create_dir(&data).await.unwrap();
            let data = tokio::fs::canonicalize(data).await.unwrap();
            let preferences = root.join("preferences.json");
            save(&preferences, &json!({"customProviderUltrafast":true}))
                .await
                .unwrap();
            let source = json!({"source":"native-selected-auth","models":[
                {"slug":"gpt-6-astra","base_instructions":"exact source instructions","service_tiers":[{"id":"priority","name":"Existing fast","description":"keep me"}],"extra":{"capability":true}},
                {"slug":"gpt-other","base_instructions":"unchanged","service_tiers":[]}
            ]});
            save(&root.join("native-catalog.json"), &source)
                .await
                .unwrap();
            let original = root.join("original.json");
            if external {
                save(&original, &source).await.unwrap();
            }
            let mut config =
                json!({"auth_mode":auth,"cli_auth_credentials_store":"keyring","unrelated":"keep"});
            if explicit_provider {
                config["model_provider"] = json!("openai");
            }
            if external {
                config["model_catalog_json"] = json!(original);
            }
            let response = json!({"config":config,"layers":[{"name":{"type":"user","file":root.join("config.toml")},"version":"v1","config":config}]});
            save(&root.join("config.json"), &response).await.unwrap();
            let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
            let binary = root.join("codex-mock");
            let script=format!("#!/bin/sh\nif [ \"$1\" = debug ]; then /bin/cat {}; exit 0; fi\nPANEL_ADAPTER_FIXTURE={}\nexport PANEL_ADAPTER_FIXTURE\nexec {} --exact models_adapter::tests::mock_app_server --nocapture --format terse\n# {}\n",quote(&root.join("native-catalog.json").to_string_lossy()),quote(&root.to_string_lossy()),quote(&std::env::current_exe().unwrap().to_string_lossy()),source);
            tokio::fs::write(&binary, script).await.unwrap();
            tokio::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
                .await
                .unwrap();
            let adapter = CatalogAdapter::new(binary.clone(), data.clone(), preferences.clone());
            adapter.sync().await.unwrap();
            let active = read(&root.join("config.json"), Value::Null).await.unwrap();
            let generated = PathBuf::from(active["config"]["model_catalog_json"].as_str().unwrap());
            assert!(generated.starts_with(&data));
            assert_ne!(generated, original);
            assert_eq!(active["config"]["auth_mode"], auth);
            assert_eq!(active["config"]["model_provider"], config["model_provider"]);
            assert!(active["config"].get("model_providers").is_none());
            let output = read(&generated, Value::Null).await.unwrap();
            assert_eq!(output["source"], source["source"]);
            assert_eq!(
                output["models"][0]["base_instructions"],
                source["models"][0]["base_instructions"]
            );
            assert_eq!(output["models"][0]["extra"], source["models"][0]["extra"]);
            assert_eq!(
                output["models"][0]["service_tiers"][0],
                source["models"][0]["service_tiers"][0]
            );
            assert!(output["models"][0]["service_tiers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tier| tier["id"] == "ultrafast"));
            assert_eq!(output["models"][1], source["models"][1]);
            if external {
                assert_eq!(read(&original, Value::Null).await.unwrap(), source);
            }
            let contexts =
                models::context_settings(&binary, &data, root, false, None, Some(&preferences))
                    .await
                    .unwrap();
            assert_eq!(
                contexts["models"].as_array().unwrap().len(),
                2,
                "managed source must remain a valid full catalog"
            );
            assert_eq!(
                read(&root.join("config.json"), Value::Null).await.unwrap(),
                active
            );
            adapter.close().await;
            // 重启适配器后仍识别自己的文件，关闭时恢复启用前的路径或缺省值。
            let adapter = CatalogAdapter::new(binary, data.clone(), preferences.clone());
            adapter.sync().await.unwrap();
            save(&preferences, &json!({"customProviderUltrafast":false}))
                .await
                .unwrap();
            adapter.sync().await.unwrap();
            assert_eq!(
                read(&root.join("config.json"), Value::Null).await.unwrap()["config"],
                config
            );
            assert_eq!(read(&generated, Value::Null).await.unwrap(), source);
            save(&preferences, &json!({"customProviderUltrafast":true}))
                .await
                .unwrap();
            adapter.sync().await.unwrap();
            assert!(
                read(&generated, Value::Null).await.unwrap()["models"][0]["service_tiers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tier| tier["id"] == "ultrafast")
            );
            let mut user_changed = read(&root.join("config.json"), Value::Null).await.unwrap();
            user_changed["config"]["model_catalog_json"] = json!(original);
            user_changed["layers"][0]["config"]["model_catalog_json"] = json!(original);
            save(&root.join("config.json"), &user_changed)
                .await
                .unwrap();
            save(&preferences, &json!({"customProviderUltrafast":false}))
                .await
                .unwrap();
            adapter.sync().await.unwrap();
            assert_eq!(
                read(&root.join("config.json"), Value::Null).await.unwrap()["config"]
                    ["model_catalog_json"],
                json!(original)
            );
            adapter.close().await;
        }
    }
}
