use super::{json_body, json_response, methods, store, validate as v, AppState};
use crate::ApiError;
use axum::{
    http::{HeaderMap, Method},
    response::Response,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

const FIELDS: &[&str] = &[
    "summary",
    "description",
    "status",
    "priority",
    "labels",
    "duedate",
    "assignee",
    "reporter",
    "project",
    "resolution",
    "issuelinks",
    "created",
    "updated",
];
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn array(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn default(v: &Value, f: Value) -> Value {
    if v.is_null() {
        f
    } else {
        v.clone()
    }
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn trim(v: &Value, fallback: &str, max: usize) -> String {
    let text = v.as_str().map(str::to_owned).unwrap_or_else(|| {
        if v.is_null() {
            fallback.into()
        } else {
            v.to_string()
        }
    });
    let text = text.trim();
    if text.is_empty() {
        fallback.chars().take(max).collect()
    } else {
        text.chars().take(max).collect()
    }
}
fn includes(v: &Value, words: &[&str]) -> bool {
    let value = s(v).to_lowercase();
    words.iter().any(|word| value.contains(word))
}
fn account_id(user: &Value) -> String {
    trim(
        &default(
            &user["accountId"],
            default(&user["key"], user["name"].clone()),
        ),
        "",
        254,
    )
}
fn encode(v: &str) -> String {
    url::form_urlencoded::byte_serialize(v.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}
fn status(value: &Value) -> &'static str {
    let name = &value["name"];
    match s(&value["statusCategory"]["key"]) {
        "done" => {
            if includes(name, &["cancel", "reject", "取消", "拒绝"]) {
                "canceled"
            } else {
                "done"
            }
        }
        "new" => {
            if includes(name, &["backlog", "待立项", "需求池"]) {
                "backlog"
            } else {
                "todo"
            }
        }
        _ => {
            if includes(name, &["review", "verify", "test", "验收", "评审", "测试"]) {
                "in_review"
            } else if includes(name, &["block", "hold", "阻塞", "挂起"]) {
                "blocked"
            } else {
                "in_progress"
            }
        }
    }
}
fn priority(value: &Value) -> &'static str {
    let name = &value["name"];
    if includes(
        name,
        &["highest", "critical", "blocker", "urgent", "紧急", "最高"],
    ) {
        "urgent"
    } else if includes(name, &["high", "major", "高"]) {
        "high"
    } else if includes(name, &["medium", "normal", "中"]) {
        "medium"
    } else if includes(name, &["low", "minor", "trivial", "低"]) {
        "low"
    } else {
        "none"
    }
}
fn normalize_url(value: &Value) -> Result<String, ApiError> {
    let raw = value
        .as_str()
        .ok_or_else(|| ApiError::new(400, "INVALID_JIRA_URL", "Jira 地址无效"))?;
    let url = url::Url::parse(raw)
        .map_err(|_| ApiError::new(400, "INVALID_JIRA_URL", "Jira 地址无效"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ApiError::new(
            400,
            "INVALID_JIRA_URL",
            "Jira 地址必须使用 http 或 https，且不能包含账号、查询参数或片段",
        ));
    }
    Ok(url.as_str().trim_end_matches('/').into())
}
fn validate_projects(value: Option<&Value>) -> Result<Value, ApiError> {
    let Some(value) = value else {
        return Ok(json!([]));
    };
    let items = value.as_array().filter(|a| a.len() <= 20).ok_or_else(|| {
        ApiError::new(
            400,
            "INVALID_JIRA_PROJECTS",
            "Jira 项目必须是最多 20 项的数组",
        )
    })?;
    let mut projects = Vec::new();
    for item in items {
        let value = item
            .as_str()
            .filter(|s| {
                !s.trim().is_empty()
                    && s.chars().count() <= 128
                    && !s.chars().any(|c| c.is_control())
            })
            .ok_or_else(|| {
                ApiError::new(
                    400,
                    "INVALID_JIRA_PROJECTS",
                    "Jira 项目名称或 Key 不能为空、不能包含控制字符，且不能超过 128 个字符",
                )
            })?
            .trim();
        if !projects.iter().any(|p: &Value| p == value) {
            projects.push(json!(value));
        }
    }
    Ok(json!(projects))
}
fn parse_config(value: &Value) -> Result<Value, ApiError> {
    v::object(value)?;
    let version = value["version"]
        .as_u64()
        .filter(|v| [1, 2, 3].contains(v))
        .ok_or_else(|| ApiError::new(400, "INVALID_JIRA_CONFIG", "Jira 配置文件无效"))?;
    let mut allowed = vec![
        "version",
        "baseUrl",
        "username",
        "password",
        "displayName",
        "projects",
    ];
    if version >= 2 {
        allowed.push("originId");
    }
    if version == 3 {
        allowed.push("accountId");
    }
    v::allowed(value, &allowed)?;
    let mut config = validate_config(value)?;
    config["version"] = json!(version);
    config["displayName"] = json!(trim(&value["displayName"], "", 254));
    if s(&config["displayName"]).is_empty() {
        return Err(ApiError::new(
            400,
            "INVALID_JIRA_CONFIG",
            "Jira 配置缺少用户显示名称",
        ));
    }
    if version >= 2 {
        if s(&value["originId"]).len() != 64
            || !s(&value["originId"])
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(ApiError::new(
                400,
                "INVALID_JIRA_CONFIG",
                "Jira 配置缺少稳定实例身份",
            ));
        }
        config["originId"] = value["originId"].clone();
    }
    if version == 3 {
        let id = s(&value["accountId"]).trim();
        if id.is_empty() || id.chars().count() > 254 {
            return Err(ApiError::new(
                400,
                "INVALID_JIRA_CONFIG",
                "Jira 配置缺少稳定账号身份",
            ));
        }
        config["accountId"] = json!(id);
    }
    Ok(config)
}
fn validate_config(input: &Value) -> Result<Value, ApiError> {
    let username = input["username"]
        .as_str()
        .filter(|s| s.chars().count() <= 254 && !s.contains(':'))
        .ok_or_else(|| {
            ApiError::new(
                400,
                "INVALID_JIRA_USERNAME",
                "Jira 用户名不能包含冒号且不能超过 254 个字符",
            )
        })?;
    let password = input["password"]
        .as_str()
        .filter(|s| !s.is_empty() && s.chars().count() <= 4096)
        .ok_or_else(|| {
            ApiError::new(
                400,
                "INVALID_JIRA_PASSWORD",
                "Jira 密码不能为空且不能超过 4096 个字符",
            )
        })?;
    Ok(
        json!({"baseUrl":normalize_url(&input["baseUrl"])?,"username":username.trim(),"password":password,"projects":validate_projects(input.get("projects"))?}),
    )
}
async fn read_config(state: &AppState) -> Result<Value, ApiError> {
    let value = store::read(
        &state.config.data_dir.join("jira-connection.json"),
        Value::Null,
    )
    .await?;
    if value.is_null() {
        Ok(value)
    } else {
        parse_config(&value)
    }
}
async fn save_config(state: &AppState, config: &Value) -> Result<Value, ApiError> {
    let mut config = config.clone();
    config["version"] = json!(3);
    let config = parse_config(&config)?;
    store::write(&state.config.data_dir.join("jira-connection.json"), &config).await?;
    Ok(config)
}
fn safe_config(state: &AppState, config: &Value) -> Result<Value, ApiError> {
    let sync = state.db("getJiraSyncState", &[])?;
    let settings = state.db("getJiraSettings", &[])?;
    let mut result = json!({"configured":!config.is_null(),"baseUrl":config["baseUrl"],"authMethod":if config.is_null()||!s(&config["username"]).is_empty(){"basic"}else{"bearer"},"username":null,"displayName":config["displayName"],"projects":default(&config["projects"],json!([])),"projectId":"jira-my-tasks","lastSyncedAt":if config.is_null(){Value::Null}else{sync["lastSuccessfulAt"].clone()},"autoCompleteEnabled":settings["autoCompleteEnabled"],"autoArchiveEnabled":settings["autoArchiveEnabled"],"insecureHttp":s(&config["baseUrl"]).starts_with("http:")});
    if let Some(values) = sync.as_object() {
        for (key, value) in values {
            result[key] = value.clone();
        }
    }
    Ok(result)
}

async fn request(
    state: &AppState,
    config: &Value,
    path: &str,
    method: Method,
    body: Option<&Value>,
) -> Result<Value, ApiError> {
    let auth = if s(&config["username"]).is_empty() {
        format!("Bearer {}", s(&config["password"]))
    } else {
        format!(
            "Basic {}",
            STANDARD.encode(format!(
                "{}:{}",
                s(&config["username"]),
                s(&config["password"])
            ))
        )
    };
    let mut builder = state
        .client
        .request(method, format!("{}{path}", s(&config["baseUrl"])))
        .timeout(Duration::from_secs(20))
        .header("accept", "application/json")
        .header("authorization", auth);
    if let Some(body) = body {
        builder = builder.json(body);
    }
    let response = builder.send().await.map_err(|e| {
        if e.is_timeout() {
            ApiError::new(502, "JIRA_TIMEOUT", "连接 Jira 超时")
        } else {
            ApiError::new(
                502,
                "JIRA_UNAVAILABLE",
                "无法连接 Jira，请检查地址和内网连接",
            )
        }
    })?;
    let status = response.status().as_u16();
    match status {
        401 => return Err(ApiError::new(
            401,
            "JIRA_AUTH_FAILED",
            "Jira 登录已失效，请在 Jira 设置中检查账号、API Token、Bearer Token 或 CAPTCHA 状态",
        )),
        403 => {
            return Err(ApiError::new(
                403,
                "JIRA_PERMISSION_DENIED",
                "当前 Jira 账号无权读取这些任务，请检查项目权限或重新连接账号",
            ))
        }
        404 => {
            return Err(ApiError::new(
                404,
                "JIRA_RESOURCE_NOT_FOUND",
                "Jira 资源不存在或当前账号无法查看",
            ))
        }
        429 => {
            return Err(ApiError::new(
                502,
                "JIRA_RATE_LIMITED",
                "Jira 请求过于频繁，Panel 将稍后重试",
            ))
        }
        300..=399 => {
            return Err(ApiError::new(
                400,
                "JIRA_REDIRECT",
                "Jira 地址发生重定向，请填写最终访问地址",
            ))
        }
        400..=599 => {
            return Err(ApiError::new(
                if status >= 500 { 502 } else { 409 },
                "JIRA_REQUEST_FAILED",
                format!("Jira 请求失败（HTTP {status}）"),
            ))
        }
        204 => return Ok(Value::Null),
        _ => {}
    }
    response
        .json()
        .await
        .map_err(|_| ApiError::new(502, "INVALID_JIRA_RESPONSE", "Jira 返回了无效的 JSON 数据"))
}
async fn origin(state: &AppState, config: &Value) -> Result<String, ApiError> {
    let manifest = request(
        state,
        config,
        "/rest/applinks/1.0/manifest",
        Method::GET,
        None,
    )
    .await?;
    let id = s(&manifest["id"]).trim();
    if id.is_empty() {
        return Err(ApiError::new(
            502,
            "INVALID_JIRA_ORIGIN",
            "Jira 未返回稳定的实例身份",
        ));
    }
    Ok(hex::encode(Sha256::digest(id.as_bytes())))
}
async fn live_origin(state: &AppState, config: &Value) -> Result<(), ApiError> {
    if origin(state, config).await? != s(&config["originId"]) {
        return Err(ApiError::new(
            409,
            "JIRA_ORIGIN_MISMATCH",
            "当前 Jira 地址指向了另一个实例，请重新连接后再操作",
        ));
    }
    Ok(())
}
async fn account(state: &AppState, config: &Value) -> Result<Value, ApiError> {
    let user = request(state, config, "/rest/api/2/myself", Method::GET, None).await?;
    let id = account_id(&user);
    if id.is_empty() {
        return Err(ApiError::new(
            502,
            "INVALID_JIRA_ACCOUNT",
            "Jira 未返回稳定的登录账号身份",
        ));
    }
    Ok(
        json!({"accountId":id,"displayName":trim(&default(&user["displayName"],user["name"].clone()),s(&config["username"]),254)}),
    )
}
fn accept_account(current: &Value, next: &Value, accepted: bool) -> Result<(), ApiError> {
    if !current["accountId"].is_null() && current["accountId"] != next["accountId"] && !accepted {
        return Err(ApiError::new(409,"JIRA_ACCOUNT_CHANGED",format!("Jira 登录账号已从“{}”变为“{}”，请确认后继续同步",s(&current["displayName"]),s(&next["displayName"]))).with_details(json!({"current":{"accountId":current["accountId"],"displayName":current["displayName"]},"next":next})));
    }
    Ok(())
}
fn jql(config: &Value) -> String {
    let projects = array(&config["projects"])
        .iter()
        .map(|v| format!("\"{}\"", s(v).replace('\\', "\\\\").replace('"', "\\\"")))
        .collect::<Vec<_>>();
    format!(
        "assignee = currentUser(){} AND statusCategory != Done ORDER BY updated DESC",
        if projects.is_empty() {
            String::new()
        } else {
            format!(" AND project in ({})", projects.join(", "))
        }
    )
}
async fn assigned(state: &AppState, config: &Value) -> Result<Vec<Value>, ApiError> {
    let cloud = url::Url::parse(s(&config["baseUrl"]))
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .is_some_and(|h| h.ends_with(".atlassian.net"));
    let mut issues = Vec::new();
    let mut next = Value::Null;
    loop {
        let mut body = json!({"jql":jql(config),"maxResults":100,"fields":FIELDS});
        if cloud {
            if !next.is_null() {
                body["nextPageToken"] = next.clone();
            }
        } else {
            body["startAt"] = json!(issues.len());
        }
        let page = request(
            state,
            config,
            if cloud {
                "/rest/api/2/search/jql"
            } else {
                "/rest/api/2/search"
            },
            Method::POST,
            Some(&body),
        )
        .await?;
        let page_issues = array(&page["issues"]);
        let count = page_issues.len();
        issues.extend(page_issues);
        if cloud {
            if page["isLast"] == true {
                break;
            }
            next = page["nextPageToken"].clone();
            if s(&next).trim().is_empty() {
                return Err(ApiError::new(
                    502,
                    "INVALID_JIRA_RESPONSE",
                    "Jira 搜索结果缺少下一页标记",
                ));
            }
        } else if count == 0 || issues.len() >= page["total"].as_u64().unwrap_or(0) as usize {
            break;
        }
    }
    Ok(issues)
}
async fn issue(state: &AppState, config: &Value, key: &str) -> Result<Value, ApiError> {
    request(
        state,
        config,
        &format!(
            "/rest/api/2/issue/{}?fields={}",
            encode(key),
            encode(&FIELDS.join(","))
        ),
        Method::GET,
        None,
    )
    .await
}
fn actor(user: &Value, fallback: &str) -> Value {
    json!({"type":"user","id":format!("jira:{}",trim(&default(&user["key"],default(&user["name"],user["accountId"].clone())),fallback,240)),"name":trim(&default(&user["displayName"],user["name"].clone()),fallback,120),"avatarUrl":default(&user["avatarUrls"]["48x48"],user["avatarUrls"]["32x32"].clone())})
}
fn normalized(issue: &Value, config: &Value, index: usize) -> Value {
    let f = &issue["fields"];
    let external = if issue["id"].is_string() {
        s(&issue["id"]).to_owned()
    } else {
        issue["id"].to_string()
    };
    let key = trim(&issue["key"], "JIRA", 128);
    let id = format!("JIRA:{}:{external}", s(&config["originId"]).to_uppercase());
    let mut labels = Vec::new();
    for label in array(&f["labels"]) {
        if label.is_string() {
            let label = trim(&label, "", 64);
            if !label.is_empty() && !labels.contains(&label) {
                labels.push(label);
            }
            if labels.len() == 20 {
                break;
            }
        }
    }
    let link = array(&f["issuelinks"]).into_iter().find(|link| {
        link["outwardIssue"]["key"].is_string()
            && includes(&link["type"]["outward"], &["duplicate", "重复"])
    });
    let duplicate = if includes(&f["resolution"]["name"], &["duplicate", "重复"]) || link.is_some()
    {
        json!({"externalKey":link.map(|l|trim(&l["outwardIssue"]["key"],"",128)).filter(|k|!k.is_empty())})
    } else {
        Value::Null
    };
    let description = regex::Regex::new(r"(?m)^([ \t]*)#\s+")
        .unwrap()
        .replace_all(s(&f["description"]), "${1}1. ")
        .chars()
        .take(100000)
        .collect::<String>();
    json!({"id":id,"identifier":id,"title":trim(&f["summary"],&key,240),"description":description,"status":status(&f["status"]),"priority":priority(&f["priority"]),"labels":labels,"sortOrder":(index+1)*1024,"creator":actor(&f["reporter"],s(&config["displayName"])),"assignee":actor(&f["assignee"],s(&config["displayName"])),"dueDate":if f["duedate"].is_string(){f["duedate"].clone()}else{Value::Null},"externalOrigin":config["originId"],"externalId":external,"externalKey":key,"externalUrl":format!("{}/browse/{}",s(&config["baseUrl"]),encode(&key)),"externalStatus":trim(&f["status"]["name"],"Unknown",128),"externalUpdatedAt":if f["updated"].is_string(){f["updated"].clone()}else{Value::Null},"duplicateOf":duplicate,"createdAt":if f["created"].is_string(){f["created"].clone()}else{json!(now())},"updatedAt":if f["updated"].is_string(){f["updated"].clone()}else{json!(now())}})
}
fn scope(issue: &Value, config: &Value) -> &'static str {
    let fields = &issue["fields"];
    let category = s(&fields["status"]["statusCategory"]["key"]);
    if category == "done" {
        return "outside";
    }
    if category.is_empty() {
        return "unknown";
    }
    if account_id(&fields["assignee"]) != s(&config["accountId"]) {
        return "outside";
    }
    let projects = array(&config["projects"]);
    if projects.is_empty() {
        return "inside";
    }
    let names = [
        s(&fields["project"]["key"]).trim().to_lowercase(),
        s(&fields["project"]["name"]).trim().to_lowercase(),
    ];
    if names.iter().all(String::is_empty) {
        return "unknown";
    }
    if projects
        .iter()
        .any(|v| names.contains(&s(v).to_lowercase()))
    {
        "inside"
    } else {
        "outside"
    }
}
async fn collect(
    state: &AppState,
    config: &Value,
    assigned: Vec<Value>,
    archive: bool,
) -> Result<(Value, usize, Value), ApiError> {
    let count = assigned.len();
    let mut items: Vec<Value> = assigned
        .iter()
        .enumerate()
        .map(|(i, v)| normalized(v, config, i))
        .collect();
    let ids: HashSet<_> = items
        .iter()
        .map(|v| s(&v["externalId"]).to_owned())
        .collect();
    let mut unknown = Vec::new();
    for task in array(&state.db("listActiveJiraTasks", &[config["originId"].clone()])?) {
        if ids.contains(s(&task["externalId"])) {
            continue;
        }
        match issue(state, config, s(&task["externalKey"])).await {
            Ok(remote) => {
                let scope = scope(&remote, config);
                if scope == "unknown" {
                    unknown.push(json!({"id":task["id"],"message":format!("同步状态未知：无法确认 {} 是否仍在同步范围内。",s(&task["externalKey"]))}));
                    continue;
                }
                let mut value = normalized(&remote, config, items.len());
                value["archived"] = json!(archive && scope == "outside");
                items.push(value);
                if scope == "inside" {
                    unknown.push(json!({"id":task["id"],"message":format!("同步状态未知：{} 仍符合范围但未出现在 Jira 搜索结果中。",s(&task["externalKey"]))}));
                }
            }
            Err(error) => {
                if matches!(
                    error.code.as_str(),
                    "JIRA_AUTH_FAILED" | "JIRA_PERMISSION_DENIED"
                ) {
                    return Err(error);
                }
                unknown.push(json!({"id":task["id"],"message":format!("同步状态未知：无法确认 {} 的当前状态。{}",s(&task["externalKey"]),error.message).chars().take(1000).collect::<String>()}));
            }
        }
    }
    let mut accessible: HashSet<String> = items
        .iter()
        .map(|v| s(&v["externalKey"]).to_owned())
        .collect();
    let canonical: HashSet<_> = items
        .iter()
        .filter_map(|v| v["duplicateOf"]["externalKey"].as_str())
        .filter(|k| !accessible.contains(*k))
        .map(str::to_owned)
        .collect();
    for key in canonical {
        match issue(state, config, &key).await {
            Ok(remote) => {
                accessible.insert(key);
                let mut value = normalized(&remote, config, items.len());
                value["archived"] = json!(archive && scope(&remote, config) != "inside");
                items.push(value);
            }
            Err(error) if error.code == "JIRA_AUTH_FAILED" => return Err(error),
            Err(_) => {}
        }
    }
    for item in &mut items {
        if !item["duplicateOf"].is_null() {
            item["duplicateOf"]["accessible"] =
                json!(accessible.contains(s(&item["duplicateOf"]["externalKey"])));
        }
    }
    Ok((json!(items), count, json!(unknown)))
}

