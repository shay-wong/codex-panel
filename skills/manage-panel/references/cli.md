# panelctl CLI

`panelctl` emits JSON for normal commands. Add `--json` when making the output contract explicit. Built-in help is the only successful stdout exception: it writes plain text, exits with code `0`, and does not contact Panel.

```bash
panelctl --help
panelctl issue --help
panelctl comment list --help
```

Use `--runtime-file FILE` with any command when an exact launcher runtime descriptor was injected.

## Terminology: local companion

**Companion** means the **device-local loopback HTTP service** used for cloud mode. In Chinese, prefer 本地 companion、本地配套服务, or 环回代理. Do not use 伴侣 or 伴侣 API. Ordinary `/api/tasks`, `/api/comments`, and `/api/attachments` routes are the Panel HTTP API, not the companion API.

## Context and projects

```bash
panelctl context current [--cwd PATH] [--json]
panelctl project list [--json]
panelctl project create --name NAME [--id ID] [--workspace-path PATH] [--json]
panelctl project map PROJECT_ID --workspace-path PATH [--json]
panelctl project readme get [PROJECT_ID] [--json]
panelctl project readme set [PROJECT_ID] (--content TEXT | --file PATH) [--if-version N] [--json]
```

Use `--workspace-path` to associate a project with a local repository. `context current` chooses the most specific project whose workspace contains the current directory, then falls back to the `local` project.

Use `project readme get` and `project readme set` to manage the project's single root README document. Detailed multi-page documentation belongs in the repository's `docs/` directory.

Set `CODEX_PANEL_URL` to override the default local API origin, `http://127.0.0.1:47823`.

For a shared cloud board, keep `panelctl` pointed at the loopback companion and configure the upstream HTTPS origin through it:

```bash
panelctl cloud login --url HTTPS_ORIGIN --actor-name NAME [--json]
panelctl cloud status [--json]
panelctl project list [--json]
panelctl project map PROJECT_ID --workspace-path /absolute/local/path [--json]
panelctl cloud logout [--json]
```

`cloud login` reads the shared password from a private `Shared key:` prompt. The actor name is the display attribution sent through Basic Authentication. The companion stores its configuration with mode `0600`; project mappings stay on the current device and can differ between collaborators. In cloud mode, failed upstream writes fail rather than falling back to or double-writing the local SQLite database.

Every issue or comment write must be attributed to a Codex conversation. In Codex, `panelctl` reads the current conversation from `CODEX_THREAD_ID`. Outside Codex, pass `--thread-id ID` explicitly. An explicit option takes precedence over the environment. Read commands do not require a conversation id.

Every successful command writes one JSON object with `schemaVersion` to stdout. The current schema version is `2`. Errors write one JSON object to stderr. Exit codes are `0` for success, `2` for invalid input, `3` when the service is unavailable, `4` for API or response errors, and `5` for conflicts.

## Read issues

```bash
panelctl issue list [--project PROJECT_ID] [--status STATUS] [--archived true|false|all] [--json]
panelctl issue get ID [--json]
panelctl issue tree ID --direction descendants|ancestors --depth N [--json]
```

`issue tree` is a bounded structural read. `--depth 1` returns only direct children or the direct parent; larger values include that many levels, up to 25. The response is flat and deterministic: every node carries `id`, traversal `parentId`, `depth`, and `path` (usable as a breadcrumb), plus a small issue summary. It never calculates status rollups or changes issues.

## Create issues

```bash
panelctl issue create \
  --project PROJECT_ID \
  --title TITLE \
  [--description TEXT | --description-file FILE] \
  [--status STATUS] \
  [--priority PRIORITY] \
  [--labels a,b] \
  [--thread-id ID] \
  [--git-branch BRANCH] \
  [--worktree-path PATH] \
  [--worktree-branch BRANCH] \
  [--start-date YYYY-MM-DD] \
  [--due-date YYYY-MM-DD] \
  [--recurrence-interval N --recurrence-unit day|week|month|year] \
  [--json]
```

