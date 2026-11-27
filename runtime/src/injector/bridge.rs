use super::{cdp::Connection, config::Environment, processes};
use crate::ApiError;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const FIND_REQUIRE: &str = include_str!("assets/find_require.js");
const APP_SERVER: &str = include_str!("assets/app_server_0.js");
const AUTOMATION: &str = include_str!("assets/automation_0.js");
const STATUS: &str = include_str!("assets/injection_status_0.js");

fn substitute(source: &str, values: &[(&str, Value)]) -> String {
    let mut source = source.replace("__FIND_REQUIRE__", FIND_REQUIRE);
    for (key, value) in values {
        source = source.replace(&format!("__JSON_{key}__"), &value.to_string());
    }
    source
}

pub async fn rpc(
    cdp: &Connection,
    host: &str,
    method: &str,
    params: Value,
    timeout_ms: u64,
) -> Result<Value, ApiError> {
    if host.is_empty() || host.len() > 256 || method.is_empty() || method.len() > 256 {
        return Err(ApiError::new(
            400,
            "HOST_RPC",
            "Invalid native host or method",
        ));
    }
    let source = substitute(
        APP_SERVER,
        &[
            (
                "requestId",
                json!(format!("panel-thread-{}", uuid::Uuid::new_v4())),
            ),
            ("hostId", json!(host)),
            ("method", json!(method)),
            ("params", params),
            ("timeoutMs", json!(timeout_ms)),
        ],
    );
    let response = cdp
        .send_timeout(
            "Runtime.evaluate",
            json!({"expression":source,"returnByValue":true,"awaitPromise":true}),
            Duration::from_millis(timeout_ms + 1000),
        )
        .await?;
    if let Some(error) = response.get("exceptionDetails") {
        return Err(ApiError::new(
            502,
            "HOST_RPC",
            error["exception"]["description"]
                .as_str()
                .unwrap_or("Native host evaluation failed"),
        ));
    }
    let result = &response["result"]["value"];
    if result["ok"] != true {
        return Err(ApiError::new(
            502,
            "HOST_RPC",
            result["error"]
                .as_str()
                .unwrap_or("Codex App Server request failed"),
        )
        .with_details(result.clone()));
    }
    Ok(result["result"].clone())
}

pub async fn automation(cdp: &Connection, method: &str, params: Value) -> Result<Value, ApiError> {
    if !matches!(
        method,
        "list-automations"
            | "automation-create"
            | "automation-update"
            | "automation-run-now"
            | "inbox-items"
    ) {
        return Err(ApiError::new(
            400,
            "AUTOMATION_METHOD",
            "Unsupported native automation method",
        ));
    }
    let source = substitute(
        AUTOMATION,
        &[
            (
                "requestId",
                json!(format!("panel-automation-{}", uuid::Uuid::new_v4())),
            ),
            ("method", json!(method)),
            ("params", params),
        ],
    )
    .replace("__METHOD_PATH__", method);
    let result = cdp.evaluate(&source, None).await?;
    let status = result["status"].as_u64().unwrap_or(0);
    if result["ok"] != true || !(200..300).contains(&status) {
        return Err(ApiError::new(
            502,
            "AUTOMATION_RPC",
            result["error"]
                .as_str()
                .unwrap_or("Native automation request failed"),
        ));
    }
    match result["bodyJsonString"].as_str().filter(|s| !s.is_empty()) {
        Some(body) => Ok(serde_json::from_str(body)?),
        None => Ok(json!({})),
    }
}

pub async fn status(cdp: &Connection) -> Result<Value, ApiError> {
    cdp.evaluate(STATUS, None).await
}

pub fn ready(value: &Value, hash: &str, token: Option<&str>) -> bool {
    let age = chrono::Utc::now().timestamp_millis() - value["heartbeatAt"].as_i64().unwrap_or(0);
    value["sourceHash"] == hash
        && value["startupToken"].as_str() == token
        && value["entryMounted"] == true
        && (0..=5000).contains(&age)
}

pub async fn install(cdp: &Connection, environment: &Environment) -> Result<i64, ApiError> {
    cdp.send("Runtime.enable", json!({})).await?;
    cdp.send("Page.enable", json!({})).await?;
    // 私有 iframe 继承 Codex 的 CSP；须在写入 Panel 文档前恢复原注入器的绕过设置，模块脚本才能加载。
    cdp.send("Page.setBypassCSP", json!({"enabled":true}))
        .await?;
    let tree = cdp.send("Page.getFrameTree", json!({})).await?;
    let world = cdp
        .send(
            "Page.createIsolatedWorld",
            json!({"frameId":tree["frameTree"]["frame"]["id"],"worldName":"codex-panel-host"}),
        )
        .await?;
    let context = world["executionContextId"]
        .as_i64()
        .ok_or_else(|| ApiError::new(502, "HOST_CONTEXT", "Codex returned no isolated world"))?;
    for name in ["__codexPanelHostV1", "__codexPanelCodexNotificationV1"] {
        cdp.send(
            "Runtime.addBinding",
            json!({"name":name,"executionContextId":context}),
        )
        .await?;
    }
    cdp.send(
        "Runtime.addBinding",
        json!({"name":"__codexPanelPlayPetAudioV1"}),
    )
    .await?;
    let source=r#"(() => {
        const capability=__CAPABILITY__;
        if(globalThis.__codexPanelIsolatedBridgeV1===capability)return;
        globalThis.__codexPanelIsolatedBridgeV1=capability;
        window.addEventListener('message',event=>{
            if(globalThis.__codexPanelIsolatedBridgeV1!==capability)return;
            const message=event.data;if(!message||typeof message!=='object')return;
            if(message.type==='mcp-notification'&&typeof message.hostId==='string'&&typeof message.method==='string') {
                globalThis.__codexPanelCodexNotificationV1(JSON.stringify({hostId:message.hostId,method:message.method,params:message.params}));return;
            }
            if(event.source!==window||event.origin!==location.origin||message.type!=='__codexPanelHostRequestV1'||message.capability!==capability)return;
            globalThis.__codexPanelHostV1(JSON.stringify(message.payload));
        });
    })()"#.replace("__CAPABILITY__",&json!(environment.capability).to_string());
    cdp.evaluate(&source, Some(context)).await?;
    Ok(context)
}

