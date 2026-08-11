import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildJiraAutomationName,
  buildJiraAutomationPrompt,
  buildJiraAutomationSpec,
  buildPanelAutomationName,
  buildPanelAutomationPrompt,
  buildPanelAutomationSpec,
  panelAutomationPolicyOperation,
  parsePanelAutomationHostRequest,
  reconcileJiraAutomation,
  reconcilePanelAutomation,
} from "../shared/panel-automation.mjs";
import {
  AUTOMATION_MODELS,
  isSupportedModelEffort,
  withAutomationModel,
} from "../shared/panel-automation-options.mjs";

const baseRequest = {
  id: "host-request-1",
  action: "automation",
  requestId: "iframe-request-1",
  operation: "ensure-active",
  panelProjectId: "ppt-skill",
  codexProjectId: "codex-project-123",
  projectName: "PPT Skill",
  workspacePath: "/Users/example/Documents/ppt-skill",
  skillPath: "/Users/example/panel/skills/manage-panel/SKILL.md",
  enabledByUser: true,
  quotaAware: false,
  intervalMinutes: 5,
  model: "gpt-5.5",
  reasoningEffort: "high",
};

const jiraRequest = {
  id: "host-request-2",
  action: "automation",
  requestId: "iframe-request-2",
  template: "jira-sync",
  operation: "ensure-active",
  providerKey: "jira-a",
  providerAlias: "Jira A",
  configPath: "/Users/example/.config/.jira/a.yml",
  jql: "assignee = currentUser() AND resolution IS EMPTY",
  skillPath: "/Users/example/panel/skills/manage-panel/SKILL.md",
  enabled: true,
};

test("the automation host request accepts only the fixed Jira sync template", () => {
  assert.deepEqual(parsePanelAutomationHostRequest(jiraRequest), jiraRequest);
  assert.equal(
    parsePanelAutomationHostRequest({ ...jiraRequest, prompt: "arbitrary" }),
    null,
  );
  assert.equal(
    parsePanelAutomationHostRequest({ ...jiraRequest, operation: "delete" }),
    null,
  );
  assert.equal(
    parsePanelAutomationHostRequest({ ...jiraRequest, configPath: "relative.yml" }),
    null,
  );
  assert.equal(
    parsePanelAutomationHostRequest({ ...jiraRequest, providerKey: "Jira A" }),
    null,
  );
});

test("the Jira sync template is projectless, daily, read-only, and emits a versioned plan", () => {
  assert.equal(buildJiraAutomationName(jiraRequest), "Panel Jira 同步 · jira-a");
  const prompt = buildJiraAutomationPrompt(jiraRequest);
  assert.match(prompt, /模板版本：1/);
  assert.match(prompt, /jira issue list/);
  assert.match(prompt, /--config '\/Users\/example\/\.config\/\.jira\/a\.yml'/);
  assert.match(prompt, /--jql 'assignee = currentUser\(\) AND resolution IS EMPTY'/);
  assert.match(prompt, /--order-by updated/);
  assert.match(prompt, /--paginate 0:100/);
  assert.match(prompt, /panelctl\.mjs.*project list.*--json/);
  assert.match(prompt, /panelctl\.mjs.*issue list.*--archived all.*--json/);
  assert.match(prompt, /schemaVersion/);
  for (const field of ["provider", "run", "snapshots", "evidence", "proposals", "ambiguities", "failures"]) {
    assert.match(prompt, new RegExp(field));
  }
  assert.match(prompt, /不得创建、修改、移动、归档或删除 Panel issue/);
  assert.match(prompt, /不得回写 Jira/);
  assert.match(prompt, /proposals、ambiguities 和 failures 都为空.*归档当前 Codex 任务/);

  assert.deepEqual(buildJiraAutomationSpec(jiraRequest), {
    kind: "cron",
    name: "Panel Jira 同步 · jira-a",
    prompt,
    executionEnvironment: "local",
    localEnvironmentConfigPath: null,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    rrule: "DTSTART;TZID=Asia/Shanghai:19700101T090000\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
  });
});