Statuses are `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, and `canceled`. Priorities are `none`, `urgent`, `high`, `medium`, and `low`.

Issues created through `panelctl` are assigned to Codex Agent by default. Other CLI writes preserve the existing assignee.

## Update issues

Read the issue immediately before a write and pass its `version` with `--if-version`.

```bash
panelctl issue update ID \
  [--project PROJECT_ID] \
  [--title TITLE] \
  [--description TEXT | --description-file FILE] \
  [--status STATUS] \
  [--priority PRIORITY] \
  [--labels a,b] \
  [--thread-id ID] \
  [--git-branch BRANCH] \
  [--worktree-path PATH] \
  [--worktree-branch BRANCH] \
  [--start-date YYYY-MM-DD] \
  [--due-date YYYY-MM-DD] \
  [--recurrence-interval N --recurrence-unit day|week|month|year] \
  [--if-version N] \
  [--json]

panelctl issue move ID --status STATUS \
  [--thread-id ID] \
  [--binding-thread-id ID \
    [--binding-codex-project-id PROJECT_ID \
     --binding-codex-project-kind local|remote \
     --binding-codex-host-id HOST_ID \
     --binding-workspace-path PATH] \
   | --clear-binding-thread] \
  [--if-version N] [--json]
panelctl issue archive ID [--thread-id ID] [--if-version N] [--json]
panelctl issue restore ID [--thread-id ID] [--if-version N] [--json]
```

Use `issue move` to set `in_progress` before implementation and `in_review` after implementation and self-verification. Codex must not move work directly from `in_progress` to `done`; use `done` only after the user explicitly confirms acceptance or explicitly asks to mark the issue complete. Use `blocked` when work cannot continue and `canceled` when it will not continue. On a version conflict, fetch the issue again and reconcile before retrying.

`--thread-id` records the conversation performing the mutation; it does not create a complete task binding. `--binding-thread-id` can stand alone only to preserve a legacy local binding. If any binding identity option is present, all four identity options are required. A conversation that claims or continues an issue must pass all five `--binding-*` options together and preserve an existing complete binding exactly. `--clear-binding-thread` conflicts with every `--binding-*` option.

To explicitly bind the current Codex conversation without changing the Issue status or fields:

```bash
panelctl conversation bind ISSUE_ID [--thread-id ID] [--json]
```

`ISSUE_ID` may be a Panel ID, Panel identifier, or an unambiguous Jira key. The command requires the running Codex host to provide a complete project, host, and workspace identity. It is idempotent for the current conversation and refuses to replace another conversation's binding. For a Jira requirement it also starts or resumes the local Jira planning record; it never changes Jira fields or status.

Use either `--git-branch` or `--worktree-path`/`--worktree-branch`; an issue has only one development context. Issue JSON stores it as `developmentContext`, either `{ "type": "branch", "branch": "..." }` or `{ "type": "worktree", "path": "...", "branch": "..." }`. Its singular `threadId` is the Codex conversation that most recently created or changed the issue itself. Recurrence requires a due date. Changing only `--project` preserves the issue's existing linked conversation.

## Issue relations

Read the anchor issue immediately before adding or removing a relation and use its current version. Relation writes require Codex conversation attribution like every other issue write.

```bash
panelctl issue relation add ISSUE_ID \
  --type parent \
  --issue PARENT_ISSUE_ID \
  [--thread-id ID] \
  [--if-version N] \
  [--json]

panelctl issue relation add ISSUE_ID \
  --type blocks|blocked_by|related \
  --issue RELATED_ISSUE_ID \
  [--thread-id ID] \
  [--if-version N] \
  [--json]

panelctl issue relation remove ISSUE_ID \
  --type parent|blocks|blocked_by|related \
  --issue RELATED_ISSUE_ID \
  [--thread-id ID] \
  [--if-version N] \
  [--json]