pub async fn heartbeat(
    cdp: &Connection,
    context: i64,
    environment: &Environment,
    startup: Option<&str>,
) -> Result<(), ApiError> {
    let preferences = match &environment.preferences_file {
        Some(path) => match tokio::fs::read(path).await {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        },
        None => Value::Null,
    };
    let mut message = json!({"type":"__codexPanelHostHeartbeatV1","capability":environment.capability,
        "at":chrono::Utc::now().timestamp_millis(),"startupToken":startup,
        "hideUsageBanner":preferences["hideUsageBanner"]==true,"showThreadUsage":preferences["showThreadUsage"]!=false,
        "threadUsageAboveComposer":preferences["threadUsageAboveComposer"]==true,"usageDotMatrix":preferences["usageDotMatrix"]!=false,
        "usageAnimationMode":if preferences["usageAnimationMode"]=="morph" {"morph"}else{"smooth"},
        "usageAnimationMinSpeed":preferences.get("usageAnimationMinSpeed").cloned().unwrap_or(json!(5)),
        "usageAnimationMaxSpeed":preferences.get("usageAnimationMaxSpeed").cloned().unwrap_or(json!(40)),
        "customProviderQuotaFix":preferences["customProviderQuotaFix"]==true,"customProviderUltrafast":preferences["customProviderUltrafast"]==true,
        "showCustomProviderDot":preferences["showCustomProviderDot"]==true,"defaultProjectlessChat":preferences["defaultProjectlessChat"]==true,
        "nativeSettingsMode":"system","terminalLayout":"bottom"});
    if matches!(
        preferences["nativeSettingsMode"].as_str(),
        Some("dialog" | "page")
    ) {
        message["nativeSettingsMode"] = preferences["nativeSettingsMode"].clone();
    }
    if matches!(preferences["terminalLayout"].as_str(), Some("system" | "bottom" | "right")) {
        message["terminalLayout"] = preferences["terminalLayout"].clone();
    }
    cdp.evaluate(
        &format!("window.postMessage({},window.location.origin)", message),
        Some(context),
    )
    .await?;
    Ok(())
}

pub async fn response(
    cdp: &Connection,
    context: i64,
    environment: &Environment,
    response: Value,
) -> Result<(), ApiError> {
    let message = json!({"type":"__codexPanelHostResponseV1","capability":environment.capability,"response":response});
    cdp.evaluate(
        &format!("window.postMessage({},window.location.origin)", message),
        Some(context),
    )
    .await?;
    Ok(())
}

pub async fn health(client: &reqwest::Client, environment: &Environment) -> Result<(), ApiError> {
    let challenge = hex::encode(uuid::Uuid::new_v4().as_bytes());
    let response = client
        .get(format!("{}/health", environment.origin()))
        .header("x-codex-panel-challenge", &challenge)
        .send()
        .await?;
    let body: Value = response.error_for_status()?.json().await?;
    if body["status"] != "ok" {
        return Err(ApiError::new(
            502,
            "PANEL_HEALTH",
            "Panel service is not ready",
        ));
    }
    if let Some(secret) = &environment.secret {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
            .map_err(|_| ApiError::new(500, "PANEL_IDENTITY", "Invalid Panel secret"))?;
        mac.update(challenge.as_bytes());
        let proof = body["proof"]
            .as_str()
            .and_then(|s| hex::decode(s).ok())
            .ok_or_else(|| {
                ApiError::new(502, "PANEL_IDENTITY", "Panel service proof is missing")
            })?;
        if mac.verify_slice(&proof).is_err()
            || body["product"] != "codex-panel"
            || body["version"] != environment.version
        {
            return Err(ApiError::new(
                502,
                "PANEL_IDENTITY",
                "Panel service identity check failed",
            ));
        }
    }
    Ok(())
}

async fn panel_api(
    client: &reqwest::Client,
    environment: &Environment,
    path: &str,
    body: Value,
) -> Result<Value, ApiError> {
    let response = client
        .post(format!("{}{path}", environment.base_url()))
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    let value: Value = response.json().await?;
    if !status.is_success() {
        return Err(ApiError::new(
            status.as_u16(),
            "PANEL_API",
            value["error"]["message"]
                .as_str()
                .unwrap_or("Panel request failed"),
        ));
    }
    Ok(value)
}

fn find_frame<'a>(tree: &'a Value, name: &str) -> Option<&'a Value> {
    if tree["frame"]["name"] == name {
        return Some(&tree["frame"]);
    }
    tree["childFrames"]
        .as_array()?
        .iter()
        .find_map(|child| find_frame(child, name))
}