test("ordinary Jira reconciliation reports drift without overwriting external edits", async () => {
  const canonical = buildJiraAutomationSpec(jiraRequest);
  const drifted = {
    id: "jira-automation-1",
    status: "ACTIVE",
    ...canonical,
    name: "My custom Jira sync",
    target: { type: "projectless" },
    cwds: [],
  };
  const calls = [];
  const result = await reconcileJiraAutomation(
    { ...jiraRequest, automationId: drifted.id },
    async (method, params) => {
      calls.push({ method, params });
      return { items: [drifted] };
    },
  );

  assert.deepEqual(calls, [{ method: "list-automations", params: {} }]);
  assert.equal(result.state, "drifted");
  assert.equal(result.item.id, drifted.id);
});

test("Jira reconciliation restores canonical drift only when explicitly requested", async () => {
  const canonical = buildJiraAutomationSpec(jiraRequest);
  const drifted = {
    id: "jira-automation-1",
    status: "ACTIVE",
    ...canonical,
    prompt: "custom prompt",
    target: { type: "projectless" },
    cwds: [],
  };
  const calls = [];
  const result = await reconcileJiraAutomation(
    { ...jiraRequest, operation: "restore", automationId: drifted.id },
    async (method, params) => {
      calls.push({ method, params });
      if (method === "list-automations") return { items: [drifted] };
      return { item: { ...params, target: { type: "projectless" }, cwds: [] } };
    },
  );

  assert.deepEqual(calls, [
    { method: "list-automations", params: {} },
    {
      method: "automation-update",
      params: { ...canonical, id: drifted.id, status: "ACTIVE" },
    },
  ]);
  assert.equal(result.state, "normal");
});

test("a missing managed Jira task is recreated only by explicit restore", async () => {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "list-automations") return { items: [] };
    return { item: { id: "jira-automation-2", status: "ACTIVE", ...params } };
  };

  const missing = await reconcileJiraAutomation(
    { ...jiraRequest, automationId: "deleted-automation" },
    rpc,
  );
  assert.equal(missing.state, "missing");
  assert.deepEqual(calls, [{ method: "list-automations", params: {} }]);

  calls.length = 0;
  const restored = await reconcileJiraAutomation(
    { ...jiraRequest, operation: "restore", automationId: "deleted-automation" },
    rpc,
  );
  assert.equal(restored.state, "normal");
  assert.equal(restored.item.id, "jira-automation-2");
  assert.deepEqual(calls, [
    { method: "list-automations", params: {} },
    { method: "automation-create", params: buildJiraAutomationSpec(jiraRequest) },
  ]);
});

test("Jira run-now rejects an overlapping provider run", async () => {
  const existing = {
    id: "jira-automation-1",
    status: "ACTIVE",
    ...buildJiraAutomationSpec(jiraRequest),
    target: { type: "projectless" },
    cwds: [],
  };
  const calls = [];
  const result = await reconcileJiraAutomation(
    { ...jiraRequest, operation: "run-now", automationId: existing.id },
    async (method, params) => {
      calls.push({ method, params });
      if (method === "list-automations") return { items: [existing] };
      if (method === "inbox-items") {
        return { items: [{ automationId: existing.id, status: "IN_PROGRESS" }] };
      }
      assert.fail(`unexpected method ${method}`);
    },
  );

  assert.deepEqual(calls, [
    { method: "list-automations", params: {} },
    { method: "inbox-items", params: { limit: 200 } },
  ]);
  assert.equal(result.run, "already-running");
});

