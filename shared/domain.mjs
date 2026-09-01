export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
];
export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"];

export const DEFAULT_PROJECT_ID = "local";
export const JIRA_PROJECT_ID = "jira-my-tasks";
export const PROJECT_ISSUE_KEY_PATTERN = /^[A-Z0-9]{1,12}$/;
export const DEFAULT_LABEL_NAMES = [
  "缺陷",
  "特性",
  "for-claude",
  "hold",
  "改进",
  "phase-1",
  "phase-2",
  "phase-3",
  "phase-4",
  "phase-5",
  "phase-6",
];

export function isTaskStatus(value) {
  return TASK_STATUSES.includes(value);
}

export function isTaskPriority(value) {
  return TASK_PRIORITIES.includes(value);
}

export function normalizeProjectIssueKey(value) {
  return String(value).trim().toUpperCase();
}

export function defaultProjectIssueKey({ id, name, firstIdentifier = null }) {
  const existing = /^([A-Z0-9]{1,12})-\d+$/i.exec(String(firstIdentifier ?? ""))?.[1];
  if (existing) return existing.toUpperCase();
  const idKey = normalizeProjectIssueKey(id).replace(/[^A-Z0-9]+/g, "").slice(0, 12) || "TASK";
  if (idKey.length <= 5) return idKey;
  return normalizeProjectIssueKey(name).replace(/[^A-Z0-9]+/g, "").slice(0, 3)
    || idKey.slice(0, 3);
}

export function nextProjectIssueKey(project, unavailableKeys) {
  const base = defaultProjectIssueKey(project);
  if (!unavailableKeys.has(base)) return base;
  for (let number = 2; ; number += 1) {
    const suffix = String(number);
    const candidate = `${base.slice(0, 12 - suffix.length)}${suffix}`;
    if (!unavailableKeys.has(candidate)) return candidate;
  }
}

export function jiraDescriptionToMarkdown(value) {
  if (typeof value !== "string") return "";
  return value.replace(/^([ \t]*)#\s+/gm, (_, indent) => `${indent}1. `).slice(0, 100_000);
}
