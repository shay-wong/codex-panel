use super::*;

fn actor() -> Value {
    json!({"type":"user","id":"local-user","name":"本地用户","avatarUrl":null})
}
fn input(id: &str, project: &str) -> Value {
    json!({"id":id,"projectId":project,"title":id,"description":"","status":"todo","priority":"medium","labels":[],"actor":actor(),"assignee":actor()})
}
fn database() -> (tempfile::TempDir, Database) {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(&directory.path().join("test.sqlite")).unwrap();
    (directory, db)
}
fn undefined() -> Value {
    json!({"$panelUndefined":true})
}
fn call(db: &mut Database, method: &str, args: Vec<Value>) -> Value {
    db.call(method, &args)
        .unwrap_or_else(|e| panic!("{method}: {} {}", e.code, e.message))
}
fn remote_issue(id: &str, origin: &str, status: &str) -> Value {
    json!({"id":format!("jira:{origin}:{id}"),"identifier":format!("JIRA:{origin}:{id}"),"title":id,"description":"# first\n# second","status":status,"priority":"high","labels":["jira"],"sortOrder":1000,"creator":actor(),"assignee":actor(),"dueDate":null,"externalOrigin":origin,"externalId":id,"externalKey":format!("JR-{id}"),"externalUrl":"https://example.invalid/issue","externalStatus":status,"externalUpdatedAt":"2026-11-26T01:00:00.000Z","archived":false,"createdAt":"2026-11-26T00:00:00.000Z","updatedAt":"2026-11-26T01:00:00.000Z"})
}

#[test]
fn task_versions_readme_and_binding_remain_compatible() {
    let (_directory, mut db) = database();
    let mut task = input("first", "local");
    task["threadBinding"] = json!({"threadId":"thread","codexProjectId":"project","codexProjectKind":"local","codexHostId":"local","workspacePath":"/tmp/isolated"});
    let created = call(&mut db, "createTask", vec![task]);
    assert_eq!(created["identifier"], "LOCAL-1");
    let updated = call(
        &mut db,
        "updateTask",
        vec![
            json!("first"),
            json!(1),
            json!({"title":"changed"}),
            undefined(),
            undefined(),
            actor(),
            undefined(),
        ],
    );
    assert_eq!(updated["version"], 2);
    assert_eq!(updated["threadBinding"], created["threadBinding"]);
    let conflict = db
        .call(
            "updateTask",
            &[
                json!("first"),
                json!(1),
                json!({"title":"lost"}),
                undefined(),
                undefined(),
                actor(),
            ],
        )
        .unwrap_err();
    assert_eq!(conflict.code, "VERSION_CONFLICT");
    assert_eq!(
        call(&mut db, "getTask", vec![json!("first")])["title"],
        "changed"
    );
    let readme = call(
        &mut db,
        "saveProjectReadme",
        vec![json!("local"), json!("hello"), Value::Null],
    );
    assert_eq!(readme["version"], 1);
    assert_eq!(
        db.call(
            "saveProjectReadme",
            &[json!("local"), json!("lost"), json!(0)]
        )
        .unwrap_err()
        .code,
        "VERSION_CONFLICT"
    );
    let cleared = call(
        &mut db,
        "updateTask",
        vec![
            json!("first"),
            json!(2),
            json!({}),
            undefined(),
            Value::Null,
            actor(),
            undefined(),
        ],
    );
    assert!(cleared["threadBinding"].is_null());
}