```

For `--type parent`, `ISSUE_ID` is the child and `PARENT_ISSUE_ID` is its parent. Adding another parent replaces the child's current parent atomically. To add an existing issue as a sub-issue, anchor the command on the child and pass the exact parent identifier with `--issue PARENT_ISSUE_ID`.

For `blocks`, the anchor issue blocks the related issue. For `blocked_by`, the related issue blocks the anchor. `related` is symmetric. Self-relations, duplicates, and parent cycles are rejected. For compatibility, relation writes between different projects remain rejected for now; this is a temporary boundary, not the final hierarchy contract.

## Issue comments

Use the issue id to read or append comments. Comment updates and deletes require the latest comment `version` returned by `comment list`.

```bash
panelctl comment list ISSUE_ID [--after CURSOR] [--json]
panelctl comment add ISSUE_ID (--body TEXT | --body-file FILE) [--thread-id ID] [--json]
panelctl comment update COMMENT_ID --body TEXT --if-version N [--thread-id ID] [--json]
panelctl comment delete COMMENT_ID --if-version N [--thread-id ID] [--json]
```

Without `--after`, `comment list` returns the full list and a `nextCursor`. Keep that cursor and pass it to the next read of the same issue to receive only new or modified comments. `--body-file` reads UTF-8 content and passes it to the normal comment write path.

Each comment JSON object independently records the most recent conversation that created or changed that comment as `threadId`. Comment operations never change the parent issue's `threadId`.

## Jira planning

`jira planning get` is a read-only context lookup and may also be used by an execution workflow to resolve its linked Jira. Use `save` and `publish` only inside a planning conversation opened from a Jira issue:

```bash
panelctl jira planning get JIRA_OR_LINKED_ISSUE_ID [--json]
panelctl jira repositories set JIRA_ID --projects PROJECT_ID,... --if-version N [--json]
panelctl jira planning save JIRA_ID --spec-file SPEC.md --if-version N [--json]
panelctl jira planning publish JIRA_ID --tickets-file TICKETS.json --if-version N [--json]
```

`jira planning get` accepts a Jira task identity or a linked execution Issue identity and returns the Jira context plus `plan.version`. For a linked execution Issue, read `context.jira.externalKey`; a null `context.jira` means no Jira link exists. When the user explicitly asks to change repository links, resolve exact IDs with `project list`, then pass `context.jira.version` to `jira repositories set`; `--projects` replaces the complete linked-repository set, so include existing `context.projects` IDs when adding a repository. Remove or replace links only when the user explicitly asks, and never infer them from the current directory or conversation project. Save the synthesized Spec first. After the user approves the ticket breakdown, publish a JSON manifest in dependency order:

```json
{
  "items": [
    {
      "key": "api-contract",
      "projectId": "checkout-api",
      "title": "Add checkout contract",
      "description": "## What to build\n...",
      "priority": "medium",
      "labels": ["特性"],
      "blockedBy": []
    },
    {
      "key": "web-flow",
      "projectId": "checkout-web",
      "title": "Connect the checkout flow",
      "description": "## What to build\n...",
      "priority": "medium",
      "labels": ["特性"],
      "blockedBy": ["api-contract"]
    }
  ]
}
```

Keys are stable within one Jira plan and blockers reference those keys. Every `projectId` must already be linked to the Jira issue. Publication creates or updates `backlog` Issues, links them to Jira, preserves dependency edges, cancels replaced Issues that have not started, and keeps Issues that are already active, under review, or complete.

## Attachments

Issue descriptions and comments may contain inline images at exact positions in their Markdown:

```markdown
![alt text](/api/attachments/ATTACHMENT_ID/content)
```

List or upload attachments with exactly one target:

```bash
panelctl attachment list (--task TASK_ID | --comment COMMENT_ID) [--after CURSOR] [--json]
panelctl attachment upload --task TASK_ID --file PATH [--content-type TYPE] [--kind inline|attachment] [--json]
panelctl attachment upload --comment COMMENT_ID --file PATH [--content-type TYPE] [--kind inline|attachment] [--json]
```

Without `--after`, each attachment list returns a full list and its own `nextCursor`. Keep separate cursors for each task or comment target.

Download an attachment to an explicit local path before inspecting it:

```bash
panelctl attachment download ATTACHMENT_ID --output PATH [--json]
```

The command writes the response body as binary data and returns the absolute output path, content type, and size in its JSON result. Choose the output filename yourself; `panelctl` does not infer or append an extension.