test("Jira run-now refuses drift and malformed native lists", async () => {
  const canonical = buildJiraAutomationSpec(jiraRequest);
  const drifted = {
    id: "jira-automation-1",
    status: "ACTIVE",
    ...canonical,
    prompt: "custom prompt that may write",
    target: { type: "projectless" },
  };
  const calls = [];
  const result = await reconcileJiraAutomation(
    { ...jiraRequest, operation: "run-now", automationId: drifted.id },
    async (method, params) => {
      calls.push({ method, params });
      return { items: [drifted] };
    },
  );
  assert.equal(result.run, "drifted");
  assert.deepEqual(calls, [{ method: "list-automations", params: {} }]);

  await assert.rejects(
    reconcileJiraAutomation(jiraRequest, async () => ({})),
    /自动化列表格式无效/,
  );
  await assert.rejects(
    reconcileJiraAutomation(
      { ...jiraRequest, operation: "run-now", automationId: "jira-automation-2" },
      async (method) => method === "list-automations"
        ? { items: [{
          id: "jira-automation-2",
          status: "ACTIVE",
          ...canonical,
          target: { type: "projectless" },
        }] }
        : {},
    ),
    /运行列表格式无效/,
  );
});

test("the automation model catalog matches Codex and normalizes unsupported efforts", () => {
  assert.deepEqual(AUTOMATION_MODELS, [
    {
      label: "5.6 Sol",
      slug: "gpt-5.6-sol",
      defaultEffort: "low",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      label: "5.6 Terra",
      slug: "gpt-5.6-terra",
      defaultEffort: "medium",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      label: "5.6 Luna",
      slug: "gpt-5.6-luna",
      defaultEffort: "medium",
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      label: "5.5",
      slug: "gpt-5.5",
      defaultEffort: "medium",
      efforts: ["low", "medium", "high", "xhigh"],
    },
    {
      label: "5.4",
      slug: "gpt-5.4",
      defaultEffort: "medium",
      efforts: ["low", "medium", "high", "xhigh"],
    },
    {
      label: "5.4 Mini",
      slug: "gpt-5.4-mini",
      defaultEffort: "medium",
      efforts: ["low", "medium", "high", "xhigh"],
    },
  ]);

  const current = {
    status: "ACTIVE",
    intervalMinutes: 5,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
  };
  assert.deepEqual(withAutomationModel(current, "gpt-5.6-terra"), {
    ...current,
    model: "gpt-5.6-terra",
  });
  assert.deepEqual(withAutomationModel(current, "gpt-5.6-luna"), {
    ...current,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
  });
});

test("the automation host request accepts only whitelisted project automation options", () => {
  assert.deepEqual(parsePanelAutomationHostRequest(baseRequest), baseRequest);
  assert.equal(
    parsePanelAutomationHostRequest({ ...baseRequest, operation: "delete" }),
    null,
  );
  assert.equal(
    parsePanelAutomationHostRequest({ ...baseRequest, method: "automation-delete" }),
    null,
  );
  assert.equal(
    parsePanelAutomationHostRequest({ ...baseRequest, prompt: "arbitrary" }),
    null,
  );
  assert.deepEqual(
    parsePanelAutomationHostRequest({ ...baseRequest, intervalMinutes: 10 }),
    { ...baseRequest, intervalMinutes: 10 },
  );
  assert.equal(
    parsePanelAutomationHostRequest({ ...baseRequest, intervalMinutes: 7 }),
    null,
  );
  assert.equal(
    parsePanelAutomationHostRequest({
      ...baseRequest,
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    })?.reasoningEffort,
    "ultra",
  );
  assert.equal(
    parsePanelAutomationHostRequest({ ...baseRequest, model: "gpt-future" }),
    null,
  );
  assert.equal(
    parsePanelAutomationHostRequest({ ...baseRequest, reasoningEffort: "xhigh" })?.reasoningEffort,
    "xhigh",
  );
  assert.equal(
    parsePanelAutomationHostRequest({
      ...baseRequest,
      model: "gpt-5.4",
      reasoningEffort: "ultra",
    }),
    null,
  );
  const allEfforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
  for (const intervalMinutes of [5, 10, 15, 30, 60]) {
    for (const model of AUTOMATION_MODELS) {
      for (const effort of allEfforts) {
        assert.equal(
          parsePanelAutomationHostRequest({
            ...baseRequest,
            intervalMinutes,
            model: model.slug,
            reasoningEffort: effort,
          }) !== null,
          model.efforts.includes(effort),
          `${intervalMinutes}m/${model.slug}/${effort}`,
        );
      }
    }
  }
  assert.equal(isSupportedModelEffort("gpt-5.6-luna", "max"), true);
  assert.equal(isSupportedModelEffort("gpt-5.6-luna", "ultra"), false);
  assert.equal(
    parsePanelAutomationHostRequest({ ...baseRequest, workspacePath: "relative/path" }),
    null,
  );
});

