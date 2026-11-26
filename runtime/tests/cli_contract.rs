use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    thread,
};

fn run_cli(args: &[&str], status: u16, response: Value) -> (std::process::Output, String, Value) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 1024];
        let (header_end, content_length) = loop {
            let count = stream.read(&mut chunk).unwrap();
            assert!(count > 0, "client disconnected before request headers");
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                break (end + 4, length);
            }
        };
        while bytes.len() < header_end + content_length {
            let count = stream.read(&mut chunk).unwrap();
            assert!(count > 0, "client disconnected before request body");
            bytes.extend_from_slice(&chunk[..count]);
        }
        let header = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
        let body = if content_length == 0 {
            Value::Null
        } else {
            serde_json::from_slice(&bytes[header_end..header_end + content_length]).unwrap()
        };
        let text = response.to_string();
        write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len()).unwrap();
        (header, body)
    });
    // 测试仅访问本次分配的回环端口，不继承用户的实例、账号或工作区配置。
    let sandbox = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_panelctl"))
        .env_clear()
        .env("HOME", sandbox.path())
        .env("USERPROFILE", sandbox.path())
        .env("CODEX_PANEL_URL", format!("http://{address}/"))
        .current_dir(sandbox.path())
        .args(args)
        .output()
        .unwrap();
    let (header, body) = server.join().unwrap();
    (output, header, body)
}

#[test]
fn create_preserves_external_identity_and_existing_wire_shape() {
    let (output, header, body) = run_cli(
        &[
            "issue",
            "create",
            "--project",
            "project",
            "--title",
            "中文标题",
            "--agent-platform",
            "pi",
            "--session-id",
            "/tmp/session one",
            "--labels",
            "one,two,one",
        ],
        201,
        json!({"task":{"id":"task"}}),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(header.starts_with("POST /api/tasks HTTP/1.1"));
    assert_eq!(
        body,
        json!({"projectId":"project","title":"中文标题","description":"",
        "status":"backlog","priority":"none","labels":["one","two"],
        "agentSession":{"platform":"pi","sessionId":"/tmp/session one"}})
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["schemaVersion"],
        2
    );
}

#[test]
fn conflict_preserves_exit_code_and_server_details() {
    let (output, header, body) = run_cli(
        &[
            "issue",
            "update",
            "A/1",
            "--title",
            "new",
            "--thread-id",
            "thread",
            "--if-version",
            "3",
        ],
        409,
        json!({"error":{"code":"VERSION_CONFLICT","message":"changed","details":{"version":4}}}),
    );
    assert_eq!(output.status.code(), Some(5));
    assert!(header.starts_with("PATCH /api/tasks/A%2F1 HTTP/1.1"));
    assert_eq!(body["version"], 3);
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["details"], json!({"version":4}));
}

#[test]
fn invalid_options_fail_without_network_or_user_state() {
    let sandbox = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_panelctl"))
        .env_clear()
        .env("HOME", sandbox.path())
        .current_dir(sandbox.path())
        .args(["issue", "get", "A", "--unknown", "value"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stderr).unwrap()["error"]["code"],
        "USAGE_ERROR"
    );
}

#[test]
fn handoff_reports_the_saved_document_when_runtime_resolution_fails() {
    let sandbox = tempfile::tempdir().unwrap();
    let file = sandbox.path().join("handoff.md");
    std::fs::write(&file, "already saved handoff\n").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_panelctl"))
        .env_clear()
        .env("HOME", sandbox.path())
        .env("USERPROFILE", sandbox.path())
        .env("CODEX_HOME", sandbox.path().join("codex"))
        .env(
            "CODEX_PANEL_RUNTIME_FILE",
            sandbox.path().join("missing-runtime.json"),
        )
        .env("CODEX_THREAD_ID", "fixture-thread")
        .current_dir(sandbox.path())
        .args(["handoff", "publish", "--issue", "LOCAL-1", "--handoff-file"])
        .arg(&file)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert!(error["error"]["message"]
        .as_str()
        .unwrap()
        .contains(&format!(
            "The handoff document remains at {}",
            file.display()
        )));
    assert_eq!(
        std::fs::read_to_string(file).unwrap(),
        "already saved handoff\n"
    );
}