#[test]
fn parent_cycles_and_cross_project_boundaries_are_enforced() {
    let (_directory, mut db) = database();
    call(
        &mut db,
        "createProject",
        vec![json!({"id":"temp-other","name":"Other","workspacePath":null})],
    );
    for (name, project) in [("a", "local"), ("b", "local"), ("c", "temp-other")] {
        call(&mut db, "createTask", vec![input(name, project)]);
    }
    call(
        &mut db,
        "addTaskRelation",
        vec![
            json!("b"),
            json!(1),
            json!("parent"),
            json!("a"),
            undefined(),
            undefined(),
            actor(),
        ],
    );
    let error = db
        .call(
            "addTaskRelation",
            &[
                json!("a"),
                json!(1),
                json!("parent"),
                json!("b"),
                undefined(),
                undefined(),
                actor(),
            ],
        )
        .unwrap_err();
    assert_eq!(error.code, "RELATION_CYCLE");
    let error = db
        .call(
            "addTaskRelation",
            &[
                json!("a"),
                json!(1),
                json!("related"),
                json!("c"),
                undefined(),
                undefined(),
                actor(),
            ],
        )
        .unwrap_err();
    assert_eq!(error.code, "CROSS_PROJECT_RELATION");
    call(
        &mut db,
        "addTaskRelation",
        vec![
            json!("a"),
            json!(1),
            json!("blocks"),
            json!("c"),
            undefined(),
            undefined(),
            actor(),
        ],
    );
    let a = call(&mut db, "getTask", vec![json!("a")]);
    assert_eq!(a["relations"]["blocks"][0]["id"], "c");
    assert_eq!(a["relations"]["subIssues"][0]["id"], "b");
    let tree = call(
        &mut db,
        "getTaskTree",
        vec![json!("a"), json!("descendants"), json!(2)],
    );
    assert_eq!(tree["nodeCount"], 2);
    let failed_commit=db.transaction(||{
        db.batch("PRAGMA defer_foreign_keys=ON")?;
        db.run("INSERT INTO jira_task_projects(jira_task_id,project_id,created_at) VALUES('missing','local','now')",&[])?;
        Ok(())
    });
    assert!(failed_commit.is_err());
    assert!(db.connection.is_autocommit());
    assert!(db
        .get(
            "SELECT * FROM jira_task_projects WHERE jira_task_id='missing'",
            &[]
        )
        .unwrap()
        .is_null());
}

#[test]
fn comments_attachments_and_incremental_revisions_are_atomic() {
    let (_directory, mut db) = database();
    call(&mut db, "createTask", vec![input("a", "local")]);
    let comment = call(
        &mut db,
        "createComment",
        vec![json!("a"), json!({"body":"first","actor":actor()})],
    );
    let file = call(
        &mut db,
        "createCommentAttachment",
        vec![
            comment["id"].clone(),
            json!({"id":"image","kind":"inline","filename":"test.png","contentType":"image/png","size":2}),
        ],
    );
    assert!(file["changeRevision"].as_i64().unwrap() > comment["changeRevision"].as_i64().unwrap());
    let updated = call(
        &mut db,
        "updateComment",
        vec![
            comment["id"].clone(),
            json!(1),
            json!("updated"),
            undefined(),
            undefined(),
            undefined(),
        ],
    );
    assert_eq!(updated["attachments"][0]["bodyFallback"], false);
    let changed = call(
        &mut db,
        "listCommentsAfter",
        vec![json!("a"), json!({"revision":comment["changeRevision"]})],
    );
    assert_eq!(changed[0]["version"], 2);
    call(
        &mut db,
        "deleteComment",
        vec![comment["id"].clone(), json!(2)],
    );
    assert!(call(&mut db, "getAttachment", vec![json!("image")]).is_null());
}

