use codex_panel_runtime::database::Database;
use serde_json::{json, Value};
use std::{path::Path, process::Command};

fn normalize(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for key in ["activityKey", "changeRevision"] {
                object.remove(key);
            }
            for value in object.values_mut() {
                normalize(value);
            }
        }
        Value::Array(values) => {
            for value in values {
                normalize(value);
            }
        }
        Value::String(text) => {
            if regex::Regex::new(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
                .unwrap()
                .is_match(text)
            {
                *text = "timestamp".into();
            } else if uuid::Uuid::parse_str(text).is_ok() {
                *text = "generated-id".into();
            }
        }
        Value::Number(number) => {
            if let Some(number) = number.as_f64() {
                *value = json!(number);
            }
        }
        _ => {}
    }
}

#[test]
fn core_database_wire_values_match_the_previous_runtime() {
    let temporary = tempfile::tempdir().unwrap();
    let actor = json!({"type":"user","id":"test-user","name":"测试用户","avatarUrl":null});
    let undefined = json!({"$panelUndefined":true});
    let task = |id: &str| json!({"id":id,"projectId":"test","title":id,"description":"plain","status":"todo","priority":"medium","labels":["label"],"actor":actor,"assignee":actor});
    let operations = vec![
        json!(["createProject",[{"id":"test","name":"测试","issueKey":"TEST","workspacePath":null}]]),
        json!(["createTask", [task("one")]]),
        json!(["createTask", [task("two")]]),
        json!(["listProjects", []]),
        json!(["getTask", ["one"]]),
        json!(["listTasks",[{"projectId":"test"}]]),
        json!(["updateTask",["one",1,{"title":"更新"},undefined,undefined,actor,undefined]]),
        json!(["createComment",["one",{"body":"comment","actor":actor}]]),
        json!(["listComments", ["one"]]),
        json!(["saveProjectReadme", ["test", "# 项目说明", 0]]),
        json!(["getProjectReadme", ["test"]]),
        json!(["getTask", ["one"]]),
        json!(["getTaskTree", ["one", "descendants", 3]]),
    ];
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let script = r#"
import {pathToFileURL} from 'node:url';
const {PanelDatabase}=await import(pathToFileURL(process.argv[1]+'/server/database.mjs'));
const ops=JSON.parse(process.argv[3]);
const revive=value=>Array.isArray(value)?value.map(revive):value&&typeof value==='object'?(value.$panelUndefined===true?undefined:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,revive(v)]))):value;
const db=new PanelDatabase(process.argv[2]);
try{console.log(JSON.stringify(ops.map(([method,args])=>db[method](...revive(args)))))}finally{db.close()}
"#;
    // 旧引擎只操作本测试的 SQLite，用作迁移对照；交付的原生程序不调用 Node。
    let output = Command::new("node")
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", temporary.path())
        .env("USERPROFILE", temporary.path())
        .env("CODEX_HOME", temporary.path().join("codex"))
        .current_dir(temporary.path())
        .args(["--input-type=module", "-e", script])
        .arg(source)
        .arg(temporary.path().join("previous.sqlite"))
        .arg(serde_json::to_string(&operations).unwrap())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut expected: Value = serde_json::from_slice(&output.stdout).unwrap();
    let mut db = Database::open(&temporary.path().join("native.sqlite")).unwrap();
    let mut actual = json!(operations
        .iter()
        .map(|op| db
            .call(op[0].as_str().unwrap(), op[1].as_array().unwrap())
            .unwrap_or_else(|e| panic!("{}: {e}", op[0])))
        .collect::<Vec<_>>());
    normalize(&mut expected);
    normalize(&mut actual);
    for (index, (expected, actual)) in expected
        .as_array()
        .unwrap()
        .iter()
        .zip(actual.as_array().unwrap())
        .enumerate()
    {
        assert_eq!(
            actual, expected,
            "operation {}: {}",
            index, operations[index][0]
        );
    }
}