async fn load_frame(
    cdp: &Connection,
    client: &reqwest::Client,
    environment: &Environment,
    request: &Value,
) -> Result<Value, ApiError> {
    let secret = environment.secret.as_ref().ok_or_else(|| {
        ApiError::new(
            403,
            "PANEL_FRAME",
            "Private Panel frame loading is not configured",
        )
    })?;
    let challenge = hex::encode(uuid::Uuid::new_v4().as_bytes());
    let response = client
        .get(environment.page_url())
        .header("origin", "app://-")
        .header("x-codex-panel-challenge", &challenge)
        .send()
        .await?
        .error_for_status()?;
    let proof = response
        .headers()
        .get("x-codex-panel-proof")
        .and_then(|s| s.to_str().ok())
        .and_then(|s| hex::decode(s).ok())
        .ok_or_else(|| {
            ApiError::new(
                502,
                "PANEL_IDENTITY",
                "Panel document identity proof missing",
            )
        })?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| ApiError::new(500, "PANEL_IDENTITY", "Invalid Panel secret"))?;
    mac.update(challenge.as_bytes());
    mac.verify_slice(&proof).map_err(|_| {
        ApiError::new(
            502,
            "PANEL_IDENTITY",
            "Panel document identity check failed",
        )
    })?;
    let html = response.text().await?;
    if !html.contains("<head>") {
        return Err(ApiError::new(
            502,
            "PANEL_FRAME",
            "Panel document has no head element",
        ));
    }
    let html = html.replacen(
        "<head>",
        &format!(
            "<head><base href={}><script>globalThis.__CODEX_PANEL_FRAME_CAPABILITY__={};</script>",
            json!(environment.page_url()),
            request["frameCapability"]
        ),
        1,
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let tree = cdp.send("Page.getFrameTree", json!({})).await?;
        if let Some(frame) = find_frame(
            &tree["frameTree"],
            request["frameName"].as_str().unwrap_or(""),
        ) {
            cdp.send(
                "Page.setDocumentContent",
                json!({"frameId":frame["id"],"html":html}),
            )
            .await?;
            return Ok(json!({"loaded":true}));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(ApiError::new(
        504,
        "PANEL_FRAME",
        "Timed out waiting for isolated Panel frame",
    ))
}

pub async fn handle(
    cdp: &Connection,
    context: i64,
    environment: &Environment,
    client: &reqwest::Client,
    request: Value,
    policies: &std::sync::Arc<crate::automation::PolicyManager>,
) -> Result<Value, ApiError> {
    validate_request(&request)?;
    match request["action"].as_str().unwrap_or("") {
        "ensure" => {
            health(client, environment).await?;
            Ok(json!({"ready":true}))
        }
        "read-current-user" => {
            let mut account = rpc(
                cdp,
                "local",
                "account/read",
                json!({"refreshToken":false}),
                30000,
            )
            .await?;
            if account["account"]["type"] == "chatgpt"
                && account["account"]["email"]
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
            {
                account = rpc(
                    cdp,
                    "local",
                    "account/read",
                    json!({"refreshToken":true}),
                    30000,
                )
                .await?;
            }
            let email = if account["account"]["type"] == "chatgpt" {
                account["account"]["email"]
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .to_lowercase()
            } else {
                String::new()
            };
            let id = if email.is_empty() {
                String::new()
            } else {
                format!(
                    "codex-user-{}",
                    hex::encode(Sha256::digest(
                        format!("codex-taskboard-user\0{email}").as_bytes()
                    ))
                )
            };
            Ok(json!({"userId":id}))
        }
        "load-frame" => load_frame(cdp, client, environment, &request).await,
        "read-thread-usage" => read_usage(cdp, text(&request, "threadId")?).await,
        "open-external" => {
            processes::open_external(text(&request, "url")?, false).await?;
            Ok(json!({"opened":true}))
        }
        "open-attachment" => open_attachment(client, environment, &request).await,
        "next-native-claim" => {
            panel_api(
                client,
                environment,
                "/api/local/native-claims/next",
                json!({}),
            )
            .await
        }
        "bind-native-claim" => {
            panel_api(
                client,
                environment,
                "/api/local/native-claims/bind",
                request.clone(),
            )
            .await
        }
        "fail-native-claim" => {
            panel_api(
                client,
                environment,
                "/api/local/native-claims/fail",
                request.clone(),
            )
            .await
        }
        "find-task-conversations" => find_conversations(cdp, &request).await,
        "confirm-task-conversation" => confirm_conversation(cdp, &request).await,
        "prefill-task-composer" => prefill(cdp, context, &request).await,
        "start-task-conversation" => start_conversation(cdp, context, &request).await,
        "automation" => policies.handle(request, native_automation_rpc(cdp)).await,
        _ => Err(ApiError::new(
            400,
            "HOST_REQUEST",
            "Unsupported Panel host request",
        )),
    }
}

fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str, ApiError> {
    value[name]
        .as_str()
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 4_000_000)
        .ok_or_else(|| invalid_request(format!("Invalid {name}")))
}

fn invalid_request(message: impl Into<String>) -> ApiError {
    ApiError::new(400, "HOST_REQUEST", message)
}

fn bounded(
    value: &Value,
    name: &str,
    min: usize,
    max: usize,
    controls: bool,
) -> Result<(), ApiError> {
    let value = value[name]
        .as_str()
        .ok_or_else(|| invalid_request(format!("Invalid {name}")))?;
    // 宿主原协议按 JavaScript UTF-16 长度计数，避免中文和 emoji 被字节长度误拒绝。
    let length = value.encode_utf16().count();
    if !(min..=max).contains(&length)
        || (controls && value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}'))
    {
        return Err(invalid_request(format!("Invalid {name}")));
    }
    Ok(())
}

fn optional_text(
    value: &Value,
    name: &str,
    min: usize,
    max: usize,
    controls: bool,
) -> Result<(), ApiError> {
    if value.get(name).is_some() {
        bounded(value, name, min, max, controls)?;
    }
    Ok(())
}

fn skill_reference(skill: &Value) -> Result<(), ApiError> {
    if !skill.is_object() {
        return Err(invalid_request("Invalid Skill reference"));
    }
    bounded(skill, "name", 1, 256, false)?;
    bounded(skill, "displayName", 1, 1024, false)?;
    bounded(skill, "path", 1, 1024, false)?;
    if !regex::Regex::new(r"(?i)^[a-z0-9_-]+(?::[a-z0-9_-]+)?$")
        .unwrap()
        .is_match(text(skill, "name")?)
    {
        return Err(invalid_request("Invalid Skill name"));
    }
    Ok(())
}

fn skill_list(value: &Value, minimum: usize) -> Result<(), ApiError> {
    let skills = value
        .as_array()
        .filter(|skills| (minimum..=41).contains(&skills.len()))
        .ok_or_else(|| invalid_request("Invalid Skill list"))?;
    for skill in skills {
        skill_reference(skill)?;
    }
    Ok(())
}

