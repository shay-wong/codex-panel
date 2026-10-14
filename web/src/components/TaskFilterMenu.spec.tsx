import { useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TaskboardLanguageProvider } from "../i18n";
import { EMPTY_TASK_FILTERS, matchesTaskFilters, readTaskFilters, writeTaskFilters, type TaskFilters } from "../taskFilters";
import type { Task } from "../types";
import { TaskFilterMenu } from "./TaskFilterMenu";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

it("filters synchronized Jira projects and restores all projects without clearing other filters", () => {
  const actor = { type: "user" as const, id: "fixture", name: "Fixture", avatarUrl: null };
  const first: Task = {
    id: "jr", identifier: "internal:1", projectId: "jira-my-tasks", externalKey: "JR-12259",
    title: "JR issue", description: "", source: "jira", status: "todo", priority: "medium", labels: [],
    sortOrder: 0, threadId: null, threadBinding: null, legacyLocalThreadId: null, conversationRefs: [],
    participants: [], previewImage: null, activityKey: "fixture", activityUpdatedAt: "2026-10-14",
    creatorType: "user", creatorId: actor.id, creatorName: actor.name, creatorAvatarUrl: null, assignee: actor,
    developmentContext: null, startDate: null, dueDate: null, recurrence: null, externalUrl: null,
    archivedAt: null, claim: null, version: 1, createdAt: "2026-10-14", updatedAt: "2026-10-14",
    relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
  };
  const tasks: Task[] = [first,
    { ...first, id: "jd", externalKey: "JD-144", title: "JD issue" },
    { ...first, id: "local", source: "local", externalKey: null, title: "Local issue" },
  ];
  function Board() {
    const [filters, setFilters] = useState<TaskFilters>({ ...EMPTY_TASK_FILTERS, priorities: ["medium"] });
    useEffect(() => writeTaskFilters(filters), [filters]);
    return <TaskboardLanguageProvider language="zh">
      <TaskFilterMenu tasks={tasks} search="" labels={[]} filters={filters} onChange={setFilters} sort="default" onSortChange={() => {}} />
      <ul aria-label="议题">{tasks.filter(task => matchesTaskFilters(task, filters)).map(task => <li key={task.id}>{task.title}</li>)}</ul>
    </TaskboardLanguageProvider>;
  }
  render(<Board />);
  fireEvent.click(screen.getByRole("button", { name: /筛选议题/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Jira 项目/ }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^JR/ }));
  expect(within(screen.getByRole("list", { name: "议题" })).getAllByRole("listitem").map(node => node.textContent)).toEqual(["JR issue"]);
  expect(readTaskFilters().jiraProjects).toEqual(["JR"]);
  expect(readTaskFilters().priorities).toEqual(["medium"]);
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^JD/ }));
  expect(within(screen.getByRole("list", { name: "议题" })).getAllByRole("listitem")).toHaveLength(2);
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "全部项目" }));
  expect(readTaskFilters().jiraProjects).toEqual([]);
  expect(readTaskFilters().priorities).toEqual(["medium"]);
  expect(within(screen.getByRole("list", { name: "议题" })).getAllByRole("listitem")).toHaveLength(3);
});
