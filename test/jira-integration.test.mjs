import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildJiraJql, createJiraIntegration } from "../server/jira-integration.mjs";

const ORIGIN = createHash("sha256").update("jira-instance").digest("hex");

function jiraConfig() {
  return {
    version: 3,
    baseUrl: "https://jira.example.test",
    username: "shay",
    password: "token",
    originId: ORIGIN,
    accountId: "account-a",
    displayName: "Shay A",
    projects: [],
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fixture(fetch) {
  let config = jiraConfig();
  const state = {
    lastAttemptedAt: null,
    lastSuccessfulAt: null,
    syncedIssueCount: 0,
    unknownIssueCount: 0,
    syncError: null,
  };
  const database = {
    active: [],
    syncCalls: [],
    getJiraSyncState: () => ({ ...state }),
    listActiveJiraTasks: () => database.active,
    recordJiraSyncAttempt: (attemptedAt) => { state.lastAttemptedAt = attemptedAt; },
    recordJiraSyncSuccess: ({ attemptedAt, succeededAt, issueCount, unknownIssueCount }) => {
      Object.assign(state, {
        lastAttemptedAt: attemptedAt,
        lastSuccessfulAt: succeededAt,
        syncedIssueCount: issueCount,
        unknownIssueCount,
        syncError: null,
      });
    },
    markJiraSyncError: (message, code, attemptedAt) => {
      state.lastAttemptedAt = attemptedAt;
      state.syncError = { code, message };
    },
    syncJiraTasks: (issues, options) => database.syncCalls.push({ issues, options }),
  };
  const configStore = {
    read: async () => config,
    save: async (next) => {
      config = { ...next, version: 3 };
      return config;
    },
  };
  return {
    database,
    integration: createJiraIntegration({ configStore, database, fetch }),
    readConfig: () => config,
  };
}

test("Jira REST sync is atomic, rechecks missing issues, and confirms account changes", async () => {
  assert.match(buildJiraJql(), /statusCategory != Done/);
  let searchFailure = true;
  let missingMode = "unknown";
  let account = { accountId: "account-a", displayName: "Shay A" };
  const requests = [];
  const { database, integration, readConfig } = fixture(async (url, init) => {
    const parsed = new URL(url);
    requests.push(parsed.pathname);
    if (parsed.pathname === "/rest/applinks/1.0/manifest") return json({ id: "jira-instance" });
    if (parsed.pathname === "/rest/api/2/myself") return json(account);
    if (parsed.pathname === "/rest/api/2/search") {
      const body = JSON.parse(init.body);
      if (body.startAt === 0) {
        return json({
          total: 2,
          issues: [{
            id: "1",
            key: "OPEN-1",
            fields: {
              summary: "Open",
              description: "改动范围：\n # 第一项\n\n # 第二项\n\n测试重点：\n * 保留项目符号",
              status: { name: "To Do", statusCategory: { key: "new" } },
              assignee: account,
              reporter: account,
            },
          }],
        });
      }
      if (searchFailure) return json({ message: "temporary" }, 503);
      return json({ total: 1, issues: [] });
    }
    if (parsed.pathname === "/rest/api/2/issue/MISSING-1") {
      if (missingMode === "unknown") return json({ message: "missing" }, 404);
      return json({
        id: "2",
        key: "MISSING-1",
        fields: {
          summary: missingMode === "done" ? "Closed" : "Open",
          status: missingMode === "done"
            ? { name: "Done", statusCategory: { key: "done" } }
            : { name: "To Do", statusCategory: { key: "new" } },
          assignee: account,
          reporter: account,
        },
      });
    }
    throw new Error(`Unexpected Jira request: ${parsed.pathname}`);
  });
  database.active = [{ id: "jira-missing", externalId: "2", externalKey: "MISSING-1" }];

  await assert.rejects(integration.sync({ force: true }), { code: "JIRA_REQUEST_FAILED" });
  assert.equal(database.syncCalls.length, 0, "a later page failure must not apply a partial sync");

  searchFailure = false;
  const unknown = await integration.sync({ force: true });
  assert.equal(unknown.syncedIssueCount, 1);
  assert.equal(unknown.unknownIssueCount, 1);
  assert.equal(
    database.syncCalls.at(-1).issues[0].description,
    "改动范围：\n 1. 第一项\n\n 1. 第二项\n\n测试重点：\n * 保留项目符号",
  );
  assert.equal(database.syncCalls.at(-1).options.unknownTasks[0].id, "jira-missing");

  missingMode = "open";
  await integration.sync({ force: true });
  const stillOpen = database.syncCalls.at(-1).issues.find((issue) => issue.externalKey === "MISSING-1");
  assert.equal(stillOpen.archived, false);
  assert.equal(database.syncCalls.at(-1).options.unknownTasks[0].id, "jira-missing");

  missingMode = "done";
  await integration.sync({ force: true });
  const closed = database.syncCalls.at(-1).issues.find((issue) => issue.externalKey === "MISSING-1");
  assert.equal(closed.archived, true);
  assert.equal(closed.externalStatus, "Done");

  account = { accountId: "account-b", displayName: "Shay B" };
  const searchesBeforeAccountChange = requests.filter((pathname) => pathname === "/rest/api/2/search").length;
  await assert.rejects(integration.sync({ force: true }), { code: "JIRA_ACCOUNT_CHANGED" });
  assert.equal(
    requests.filter((pathname) => pathname === "/rest/api/2/search").length,
    searchesBeforeAccountChange,
  );
  await integration.sync({ force: true, acceptAccountChange: true });
  assert.equal(readConfig().accountId, "account-b");
  assert.ok(requests.filter((pathname) => pathname === "/rest/api/2/search").length >= 4);
});

test("Jira transition retries accept the remote target state after a lost response", async () => {
  let statusCategory = "new";
  let transitionPosts = 0;
  const { integration } = fixture(async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/rest/applinks/1.0/manifest") return json({ id: "jira-instance" });
    if (parsed.pathname === "/rest/api/2/issue/OPEN-1" && parsed.searchParams.has("fields")) {
      return json({ fields: { status: { statusCategory: { key: statusCategory } } } });
    }
    if (parsed.pathname === "/rest/api/2/issue/OPEN-1/transitions" && init.method !== "POST") {
      return json({
        transitions: [{ id: "21", name: "Start", to: { statusCategory: { key: "indeterminate" } } }],
      });
    }
    if (parsed.pathname === "/rest/api/2/issue/OPEN-1/transitions" && init.method === "POST") {
      transitionPosts += 1;
      statusCategory = "indeterminate";
      throw new Error("response lost");
    }
    throw new Error(`Unexpected Jira request: ${parsed.pathname}`);
  });
  const task = {
    externalOrigin: ORIGIN,
    externalKey: "OPEN-1",
    status: "todo",
  };

  await assert.rejects(integration.moveTask(task, "in_progress"), { code: "JIRA_UNAVAILABLE" });
  await integration.moveTask(task, "in_progress");

  assert.equal(transitionPosts, 1);
});
