import { beforeEach, describe, expect, it } from "vitest";
import {
  PENDING_JIRA_PLANNING_TIMEOUT_MS,
  clearPendingJiraPlanning,
  readPendingJiraPlanning,
  savePendingJiraPlanning,
} from "./jiraPlanningStorage";

describe("pending Jira planning storage", () => {
  beforeEach(() => {
    const pending = readPendingJiraPlanning(0);
    if (pending) clearPendingJiraPlanning(pending.taskId);
  });

  it("restores a planning intent after component state is recreated", () => {
    savePendingJiraPlanning({
      taskId: "jira-task",
      kind: "planning",
      projectId: "repository",
    }, 100);

    expect(readPendingJiraPlanning(101)).toEqual({
      taskId: "jira-task",
      kind: "planning",
      projectId: "repository",
      expiresAt: 100 + PENDING_JIRA_PLANNING_TIMEOUT_MS,
    });
  });

  it("uses the repository selected by the latest planning attempt", () => {
    savePendingJiraPlanning({
      taskId: "jira-task",
      kind: "planning",
      projectId: null,
    }, 100);
    savePendingJiraPlanning({
      taskId: "jira-task",
      kind: "planning",
      projectId: "relinked-repository",
    }, 101);

    expect(readPendingJiraPlanning(102)?.projectId).toBe("relinked-repository");
  });

  it("removes an expired planning intent", () => {
    savePendingJiraPlanning({
      taskId: "jira-task",
      kind: "planning",
      projectId: null,
    }, 100);

    expect(readPendingJiraPlanning(100 + PENDING_JIRA_PLANNING_TIMEOUT_MS)).toBeNull();
    expect(readPendingJiraPlanning(0)).toBeNull();
  });
});
