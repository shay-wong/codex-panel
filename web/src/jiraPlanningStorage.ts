import { panelStorage } from "./storage";

export type PendingJiraPlanning = {
  taskId: string;
  kind: "planning" | "replan";
  lifecycleVersion?: number;
  projectId: string | null;
  expiresAt: number;
};

export const PENDING_JIRA_PLANNING_TIMEOUT_MS = 10 * 60_000;
const PENDING_JIRA_PLANNING_KEY = "panel.pending-jira-planning.v1";

export function readPendingJiraPlanning(now = Date.now()): PendingJiraPlanning | null {
  try {
    const pending = JSON.parse(panelStorage.getItem(PENDING_JIRA_PLANNING_KEY) ?? "null") as Partial<PendingJiraPlanning> | null;
    if (
      typeof pending?.taskId !== "string"
      || pending.taskId.trim() === ""
      || (pending.kind !== "planning" && pending.kind !== "replan")
      || (pending.projectId !== null && (
        typeof pending.projectId !== "string" || pending.projectId.trim() === ""
      ))
      || typeof pending.expiresAt !== "number"
      || !Number.isFinite(pending.expiresAt)
      || pending.expiresAt <= now
      || (pending.kind === "replan" && typeof pending.lifecycleVersion !== "number")
    ) {
      panelStorage.removeItem(PENDING_JIRA_PLANNING_KEY);
      return null;
    }
    return pending as PendingJiraPlanning;
  } catch {
    panelStorage.removeItem(PENDING_JIRA_PLANNING_KEY);
    return null;
  }
}

export function savePendingJiraPlanning(
  pending: Omit<PendingJiraPlanning, "expiresAt">,
  now = Date.now(),
) {
  panelStorage.setItem(PENDING_JIRA_PLANNING_KEY, JSON.stringify({
    ...pending,
    expiresAt: now + PENDING_JIRA_PLANNING_TIMEOUT_MS,
  }));
}

export function clearPendingJiraPlanning(taskId: string) {
  if (readPendingJiraPlanning()?.taskId === taskId) {
    panelStorage.removeItem(PENDING_JIRA_PLANNING_KEY);
  }
}
