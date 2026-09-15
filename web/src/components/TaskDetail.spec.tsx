import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { TaskDetail } from "./TaskDetail";
import { TaskboardLanguageProvider } from "../i18n";

vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(),
  getTaskPlan: async () => ({ spec: "", version: 1, updatedAt: null }),
  listComments: async () => [],
  listTaskActivities: async () => [],
  listAttachments: async () => [],
}));
vi.mock("./InlineMediaComposer", () => ({ InlineMediaComposer: () => <div /> }));
afterEach(cleanup);

it("shows manual conversation activity and opens its binding without preparing another execution", async () => {
  const binding = { threadId: "planning-thread", codexProjectId: "project", codexProjectKind: "local" as const, codexHostId: "local", workspacePath: "/disposable/workspace" };
  const actor = { type: "user" as const, id: "fixture", name: "Fixture", avatarUrl: null };
  const task: ComponentProps<typeof TaskDetail>["task"] = {
    id: "task", identifier: "TEST-1", projectId: "project", title: "Manual execution", description: "",
    status: "in_progress", priority: "none", labels: [], version: 1, source: "local", claim: null,
    threadBinding: binding, legacyLocalThreadId: null, conversationRefs: [], assignee: actor,
    relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
    createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
    creatorType: "user", creatorId: "fixture", creatorName: "Fixture", creatorAvatarUrl: null,
    archivedAt: null, developmentContext: null, startDate: null, dueDate: null, recurrence: null,
    sortOrder: 0, threadId: binding.threadId, participants: [], previewImage: null,
    activityKey: "fixture", activityUpdatedAt: "2026-09-15T00:00:00.000Z", externalUrl: null,
  };
  const open = vi.fn();
  const prepare = vi.fn();
  const props = {
    task, tasks: [task], referenceTasks: [],
    projects: [{ id: "project", name: "Fixture", issueKey: "TEST", workspacePath: binding.workspacePath,
      source: "local", labels: [], issueCount: 1, createdAt: task.createdAt, updatedAt: task.updatedAt }],
    jiraRepositoryProjects: [], currentUser: actor,
    jiraAvailable: false, availableLabels: [], developmentScan: { workspacePath: null, contexts: [] },
    developmentScanLoading: false, commentsRevision: 0, attachmentsRevision: 0, aiChatThreads: [],
    openingThread: false, onOpenThread: open, onPrepareExecution: prepare, onError: vi.fn(),
  } as unknown as ComponentProps<typeof TaskDetail>;
  const view = (running: boolean, current = task) => <TaskboardLanguageProvider language="zh"><TaskDetail {...props} task={current} processingRunning={running} /></TaskboardLanguageProvider>;
  let result: ReturnType<typeof render>;
  await act(async () => { result = render(view(true)); });
  const running = screen.getByRole("button", { name: "正在处理 · 查看对话" });
  expect(running.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(running);
  expect(open).toHaveBeenCalledWith(binding);
  expect(prepare).not.toHaveBeenCalled();
  await act(async () => { result.rerender(view(false)); });
  expect(screen.getByRole("button", { name: "处理中 · 查看对话" }).getAttribute("aria-busy")).toBe("false");
  await act(async () => { result.rerender(view(false, { ...task, status: "todo" })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "准备执行" })); });
  expect(prepare).toHaveBeenCalledOnce();
});