async fn sync_stored(
    state: &AppState,
    stored: &Value,
    accept: bool,
    archive: bool,
) -> Result<Value, ApiError> {
    let attempted = now();
    state.db("recordJiraSyncAttempt", &[json!(attempted)])?;
    let result=async{let mut config=stored.clone();let legacy=if stored["version"]==1{config["originId"]=json!(origin(state,stored).await?);json!({"urlHash":hex::encode(Sha256::digest(s(&stored["baseUrl"]).as_bytes()))[..16],"originId":config["originId"]})}else{live_origin(state,stored).await?;Value::Null};let user=account(state,&config).await?;accept_account(stored,&user,accept || (archive && state.jira_sync_accept.load(Ordering::Acquire)))?;config["accountId"]=user["accountId"].clone();config["displayName"]=user["displayName"].clone();let assigned=assigned(state,&config).await?;let (issues,count,unknown)=collect(state,&config,assigned,archive).await?;let succeeded=now();state.db("syncJiraTasks",&[issues,json!({"archiveMissing":archive,"originId":config["originId"],"projectName":format!("Jira · {}",s(&config["displayName"])),"legacyIdentity":legacy,"unknownTasks":unknown,"syncedAt":succeeded})])?;if stored["version"]!=3||stored["accountId"]!=config["accountId"]||stored["displayName"]!=config["displayName"]{config=save_config(state,&config).await?;}state.db("recordJiraSyncSuccess",&[json!({"attemptedAt":attempted,"succeededAt":succeeded,"issueCount":count,"unknownIssueCount":array(&unknown).len()})])?;safe_config(state,&config)}.await;
    if let Err(error) = &result {
        state.db(
            "markJiraSyncError",
            &[json!(error.message), json!(error.code), json!(attempted)],
        )?;
    }
    result
}
pub async fn sync(state: &AppState, force: bool, accept: bool) -> Result<Value, ApiError> {
    if accept {
        state.jira_sync_accept.store(true, Ordering::Release);
    }
    let generation = state.jira_sync_generation.load(Ordering::Acquire);
    let _gate = state.jira_gate.lock().await;
    struct AcceptanceReset<'a>(&'a std::sync::atomic::AtomicBool);
    impl Drop for AcceptanceReset<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }
    // 账号变更确认只属于本次同步；无配置、节流和错误返回也不能把授权留给后续请求。
    let _acceptance_reset = AcceptanceReset(&state.jira_sync_accept);
    // 同时请求复用正在执行的结果，force 不再触发第二次网络同步。
    if state.jira_sync_generation.load(Ordering::Acquire) != generation {
        if let Some((_, result)) = &*state
            .jira_sync_result
            .lock()
            .map_err(|_| ApiError::new(500, "JIRA_LOCK", "Jira sync result lock was poisoned"))?
        {
            return result.clone();
        }
    }
    let config = read_config(state).await?;
    if config.is_null() {
        return safe_config(state, &config);
    }
    if !force {
        let summary = state.db("getJiraSyncState", &[])?;
        if let Ok(last) = chrono::DateTime::parse_from_rfc3339(s(&summary["lastSuccessfulAt"])) {
            if chrono::Utc::now()
                .signed_duration_since(last)
                .num_milliseconds()
                < 60000
            {
                return safe_config(state, &config);
            }
        }
    }
    let result = sync_stored(state, &config, accept, true).await;
    let next = state.jira_sync_generation.fetch_add(1, Ordering::AcqRel) + 1;
    *state
        .jira_sync_result
        .lock()
        .map_err(|_| ApiError::new(500, "JIRA_LOCK", "Jira sync result lock was poisoned"))? =
        Some((next, result.clone()));
    result
}
pub async fn reconcile(state: &AppState) -> Result<Value, ApiError> {
    let _gate = state.jira_gate.lock().await;
    let config = read_config(state).await?;
    if config.is_null() || config["version"] == 1 {
        return Err(ApiError::new(
            409,
            "JIRA_NOT_CONFIGURED",
            "Jira 尚未完成稳定身份配置",
        ));
    }
    sync_stored(state, &config, false, false).await
}
async fn configure(state: &AppState, input: &Value) -> Result<Value, ApiError> {
    let _gate = state.jira_gate.lock().await;
    let current = read_config(state).await?;
    let current_method = if s(&current["username"]).is_empty() {
        "bearer"
    } else {
        "basic"
    };
    let method = input["authMethod"]
        .as_str()
        .unwrap_or(if current.is_null() {
            "basic"
        } else {
            current_method
        });
    let username = if method == "bearer" {
        ""
    } else {
        input["username"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(s(&current["username"]))
    };
    if method == "basic" && username.trim().is_empty() {
        return Err(ApiError::new(
            400,
            "JIRA_USERNAME_REQUIRED",
            "Basic Auth 必须填写 Jira 用户名或邮箱",
        ));
    }
    let password = input["password"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(s(&current["password"]));
    let mut candidate = validate_config(
        &json!({"baseUrl":input["baseUrl"],"username":username,"password":password,"projects":default(&input["projects"],json!([]))}),
    )?;
    if current["version"] == 1 && candidate["baseUrl"] != current["baseUrl"] {
        return Err(ApiError::new(
            409,
            "JIRA_LEGACY_URL_CHANGE_UNAVAILABLE",
            "请先使用原 Jira 地址完成配置升级，再修改地址",
        ));
    }
    if s(&input["password"]).is_empty()
        && (current.is_null()
            || candidate["baseUrl"] != current["baseUrl"]
            || candidate["username"] != current["username"]
            || method != current_method)
    {
        return Err(ApiError::new(
            400,
            "JIRA_PASSWORD_REQUIRED",
            "修改 Jira 地址、用户名或认证方式时必须重新输入密码或 Token",
        ));
    }
    let attempted = now();
    state.db("recordJiraSyncAttempt", &[json!(attempted)])?;
    let result=async{candidate["originId"]=json!(origin(state,&candidate).await?);let user=account(state,&candidate).await?;accept_account(&current,&user,input["acceptAccountChange"]==true)?;candidate["accountId"]=user["accountId"].clone();candidate["displayName"]=user["displayName"].clone();let assigned=assigned(state,&candidate).await?;let (issues,count,unknown)=collect(state,&candidate,assigned,true).await?;let legacy=if current["version"]==1{json!({"urlHash":hex::encode(Sha256::digest(s(&current["baseUrl"]).as_bytes()))[..16],"originId":candidate["originId"]})}else{Value::Null};let succeeded=now();state.db("syncJiraTasks",&[issues,json!({"archiveMissing":true,"originId":if current["originId"]==candidate["originId"]{candidate["originId"].clone()}else{Value::Null},"projectName":format!("Jira · {}",s(&candidate["displayName"])),"legacyIdentity":legacy,"unknownTasks":unknown,"syncedAt":succeeded})])?;let saved=save_config(state,&candidate).await?;state.db("recordJiraSyncSuccess",&[json!({"attemptedAt":attempted,"succeededAt":succeeded,"issueCount":count,"unknownIssueCount":array(&unknown).len()})])?;safe_config(state,&saved)}.await;
    if let Err(error) = &result {
        state.db(
            "markJiraSyncError",
            &[json!(error.message), json!(error.code), json!(attempted)],
        )?;
    }
    result
}
async fn task_config(state: &AppState, task: &Value) -> Result<Value, ApiError> {
    let config = read_config(state).await?;
    if config.is_null() {
        return Err(ApiError::new(409, "JIRA_NOT_CONFIGURED", "Jira 尚未配置"));
    }
    if task["externalOrigin"] != config["originId"] || s(&task["externalKey"]).is_empty() {
        return Err(ApiError::new(
            409,
            "JIRA_ORIGIN_MISMATCH",
            "此任务不属于当前 Jira 连接，请重新同步后再操作",
        ));
    }
    live_origin(state, &config).await?;
    Ok(config)
}
async fn transition(
    state: &AppState,
    config: &Value,
    key: &str,
    target: &str,
) -> Result<Value, ApiError> {
    let response = request(
        state,
        config,
        &format!(
            "/rest/api/2/issue/{}/transitions?expand=transitions.fields",
            encode(key)
        ),
        Method::GET,
        None,
    )
    .await?;
    let transitions = array(&response["transitions"]);
    let matches: Vec<_> = transitions
        .iter()
        .filter(|candidate| status(&candidate["to"]) == target)
        .collect();
    let available:Vec<_>=transitions.iter().map(|candidate|json!({"id":if candidate["id"].is_string(){s(&candidate["id"]).to_owned()}else{candidate["id"].to_string()},"name":default(&candidate["name"],candidate["to"]["name"].clone()),"taskboardStatus":status(&candidate["to"])})).collect();
    if matches.is_empty() {
        return Err(ApiError::new(
            409,
            "JIRA_TRANSITION_UNAVAILABLE",
            format!("Jira 当前工作流不能将 {key} 移到目标状态"),
        )
        .with_details(json!({"availableStatuses":available})));
    }
    if matches.len() > 1 {
        return Err(ApiError::new(409,"JIRA_TRANSITION_AMBIGUOUS",format!("Jira 有多个工作流操作可将 {key} 移到目标状态，请在 Jira 中选择")).with_details(json!({"availableStatuses":available.iter().filter(|v|v["taskboardStatus"]==target).collect::<Vec<_>>()})));
    }
    Ok(matches[0].clone())
}
async fn apply_transition(
    state: &AppState,
    config: &Value,
    key: &str,
    transition: &Value,
) -> Result<(), ApiError> {
    let id = if transition["id"].is_string() {
        s(&transition["id"]).to_owned()
    } else {
        transition["id"].to_string()
    };
    request(
        state,
        config,
        &format!("/rest/api/2/issue/{}/transitions", encode(key)),
        Method::POST,
        Some(&json!({"transition":{"id":id}})),
    )
    .await?;
    Ok(())
}
async fn task_transition(
    state: &AppState,
    config: &Value,
    key: &str,
    target: &str,
) -> Result<(), ApiError> {
    let issue = request(
        state,
        config,
        &format!("/rest/api/2/issue/{}?fields=status", encode(key)),
        Method::GET,
        None,
    )
    .await?;
    if status(&issue["fields"]["status"]) != target {
        let transition = transition(state, config, key, target).await?;
        apply_transition(state, config, key, &transition).await?;
    }
    Ok(())
}
pub async fn move_task(state: &AppState, current: &Value, target: &str) -> Result<(), ApiError> {
    if current["status"] == target {
        return Ok(());
    }
    let config = task_config(state, current).await?;
    task_transition(state, &config, s(&current["externalKey"]), target).await
}
pub async fn update_task(
    state: &AppState,
    current: &Value,
    changes: &Value,
) -> Result<bool, ApiError> {
    let config = task_config(state, current).await?;
    let status_changed = changes.get("status").is_some() && changes["status"] != current["status"];
    let priority_changed =
        changes.get("priority").is_some() && changes["priority"] != current["priority"];
    let mut fields = json!({});
    for (key, destination) in [
        ("title", "summary"),
        ("description", "description"),
        ("labels", "labels"),
        ("dueDate", "duedate"),
    ] {
        if let Some(value) = changes.get(key) {
            if *value != current[key] {
                fields[destination] = value.clone();
            }
        }
    }
    let fields_changed = !fields.as_object().unwrap().is_empty() || priority_changed;
    if status_changed && fields_changed {
        return Err(ApiError::new(
            409,
            "JIRA_MULTI_STEP_UPDATE_UNAVAILABLE",
            "请分开修改 Jira 状态和其他字段",
        ));
    }
    if priority_changed {
        fields["priority"] = if changes["priority"] == "none" {
            Value::Null
        } else {
            let list = request(state, &config, "/rest/api/2/priority", Method::GET, None).await?;
            let item = array(&list)
                .into_iter()
                .find(|p| priority(p) == s(&changes["priority"]))
                .ok_or_else(|| {
                    ApiError::new(
                        409,
                        "JIRA_PRIORITY_UNAVAILABLE",
                        "Jira 中没有可映射到该优先级的选项",
                    )
                })?;
            json!({"id":if item["id"].is_string(){s(&item["id"]).to_owned()}else{item["id"].to_string()}})
        };
    }
    if status_changed {
        task_transition(
            state,
            &config,
            s(&current["externalKey"]),
            s(&changes["status"]),
        )
        .await?;
        return Ok(true);
    }
    if fields_changed {
        request(
            state,
            &config,
            &format!("/rest/api/2/issue/{}", encode(s(&current["externalKey"]))),
            Method::PUT,
            Some(&json!({"fields":fields})),
        )
        .await?;
        return Ok(true);
    }
    Ok(false)
}
fn live_state(issue: &Value) -> Value {
    json!({"updatedAt":if issue["fields"]["updated"].is_string(){issue["fields"]["updated"].clone()}else{Value::Null},"statusName":trim(&issue["fields"]["status"]["name"],"Unknown",128),"taskStatus":status(&issue["fields"]["status"])})
}
async fn complete_task(
    state: &AppState,
    task: &Value,
    expected: &Value,
) -> Result<Value, ApiError> {
    let config = task_config(state, task).await?;
    let key = s(&task["externalKey"]);
    let remote = live_state(&issue(state, &config, key).await?);
    if remote["taskStatus"] == "done" {
        return Ok(remote);
    }
    if !expected.is_null() && remote["updatedAt"] != *expected {
        return Err(ApiError::new(
            409,
            "JIRA_AUTO_COMPLETE_CONFLICT",
            format!("{key} 在 Panel 上次同步后已被修改，请确认远端状态后重试"),
        )
        .with_details(json!({"remote":remote})));
    }
    let transition = transition(state, &config, key, "done").await?;
    if state.db("isJiraAutoCompletionEligible", &[task["id"].clone()])? != true {
        return Err(ApiError::new(
            409,
            "JIRA_AUTO_COMPLETE_NOT_ELIGIBLE",
            "关联 Issue 已变化，Jira 不再满足自动完成条件",
        ));
    }
    apply_transition(state, &config, key, &transition).await?;
    let remote = live_state(&issue(state, &config, key).await?);
    if remote["taskStatus"] != "done" {
        return Err(ApiError::new(
            502,
            "JIRA_TRANSITION_NOT_CONFIRMED",
            format!("Jira 未确认 {key} 已进入完成状态"),
        )
        .with_details(json!({"remote":remote})));
    }
    Ok(remote)
}
fn emit_jira(state: &AppState, id: &Value) -> Result<(), ApiError> {
    let task = state.db("getTask", &[id.clone()])?;
    state.emit("task.jira.updated", json!({"taskId":id,"task":task}));
    Ok(())
}
pub async fn tick(state: &Arc<AppState>) -> Result<(), ApiError> {
    if state.jira_gate.try_lock().is_ok() {
        let _ = sync(state, false, false).await;
    }
    let Ok(_guard) = state.jira_completion_gate.try_lock() else {
        return Ok(());
    };
    for id in array(&state.db("queueEligibleJiraAutoCompletions", &[])?) {
        emit_jira(state, &id)?;
    }
    let next = state.db("takeNextJiraAutoCompletion", &[])?;
    if next.is_null() {
        return Ok(());
    }
    let task = &next["jira"];
    emit_jira(state, &task["id"])?;
    match complete_task(state, task, &next["completion"]["expectedUpdatedAt"]).await {
        Ok(result) => {
            state.db("finishJiraAutoCompletion", &[task["id"].clone(), result])?;
        }
        Err(error) => {
            let attempt = next["completion"]["attemptCount"].as_u64().unwrap_or(1);
            let retry = if error.status >= 500 && attempt <= 2 {
                json!((chrono::Utc::now()
                    + chrono::Duration::seconds(if attempt == 1 { 30 } else { 120 }))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            } else {
                Value::Null
            };
            state.db("failJiraAutoCompletion",&[task["id"].clone(),json!({"code":error.code,"message":error.message}),json!({"retryAt":retry,"remote":error.details.as_ref().map(|d|d["remote"].clone())})])?;
        }
    }
    emit_jira(state, &task["id"])
}
pub async fn handle(
    state: &Arc<AppState>,
    method: &Method,
    path: &[&str],
    raw: Option<&str>,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Option<Response>, ApiError> {
    match path {
        ["api", "local", "jira-connection"] => {
            v::query(raw, &[])?;
            if *method == Method::GET {
                return Ok(Some(json_response(
                    200,
                    json!({"connection":safe_config(state,&read_config(state).await?)?}),
                )));
            }
            if *method != Method::PUT {
                return Ok(Some(methods(&["GET", "PUT"])));
            }
            let cloud = store::read(
                &state.config.data_dir.join("cloud-companion.json"),
                store::empty_cloud(),
            )
            .await?;
            if cloud["remoteUrl"].is_string() {
                return Err(ApiError::new(
                    409,
                    "JIRA_LOCAL_MODE_REQUIRED",
                    "Jira 连接当前仅支持本地数据模式，请先退出云端协作模式",
                ));
            }
            let input = json_body(headers, body)?;
            v::allowed(
                &input,
                &[
                    "baseUrl",
                    "authMethod",
                    "username",
                    "password",
                    "projects",
                    "acceptAccountChange",
                ],
            )?;
            v::required_string(input.get("baseUrl"), "baseUrl", 2048)?;
            if let Some(auth) = input.get("authMethod") {
                if ![json!("basic"), json!("bearer")].contains(auth) {
                    return Err(v::invalid("'authMethod' must be 'basic' or 'bearer'"));
                }
            }
            if input
                .get("acceptAccountChange")
                .is_some_and(|v| !v.is_boolean())
            {
                return Err(v::invalid("'acceptAccountChange' must be a boolean"));
            }
            if input
                .get("password")
                .is_some_and(|v| !v.is_string() || s(v).chars().count() > 4096)
            {
                return Err(v::invalid(
                    "'password' must be a string up to 4096 characters",
                ));
            }
            let connection = configure(state, &input).await?;
            state.emit(
                "project.labels.updated",
                json!({"project":state.db("getProject",&[json!("jira-my-tasks")])?}),
            );
            Ok(Some(json_response(200, json!({"connection":connection}))))
        }
        ["api", "local", "jira-connection", "sync"] => {
            v::query(raw, &[])?;
            if *method != Method::POST {
                return Ok(Some(methods(&["POST"])));
            }
            let accept = if body.is_empty() {
                false
            } else {
                let value = json_body(headers, body)?;
                v::allowed(&value, &["acceptAccountChange"])?;
                value["acceptAccountChange"]
                    .as_bool()
                    .ok_or_else(|| v::invalid("'acceptAccountChange' must be a boolean"))?
            };
            let connection = sync(state, true, accept).await?;
            state.emit(
                "project.labels.updated",
                json!({"project":state.db("getProject",&[json!("jira-my-tasks")])?}),
            );
            Ok(Some(json_response(200, json!({"connection":connection}))))
        }
        ["api", "tasks", id, "jira-auto-complete"] => {
            v::query(raw, &[])?;
            if *method != Method::POST {
                return Ok(Some(methods(&["POST"])));
            }
            let value = json_body(headers, body)?;
            v::allowed(&value, &["action"])?;
            match s(&value["action"]) {
                "retry" => {
                    state.db("queueJiraAutoCompletionRetry", &[json!(id)])?;
                }
                "accept_remote" => {
                    reconcile(state).await?;
                    state.db("dismissJiraAutoCompletionConflict", &[json!(id)])?;
                }
                _ => return Err(v::invalid("Unsupported Jira automatic completion action")),
            }
            let context = state.db("getJiraContext", &[json!(id)])?;
            emit_jira(state, &json!(id))?;
            Ok(Some(json_response(200, json!({"context":context}))))
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, extract::State, http::Request, Router};
    use std::sync::Mutex;

    #[test]
    fn identity_scope_and_status_normalization_match_jira_contract() {
        assert!(normalize_url(&json!("https://example.invalid/jira/")).is_ok());
        for url in [
            "ftp://example.invalid",
            "https://user:pass@example.invalid",
            "https://example.invalid/?token=secret",
        ] {
            assert!(normalize_url(&json!(url)).is_err());
        }
        let config = json!({"originId":"origin","accountId":"me","displayName":"Me","baseUrl":"http://127.0.0.1","projects":["JR"]});
        let issue = json!({"id":"42","key":"JR-42","fields":{"summary":"Title","description":"# one","status":{"name":"In Review","statusCategory":{"key":"indeterminate"}},"priority":{"name":"Highest"},"assignee":{"accountId":"me"},"reporter":{"accountId":"creator"},"project":{"key":"JR"},"labels":["same","same"," other "],"resolution":{"name":"Duplicate"},"issuelinks":[{"type":{"outward":"duplicates"},"outwardIssue":{"key":"JR-1"}}]}});
        assert_eq!(scope(&issue, &config), "inside");
        let normalized = normalized(&issue, &config, 0);
        assert_eq!(normalized["id"], "JIRA:ORIGIN:42");
        assert_eq!(normalized["status"], "in_review");
        assert_eq!(normalized["priority"], "urgent");
        assert_eq!(normalized["description"], "1. one");
        assert_eq!(normalized["labels"], json!(["same", "other"]));
        assert_eq!(normalized["duplicateOf"]["externalKey"], "JR-1");
    }

    async fn mock(
        State(calls): State<Arc<Mutex<Vec<(String, String, Value)>>>>,
        request: Request<Body>,
    ) -> Response {
        let method = request.method().to_string();
        let path = request.uri().path().to_owned();
        assert_eq!(
            request.headers().get("authorization").unwrap(),
            "Bearer private-test-token"
        );
        let bytes = axum::body::to_bytes(request.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        calls
            .lock()
            .unwrap()
            .push((method.clone(), path.clone(), body));
        let payload = match path.as_str() {
            "/rest/applinks/1.0/manifest" => json!({"id":"mock-jira-instance"}),
            "/rest/api/2/myself" => json!({"accountId":"me","displayName":"Tester"}),
            "/rest/api/2/search" => {
                json!({"total":1,"issues":[{"id":"1","key":"JR-1","fields":{"summary":"Remote issue","description":"# step","status":{"name":"Open","statusCategory":{"key":"new"}},"priority":{"name":"Medium"},"labels":[],"assignee":{"accountId":"me","displayName":"Tester"},"reporter":{"accountId":"reporter","displayName":"Reporter"},"project":{"key":"JR"},"created":"2026-11-26T00:00:00.000Z","updated":"2026-11-26T00:00:00.000Z"}}]})
            }
            "/rest/api/2/issue/JR-1" => {
                json!({"fields":{"status":{"name":"Open","statusCategory":{"key":"new"}}}})
            }
            "/rest/api/2/issue/JR-1/transitions" if method == "GET" => {
                json!({"transitions":[{"id":"31","name":"Start","to":{"name":"In Progress","statusCategory":{"key":"indeterminate"}}}]})
            }
            "/rest/api/2/issue/JR-1/transitions" => return super::super::empty_response(204),
            _ => return json_response(404, json!({"error":"unknown mock path"})),
        };
        json_response(200, payload)
    }

    #[tokio::test]
    async fn configure_sync_and_transition_use_stable_identity_and_keep_secrets_private() {
        let directory = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let router = Router::new().fallback(mock).with_state(calls.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let config = super::super::Config {
            data_dir: directory.path().join("data"),
            static_dir: directory.path().join("web"),
            project_root: directory.path().join("workspace"),
            host: "127.0.0.1".into(),
            port: 47823,
            instance_token: String::new(),
            instance_secret: String::new(),
            version: "test".into(),
            trusted_origins: HashSet::new(),
            codex_home: directory.path().join("codex"),
            listen_fd: None,
        };
        let state = AppState::open(config).unwrap();
        let connection=configure(&state,&json!({"baseUrl":format!("http://{address}"),"authMethod":"bearer","password":"private-test-token","projects":["JR"]})).await.unwrap();
        assert_eq!(connection["configured"], true);
        assert_eq!(connection["syncedIssueCount"], 1);
        assert!(!connection.to_string().contains("private-test-token"));
        let saved = read_config(&state).await.unwrap();
        assert_eq!(saved["version"], 3);
        assert_eq!(s(&saved["originId"]).len(), 64);
        assert_eq!(saved["accountId"], "me");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(state.config.data_dir.join("jira-connection.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let id = format!("JIRA:{}:1", s(&saved["originId"]).to_uppercase());
        let task = state.db("getTask", &[json!(id)]).unwrap();
        assert_eq!(task["version"], 1);
        assert_eq!(task["description"], "1. step");
        sync(&state, true, false).await.unwrap();
        assert_eq!(state.db("getTask", &[json!(id)]).unwrap()["version"], 1);
        let previous_searches = calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, path, _)| path.ends_with("/search"))
            .count();
        let (first, second) = tokio::join!(sync(&state, true, false), sync(&state, true, false));
        first.unwrap();
        second.unwrap();
        let next_searches = calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, path, _)| path.ends_with("/search"))
            .count();
        assert_eq!(next_searches, previous_searches + 1);
        move_task(&state, &task, "in_progress").await.unwrap();
        let calls = calls.lock().unwrap();
        assert!(calls.iter().any(|(method, path, body)| method == "POST"
            && path.ends_with("/transitions")
            && body["transition"]["id"] == "31"));
        assert!(calls.iter().any(|(method,path,body)|method=="POST"&&path.ends_with("/search")&&body["jql"]=="assignee = currentUser() AND project in (\"JR\") AND statusCategory != Done ORDER BY updated DESC"));
        drop(calls);
        server.abort();
    }
}
