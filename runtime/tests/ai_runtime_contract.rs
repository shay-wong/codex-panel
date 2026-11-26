#![cfg(unix)]

use serde_json::{json, Value};
use std::{
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    process::{Child, Command, Stdio},
    time::Duration,
};

struct Fixture {
    child: Child,
    base: String,
    _root: tempfile::TempDir,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Fixture {
    async fn start() -> Self {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let web = root.path().join("web");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&web).unwrap();
        std::fs::create_dir_all(root.path().join("tmp")).unwrap();
        std::fs::write(web.join("index.html"), "isolated").unwrap();
        let fake = root.path().join("fake-codex");
        std::fs::write(&fake,r##"#!/usr/bin/python3
import json,sys,time,os,threading
root=os.path.dirname(__file__)
def log(value):
    with open(os.path.join(root,'app-log.jsonl'),'a') as output: output.write(json.dumps(dict(value,pid=os.getpid()))+'\n')
if len(sys.argv)>1 and sys.argv[1]=='app-server':
    for line in sys.stdin:
        call=json.loads(line)
        if 'id' not in call: continue
        method=call.get('method')
        log({'method':method})
        result={}
        if method=='model/list': result={'data':[{'model':'fixture-model','displayName':'Fixture model','defaultReasoningEffort':'medium','supportedReasoningEfforts':[{'reasoningEffort':'medium'}]}],'nextCursor':None}
        elif method=='skills/list': result={'data':[]}
        elif method=='thread/start' and os.path.exists(os.path.join(root,'fail-thread-start')):
            print(json.dumps({'id':call['id'],'error':{'code':-32000,'message':'fixture thread start failed'}}),flush=True)
            continue
        elif method in ['thread/start','thread/resume']: result={'thread':{'id':'fixture-app-thread'}}
        elif method=='turn/start': result={'turn':{'id':'fixture-app-turn'}}
        print(json.dumps({'id':call['id'],'result':result}),flush=True)
        if method=='thread/compact/start': threading.Timer(0.05,lambda:log({'method':'fixture-compact-completed'})).start()
        if method=='turn/start':
            print(json.dumps({'method':'turn/started','params':{'threadId':'fixture-app-thread','turn':{'id':'fixture-app-turn'}}}),flush=True)
            print(json.dumps({'method':'item/completed','params':{'threadId':'fixture-app-thread','turnId':'fixture-app-turn','item':{'id':'app-answer','type':'agentMessage','text':'fixture app answer'}}}),flush=True)
            print(json.dumps({'method':'turn/completed','params':{'threadId':'fixture-app-thread','turn':{'id':'fixture-app-turn','status':'completed'}}}),flush=True)
else:
    prompt=sys.stdin.read()
    if '--ephemeral' in sys.argv:
        sys.stdout.write(json.dumps({'type':'item.completed','item':{'id':'answer','type':'agent_message','text':'fixture final line','status':'completed'}}))
        sys.stdout.flush()
        sys.exit(0)
    if 'malformed-fixture' in prompt:
        print('invalid-json',flush=True)
        time.sleep(10)
    else:
        print(json.dumps({'type':'thread.started','thread_id':'fixture-thread'}),flush=True)
        print(json.dumps({'type':'turn.started'}),flush=True)
        if 'wait-fixture' in prompt: time.sleep(30)
        print(json.dumps({'type':'item.completed','item':{'id':'answer','type':'agent_message','text':'fixture answer','status':'completed'}}),flush=True)
        print(json.dumps({'type':'turn.completed','usage':{'input_tokens':2,'output_tokens':3}}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        // 所有真实凭据与目录都隔离；替身只说协议，不访问 Codex 或任何外部服务。
        let child = Command::new(env!("CARGO_BIN_EXE_codex-panel-runtime"))
            .env_clear()
            .env("HOME", root.path())
            .env("USERPROFILE", root.path())
            .env("CODEX_HOME", root.path().join("codex"))
            .env("TMPDIR", root.path().join("tmp"))
            .env("CODEX_BIN", &fake)
            .env("PATH", "/usr/bin:/bin")
            .args([
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--data-dir",
            ])
            .arg(root.path().join("data"))
            .arg("--static-dir")
            .arg(&web)
            .arg("--app-root")
            .arg(&workspace)
            .current_dir(&workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut fixture = Self {
            child,
            base: format!("http://127.0.0.1:{port}"),
            _root: root,
        };
        for _ in 0..200 {
            if reqwest::get(format!("{}/health", fixture.base))
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                return fixture;
            }
            assert!(fixture.child.try_wait().unwrap().is_none(), "server exited");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("isolated server did not start");
    }
    async fn request(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let mut request = reqwest::Client::new().request(
            reqwest::Method::from_bytes(method.as_bytes()).unwrap(),
            format!("{}{path}", self.base),
        );
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (
            status,
            serde_json::from_str(&text).unwrap_or_else(|_| panic!("HTTP {status}: {text}")),
        )
    }
    async fn thread(&self) -> String {
        let path = self._root.path().join("workspace");
        let (status, project) = self
            .request(
                "POST",
                "/api/projects",
                Some(json!({"id":"fixture","name":"Fixture","workspacePath":path})),
            )
            .await;
        assert_eq!(status, 201, "{project}");
        let(status,thread)=self.request("POST","/api/local/ai/threads",Some(json!({"projectId":"fixture","model":"fixture-model","reasoningEffort":"medium"}))).await;
        assert_eq!(status, 201, "{thread}");
        thread["thread"]["id"].as_str().unwrap().into()
    }
    async fn wait_run(&self, id: &str) -> Value {
        for _ in 0..200 {
            let (_, snapshot) = self
                .request("GET", &format!("/api/local/ai/threads/{id}"), None)
                .await;
            let run = snapshot["runs"]
                .as_array()
                .and_then(|v| v.last())
                .cloned()
                .unwrap_or(Value::Null);
            if !run.is_null() && run["status"] != "running" {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("run did not finish")
    }
}

#[tokio::test]
async fn isolated_native_turn_persists_events_and_interrupts_owned_process() {
    let fixture = Fixture::start().await;
    let thread = fixture.thread().await;
    let (status, created) = fixture
        .request(
            "POST",
            &format!("/api/local/ai/threads/{thread}/turns"),
            Some(json!({"message":"hello fixture"})),
        )
        .await;
    assert_eq!(status, 202, "{created}");
    let snapshot = fixture.wait_run(&thread).await;
    assert_eq!(snapshot["runs"][0]["status"], "completed", "{snapshot}");
    assert!(snapshot["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["role"] == "assistant" && event["content"] == "fixture answer"));
    let (status, waiting) = fixture
        .request(
            "POST",
            &format!("/api/local/ai/threads/{thread}/turns"),
            Some(json!({"message":"wait-fixture"})),
        )
        .await;
    assert_eq!(status, 202, "{waiting}");
    let run = waiting["run"]["id"].as_str().unwrap();
    let (status, interrupted) = fixture
        .request("POST", &format!("/api/local/ai/runs/{run}/interrupt"), None)
        .await;
    assert_eq!(status, 200, "{interrupted}");
    assert_eq!(interrupted["run"]["status"], "interrupted");
}

#[tokio::test]
async fn malformed_jsonl_fails_without_hanging_the_turn() {
    let fixture = Fixture::start().await;
    let thread = fixture.thread().await;
    let (status, created) = fixture
        .request(
            "POST",
            &format!("/api/local/ai/threads/{thread}/turns"),
            Some(json!({"message":"malformed-fixture"})),
        )
        .await;
    assert_eq!(status, 202, "{created}");
    let snapshot = fixture.wait_run(&thread).await;
    assert_eq!(snapshot["runs"][0]["status"], "failed", "{snapshot}");
    assert!(snapshot["runs"][0]["error"]
        .as_str()
        .unwrap()
        .contains("malformed JSONL"));
}

#[tokio::test]
async fn comment_cursor_returns_only_later_changes_without_internal_fields() {
    let fixture = Fixture::start().await;
    let (status, created) = fixture
        .request(
            "POST",
            "/api/tasks",
            Some(json!({"title":"cursor fixture"})),
        )
        .await;
    assert_eq!(status, 201, "{created}");
    let id = created["task"]["id"].as_str().unwrap();
    let (status, first) = fixture
        .request(
            "POST",
            &format!("/api/tasks/{id}/comments"),
            Some(json!({"body":"first"})),
        )
        .await;
    assert_eq!(status, 201, "{first}");
    let (status, list) = fixture
        .request("GET", &format!("/api/tasks/{id}/comments"), None)
        .await;
    assert_eq!(status, 200, "{list}");
    let cursor = list["nextCursor"].as_str().unwrap();
    assert_ne!(cursor, "0");
    assert_eq!(list["comments"].as_array().unwrap().len(), 1);
    assert!(list["comments"][0].get("changeRevision").is_none());
    fixture
        .request(
            "POST",
            &format!("/api/tasks/{id}/comments"),
            Some(json!({"body":"second"})),
        )
        .await;
    let (status, later) = fixture
        .request(
            "GET",
            &format!("/api/tasks/{id}/comments?after={cursor}"),
            None,
        )
        .await;
    assert_eq!(status, 200, "{later}");
    assert_eq!(later["comments"].as_array().unwrap().len(), 1);
    assert_eq!(later["comments"][0]["body"], "second");
    assert_ne!(later["nextCursor"], cursor);
}

#[tokio::test]
async fn readonly_generation_accepts_an_unterminated_final_jsonl_record() {
    let fixture = Fixture::start().await;
    fixture.thread().await;
    let (status, result) = fixture
        .request("POST", "/api/local/projects/fixture/summary", None)
        .await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["summary"], "fixture final line", "{result}");
}

#[tokio::test]
async fn device_workspaces_skip_missing_roots_and_include_project_fallback() {
    let fixture = Fixture::start().await;
    fixture.thread().await;
    let home = fixture._root.path().join("codex");
    std::fs::create_dir_all(&home).unwrap();
    let workspace = std::fs::canonicalize(fixture._root.path().join("workspace")).unwrap();
    std::fs::write(home.join(".codex-global-state.json"),json!({"local-projects":{"mapped":{"rootPaths":[fixture._root.path().join("missing"),workspace]}}}).to_string()).unwrap();
    let (status, result) = fixture.request("GET", "/api/device-workspaces", None).await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["workspaces"]["mapped"], json!(workspace));
    assert_eq!(result["workspaces"]["fixture"], json!(workspace));
}

#[tokio::test]
async fn cloud_binary_responses_stream_before_the_upstream_finishes() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (release, waiting) = tokio::sync::oneshot::channel::<()>();
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 4096];
        let _ = socket.read(&mut request).await.unwrap();
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n").await.unwrap();
        socket.flush().await.unwrap();
        let _ = waiting.await;
        socket.write_all(b"5\r\nworld\r\n0\r\n\r\n").await.unwrap();
    });
    let fixture = Fixture::start().await;
    let(status,configured)=fixture.request("PUT","/api/local/cloud-session",Some(json!({"remoteUrl":format!("http://{address}"),"actorName":"fixture","sharedKey":"isolated-test-key"}))).await;
    assert_eq!(status, 200, "{configured}");
    // 上游尚未结束时必须可读到第一块数据；整体缓冲的实现会在这里超时。
    let mut response = tokio::time::timeout(
        Duration::from_secs(2),
        reqwest::get(format!("{}/api/stream-fixture", fixture.base)),
    )
    .await
    .expect("proxy buffered response headers")
    .unwrap();
    let first = tokio::time::timeout(Duration::from_secs(2), response.chunk())
        .await
        .expect("proxy buffered the entire response")
        .unwrap()
        .unwrap();
    assert_eq!(&first[..], b"hello");
    release.send(()).unwrap();
    assert_eq!(response.text().await.unwrap(), "world");
    upstream.await.unwrap();
}

#[tokio::test]
async fn composer_reuses_app_server_and_cleans_attachments_after_start_failure() {
    let fixture = Fixture::start().await;
    let thread = fixture.thread().await;
    let body = |message: &str| json!({"contractVersion":"composer.v1","revision":"fixture-revision","document":{"version":1,"nodes":[{"type":"text","text":message}]},"attachments":[{"filename":"fixture.txt","contentType":"text/plain","dataBase64":"aGVsbG8="}]});
    let marker = fixture._root.path().join("fail-thread-start");
    std::fs::write(&marker, "").unwrap();
    let (status, failure) = fixture
        .request(
            "POST",
            &format!("/api/local/ai/threads/{thread}/turns"),
            Some(body("fail to start")),
        )
        .await;
    assert_eq!(status, 502, "{failure}");
    assert_eq!(
        std::fs::read_dir(fixture._root.path().join("tmp"))
            .unwrap()
            .count(),
        0,
        "failed start left attachment files"
    );
    std::fs::remove_file(marker).unwrap();
    for message in ["first composer turn", "second composer turn"] {
        let (status, started) = fixture
            .request(
                "POST",
                &format!("/api/local/ai/threads/{thread}/turns"),
                Some(body(message)),
            )
            .await;
        assert_eq!(status, 202, "{started}");
        let snapshot = fixture.wait_run(&thread).await;
        assert_eq!(
            snapshot["runs"].as_array().unwrap().last().unwrap()["status"],
            "completed",
            "{snapshot}"
        );
    }
    let (status, compact) = fixture
        .request(
            "POST",
            &format!("/api/local/ai/threads/{thread}/compact"),
            None,
        )
        .await;
    assert_eq!(status, 200, "{compact}");
    let mut log = Vec::new();
    for _ in 0..100 {
        log = std::fs::read_to_string(fixture._root.path().join("app-log.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect();
        if log
            .iter()
            .any(|call| call["method"] == "fixture-compact-completed")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        log.iter()
            .any(|call| call["method"] == "fixture-compact-completed"),
        "compact connection closed before completion: {log:?}"
    );
    let pids = log
        .iter()
        .filter(|call| {
            [
                "thread/start",
                "thread/resume",
                "turn/start",
                "thread/compact/start",
            ]
            .contains(&call["method"].as_str().unwrap_or(""))
        })
        .map(|call| call["pid"].as_u64().unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        pids.len(),
        1,
        "composer created a new app-server for each operation"
    );
    let remaining = std::fs::read_dir(fixture._root.path().join("tmp"))
        .unwrap()
        .count();
    assert_eq!(remaining, 0);
}