test("the stable name and generated prompt are project-scoped and encode the claim protocol", () => {
  assert.equal(
    buildPanelAutomationName(baseRequest),
    "Panel 自动认领 · ppt-skill",
  );

  const prompt = buildPanelAutomationPrompt(baseRequest);
  assert.match(
    prompt,
    /\[\$manage-panel\]\(\/Users\/example\/panel\/skills\/manage-panel\/SKILL\.md\)/,
  );
  assert.match(prompt, /\[\$manage-panel\]\([^)]*\) e-panel /);
  assert.match(prompt, /本轮所有 panelctl 操作都使用完整命令前缀/);
  assert.match(prompt, /\/Users\/example\/panel\/cli\/panelctl\.mjs/);
  assert.doesNotMatch(prompt, /taskctl/);
  assert.match(prompt, /PPT Skill/);
  assert.match(prompt, /每 5 分钟检查/);
  assert.match(prompt, /ppt-skill/);
  assert.match(prompt, /\/Users\/example\/Documents\/ppt-skill/);
  assert.match(prompt, /每次仅处理一个 todo/);
  assert.match(prompt, /issue get/);
  assert.match(prompt, /comment list/);
  assert.match(prompt, /最新 version/);
  assert.match(prompt, /in_progress/);
  assert.match(prompt, /版本冲突.*跳过/);
  assert.match(prompt, /关键改动、验证结果、执行结果和剩余风险/);
  assert.match(prompt, /in_review/);
  assert.match(prompt, /已绑定.*branch.*worktree/);
  assert.match(prompt, /若没有 todo.*PAUSED/);
});

test("the generated cron spec uses the selected whitelisted local Codex options", () => {
  assert.deepEqual(buildPanelAutomationSpec(baseRequest), {
    kind: "cron",
    name: "Panel 自动认领 · ppt-skill",
    prompt: buildPanelAutomationPrompt(baseRequest),
    projectId: "codex-project-123",
    executionEnvironment: "local",
    localEnvironmentConfigPath: null,
    model: "gpt-5.5",
    reasoningEffort: "high",
    rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5",
  });
  assert.deepEqual(buildPanelAutomationSpec({
    ...baseRequest,
    intervalMinutes: 30,
    model: "gpt-5.4",
    reasoningEffort: "medium",
  }), {
    ...buildPanelAutomationSpec(baseRequest),
    prompt: buildPanelAutomationPrompt({ ...baseRequest, intervalMinutes: 30 }),
    model: "gpt-5.4",
    reasoningEffort: "medium",
    rrule: "RRULE:FREQ=MINUTELY;INTERVAL=30",
  });
});

test("passive policy checks resume only after quota recovery", () => {
  const passiveAvailable = {
    explicit: false,
    previousQuotaState: "available",
    quotaState: "available",
    currentStatus: "PAUSED",
  };
  assert.equal(
    panelAutomationPolicyOperation(
      { ...baseRequest, quotaAware: true },
      passiveAvailable,
    ),
    "list",
  );
  assert.equal(
    panelAutomationPolicyOperation(
      { ...baseRequest, quotaAware: true },
      { ...passiveAvailable, quotaState: "unknown" },
    ),
    "list",
  );
  assert.equal(
    panelAutomationPolicyOperation(
      { ...baseRequest, quotaAware: true },
      { ...passiveAvailable, previousQuotaState: "blocked" },
    ),
    "ensure-active",
  );
  assert.equal(
    panelAutomationPolicyOperation(
      { ...baseRequest, quotaAware: true },
      { ...passiveAvailable, explicit: true },
    ),
    "ensure-active",
  );
  assert.equal(
    panelAutomationPolicyOperation(
      { ...baseRequest, quotaAware: false },
      { ...passiveAvailable, currentStatus: "ACTIVE" },
    ),
    "ensure-active",
  );
});

