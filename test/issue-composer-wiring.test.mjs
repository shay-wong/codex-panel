import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const chatSource = await readFile(
  new URL("../web/src/components/AiChat.tsx", import.meta.url),
  "utf8",
);
const detailSource = await readFile(
  new URL("../web/src/components/TaskDetail.tsx", import.meta.url),
  "utf8",
);
const editorSource = await readFile(
  new URL("../web/src/components/TaskEditor.tsx", import.meta.url),
  "utf8",
);

test("all four issue composers request candidates with the owning project and surface", () => {
  assert.match(
    editorSource,
    /completionContext=\{\{ projectId, surface: "issue-description" \}\}/,
  );
  assert.equal(
    detailSource.match(/surface: "issue-description"/g)?.length,
    1,
  );
  assert.equal(detailSource.match(/surface: "comment"/g)?.length, 2);
  assert.match(appSource, /projectId=\{selectedProjectId\}/);
});

test("embedded AI composer rebinds durable references and hydrates only a fresh document", () => {
  assert.match(apiSource, /"\/api\/local\/ai\/composer\/rebind"/);
  assert.match(chatSource, /await rebindAiChatComposerReferences\(\{/);
  assert.match(chatSource, /if \(!rebound\.ready\)/);
  assert.match(chatSource, /resolvedNodes\.push\(rebound\.document\.nodes\[reboundIndex\]\)/);
  assert.match(chatSource, /if \(!unavailable\) tokenElement\.dataset\.composerCandidateRef = node\.candidateRef/);
  assert.match(chatSource, /setComposerRevision\(composerDraft\.revision\)/);
  assert.match(chatSource, /\|\| composerRebindBlocked/);
  assert.match(chatSource, /node\.type === "skill" \|\| node\.type === "agent"/);
});
