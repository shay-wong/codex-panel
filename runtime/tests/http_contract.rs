use serde_json::{json, Value};
use std::{
    net::TcpListener,
    process::{Child, Command, Stdio},
    time::Duration,
};

struct Server {
    child: Child,
    base: String,
    _data: tempfile::TempDir,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Server {
    async fn start() -> Self {
        let data = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let workspace = data.path().join("workspace");
        let web = data.path().join("web");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&web).unwrap();
        std::fs::write(
            web.join("index.html"),
            "<!doctype html><title>isolated fixture</title>",
        )
        .unwrap();
        // 所有可写路径和 Codex 查找路径都留在本次临时目录，不复用日常实例。
        let child = Command::new(env!("CARGO_BIN_EXE_codex-panel-runtime"))
            .env_clear()
            .env("HOME", data.path())
            .env("USERPROFILE", data.path())
            .env("CODEX_HOME", data.path().join("codex"))
            .current_dir(&workspace)
            .args([
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--data-dir",
            ])
            .arg(data.path().join("data"))
            .arg("--static-dir")
            .arg(&web)
            .arg("--app-root")
            .arg(&workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut server = Self {
            child,
            base: format!("http://127.0.0.1:{port}"),
            _data: data,
        };
        let client = reqwest::Client::new();
        for _ in 0..100 {
            if client
                .get(format!("{}/health", server.base))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                return server;
            }
            assert!(
                server.child.try_wait().unwrap().is_none(),
                "isolated server exited during startup"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        panic!("isolated server did not become ready");
    }

    async fn request(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let client = reqwest::Client::new();
        let mut request = client.request(
            reqwest::Method::from_bytes(method.as_bytes()).unwrap(),
            format!("{}{path}", self.base),
        );
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let body = response.text().await.unwrap();
        let value = serde_json::from_str(&body)
            .unwrap_or_else(|_| panic!("unexpected HTTP {status} body: {body}"));
        (status, value)
    }
}

#[tokio::test]
async fn native_server_keeps_task_versions_and_relation_transactions() {
    let server = Server::start().await;
    let project = json!({"id":"project","name":"迁移验证","issueKey":"RUST"});
    let (status, response) = server.request("POST", "/api/projects", Some(project)).await;
    assert_eq!(status, 201, "{response}");
    let (status, created) = server
        .request(
            "POST",
            "/api/tasks",
            Some(json!({"projectId":"project","title":"first","threadId":"isolated-thread"})),
        )
        .await;
    assert_eq!(status, 201, "{created}");
    let task = &created["task"];
    let id = task["id"].as_str().unwrap();
    assert_eq!(task["status"], "backlog");
    assert_eq!(task["version"], 1);
    let (status, updated) = server
        .request(
            "PATCH",
            &format!("/api/tasks/{id}"),
            Some(json!({"title":"updated","version":1,"threadId":"isolated-thread"})),
        )
        .await;
    assert_eq!(status, 200, "{updated}");
    assert_eq!(updated["task"]["version"], 2);
    let (status, conflict) = server
        .request(
            "PATCH",
            &format!("/api/tasks/{id}"),
            Some(json!({"title":"stale","version":1,"threadId":"isolated-thread"})),
        )
        .await;
    assert_eq!(status, 409, "{conflict}");
    assert_eq!(conflict["error"]["code"], "VERSION_CONFLICT");
    let (_, fresh) = server
        .request("GET", &format!("/api/tasks/{id}"), None)
        .await;
    assert_eq!(fresh["task"]["title"], "updated");
    let (status, second) = server
        .request(
            "POST",
            "/api/tasks",
            Some(json!({"projectId":"project","title":"second","threadId":"isolated-thread"})),
        )
        .await;
    assert_eq!(status, 201, "{second}");
    let child = second["task"]["id"].as_str().unwrap();
    let (status, linked) = server
        .request(
            "POST",
            &format!("/api/tasks/{child}/relations/parent/{id}"),
            Some(json!({"version":1,"threadId":"isolated-thread"})),
        )
        .await;
    assert_eq!(status, 200, "{linked}");
    let (status, cycle) = server
        .request(
            "POST",
            &format!("/api/tasks/{id}/relations/parent/{child}"),
            Some(json!({"version":2,"threadId":"isolated-thread"})),
        )
        .await;
    assert_eq!(status, 409, "{cycle}");
}

#[tokio::test]
async fn native_handoff_publishes_the_exact_document_and_rejects_archived_issues() {
    let server = Server::start().await;
    let (_, created) = server
        .request(
            "POST",
            "/api/tasks",
            Some(json!({"title":"handoff fixture"})),
        )
        .await;
    let id = created["task"]["id"].as_str().unwrap();
    let handoff = "\n# Session handoff\n\n保留原始验收结论。\n\n";
    let file = server._data.path().join("handoff.md");
    std::fs::write(&file, handoff).unwrap();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_panelctl"))
            .env_clear()
            .env("HOME", server._data.path())
            .env("USERPROFILE", server._data.path())
            .env("CODEX_PANEL_URL", &server.base)
            .env("CODEX_THREAD_ID", "handoff-thread")
            .current_dir(server._data.path())
            .args(["handoff", "publish", "--issue", id, "--handoff-file"])
            .arg(&file)
            .output()
            .unwrap()
    };
    let output = run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["comment"]["threadId"], "handoff-thread");
    assert_eq!(result["comment"]["body"],format!("<!-- codex-panel:ai-chat-handoff:v1 -->\n### AI 对话交接\n\n{handoff}\n\n> 来源：全局 Codex 对话（`$handoff-panel`）"));
    let (status, archived) = server
        .request(
            "POST",
            &format!("/api/tasks/{id}/archive"),
            Some(json!({"version":1,"threadId":"handoff-thread"})),
        )
        .await;
    assert_eq!(status, 200, "{archived}");
    let output = run();
    assert!(!output.status.success());
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert!(error["error"]["message"]
        .as_str()
        .unwrap()
        .contains("The handoff document remains at"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), handoff);
    let (_, comments) = server
        .request("GET", &format!("/api/tasks/{id}/comments"), None)
        .await;
    assert_eq!(comments["comments"].as_array().unwrap().len(), 1);
}