test("ensure-active updates a matching automation by id with a complete active spec", async () => {
  const existing = {
    id: "automation-1",
    status: "ACTIVE",
    kind: "cron",
    name: "Panel 自动认领 · ppt-skill",
    prompt: "old prompt",
    projectId: "old-project",
    executionEnvironment: "local",
    localEnvironmentConfigPath: null,
    model: "gpt-5.5",
    reasoningEffort: "medium",
    rrule: "FREQ=HOURLY",
    createdAt: "2026-07-25T00:00:00.000Z",
    internalRevision: 4,
  };
  const calls = [];
  const response = await reconcilePanelAutomation(
    { ...baseRequest, automationId: "automation-1" },
    async (method, params) => {
      calls.push({ method, params });
      if (method === "list-automations") return { items: [existing] };
      return { item: params };
    },
  );

  const spec = buildPanelAutomationSpec(baseRequest);
  assert.deepEqual(calls, [
    { method: "list-automations", params: {} },
    {
      method: "automation-update",
      params: {
        ...spec,
        id: "automation-1",
        status: "ACTIVE",
      },
    },
  ]);
  assert.deepEqual(response, {
    item: { ...spec, id: "automation-1", status: "ACTIVE" },
  });
});

test("ensure-active adopts a legacy automation instead of creating a duplicate", async () => {
  const legacy = {
    id: "legacy-automation",
    status: "ACTIVE",
    ...buildPanelAutomationSpec(baseRequest),
    name: "Taskboard 自动认领 · ppt-skill",
  };
  const calls = [];

  await reconcilePanelAutomation(baseRequest, async (method, params) => {
    calls.push({ method, params });
    if (method === "list-automations") return { items: [legacy] };
    return { item: params };
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, "automation-update");
  assert.equal(calls[1].params.id, legacy.id);
  assert.equal(calls[1].params.name, "Panel 自动认领 · ppt-skill");
});

test("ensure-active is idempotent when the listed automation already matches", async () => {
  const existing = {
    id: "automation-1",
    status: "ACTIVE",
    ...buildPanelAutomationSpec(baseRequest),
    createdAt: "2026-07-25T00:00:00.000Z",
  };
  const calls = [];
  const response = await reconcilePanelAutomation(
    { ...baseRequest, automationId: "automation-1" },
    async (method, params) => {
      calls.push({ method, params });
      return { items: [existing] };
    },
  );

  assert.deepEqual(calls, [{ method: "list-automations", params: {} }]);
  assert.deepEqual(response, { item: existing });
});

test("a foreign automation id never grants control outside the project", async () => {
  const foreign = {
    id: "foreign-automation",
    status: "ACTIVE",
    ...buildPanelAutomationSpec({
      ...baseRequest,
      panelProjectId: "another-project",
    }),
  };
  const ensureCalls = [];
  await reconcilePanelAutomation(
    { ...baseRequest, automationId: foreign.id },
    async (method, params) => {
      ensureCalls.push({ method, params });
      if (method === "list-automations") return { items: [foreign] };
      return { item: params };
    },
  );
  assert.deepEqual(ensureCalls, [
    { method: "list-automations", params: {} },
    { method: "automation-create", params: buildPanelAutomationSpec(baseRequest) },
  ]);

  const pauseCalls = [];
  const paused = await reconcilePanelAutomation(
    { ...baseRequest, operation: "pause", automationId: foreign.id },
    async (method, params) => {
      pauseCalls.push({ method, params });
      return { items: [foreign] };
    },
  );
  assert.deepEqual(pauseCalls, [{ method: "list-automations", params: {} }]);
  assert.deepEqual(paused, { error: "not-found" });
});

test("ensure-active falls back to the stable name and otherwise creates", async () => {
  const matching = {
    id: "automation-by-name",
    status: "PAUSED",
    ...buildPanelAutomationSpec(baseRequest),
  };
  const updateCalls = [];
  await reconcilePanelAutomation(baseRequest, async (method, params) => {
    updateCalls.push({ method, params });
    if (method === "list-automations") return { items: [matching] };
    return { item: params };
  });
  assert.equal(updateCalls[1].method, "automation-update");
  assert.equal(updateCalls[1].params.id, "automation-by-name");

  const createCalls = [];
  const created = await reconcilePanelAutomation(baseRequest, async (method, params) => {
    createCalls.push({ method, params });
    if (method === "list-automations") return { items: [] };
    return { item: { id: "created-1", status: "ACTIVE", ...params } };
  });
  assert.deepEqual(createCalls, [
    { method: "list-automations", params: {} },
    { method: "automation-create", params: buildPanelAutomationSpec(baseRequest) },
  ]);
  assert.equal(created.item.id, "created-1");
});

test("pause never creates and list returns only sanitized matching project automations", async () => {
  const matching = {
    id: "matching",
    status: "ACTIVE",
    ...buildPanelAutomationSpec(baseRequest),
    untrustedListField: "must not be echoed into an update",
  };
  const unrelated = {
    id: "unrelated",
    status: "ACTIVE",
    ...buildPanelAutomationSpec({
      ...baseRequest,
      panelProjectId: "another-project",
    }),
  };

  const pauseCalls = [];
  const paused = await reconcilePanelAutomation(
    { ...baseRequest, operation: "pause" },
    async (method, params) => {
      pauseCalls.push({ method, params });
      if (method === "list-automations") return { items: [unrelated, matching] };
      return { item: params };
    },
  );
  assert.deepEqual(pauseCalls, [
    { method: "list-automations", params: {} },
    {
      method: "automation-update",
      params: {
        ...buildPanelAutomationSpec(baseRequest),
        id: "matching",
        status: "PAUSED",
      },
    },
  ]);
  assert.deepEqual(paused, {
    item: {
      ...buildPanelAutomationSpec(baseRequest),
      id: "matching",
      status: "PAUSED",
    },
  });

  const notFoundCalls = [];
  const notFound = await reconcilePanelAutomation(
    { ...baseRequest, operation: "pause", panelProjectId: "missing" },
    async (method, params) => {
      notFoundCalls.push({ method, params });
      return { items: [matching, unrelated] };
    },
  );
  assert.deepEqual(notFoundCalls, [{ method: "list-automations", params: {} }]);
  assert.deepEqual(notFound, { error: "not-found" });

  const listed = await reconcilePanelAutomation(
    { ...baseRequest, operation: "list" },
    async () => ({ items: [unrelated, matching] }),
  );
  assert.deepEqual(listed, {
    items: [{
      id: "matching",
      status: "ACTIVE",
      model: "gpt-5.5",
      reasoningEffort: "high",
      rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5",
    }],
  });

  const invalidPair = {
    ...matching,
    id: "invalid-pair",
    model: "gpt-5.4",
    reasoningEffort: "ultra",
  };
  const invalidListed = await reconcilePanelAutomation(
    { ...baseRequest, operation: "list" },
    async () => ({ items: [invalidPair] }),
  );
  assert.deepEqual(invalidListed, { items: [] });
});

test("pause is idempotent for an already paused matching automation", async () => {
  const matching = {
    id: "matching",
    status: "PAUSED",
    ...buildPanelAutomationSpec(baseRequest),
  };
  const calls = [];
  const response = await reconcilePanelAutomation(
    { ...baseRequest, operation: "pause" },
    async (method, params) => {
      calls.push({ method, params });
      return { items: [matching] };
    },
  );
  assert.deepEqual(calls, [{ method: "list-automations", params: {} }]);
  assert.deepEqual(response, { item: matching });
});