fn validate_request(request: &Value) -> Result<(), ApiError> {
    if !request.is_object() || !super::config::identifier(text(request, "id")?, 80) {
        return Err(invalid_request(
            "Panel 与 Codex 宿主协议不匹配，请重启 Codex Panel 后重试",
        ));
    }
    match text(request, "action")? {
        "ensure" | "read-current-user" | "next-native-claim" => {}
        "read-thread-usage" => {
            uuid::Uuid::parse_str(text(request, "threadId")?)
                .map_err(|_| invalid_request("Invalid thread id"))?;
        }
        "load-frame" => {
            let name = text(request, "frameName")?;
            let capability = text(request, "frameCapability")?;
            if !regex::Regex::new(r"(?i)^codex-(?:panel|taskboard)-[a-f0-9-]{36,80}$")
                .unwrap()
                .is_match(name)
                || !regex::Regex::new(r"(?i)^[a-f0-9-]{36,80}$")
                    .unwrap()
                    .is_match(capability)
            {
                return Err(invalid_request("Invalid isolated frame capability"));
            }
        }
        "open-external" => {
            let url = url::Url::parse(text(request, "url")?)
                .map_err(|_| invalid_request("Invalid external URL"))?;
            if url.as_str().encode_utf16().count() > 2048
                || !matches!(url.scheme(), "http" | "https")
            {
                return Err(invalid_request("Invalid external URL"));
            }
        }
        "open-attachment" => {
            uuid::Uuid::parse_str(text(request, "attachmentId")?)
                .map_err(|_| invalid_request("Invalid attachment id"))?;
            bounded(request, "filename", 1, 240, true)?;
            let name = text(request, "filename")?;
            if name == "." || name == ".." || name.contains(['/', '\\']) {
                return Err(invalid_request("Invalid attachment filename"));
            }
            if request.get("operation").is_some()
                && !matches!(request["operation"].as_str(), Some("local-path" | "reveal"))
            {
                return Err(invalid_request("Invalid attachment operation"));
            }
        }
        "find-task-conversations" => {
            for name in ["codexHostId", "identifier"] {
                bounded(request, name, 1, 240, true)?;
            }
        }
        "confirm-task-conversation" => {
            for name in ["codexHostId", "threadId", "identifier"] {
                bounded(request, name, 1, 240, true)?;
            }
            bounded(request, "targetRoot", 0, 4096, false)?;
            optional_text(request, "title", 1, 240, true)?;
            if request.get("executionPreparation").is_some()
                && !request["executionPreparation"].is_boolean()
            {
                return Err(invalid_request("Invalid execution preparation"));
            }
            if request["executionPreparation"] == true {
                if request["codexHostId"] != "local" || !request["useWorktree"].is_boolean() {
                    return Err(invalid_request("Invalid local execution preparation"));
                }
                bounded(request, "codexProjectId", 1, 240, true)?;
                if !request["previousTurnId"].is_null() {
                    bounded(request, "previousTurnId", 1, 240, false)?;
                }
            }
        }
        "start-task-conversation" => {
            bounded(request, "taskId", 1, 128, true)?;
            bounded(request, "previousThreadId", 0, 240, false)?;
            bounded(request, "codexHostId", 1, 240, true)?;
            if !request["projectless"].is_boolean() {
                return Err(invalid_request("Invalid projectless flag"));
            }
            if request["projectless"] != true {
                bounded(request, "targetRoot", 1, 4096, false)?;
            }
            bounded(request, "instruction", 1, 4_000_000, false)?;
            bounded(request, "title", 1, 240, false)?;
            optional_text(request, "codexProjectId", 1, 240, false)?;
            if request.get("useWorktree").is_some() && !request["useWorktree"].is_boolean() {
                return Err(invalid_request("Invalid worktree flag"));
            }
            if request.get("collaborationMode").is_some()
                && request["collaborationMode"] != "default"
            {
                return Err(invalid_request("Invalid collaboration mode"));
            }
            if request.get("threadId").is_some() {
                if !super::config::identifier(text(request, "threadId")?, 128) {
                    return Err(invalid_request("Invalid continuation thread"));
                }
                skill_list(&request["skills"], 0)?;
            }
        }
        "prefill-task-composer" => {
            optional_text(request, "threadId", 1, 240, true)?;
            bounded(request, "instruction", 1, 16384, false)?;
            if let Some(skills) = request.get("skills") {
                skill_list(skills, 1)?;
            } else {
                skill_reference(
                    &json!({"name":request["skillName"],"displayName":request["skillDisplayName"],"path":request["skillPath"]}),
                )?;
            }
        }
        "bind-native-claim" => {
            bounded(request, "taskId", 1, 128, false)?;
            uuid::Uuid::parse_str(text(request, "reservationId")?)
                .map_err(|_| invalid_request("Invalid reservation"))?;
            let binding = &request["threadBinding"];
            for name in ["threadId", "codexProjectId"] {
                bounded(binding, name, 1, 240, false)?;
            }
            bounded(binding, "workspacePath", 1, 4096, false)?;
            if binding["codexProjectKind"] != "local" || binding["codexHostId"] != "local" {
                return Err(invalid_request(
                    "Native claim must bind a local conversation",
                ));
            }
            let context = &request["developmentContext"];
            if !context.is_null() {
                if !context.is_object() {
                    return Err(invalid_request("Invalid development context"));
                }
                match context["type"].as_str() {
                    Some("worktree") => {
                        bounded(context, "path", 1, 4096, false)?;
                        if !context["branch"].is_null() {
                            bounded(context, "branch", 0, 512, false)?;
                        } else if context.get("branch").is_none() {
                            return Err(invalid_request("Missing worktree branch"));
                        }
                    }
                    Some("branch") => bounded(context, "branch", 1, 512, false)?,
                    _ => return Err(invalid_request("Invalid development context")),
                }
            }
        }
        "fail-native-claim" => {
            bounded(request, "taskId", 1, 128, false)?;
            bounded(request, "error", 1, 4096, false)?;
            uuid::Uuid::parse_str(text(request, "reservationId")?)
                .map_err(|_| invalid_request("Invalid reservation"))?;
        }
        "automation" => crate::automation::validate(request).map_err(|mut error| {
            error.code = "AUTOMATION_SCHEMA_MISMATCH".into();
            error
        })?,
        _ => return Err(invalid_request("Unsupported Panel host request")),
    }
    Ok(())
}

async fn open_attachment(
    client: &reqwest::Client,
    environment: &Environment,
    request: &Value,
) -> Result<Value, ApiError> {
    let directory = environment
        .data_dir
        .join("opened-attachments")
        .join(text(request, "attachmentId")?);
    let path = directory.join(text(request, "filename")?);
    let operation = request["operation"].as_str();
    if operation.is_some() {
        if tokio::fs::metadata(&path).await.is_ok_and(|s| s.is_file()) {
            if operation == Some("reveal") {
                processes::open_external(&path.to_string_lossy(), true).await?;
            }
            return Ok(json!({"localPath":path,"opened":operation==Some("reveal")}));
        }
        if operation == Some("reveal") {
            return Err(ApiError::new(
                404,
                "ATTACHMENT_LOCAL",
                "No device-local attachment copy is available",
            ));
        }
        let session: Value = client
            .get(format!(
                "{}/api/local/cloud-session",
                environment.base_url()
            ))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if session["mode"] != "local" {
            return Ok(json!({"localPath":null}));
        }
    }
    let response = client
        .get(format!(
            "{}/api/attachments/{}/content",
            environment.base_url(),
            text(request, "attachmentId")?
        ))
        .send()
        .await?
        .error_for_status()?;
    let bytes = response.bytes().await?;
    tokio::fs::create_dir_all(&directory).await?;
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&path).await?;
    tokio::io::AsyncWriteExt::write_all(&mut file, &bytes).await?;
    drop(file);
    if operation == Some("local-path") {
        return Ok(json!({"localPath":path}));
    }
    processes::open_external(&path.to_string_lossy(), true).await?;
    Ok(json!({"localPath":path,"opened":true}))
}

