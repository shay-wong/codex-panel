import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { main as panelctl } from "../cli/panelctl.mjs";
import { createPanelServer, resolveServerOptions } from "../server/app.mjs";

async function canonical(filename) {
  try { return await realpath(filename); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return path.join(await canonical(path.dirname(filename)), path.basename(filename));
  }
}

test("ordinary planning prepares manually, saves Spec and splits backlog sub-issues", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "panel-task-planning-api-")));
  const workspace = path.join(directory, "workspace");
  const skillsDirectory = path.join(directory, "skills");
  await mkdir(workspace);
  await mkdir(skillsDirectory);
  const codexExecutable = path.join(directory, "fake-codex");
  await writeFile(codexExecutable, "#!/bin/sh\nexit 1\n");
  await chmod(codexExecutable, 0o755);
  const options = {
    dataDirectory: path.join(directory, "data"), codexExecutable,
    codexStatePath: path.join(directory, "state.json"),
    codexProcessesPath: path.join(directory, "processes.json"),
    skillsDirectory, skillPath: path.join(skillsDirectory, "manage-panel.md"),
    nativeSkillPath: path.join(skillsDirectory, "manage-panel.md"), processEnv: {},
  };
  await writeFile(options.codexStatePath, JSON.stringify({ "local-projects": { planning: { rootPaths: [workspace] } } }));
  await writeFile(options.codexProcessesPath, "{}");
  await writeFile(options.skillPath, "# Isolated Manage Panel fixture\n");
  const production = resolveServerOptions({ codexExecutable });
  const effective = resolveServerOptions(options);
  for (const key of ["dataDirectory", "databasePath", "attachmentsDirectory", "cloudConfigPath", "jiraConfigPath", "clientStoragePath", "codexStatePath", "codexProcessesPath", "skillsDirectory", "nativeSkillPath"]) {
    const testPath = await canonical(effective[key]);
    const productionPath = await canonical(production[key]);
    assert.ok(testPath.startsWith(directory + path.sep), key);
    assert.ok(testPath !== productionPath && !testPath.startsWith(productionPath + path.sep) && !productionPath.startsWith(testPath + path.sep), key);
  }
  assert.ok(!workspace.startsWith(await canonical(process.cwd()) + path.sep));
  const app = createPanelServer(options);
  try {
    app.database.createProject({ id: "planning", name: "Planning", workspacePath: workspace });
    app.aiChat.getCatalog = async () => { throw new Error("Default planning does not need Skill discovery"); };
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    app.claimQueue.close();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = async (route, method = "GET", body, status = 200) => {
      const response = await fetch(baseUrl + route, {
        method, headers: { "content-type": "application/json", "x-panel-client": "panelctl" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    };
    const parent = (await request("/api/tasks", "POST", {
      projectId: "planning", title: "Plan a main task", description: "Record only; no implementation yet", status: "backlog",
    }, 201)).task;
    const prepared = await request(`/api/local/tasks/${parent.id}/prepare-planning`, "POST");
    assert.equal(prepared.collaborationMode, "plan");
    assert.equal(prepared.autoSubmit, false);
    assert.equal(prepared.planningPreparation, true);
    assert.equal(prepared.workspacePath, workspace);
    assert.equal(prepared.useWorktree, false);
    assert.deepEqual(prepared.skillReferences.map((skill) => skill.name), ["manage-panel"]);
    assert.deepEqual(app.database.getTask(parent.id), parent);
    assert.equal(app.database.getClaimQueueItem(parent.id), null);

    const customSkill = { id: "test:planning", label: "Planning", path: path.join(skillsDirectory, "planning.md") };
    await writeFile(customSkill.path, "# Isolated planning Skill\n");
    app.aiChat.getCatalog = async () => ({ skills: [customSkill] });
    await request("/api/local/workflow-settings", "PUT", { planning: [customSkill.id], execution: [], review: [], handoff: [] });
    const custom = await request(`/api/local/tasks/${parent.id}/prepare-planning`, "POST");
    assert.equal(custom.collaborationMode, "default");
    assert.deepEqual(custom.skillReferences.map((skill) => skill.name), ["manage-panel", customSkill.id]);
    assert.deepEqual(app.database.getTask(parent.id), parent);
    assert.equal(app.database.getClaimQueueItem(parent.id), null);

    const { plan } = await request(`/api/tasks/${parent.identifier}/planning`);
    assert.equal(plan.version, 1);
    const spec = "# Spec\n\nSplit into research and implementation; implementation depends on research.";
    const { plan: saved } = await request(`/api/tasks/${parent.id}/planning/spec`, "PUT", { version: plan.version, spec });
    assert.equal(saved.version, 2);
    assert.equal(saved.spec, spec);
    assert.deepEqual((await request(`/api/tasks/${parent.id}/planning`)).plan, saved);
    assert.equal((await request(`/api/tasks/${parent.id}/planning/spec`, "PUT", { version: 1, spec: "Stale" }, 409)).error.code, "VERSION_CONFLICT");
    assert.deepEqual(app.database.getTask(parent.id), parent);

    async function cli(args) {
      let output = "";
      const exitCode = await panelctl([...args, "--json"], {
        cwd: workspace, env: { CODEX_PANEL_URL: baseUrl, CODEX_THREAD_ID: "planning-fixture" },
        stdout: { write: (chunk) => { output += chunk; } }, stderr: { write: (chunk) => assert.fail(chunk) },
      });
      assert.equal(exitCode, 0);
      return JSON.parse(output);
    }
    const children = [];
    for (const title of ["Research options", "Implement approved option"]) {
      const { task } = await cli(["issue", "create", "--project", "planning", "--title", title, "--status", "backlog"]);
      children.push(task);
      await cli(["issue", "relation", "add", task.id, "--type", "parent", "--issue", parent.id]);
    }
    await cli(["issue", "relation", "add", children[1].id, "--type", "blocked_by", "--issue", children[0].id]);
    const { tree } = await cli(["issue", "tree", parent.id, "--direction", "descendants", "--depth", "1"]);
    assert.deepEqual(new Set(tree.nodes.map((node) => node.id)), new Set([parent.id, ...children.map((child) => child.id)]));
    assert.deepEqual(app.database.getTask(children[1].id).relations.blockedBy.map((task) => task.id), [children[0].id]);
    for (const task of [parent, ...children]) {
      assert.equal(app.database.getTask(task.id).status, "backlog");
      assert.equal(app.database.getClaimQueueItem(task.id), null);
    }
    assert.deepEqual((await request(`/api/tasks/${parent.id}/planning`)).plan, saved);

    const threadBinding = {
      threadId: "planning-confirmed-thread", codexProjectId: "planning",
      codexProjectKind: "local", codexHostId: "local", workspacePath: workspace,
    };
    const { task: bound } = await request(`/api/tasks/${parent.id}`, "PATCH", {
      version: app.database.getTask(parent.id).version, status: "backlog", threadId: threadBinding.threadId, threadBinding,
    });
    assert.equal(bound.status, "backlog");
    assert.deepEqual(bound.threadBinding, threadBinding);
    assert.deepEqual((await request(`/api/local/tasks/${parent.id}/prepare-planning`, "POST")).threadBinding, threadBinding);
    const { task: approved } = await request(`/api/tasks/${parent.id}`, "PATCH", {
      version: bound.version, status: "todo",
    });
    assert.equal(approved.status, "todo");
    const execution = await request(`/api/local/tasks/${parent.id}/prepare-execution`, "POST", { useWorktree: false });
    assert.deepEqual(execution.threadBinding, threadBinding);
    assert.equal(execution.collaborationMode, "default");
    assert.equal(execution.autoSubmit, false);
    assert.match(execution.instruction, /issue planning get/);
    assert.equal(app.database.getClaimQueueItem(parent.id), null);
    assert.equal(app.database.getTask(parent.id).status, "todo");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
