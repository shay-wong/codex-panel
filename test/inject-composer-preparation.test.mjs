import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
function functionsBetween(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

function composerHarness(t, { hiddenFirst = false, bound = false, localProject = false, projectSwitchFails = false, newConversation = false, onPrefill = async () => {} } = {}) {
  const dom = new JSDOM(`<section data-codex-composer-root data-composer-placement="home">
    ${hiddenFirst ? '<div id="hidden" data-codex-composer="true" contenteditable="true"></div>' : ""}
    <div id="visible" data-codex-composer="true" contenteditable="true"></div>
    <button aria-label="Send">Send</button>
  </section>`, { url: "https://fixture.invalid" });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const editor = document.getElementById("visible");
  editor.getClientRects = () => [{ width: 300, height: 80 }];
  const messages = [], requests = [], modes = [], navigation = [];
  let selectedProjectId = "";
  const created = Promise.withResolvers();
  let threadId = bound ? "existing-thread" : "";
  let now = Date.now();
  let api;
  api = vm.runInNewContext(`(() => {
    let pendingThreadCreation = null, pendingThreadAssociation = null;
    let lastNativeThreadId = "", lastNativeProjectId = "";
    ${functionsBetween("  function persistPendingThreadAssociation()", "  function restorePendingThreadAssociation()")}
    ${functionsBetween("  function markPendingThreadAssociationSubmitted(event)", "  function dispatchHostMessage(message)")}
    ${functionsBetween("  async function waitForPreparedComposer(", "  async function waitForNativeProject(")}
    ${functionsBetween("  async function createThreadForTask(payload)", "  function buildAutomationHostPayload(payload)")}
    return {
      prepare: createThreadForTask,
      publish: publishPendingThreadAssociation,
      submitted: markPendingThreadAssociationSubmitted,
      pending: () => pendingThreadAssociation,
    };
  })()`, {
    document, Error,
    Date: { now: () => now },
    window: {
      localStorage: dom.window.localStorage,
      electronBridge: { sendMessageFromView() {} },
      setTimeout: (callback, delay) => { now += delay; callback(); },
    },
    PENDING_THREAD_ASSOCIATION_KEY: "fixture-pending",
    THREAD_ASSOCIATION_TIMEOUT_MS: 60_000,
    TASK_CONVERSATION_REQUEST_TIMEOUT_MS: 60_000,
    SEND_LABELS: ["send"],
    normalizedLabel: (value) => String(value || "").trim().toLowerCase(),
    normalizeThreadId: (value) => value || "",
    nativeThreadIds: () => new Set(bound ? ["existing-thread"] : []),
    threadIdFromLocation: () => threadId,
    closePanel() {},
    dispatchHostMessage(message) {
      navigation.push(message);
      if (message.state?.project) selectedProjectId = message.state.project.projectId;
    },
    resolveNativeProject: async () => ({ projectId: "fixture-project", targetRoot: "/disposable/fixture" }),
    waitForNativeProject: async (root, id) => {
      assert.equal(root, "/disposable/fixture");
      assert.equal(id, selectedProjectId, "navigate to the requested project before confirming selection");
      if (projectSwitchFails) throw new Error("Fixture project selection not confirmed");
      return id;
    },
    selectedNativeProjectId: async () => selectedProjectId,
    openThread: async () => {},
    isTrustedPanelOrigin: () => true,
    findThreadRow: () => null, findThreadRowInProject: () => null,
    selectNativeCollaborationMode: async (mode, selected) => {
      assert.equal(selected, editor, "mode changes must target the visible composer");
      modes.push(mode);
    },
    requestHostTaskComposerPrefill: async ({ instruction, skills }) => {
      assert.deepEqual(modes, ["plan"], "select mode before making the draft available to send");
      assert.equal(api.pending()?.composer, editor, "track submission before host prefill completes");
      for (const skill of skills) {
        const mention = document.createElement("span");
        mention.setAttribute("skill-mention-name", skill.name);
        mention.setAttribute("skill-mention-path", skill.path);
        mention.textContent = skill.displayName;
        editor.append(mention);
      }
      editor.append(instruction);
      await onPrefill({ api, editor, submit: () => {
        editor.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        editor.textContent = "";
        threadId = bound ? "existing-thread" : "created-thread";
      } });
      return { previousTurnId: "previous-turn" };
    },
    requestHost: async (action, payload) => {
      requests.push({ action, payload });
      return { threadBinding: { threadId } };
    },
    postToFrame: (message) => {
      messages.push(message);
      if (message.type === "panel:thread-created") created.resolve(message);
    },
  });
  document.addEventListener("keydown", api.submitted, true);
  return {
    ...api, editor, messages, requests, navigation, created: created.promise,
    stored: () => JSON.parse(dom.window.localStorage.getItem("fixture-pending")),
    run: () => api.prepare({
      taskId: "fixture-task", identifier: "LOCAL-42", title: "Plan fixture task",
      instruction: "Read LOCAL-42 and prepare its plan", collaborationMode: "plan",
      projectless: !bound && !localProject,
      ...(localProject ? { codexProjectId: "fixture-project", workspacePath: "/disposable/fixture", newConversation } : {}),
      ...(bound ? {
        executionPreparation: true, planningPreparation: true,
        threadBinding: {
          threadId: "existing-thread", codexProjectId: "fixture-project",
          codexHostId: "local", workspacePath: "/disposable/fixture",
        },
      } : {}),
      skillReferences: [{ name: "manage-panel", displayName: "Manage Panel", path: "/fixture/SKILL.md" }],
    }),
  };
}

test("local planning and new drafts select the project without any sidebar rows", async t => {
  for (const newConversation of [false, true]) {
    const harness = composerHarness(t, { localProject: true, newConversation });
    await harness.run();
    assert.deepEqual(JSON.parse(JSON.stringify(harness.navigation[0])), {
      type: "navigate-to-route", path: "/",
      state: { project: { type: "local", projectId: "fixture-project" } },
    });
    assert.equal(harness.pending().projectId, "fixture-project");
    assert.match(harness.editor.textContent, /Read LOCAL-42/);
    assert.deepEqual(harness.messages.map(({ type }) => type), ["panel:thread-prepared"]);
  }
});

test("failed project confirmation prevents filling a draft in the wrong project", async t => {
  const harness = composerHarness(t, { localProject: true, projectSwitchFails: true });
  await harness.run();
  assert.equal(harness.editor.textContent, "");
  assert.equal(harness.pending(), null);
  assert.equal(harness.messages[0].type, "panel:thread-create-error");
  assert.equal(harness.messages[0].payload.error, "Fixture project selection not confirmed");
});

test("local prefill prepares the visible composer when a hidden editor comes first", async (t) => {
  const harness = composerHarness(t, { hiddenFirst: true });
  await harness.run();
  assert.deepEqual(harness.messages.map(({ type }) => type), ["panel:thread-prepared"]);
  assert.equal(harness.pending().composer, harness.editor);
  assert.match(harness.editor.textContent, /LOCAL-42/);
});

test("a draft sent before host prefill returns is named and confirmed even without sidebar rows", { timeout: 1_000 }, async (t) => {
  for (const bound of [false, true]) {
    let submitted;
    const harness = composerHarness(t, { bound, onPrefill: async ({ api, submit }) => {
      submit();
      submitted = api.pending();
      assert.equal(submitted.submitted, true);
      await api.publish();
      assert.equal(harness.requests.length, 0, "do not confirm until preparation supplies previousTurnId");
    } });
    await harness.run();
    assert.equal(harness.editor.textContent, "");
    assert.equal(submitted.submitted, true);
    if (bound) assert.equal(submitted.previousTurnId, "previous-turn");
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].action, "confirm-task-conversation");
    assert.equal(harness.requests[0].payload.title, "Plan fixture task");
    if (bound) assert.equal(harness.requests[0].payload.previousTurnId, "previous-turn");
    await harness.created;
    assert.deepEqual(harness.messages.map(({ type }) => type), ["panel:thread-prepared", "panel:thread-created"]);
    assert.equal(harness.pending(), null);
  }
});