async fn read_usage(cdp: &Connection, id: &str) -> Result<Value, ApiError> {
    let thread = rpc(
        cdp,
        "local",
        "thread/read",
        json!({"threadId":id,"includeTurns":false}),
        3000,
    )
    .await?;
    if thread["thread"]["id"] != id {
        return Ok(json!({"usage":null}));
    }
    let Some(path) = thread["thread"]["path"].as_str() else {
        return Ok(json!({"usage":null}));
    };
    let path = tokio::fs::canonicalize(path).await?;
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let pattern = regex::Regex::new(&format!(
        r"(?i)-{}(?:_[a-f0-9]{{8}}(?:-[a-f0-9]{{4}}){{3}}-[a-f0-9]{{12}})?\.jsonl$",
        regex::escape(id)
    ))
    .unwrap();
    if !pattern.is_match(name) {
        return Err(ApiError::new(403, "USAGE_PATH", "会话日志路径不匹配"));
    }
    let mut file = tokio::fs::File::open(path).await?;
    let metadata = file.metadata().await?;
    if !metadata.is_file() {
        return Err(ApiError::new(400, "USAGE_PATH", "会话日志不是普通文件"));
    }
    for limit in [512 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024] {
        let size = metadata.len().min(limit);
        let start = metadata.len() - size;
        file.seek(std::io::SeekFrom::Start(start)).await?;
        let mut bytes = vec![0; size as usize];
        file.read_exact(&mut bytes).await?;
        let text = String::from_utf8_lossy(&bytes);
        let text = if start > 0 {
            text.split_once('\n').map(|(_, tail)| tail).unwrap_or("")
        } else {
            &text
        };
        let text = text.rsplit_once('\n').map(|(head, _)| head).unwrap_or("");
        let usage = summarize_usage(text, chrono::Utc::now().timestamp_millis());
        if usage["partial"] == false || start == 0 || limit == 8 * 1024 * 1024 {
            return Ok(json!({"usage":usage}));
        }
    }
    unreachable!()
}

pub fn summarize_usage(text: &str, now: i64) -> Value {
    let mut turn = Value::Null;
    let mut started = Value::Null;
    let mut ended = Value::Null;
    let mut observed = Value::Null;
    let (mut input, mut cached, mut tokens) = (0i64, 0i64, 0i64);
    let mut previous = Value::Null;
    let mut progress = false;
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let event = &record["payload"];
        let at = record["timestamp"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis());
        if record["type"] == "event_msg"
            && matches!(
                event["type"].as_str(),
                Some("task_started" | "turn_started")
            )
        {
            turn = event["turn_id"].clone();
            started = json!(at);
            ended = Value::Null;
            observed = Value::Null;
            input = 0;
            cached = 0;
            tokens = 0;
            progress = true;
            continue;
        }
        if record["type"] == "turn_context"
            && event["turn_id"].is_string()
            && event["turn_id"] != turn
        {
            turn = event["turn_id"].clone();
            started = Value::Null;
            ended = Value::Null;
            observed = Value::Null;
            input = 0;
            cached = 0;
            tokens = 0;
            progress = true;
            continue;
        }
        if record["type"] == "event_msg"
            && matches!(
                event["type"].as_str(),
                Some("task_complete" | "turn_aborted")
            )
        {
            if event["turn_id"].is_null() || turn.is_null() || event["turn_id"] == turn {
                progress = false;
                ended = json!(at);
            }
            continue;
        }
        if record["type"] != "event_msg" || event["type"] != "token_count" || at.is_none() {
            continue;
        }
        let last = &event["info"]["last_token_usage"];
        let total = &event["info"]["total_token_usage"];
        if last.is_null() || total.is_null() {
            continue;
        }
        if previous["output_tokens"] == total["output_tokens"]
            && previous["total_tokens"] == total["total_tokens"]
            && !previous.is_null()
        {
            continue;
        }
        if started.is_null() {
            input = 0;
            cached = 0;
            tokens = 0;
            ended = Value::Null;
        }
        tokens += last["output_tokens"]
            .as_i64()
            .filter(|n| *n >= 0)
            .unwrap_or(0);
        let n = last["input_tokens"].as_i64().unwrap_or(0);
        let c = last["cached_input_tokens"].as_i64().unwrap_or(-1);
        if n > 0 && c >= 0 {
            input += n;
            cached += c.min(n);
        }
        previous = total.clone();
        observed = json!(at);
    }
    let elapsed = started
        .as_i64()
        .map(|start| {
            ((if progress {
                now
            } else {
                ended.as_i64().unwrap_or(start)
            }) - start) as f64
                / 1000.0
        })
        .unwrap_or(0.0);
    json!({"speed":if tokens>0&&elapsed>0.0{Some(tokens as f64/elapsed)}else{None},
        "cache":if input>0{Some(cached as f64/input as f64*100.0)}else{None},"outputTokens":tokens,"inputTokens":input,"cachedInputTokens":cached,
        "totalTokens":previous["total_tokens"],"turnId":turn,"startedAt":started,"endedAt":ended,"observedAt":observed,"partial":turn.is_null()||started.is_null(),"inProgress":progress})
}