#[test]
fn automatic_claims_skip_excluded_labels_without_changing_manual_or_resume_claims() {
    let (_directory, mut db) = database();
    let at = json!("2099-01-01T00:00:00.000Z");
    call(
        &mut db,
        "saveProjectAutomationPolicy",
        vec![json!("local"), json!({"enabledByUser":true,"paused":false,"intervalMinutes":5,"model":"fixture-model","reasoningEffort":"high"})],
    );
    for (id, labels) in [
        ("normal", json!([])),
        ("imported", json!([" SSH-IMPORT "])),
        ("excluded", json!(["No-Auto-Claim"])),
    ] {
        let mut task = input(id, "local");
        task["labels"] = labels;
        call(&mut db, "createTask", vec![task]);
    }
    let set_labels = |db: &mut Database, id: &str, labels: Value| {
        let task = call(db, "getTask", vec![json!(id)]);
        call(
            db,
            "updateTask",
            vec![
                json!(id),
                task["version"].clone(),
                json!({"labels":labels}),
                undefined(),
                undefined(),
                actor(),
            ],
        );
    };
    let queued = call(&mut db, "enqueueDueProjectScans", vec![at.clone()]);
    assert_eq!(queued.as_array().unwrap().len(), 1);
    assert_eq!(queued[0]["taskId"], "normal");
    for id in ["imported", "excluded"] {
        assert!(call(&mut db, "getClaimQueueItem", vec![json!(id)]).is_null());
    }

    set_labels(&mut db, "normal", json!(["no-auto-claim"]));
    assert!(call(&mut db, "nextClaim", vec![at.clone()]).is_null());
    assert_eq!(
        call(&mut db, "getClaimQueueItem", vec![json!("normal")])["state"],
        "queued"
    );
    set_labels(&mut db, "normal", json!([]));
    assert_eq!(
        call(&mut db, "nextClaim", vec![at.clone()])["task"]["id"],
        "normal"
    );
    call(&mut db, "markClaimRunning", vec![json!("normal")]);
    call(
        &mut db,
        "scheduleClaimRetry",
        vec![json!("normal"), json!("temporary"), at.clone()],
    );
    set_labels(&mut db, "normal", json!(["ssh-import"]));
    assert_eq!(
        call(&mut db, "nextClaim", vec![at.clone()])["claim"]["source"],
        "resume"
    );
    call(&mut db, "markClaimRunning", vec![json!("normal")]);
    call(
        &mut db,
        "finishClaim",
        vec![json!("normal"), json!("completed")],
    );

    call(
        &mut db,
        "enqueueClaim",
        vec![json!("imported"), json!("jira")],
    );
    assert!(call(&mut db, "nextClaim", vec![at.clone()]).is_null());
    call(
        &mut db,
        "enqueueClaim",
        vec![json!("imported"), json!("manual")],
    );
    call(
        &mut db,
        "enqueueClaim",
        vec![json!("excluded"), json!("resume")],
    );
    let ready = call(&mut db, "listReadyClaims", vec![at]);
    assert_eq!(ready[0]["task"]["id"], "imported");
    assert_eq!(ready[1]["task"]["id"], "excluded");
}

#[test]
fn claims_preserve_priority_and_native_binding() {
    let (_directory, mut db) = database();
    for name in ["a", "b"] {
        call(&mut db, "createTask", vec![input(name, "local")]);
    }
    call(&mut db, "enqueueClaim", vec![json!("a"), json!("scan")]);
    call(&mut db, "enqueueClaim", vec![json!("a"), json!("manual")]);
    call(&mut db, "enqueueClaim", vec![json!("b"), json!("resume")]);
    let ready = call(
        &mut db,
        "listReadyClaims",
        vec![json!("2099-01-01T00:00:00.000Z")],
    );
    assert_eq!(ready[0]["task"]["id"], "a");
    call(&mut db, "markClaimRunning", vec![json!("a"), json!(true)]);
    let bound = call(
        &mut db,
        "bindNativeClaim",
        vec![
            json!("a"),
            json!({"threadId":"native","codexProjectId":"project","codexProjectKind":"local","codexHostId":"local","workspacePath":"/tmp/isolated"}),
            actor(),
            json!({"type":"branch","branch":"feature"}),
        ],
    );
    assert_eq!(bound["task"]["status"], "in_progress");
    assert_eq!(bound["claim"]["threadId"], "native");
    assert_eq!(bound["attempt"]["status"], "running");
    call(
        &mut db,
        "moveTask",
        vec![
            json!("a"),
            bound["task"]["version"].clone(),
            json!("done"),
            Value::Null,
            undefined(),
            undefined(),
            actor(),
            undefined(),
        ],
    );
    call(&mut db, "reconcileClaimQueue", vec![]);
    assert_eq!(
        call(&mut db, "getClaimQueueItem", vec![json!("a")])["state"],
        "completed"
    );
}

#[test]
fn jira_sync_keeps_origin_identity_and_does_not_bump_unchanged_versions() {
    let (_directory, mut db) = database();
    let issue = remote_issue("1", "site-a", "todo");
    let options =
        json!({"projectName":"Jira","originId":"site-a","syncedAt":"2026-11-26T01:00:00.000Z"});
    call(
        &mut db,
        "syncJiraTasks",
        vec![json!([issue]), options.clone()],
    );
    let task = call(&mut db, "getTask", vec![json!("jira:site-a:1")]);
    assert_eq!(task["description"], "1. first\n1. second");
    call(
        &mut db,
        "syncJiraTasks",
        vec![
            json!([remote_issue("1", "site-a", "todo")]),
            options.clone(),
        ],
    );
    assert_eq!(
        call(&mut db, "getTask", vec![json!("jira:site-a:1")])["version"],
        1
    );
    call(
        &mut db,
        "syncJiraTasks",
        vec![
            json!([remote_issue("2", "site-b", "todo")]),
            json!({"projectName":"Jira","originId":"site-b"}),
        ],
    );
    assert!(call(&mut db, "getTask", vec![json!("jira:site-a:1")])["archivedAt"].is_null());
    call(&mut db, "syncJiraTasks", vec![json!([]), options]);
    assert!(!call(&mut db, "getTask", vec![json!("jira:site-a:1")])["archivedAt"].is_null());
    assert!(call(&mut db, "getTask", vec![json!("jira:site-b:2")])["archivedAt"].is_null());
}

