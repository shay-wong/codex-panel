import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const menuSource = await readFile(
  new URL("../web/src/components/ProjectAutomationMenu.tsx", import.meta.url),
  "utf8",
);
const detailSource = await readFile(
  new URL("../web/src/components/TaskDetail.tsx", import.meta.url),
  "utf8",
);
const iconSource = await readFile(
  new URL("../web/src/components/PanelIcon.tsx", import.meta.url),
  "utf8",
);
const playIcon = await readFile(
  new URL("../web/src/assets/panel/automation-play.svg", import.meta.url),
  "utf8",
);
const pauseIcon = await readFile(
  new URL("../web/src/assets/panel/automation-pause.svg", import.meta.url),
  "utf8",
);
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("project automation reads and writes the persistent Panel policy", () => {
  assert.match(apiSource, /\/api\/local\/projects\/\$\{encodeURIComponent\(projectId\)\}\/automation/);
  assert.match(apiSource, /method: "PUT", body: JSON\.stringify\(options\)/);
  assert.match(appSource, /getProjectAutomationPolicy\(projectId\)/);
  assert.match(appSource, /saveProjectAutomationPolicy\(selectedProject\.id, options\)/);
  assert.match(appSource, /const projectId = selectedProjectId;/);
  assert.match(appSource, /automationUnavailableReason,\s*selectedProjectId,\s*text/);
  assert.match(appSource, /catch \(error\) \{\s*if \(selectedProjectIdRef\.current === projectId\) \{\s*setAutomationError/);
  assert.doesNotMatch(appSource, /setProjectAutomations|readProjectAutomations/);
  assert.match(appSource, /LEGACY_PROJECT_AUTOMATIONS_KEY/);
  assert.match(appSource, /operation: "pause"/);
  assert.doesNotMatch(appSource, /operation: "apply-policy"/);
});

test("automation is local to repository projects", () => {
  assert.match(appSource, /panelMetadata\?\.mode === "cloud"/);
  assert.match(appSource, /selectedProject\.source === "jira"/);
  assert.match(appSource, /请在关联仓库项目中设置自动化/);
  assert.match(appSource, /setSelectedProjectAutomation\(null\)/);
});

test("the automation menu exposes execution policy and queue state", () => {
  assert.match(menuSource, /自动认领开关/);
  assert.match(menuSource, /暂停当前项目/);
  assert.match(menuSource, /draft\.paused/);
  assert.match(menuSource, /扫描间隔/);
  assert.match(menuSource, /5, 10, 15, 30, 60/);
  assert.match(menuSource, /AUTOMATION_MODELS\.map/);
  assert.match(menuSource, /EFFORT_LABELS\[effort\]/);
  assert.match(menuSource, /TaskPropertyPicker/);
  assert.match(menuSource, /automation\?\.queue\.queued/);
  assert.match(menuSource, /automation\?\.queue\.running/);
  assert.match(menuSource, /automation\?\.queue\.blocked/);
  assert.match(menuSource, /automation\?\.queue\.failed/);
  assert.match(menuSource, /默认项目并行数/);
  assert.match(menuSource, /当前项目并行数/);
  assert.match(menuSource, /Array\.from\(\{ length: 8 \}/);
  assert.match(menuSource, /createPortal/);
  assert.match(menuSource, /aria-busy=\{pending\}/);
  assert.match(styles, /\.project-automation-queue\s*\{/);
});

test("automation changes submit immediately and reconcile server state", () => {
  assert.match(menuSource, /const disabled = pending \|\| Boolean\(unavailableReason\)/);
  assert.match(menuSource, /setDraft\(next\);\s*onChange\(next\)/);
  assert.match(menuSource, /submitChange\(withAutomationModel\(draft, value as AutomationModel\)\)/);
  assert.match(menuSource, /wasPendingRef\.current && !pending/);
  assert.doesNotMatch(menuSource, />保存</);
  assert.match(appSource, /onOpen=\{\(\) => void reconcileProjectAutomation\(\)\}/);
  assert.match(appSource, /onChange=\{saveProjectAutomation\}/);
});

test("issue details expose one persistent immediate-execution action", () => {
  assert.match(apiSource, /\/api\/local\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/claim/);
  assert.match(detailSource, /await claimTask\(currentTask\.id\)/);
  assert.match(detailSource, /currentTask\.status === "todo"/);
  assert.match(detailSource, /正在加入队列/);
  assert.match(detailSource, /等待执行槽位/);
  assert.match(detailSource, /自动执行中/);
  assert.match(detailSource, /等待你的回复/);
  assert.match(detailSource, /aria-busy=\{claiming \|\| claimState === "running"\}/);
  assert.match(styles, /\.detail-run-action/);
});

test("automation status uses the exported Panel play and pause icon assets", () => {
  assert.match(iconSource, /import automationPause from "\.\.\/assets\/panel\/automation-pause\.svg"/);
  assert.match(iconSource, /import automationPlay from "\.\.\/assets\/panel\/automation-play\.svg"/);
  assert.match(iconSource, /const PANEL_ICONS = \{[\s\S]*?automationPause,[\s\S]*?automationPlay,/);
  assert.match(playIcon, /width="16" height="16" viewBox="0 0 16 16"/);
  assert.match(pauseIcon, /width="16" height="16" viewBox="0 0 16 16"/);
});