async fn find_conversations(cdp: &Connection, request: &Value) -> Result<Value, ApiError> {
    let host = text(request, "codexHostId")?;
    let identifier = text(request, "identifier")?;
    let pattern = regex::Regex::new(&format!(
        r"(^|[^A-Za-z0-9-]){}($|[^A-Za-z0-9-])",
        regex::escape(identifier)
    ))
    .unwrap();
    let mut cursor = Value::Null;
    let mut matches = Vec::new();
    loop {
        let page=rpc(cdp,host,"thread/list",json!({"cursor":cursor,"limit":50,"sortKey":"created_at","sortDirection":"desc","searchTerm":identifier}),10000).await?;
        for summary in page["data"].as_array().into_iter().flatten() {
            let Some(id) = summary["id"].as_str().filter(|id| !id.is_empty()) else {
                continue;
            };
            let result = rpc(
                cdp,
                host,
                "thread/read",
                json!({"threadId":id,"includeTurns":true}),
                10000,
            )
            .await?;
            if result["thread"]["id"] != id
                || !pattern.is_match(&first_user_text(&result["thread"]))
            {
                continue;
            }
            matches.push(json!({"threadId":id,"name":summary["name"].as_str().unwrap_or(""),"cwd":result["thread"]["cwd"].as_str().unwrap_or(""),"createdAt":summary["createdAt"]}));
            if matches.len() >= 2 {
                return Ok(json!({"matches":matches}));
            }
        }
        cursor = page["nextCursor"].clone();
        if !cursor.as_str().is_some_and(|s| !s.is_empty()) {
            return Ok(json!({"matches":matches}));
        }
    }
}