test("host prefill failure preserves the actual error and removes pending submission state", async (t) => {
  for (const bound of [false, true]) {
    const harness = composerHarness(t, { bound, onPrefill: async () => {
      throw new Error("Fixture host could not insert the selected skill");
    } });
    await harness.run();
    assert.deepEqual(harness.messages.map(({ type }) => type), ["panel:thread-create-error"]);
    assert.equal(harness.messages[0].payload.error, "Fixture host could not insert the selected skill");
    assert.equal(harness.pending(), null);
    assert.equal(harness.stored(), null);
    await harness.publish();
    assert.equal(harness.requests.length, 0);
  }
});

test("ordinary successful prefill leaves an unsent draft ready without confirming a conversation", async (t) => {
  for (const bound of [false, true]) {
    const harness = composerHarness(t, { bound });
    await harness.run();
    assert.equal(harness.pending().submitted, false);
    assert.equal(harness.stored().submitted, false);
    if (bound) assert.equal(harness.stored().previousTurnId, "previous-turn");
    assert.equal(harness.editor.querySelector("[skill-mention-name]").getAttribute("skill-mention-name"), "manage-panel");
    assert.match(harness.editor.textContent, /Read LOCAL-42 and prepare its plan/);
    await harness.publish();
    assert.equal(harness.requests.length, 0);
    assert.deepEqual(harness.messages.map(({ type }) => type), ["panel:thread-prepared"]);
  }
});
