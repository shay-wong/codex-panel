import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { PanelDatabase } from "../server/database.mjs";
import { createPanelServer } from "../server/index.mjs";
import {
  isProjectSummaryDue,
  projectSummaryRetryDelay,
} from "../server/project-summary.mjs";

const MINUTE_MS = 60_000;

test("project summary failures retry after 5, 15 and 60 minutes, then stop", () => {
  const attemptedAt = "2026-08-27T00:00:00.000Z";
  const attemptedAtMs = Date.parse(attemptedAt);

  assert.equal(projectSummaryRetryDelay(1), 5 * MINUTE_MS);
  assert.equal(projectSummaryRetryDelay(2), 15 * MINUTE_MS);
  assert.equal(projectSummaryRetryDelay(3), 60 * MINUTE_MS);
  assert.equal(projectSummaryRetryDelay(4), null);

  for (const [failureCount, delay] of [[1, 5], [2, 15], [3, 60]]) {
    const summary = { attemptedAt, error: "failed", failureCount };
    assert.equal(isProjectSummaryDue(summary, attemptedAtMs + delay * MINUTE_MS - 1), false);
    assert.equal(isProjectSummaryDue(summary, attemptedAtMs + delay * MINUTE_MS), true);
  }
  assert.equal(isProjectSummaryDue({ attemptedAt, error: "failed", failureCount: 4 }, Infinity), false);
  assert.equal(isProjectSummaryDue({ attemptedAt, error: null, failureCount: 0 }, attemptedAtMs + 24 * 60 * MINUTE_MS), true);
});

test("project summary failure count persists and resets after success", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-summary-db-"));
  const filename = path.join(directory, "panel.sqlite");
  let database;
  try {
    database = new PanelDatabase(filename);
    database.createProject({ id: "summary-project", name: "Summary", workspacePath: null });
    assert.equal(database.saveProjectSummaryError("summary-project", "one").failureCount, 1);
    assert.equal(database.saveProjectSummaryError("summary-project", "two").failureCount, 2);
    database.database.close();
    database = new PanelDatabase(filename);
    assert.equal(database.getProjectSummary("summary-project").failureCount, 2);
    assert.equal(database.saveProjectSummary("summary-project", "ready").failureCount, 0);
  } finally {
    database?.database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing project summary errors migrate without losing data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-summary-migration-"));
  const filename = path.join(directory, "panel.sqlite");
  let database;
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      CREATE TABLE project_summaries (
        project_id TEXT PRIMARY KEY,
        summary TEXT,
        generated_at TEXT,
        attempted_at TEXT NOT NULL,
        error TEXT
      );
      INSERT INTO project_summaries VALUES (
        'legacy-project', '旧总结', '2026-08-26T00:00:00.000Z',
        '2026-08-27T00:00:00.000Z', '旧错误'
      );
    `);
    legacy.close();

    database = new PanelDatabase(filename);
    const summary = database.getProjectSummary("legacy-project");
    assert.equal(summary.summary, "旧总结");
    assert.equal(summary.error, "旧错误");
    assert.equal(summary.failureCount, 1);
  } finally {
    database?.database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual project summary retry still runs after automatic retries are exhausted", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-summary-api-"));
  const executable = path.join(directory, "fake-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write('{"type":"thread.started","thread_id":"summary-thread"}\\n');
  process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"项目总结已生成"}}\\n');
  process.stdout.write('{"type":"turn.completed"}\\n');
});
`);
  await chmod(executable, 0o755);
  const app = createPanelServer({ dataDirectory: directory, codexExecutable: executable });
  try {
    app.database.createProject({ id: "summary-project", name: "Summary", workspacePath: null });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      app.database.saveProjectSummaryError("summary-project", `failure ${attempt + 1}`);
    }
    const address = await app.listen({ port: 0 });
    const url = `http://127.0.0.1:${address.port}/api/local/projects/summary-project/summary`;

    let response = await fetch(url);
    let body = await response.json();
    assert.equal(body.refreshing, false);
    assert.equal(app.database.getProjectSummary("summary-project").failureCount, 4);

    response = await fetch(url, { method: "POST" });
    body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.summary, "项目总结已生成");
    assert.equal(body.refreshing, false);
    assert.equal(app.database.getProjectSummary("summary-project").failureCount, 0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