fn first_user_text(thread: &Value) -> String {
    thread["turns"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|turn| turn["items"].as_array().into_iter().flatten())
        .find(|item| item["type"] == "userMessage")
        .map(|item| {
            item["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|content| content["type"] == "text")
                .filter_map(|content| content["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn normalize_root(value: &str) -> String {
    let value = value.trim();
    let windows = value.contains('\\');
    let normalized = if windows {
        value.replace('\\', "/")
    } else {
        value.to_owned()
    };
    let mut normalized = normalized.trim_end_matches('/').to_owned();
    if normalized.is_empty() && value.starts_with('/') {
        normalized.push('/');
    }
    if normalized.as_bytes().get(1) == Some(&b':') && normalized.as_bytes()[0].is_ascii_alphabetic()
    {
        normalized.replace_range(0..1, &normalized[..1].to_ascii_lowercase());
    }
    normalized
}

async fn git_value(workspace: &str, args: &[&str]) -> Result<String, ApiError> {
    let output = processes::command("git")
        .args(["-C", workspace])
        .args(args)
        .output()
        .await?;
    if !output.status.success() {
        return Err(ApiError::new(
            409,
            "WORKTREE",
            String::from_utf8_lossy(&output.stderr).trim(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

async fn development_context(
    workspace: &str,
    target: Option<&str>,
    worktree: bool,
) -> Result<Value, ApiError> {
    let root = git_value(workspace, &["rev-parse", "--show-toplevel"]).await?;
    if let Some(target) = target.filter(|target| !target.is_empty()) {
        let common =
            Path::new(&root).join(git_value(&root, &["rev-parse", "--git-common-dir"]).await?);
        let target_common =
            Path::new(target).join(git_value(target, &["rev-parse", "--git-common-dir"]).await?);
        if tokio::fs::canonicalize(common).await? != tokio::fs::canonicalize(target_common).await? {
            return Err(ApiError::new(
                409,
                "WORKTREE",
                "Codex created the task conversation outside the selected repository",
            ));
        }
        if worktree && normalize_root(&root) == normalize_root(target) {
            return Err(ApiError::new(
                409,
                "WORKTREE",
                "Codex did not create a new local worktree",
            ));
        }
    }
    let branch = git_value(&root, &["branch", "--show-current"]).await?;
    let branch = if branch.is_empty() {
        Value::Null
    } else {
        json!(branch)
    };
    Ok(
        json!({"workspacePath":root,"developmentContext":if worktree{json!({"type":"worktree","path":root,"branch":branch})}else{json!({"type":"branch","branch":branch})}}),
    )
}

async fn confirm_conversation(cdp: &Connection, request: &Value) -> Result<Value, ApiError> {
    let host = text(request, "codexHostId")?;
    let id = text(request, "threadId")?;
    let title = request["title"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(text(request, "identifier")?);
    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        if let Ok(result) = rpc(
            cdp,
            host,
            "thread/read",
            json!({"threadId":id,"includeTurns":true}),
            3000,
        )
        .await
        {
            let thread = &result["thread"];
            let execution = request["executionPreparation"] == true;
            let last = thread["turns"].as_array().and_then(|v| v.last());
            let turn_text = if execution {
                first_user_text(&json!({"turns":last.map(|v|vec![v.clone()]).unwrap_or_default()}))
            } else {
                first_user_text(thread)
            };
            let previous = request["previousTurnId"].as_str();
            let workspace = thread["cwd"].as_str().unwrap_or("");
            if thread["id"] == id
                && previous.map_or(true, |old| last.and_then(|v| v["id"].as_str()) != Some(old))
                && turn_text.contains(text(request, "identifier")?)
                && (request["targetRoot"].as_str().unwrap_or("").is_empty()
                    || execution && request["useWorktree"] == true
                    || normalize_root(request["targetRoot"].as_str().unwrap_or(""))
                        == normalize_root(workspace))
            {
                set_name(cdp, host, id, title).await?;
                let context = if execution {
                    Some(if request["useWorktree"] == true {
                        development_context(workspace, request["targetRoot"].as_str(), true).await?
                    } else {
                        let branch = git_value(workspace, &["branch", "--show-current"])
                            .await
                            .unwrap_or_default();
                        json!({"workspacePath":workspace,"developmentContext":if branch.is_empty(){Value::Null}else{json!({"type":"branch","branch":branch})}})
                    })
                } else {
                    None
                };
                return Ok(match context {
                    None => json!({"confirmed":true}),
                    Some(context) => {
                        json!({"confirmed":true,"threadBinding":{"threadId":id,"codexProjectId":request["codexProjectId"],"codexProjectKind":"local","codexHostId":host,"workspacePath":context["workspacePath"]},"developmentContext":context["developmentContext"]})
                    }
                });
            }
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
    Err(ApiError::new(
        504,
        "THREAD_CONFIRM",
        "Codex did not confirm the new issue conversation",
    ))
}

async fn set_name(cdp: &Connection, host: &str, id: &str, title: &str) -> Result<(), ApiError> {
    if let Err(error) = rpc(
        cdp,
        host,
        "thread/name/set",
        json!({"threadId":id,"name":title}),
        10000,
    )
    .await
    {
        let message = error.message.to_lowercase();
        if !(message.contains("rollout") && message.contains("is empty")) {
            return Err(error);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        rpc(
            cdp,
            host,
            "thread/name/set",
            json!({"threadId":id,"name":title}),
            10000,
        )
        .await?;
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Ok(result) = rpc(
            cdp,
            host,
            "thread/read",
            json!({"threadId":id,"includeTurns":false}),
            3000,
        )
        .await
        {
            if result["thread"]["id"] == id && result["thread"]["name"] == title {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
    Err(ApiError::new(
        409,
        "THREAD_TITLE",
        "Codex did not confirm the task conversation title",
    ))
}

async fn prefill(cdp: &Connection, context: i64, request: &Value) -> Result<Value, ApiError> {
    let mut skills=request["skills"].as_array().cloned().unwrap_or_else(||vec![json!({"name":request["skillName"],"displayName":request["skillDisplayName"],"path":request["skillPath"]})]);
    if skills.is_empty() || skills.len() > 41 {
        return Err(ApiError::new(400, "SKILL", "Invalid Skill references"));
    }
    for skill in &mut skills {
        for field in ["name", "displayName", "path"] {
            text(skill, field)?;
        }
        skill["resolvedPath"] = tokio::fs::canonicalize(text(skill, "path")?)
            .await
            .map(|p| json!(p))
            .unwrap_or_else(|_| skill["path"].clone());
    }
    let values = [
        ("instruction", request["instruction"].clone()),
        ("resolvedSkills", json!(skills)),
    ];
    let initial = substitute(include_str!("assets/prefill_0.js"), &values);
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut editor_ready = false;
    while Instant::now() < deadline {
        let result = cdp.evaluate(&initial, Some(context)).await?;
        if result["ready"] == true {
            editor_ready = true;
            if result["matches"] == true {
                return Ok(json!({"prefilled":true}));
            }
            break;
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
    if !editor_ready {
        return Err(ApiError::new(
            504,
            "COMPOSER",
            "Codex composer did not become ready",
        ));
    }
    for (index, skill) in skills.iter().enumerate() {
        cdp.send("Input.insertText", json!({"text":"$"})).await?;
        let source = substitute(
            include_str!("assets/prefill_1.js"),
            &[("skill_displayName", skill["displayName"].clone())],
        );
        wait_evaluation(cdp, context, &source, Duration::from_secs(8), |value| {
            value["found"] == true
        })
        .await?;
        let source = substitute(
            include_str!("assets/prefill_2.js"),
            &[
                ("skill_name", skill["name"].clone()),
                ("skill_path", skill["path"].clone()),
                ("skill_resolvedPath", skill["resolvedPath"].clone()),
            ],
        );
        let result = wait_evaluation(cdp, context, &source, Duration::from_secs(15), |value| {
            value["ready"] == true
        })
        .await?;
        if result["pathMatches"] != true {
            return Err(ApiError::new(
                409,
                "SKILL",
                "Codex selected a different Skill",
            ));
        }
        if index + 1 < skills.len() {
            wait_evaluation(
                cdp,
                context,
                include_str!("assets/prefill_3.js"),
                Duration::from_secs(8),
                |value| value == true,
            )
            .await?;
            cdp.send("Input.insertText", json!({"text":" "})).await?;
        }
    }
    cdp.send("Input.insertText", json!({"text":request["instruction"]}))
        .await?;
    wait_evaluation(
        cdp,
        context,
        &substitute(include_str!("assets/prefill_4.js"), &values),
        Duration::from_secs(8),
        |value| value == true,
    )
    .await?;
    Ok(json!({"prefilled":true}))
}

async fn wait_evaluation(
    cdp: &Connection,
    context: i64,
    source: &str,
    duration: Duration,
    check: impl Fn(&Value) -> bool,
) -> Result<Value, ApiError> {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        let value = cdp.evaluate(source, Some(context)).await?;
        if check(&value) {
            return Ok(value);
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
    Err(ApiError::new(
        504,
        "COMPOSER",
        "Timed out waiting for the Codex composer",
    ))
}

async fn start_conversation(
    cdp: &Connection,
    context: i64,
    request: &Value,
) -> Result<Value, ApiError> {
    let host = text(request, "codexHostId")?;
    if let Some(id) = request["threadId"].as_str().filter(|s| !s.is_empty()) {
        let result = rpc(
            cdp,
            host,
            "thread/read",
            json!({"threadId":id,"includeTurns":true}),
            10000,
        )
        .await?;
        if result["thread"]["id"] != id || result["thread"]["cwd"] != request["targetRoot"] {
            return Err(ApiError::new(
                409,
                "THREAD",
                "Codex shared execution workspace does not match saved binding",
            ));
        }
        if result["thread"]["status"]["type"] == "active"
            || result["thread"]["turns"]
                .as_array()
                .is_some_and(|turns| turns.iter().any(|turn| turn["status"] == "inProgress"))
        {
            return Err(ApiError::new(
                409,
                "THREAD_BUSY",
                "Codex conversation is temporarily busy",
            ));
        }
        let resumed = rpc(cdp, host, "thread/resume", json!({"threadId":id}), 10000).await?;
        if resumed["thread"]["id"] != id || resumed["thread"]["cwd"] != request["targetRoot"] {
            return Err(ApiError::new(
                409,
                "THREAD",
                "Codex did not resume saved execution conversation",
            ));
        }
        let mut input =
            vec![json!({"type":"text","text":request["instruction"],"text_elements":[]})];
        for skill in request["skills"].as_array().into_iter().flatten() {
            input.push(json!({"type":"skill","name":skill["name"],"path":skill["path"]}));
        }
        let mut params = json!({"threadId":id,"input":input});
        if request["collaborationMode"] == "default" {
            params["collaborationMode"] = json!({"mode":"default","settings":{"model":resumed["model"],"reasoning_effort":resumed["reasoningEffort"],"developer_instructions":null}});
        }
        let result = rpc(cdp, host, "turn/start", params, 10000).await;
        match result{
            Ok(result) if result["turn"]["id"].is_string()=>{},
            Err(error) if regex::Regex::new(r"(?i)\bTHREAD_BUSY\b|already.*(?:active|running).*turn|turn.*already.*(?:active|running)|thread.*busy").unwrap().is_match(&error.message)=>{
                return Err(ApiError::new(409,"THREAD_BUSY","Codex conversation is temporarily busy"));
            },
            _=>return Err(ApiError::new(502,"TURN_UNCERTAIN","Codex 执行请求是否送达尚未确认，请检查原会话后再重试").with_details(json!({"threadId":id,"uncertain":true}))),
        }
        return Ok(
            json!({"threadId":id,"threadBinding":{"threadId":id,"codexProjectId":request["codexProjectId"],"codexProjectKind":"local","codexHostId":host,"workspacePath":request["targetRoot"]}}),
        );
    }
    let source = substitute(
        include_str!("assets/start_conversation_0.js"),
        &[("instruction", request["instruction"].clone())],
    );
    wait_evaluation(cdp, context, &source, Duration::from_secs(8), |v| v == true).await?;
    // 一旦提交可能成功，后续失败必须带 uncertain，调用方不能自动重试创建。
    for event in ["keyDown", "keyUp"] {
        cdp.send("Input.dispatchKeyEvent",json!({"type":event,"key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"nativeVirtualKeyCode":13})).await.map_err(|mut error|{error.details=Some(json!({"uncertain":true}));error})?;
    }
    let mut discovered = None;
    let result=async {
        let deadline=Instant::now()+Duration::from_secs(12);
        while Instant::now()<deadline {
            let value=cdp.evaluate(include_str!("assets/start_conversation_1.js"),Some(context)).await?;
            let Some(id)=value.as_str().filter(|s|!s.is_empty()&&Some(*s)!=request["previousThreadId"].as_str())else{tokio::time::sleep(Duration::from_millis(80)).await;continue;};
            discovered=Some(id.to_owned());
            let ready_deadline=Instant::now()+Duration::from_secs(10);
            let thread=loop{
                if let Ok(thread)=rpc(cdp,host,"thread/read",json!({"threadId":id,"includeTurns":false}),10000).await{
                    let workspace=thread["thread"]["cwd"].as_str().unwrap_or("");
                    if thread["thread"]["id"]==id&&(request["projectless"]==true||request["useWorktree"]==true||normalize_root(request["targetRoot"].as_str().unwrap_or(""))==normalize_root(workspace)){break thread;}
                }
                if Instant::now()>=ready_deadline{return Err(ApiError::new(409,"THREAD_WORKSPACE","Codex did not confirm task conversation workspace root").with_details(json!({"threadId":id})));}
                tokio::time::sleep(Duration::from_millis(80)).await;
            };
            let workspace=thread["thread"]["cwd"].as_str().unwrap_or("");
            set_name(cdp,host,id,text(request,"title")?).await?;
            let context=if request["projectless"]==true{json!({"workspacePath":workspace,"developmentContext":null})}else{development_context(workspace,request["targetRoot"].as_str(),request["useWorktree"]==true).await?};
            return Ok(json!({"threadId":id,"title":request["title"],"threadBinding":{"threadId":id,"codexProjectId":request["codexProjectId"],"codexProjectKind":"local","codexHostId":host,"workspacePath":context["workspacePath"]},"developmentContext":context["developmentContext"]}));
        }
        Err(ApiError::new(504,"THREAD_START","Timed out while starting Codex conversation"))
    }.await;
    result.map_err(|mut error: ApiError| {
        if error.details.is_none() {
            error.details = Some(match discovered {
                Some(id) => json!({"threadId":id}),
                None => json!({"uncertain":true}),
            });
        }
        error
    })
}

pub fn native_automation_rpc(cdp: &Connection) -> crate::automation::NativeRpc {
    let connection = cdp.clone();
    std::sync::Arc::new(move |method, params| {
        let connection = connection.clone();
        Box::pin(async move { automation(&connection, &method, params).await })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_protocol_checks_utf16_limits_skills_and_execution_fields() {
        let mut request = json!({"id":"request-1","action":"start-task-conversation","taskId":"task-1","previousThreadId":"","codexHostId":"local","projectless":false,"targetRoot":"/tmp/repo","instruction":"中".repeat(20_000),"title":"迁移测试"});
        assert!(validate_request(&request).is_ok());
        request["projectless"] = json!("false");
        assert!(validate_request(&request).is_err());
        request["projectless"] = json!(false);
        request["instruction"] = json!("😀".repeat(2_000_001));
        assert!(validate_request(&request).is_err());
        let mut prefill = json!({"id":"request-2","action":"prefill-task-composer","instruction":"执行","skills":[{"name":"plugin:build","displayName":"构建","path":"/tmp/SKILL.md"}]});
        assert!(validate_request(&prefill).is_ok());
        prefill["skills"][0]["name"] = json!("plugin:build:extra");
        assert!(validate_request(&prefill).is_err());
        let mut confirm = json!({"id":"request-3","action":"confirm-task-conversation","threadId":"thread-1","codexHostId":"local","identifier":"task-1","targetRoot":"/tmp/repo","executionPreparation":true,"useWorktree":false,"codexProjectId":"project-1"});
        assert!(validate_request(&confirm).is_ok());
        confirm["codexHostId"] = json!("remote");
        assert!(validate_request(&confirm).is_err());
        let mut claim = json!({"id":"request-4","action":"bind-native-claim","taskId":"task-1","reservationId":"12345678-1234-1234-1234-123456789abc","threadBinding":{"threadId":"thread-1","codexProjectId":"project-1","codexProjectKind":"local","codexHostId":"local","workspacePath":"/tmp/repo"},"developmentContext":{"type":"worktree","path":"/tmp/worktree","branch":null}});
        assert!(validate_request(&claim).is_ok());
        claim["developmentContext"]
            .as_object_mut()
            .unwrap()
            .remove("branch");
        assert!(validate_request(&claim).is_err());
    }
    #[test]
    fn usage_resets_at_turn_boundary_and_ignores_duplicates() {
        let source = [
            json!({"type":"event_msg","timestamp":"2026-11-26T00:00:00Z","payload":{"type":"task_started","turn_id":"turn-1"}}),
            json!({"type":"event_msg","timestamp":"2026-11-26T00:00:02Z","payload":{"type":"token_count","info":{"last_token_usage":{"output_tokens":20,"input_tokens":100,"cached_input_tokens":50},"total_token_usage":{"output_tokens":20,"total_tokens":120}}}}),
        ];
        let line = source[1].to_string();
        let text = format!("{}\n{}\n{}\n", source[0], line, line);
        let usage = summarize_usage(
            &text,
            chrono::DateTime::parse_from_rfc3339("2026-11-26T00:00:04Z")
                .unwrap()
                .timestamp_millis(),
        );
        assert_eq!(usage["speed"], 5.0);
        assert_eq!(usage["cache"], 50.0);
        assert_eq!(usage["outputTokens"], 20);
    }
}