#[test]
fn chat_run_restart_and_latest_todo_match_the_active_run() {
    let (directory, mut db) = database();
    let thread = call(
        &mut db,
        "createAiChatThread",
        vec![
            json!({"id":"chat","title":"Chat","origin":{"projectId":"local","projectName":"Local","workspacePath":"/tmp/isolated"},"model":"test","reasoningEffort":"high","sandbox":"read-only"}),
        ],
    );
    assert_eq!(thread["status"], "idle");
    let run = call(
        &mut db,
        "createAiChatRun",
        vec![json!({"id":"run","threadId":"chat"})],
    );
    assert_eq!(run["status"], "running");
    call(
        &mut db,
        "insertAiChatEvent",
        vec![
            json!({"threadId":"chat","runId":"run","type":"todo_list","role":"activity","content":"tasks","data":{"detail":[{"text":"one","completed":true},{"text":"two","completed":false}]}}),
        ],
    );
    let active = call(&mut db, "getAiChatThread", vec![json!("chat")]);
    assert_eq!(active["latestTodo"]["completed"], 1);
    assert_eq!(active["latestTodo"]["total"], 2);
    drop(db);
    let mut reopened = Database::open(&directory.path().join("test.sqlite")).unwrap();
    assert_eq!(
        call(&mut reopened, "getAiChatRun", vec![json!("run")])["status"],
        "interrupted"
    );
    assert_eq!(
        call(&mut reopened, "getAiChatThread", vec![json!("chat")])["status"],
        "idle"
    );
}

#[test]
fn legacy_status_and_conversation_migration_keeps_records_and_foreign_keys() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("legacy.sqlite");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(&include_str!("base.sql").replace("'in_review', 'blocked', ", ""))
        .unwrap();
    connection.execute_batch("INSERT INTO projects(id,name,issue_key,created_at,updated_at) VALUES('local','Old','LOCAL','2020','2020'); INSERT INTO tasks(id,identifier,project_id,title,status,priority,sort_order,thread_id,created_at,updated_at) VALUES('old','LOCAL-1','local','Old','todo','none',1000,'legacy-thread','2020','2020'); ALTER TABLE tasks RENAME COLUMN thread_id TO linked_thread_id; INSERT INTO comments(id,task_id,body,thread_id,author_id,author_name,created_at,updated_at) VALUES('comment','old','Old comment','comment-thread','local','User','2020','2020'); CREATE TABLE task_threads(task_id TEXT,thread_id TEXT,created_at TEXT);").unwrap();
    drop(connection);
    let mut database = Database::open(&path).unwrap();
    let task = call(&mut database, "getTask", vec![json!("old")]);
    assert_eq!(task["threadId"], "legacy-thread");
    assert_eq!(task["legacyLocalThreadId"], "legacy-thread");
    assert_eq!(task["creatorId"], "codex-agent");
    assert_eq!(
        call(&mut database, "getComment", vec![json!("comment")])["authorId"],
        "codex-agent"
    );
    assert!(database
        .get("PRAGMA foreign_key_check", &[])
        .unwrap()
        .is_null());
    let updated = call(
        &mut database,
        "updateTask",
        vec![
            json!("old"),
            json!(1),
            json!({"status":"in_review"}),
            undefined(),
            undefined(),
            actor(),
            undefined(),
        ],
    );
    assert_eq!(updated["status"], "in_review");
    assert!(!database
        .all("PRAGMA table_info(tasks)", &[])
        .unwrap()
        .iter()
        .any(|column| column["name"] == "linked_thread_id"));
}

