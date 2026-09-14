import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { main as panelctl } from "../cli/panelctl.mjs";
import { PanelDatabase } from "../server/database.mjs";

test("ordinary task Spec persists through CLI save/reload without changing the task", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "panel-task-planning-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const filename = path.join(directory, "panel.sqlite");
  let database = new PanelDatabase(filename);
  try {
    database.createProject({ id: "planning", name: "Planning", workspacePath: workspace });
    const actor = { type: "user", id: "planner", name: "Planner", avatarUrl: null };
    const task = database.createTask({
      projectId: "planning", title: "Plan a local task", description: "Do not implement yet",
      status: "backlog", priority: "none", labels: [], actor, assignee: actor,
      threadId: null, workflowId: null, developmentContext: null,
      startDate: null, dueDate: null, recurrence: null,
    });
    const before = database.getTask(task.id);
    const empty = { spec: "", version: 1, createdAt: null, updatedAt: null };
    assert.deepEqual(database.getTaskPlan(task.identifier), empty);
    assert.equal(database.database.prepare("SELECT count(*) AS count FROM task_plans").get().count, 0);
    assert.throws(() => database.saveTaskPlanSpec(task.id, 2, "Wrong initial version"), { code: "VERSION_CONFLICT" });

    const spec = "# Spec\n\nInvestigate alternatives first.\n";
    await writeFile(path.join(workspace, "spec.md"), spec);
    const calls = [];
    async function cli(args) {
      let stdout = "";
      let stderr = "";
      const exitCode = await panelctl(["issue", "planning", ...args, "--json"], {
        cwd: workspace,
        env: { CODEX_PANEL_URL: "http://127.0.0.1:12345" },
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
        fetch: async (url, init) => {
          const pathname = new URL(url).pathname;
          const body = init.body ? JSON.parse(init.body) : null;
          calls.push({ pathname, method: init.method, body });
          const plan = init.method === "GET"
            ? database.getTaskPlan(task.identifier)
            : database.saveTaskPlanSpec(task.identifier, body.version, body.spec);
          return new Response(JSON.stringify({ plan }), { headers: { "content-type": "application/json" } });
        },
      });
      assert.equal(exitCode, 0, stderr);
      return JSON.parse(stdout).plan;
    }
    assert.deepEqual(await cli(["get", task.identifier]), empty);
    const saved = await cli(["save", task.identifier, "--spec-file", "spec.md", "--if-version", "1"]);
    assert.equal(saved.spec, spec);
    assert.equal(saved.version, 2);
    assert.ok(saved.updatedAt);
    assert.deepEqual(calls, [
      { pathname: `/api/tasks/${task.identifier}/planning`, method: "GET", body: null },
      { pathname: `/api/tasks/${task.identifier}/planning/spec`, method: "PUT", body: { version: 1, spec } },
    ]);
    assert.throws(() => database.saveTaskPlanSpec(task.id, 1, "Stale overwrite"), { code: "VERSION_CONFLICT" });
    assert.deepEqual(database.getTask(task.id), before);
    database.close();
    database = new PanelDatabase(filename);
    assert.deepEqual(database.getTaskPlan(task.id), saved);
    const revised = database.saveTaskPlanSpec(task.id, saved.version, `${spec}\nApproved scope.`);
    assert.equal(revised.version, 3);
    assert.equal(revised.createdAt, saved.createdAt);
    assert.deepEqual(database.getTask(task.id), before);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