fn jira_fixture(db: &mut Database) -> Value {
    call(
        db,
        "createProject",
        vec![json!({"id":"repo","name":"Repository","workspacePath":"/tmp/isolated"})],
    );
    call(
        db,
        "syncJiraTasks",
        vec![
            json!([remote_issue("1", "site-a", "todo")]),
            json!({"projectName":"Jira","originId":"site-a"}),
        ],
    );
    let jira = call(db, "getTask", vec![json!("jira:site-a:1")]);
    call(
        db,
        "setJiraProjects",
        vec![
            jira["identifier"].clone(),
            jira["version"].clone(),
            json!(["repo"]),
            actor(),
        ],
    );
    call(db, "getTask", vec![jira["id"].clone()])
}
fn plan_item(key: &str) -> Value {
    json!({"key":key,"projectId":"repo","title":key,"description":"Implement","priority":"medium","labels":[],"blockedBy":[]})
}

#[test]
fn interrupted_publication_requires_same_manifest_and_preserves_started_work() {
    let (_directory, mut db) = database();
    let jira = jira_fixture(&mut db);
    let jira_id = jira["id"].clone();
    call(
        &mut db,
        "createAiChatThread",
        vec![
            json!({"id":"planning","title":"Planning","origin":{"projectId":"repo","projectName":"Repository","workspacePath":"/tmp/isolated"},"model":"test","reasoningEffort":"high","sandbox":"read-only"}),
        ],
    );
    let plan = call(
        &mut db,
        "beginJiraPlanning",
        vec![
            jira["identifier"].clone(),
            jira["version"].clone(),
            json!("planning"),
        ],
    )["plan"]
        .clone();
    let plan = call(
        &mut db,
        "saveJiraPlanSpec",
        vec![
            jira_id.clone(),
            plan["version"].clone(),
            json!("# Initial plan"),
        ],
    );
    assert_eq!(
        call(&mut db, "getTaskPlan", vec![jira["identifier"].clone()]),
        plan
    );
    let publication = call(
        &mut db,
        "beginJiraPlanPublish",
        vec![
            jira_id.clone(),
            plan["version"].clone(),
            json!([plan_item("api"), plan_item("docs")]),
        ],
    );
    let resumed = call(
        &mut db,
        "beginJiraPlanPublish",
        vec![
            jira_id.clone(),
            publication["plan"]["version"].clone(),
            json!([plan_item("api"), plan_item("docs")]),
        ],
    );
    assert_eq!(publication["items"], resumed["items"]);
    assert_eq!(
        db.call(
            "beginJiraPlanPublish",
            &[
                jira_id.clone(),
                publication["plan"]["version"].clone(),
                json!([plan_item("different")])
            ]
        )
        .unwrap_err()
        .code,
        "JIRA_PLAN_PUBLISH_CONFLICT"
    );
    for item in array(&publication["items"]) {
        let mut task = input(text(&item["taskId"]), "repo");
        task["status"] = json!("backlog");
        let created = call(&mut db, "createTask", vec![task]);
        let current = call(&mut db, "getTask", vec![jira_id.clone()]);
        call(
            &mut db,
            "addJiraTaskLink",
            vec![
                jira_id.clone(),
                current["version"].clone(),
                created["id"].clone(),
                actor(),
            ],
        );
    }
    call(
        &mut db,
        "finishJiraPlanPublish",
        vec![jira_id.clone(), publication["plan"]["publication"].clone()],
    );
    let api_id = publication["items"][0]["taskId"].clone();
    let api = call(&mut db, "getTask", vec![api_id.clone()]);
    call(
        &mut db,
        "moveTask",
        vec![
            api_id.clone(),
            api["version"].clone(),
            json!("in_progress"),
            Value::Null,
            undefined(),
            undefined(),
            actor(),
            undefined(),
        ],
    );
    let plan = call(&mut db, "getJiraPlan", vec![jira_id.clone()]);
    let plan = call(
        &mut db,
        "saveJiraPlanSpec",
        vec![
            jira_id.clone(),
            plan["version"].clone(),
            json!("# Revised plan"),
        ],
    );
    assert_eq!(
        db.call(
            "beginJiraPlanPublish",
            &[
                jira_id.clone(),
                plan["version"].clone(),
                json!([plan_item("replacement")])
            ]
        )
        .unwrap_err()
        .code,
        "JIRA_PLAN_PRESERVED_TASK_REQUIRED"
    );
    let next = call(
        &mut db,
        "beginJiraPlanPublish",
        vec![
            jira_id,
            plan["version"].clone(),
            json!([plan_item("api"), plan_item("replacement")]),
        ],
    );
    assert_eq!(next["items"][0]["taskId"], api_id);
    assert_eq!(
        call(&mut db, "getTask", vec![api_id])["status"],
        "in_progress"
    );
}

#[test]
fn lifecycle_pause_and_resume_release_only_dependency_frontier() {
    let (_directory, mut db) = database();
    let jira = jira_fixture(&mut db);
    let jira_id = jira["id"].clone();
    for name in ["first", "second", "independent"] {
        let mut input = input(name, "repo");
        input["status"] = json!("backlog");
        let created = call(&mut db, "createTask", vec![input]);
        let jira = call(&mut db, "getTask", vec![jira_id.clone()]);
        call(
            &mut db,
            "addJiraTaskLink",
            vec![
                jira_id.clone(),
                jira["version"].clone(),
                created["id"].clone(),
                actor(),
            ],
        );
    }
    call(
        &mut db,
        "addTaskRelation",
        vec![
            json!("second"),
            json!(1),
            json!("blocked_by"),
            json!("first"),
            undefined(),
            undefined(),
            actor(),
        ],
    );
    let jira = call(&mut db, "getTask", vec![jira_id.clone()]);
    call(
        &mut db,
        "moveTask",
        vec![
            jira_id.clone(),
            jira["version"].clone(),
            json!("in_progress"),
            Value::Null,
            undefined(),
            undefined(),
            actor(),
            undefined(),
        ],
    );
    assert_eq!(
        call(&mut db, "getTask", vec![json!("first")])["status"],
        "todo"
    );
    assert_eq!(
        call(&mut db, "getTask", vec![json!("second")])["status"],
        "backlog"
    );
    let independent = call(&mut db, "getTask", vec![json!("independent")]);
    call(
        &mut db,
        "moveTask",
        vec![
            json!("independent"),
            independent["version"].clone(),
            json!("in_progress"),
            Value::Null,
            undefined(),
            undefined(),
            actor(),
            undefined(),
        ],
    );
    let jira = call(&mut db, "getTask", vec![jira_id.clone()]);
    call(
        &mut db,
        "moveTask",
        vec![
            jira_id.clone(),
            jira["version"].clone(),
            json!("todo"),
            Value::Null,
            undefined(),
            undefined(),
            actor(),
            undefined(),
        ],
    );
    let lifecycle = call(&mut db, "getJiraLifecycle", vec![jira_id.clone()]);
    assert_eq!(lifecycle["pending"]["kind"], "waiting");
    let targets = call(
        &mut db,
        "beginJiraLifecyclePause",
        vec![jira["identifier"].clone(), lifecycle["version"].clone()],
    );
    let first = call(&mut db, "getTask", vec![json!("first")]);
    assert_eq!(
        db.call(
            "moveTask",
            &[
                json!("first"),
                first["version"].clone(),
                json!("in_progress"),
                Value::Null,
                undefined(),
                undefined(),
                actor()
            ]
        )
        .unwrap_err()
        .code,
        "JIRA_PAUSE_IN_PROGRESS"
    );
    call(
        &mut db,
        "resolveJiraLifecycle",
        vec![
            jira_id.clone(),
            lifecycle["version"].clone(),
            json!("pause"),
            targets.clone(),
        ],
    );
    call(
        &mut db,
        "finishJiraLifecyclePause",
        vec![jira_id.clone(), targets],
    );
    assert_eq!(
        call(&mut db, "getTask", vec![json!("first")])["status"],
        "backlog"
    );
    assert_eq!(
        call(&mut db, "getTask", vec![json!("independent")])["status"],
        "blocked"
    );
    let jira = call(&mut db, "getTask", vec![jira_id.clone()]);
    call(
        &mut db,
        "moveTask",
        vec![
            jira_id,
            jira["version"].clone(),
            json!("in_progress"),
            Value::Null,
            undefined(),
            undefined(),
            actor(),
            undefined(),
        ],
    );
    assert_eq!(
        call(&mut db, "getTask", vec![json!("first")])["status"],
        "todo"
    );
    assert_eq!(
        call(&mut db, "getTask", vec![json!("independent")])["status"],
        "todo"
    );
    assert_eq!(
        call(&mut db, "getTask", vec![json!("second")])["status"],
        "backlog"
    );
}
