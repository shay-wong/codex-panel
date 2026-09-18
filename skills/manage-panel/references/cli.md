# panelctl CLI

`panelctl` emits JSON for normal commands. Add `--json` when making the output contract explicit. Built-in help is the only successful stdout exception: it writes plain text, exits with code `0`, and does not contact Panel.

```bash
panelctl --help
panelctl issue --help
panelctl comment list --help
panelctl comment add --help
panelctl comment update --help
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

Every issue or comment write requires conversation attribution. For Codex, `panelctl` reads `CODEX_THREAD_ID` or accepts explicit `--thread-id ID` (which takes precedence). For Claude Code, Pi, AGY, or Grok, supply both `--agent-platform claude|pi|agy|grok` and `--session-id ID`. External attribution ignores `CODEX_THREAD_ID` and cannot be combined with `--thread-id`. No external session environment variables are inferred. Read commands do not require a conversation ID.

Every successful command writes one JSON object with `schemaVersion` to stdout. The current schema version is `2`. Errors write one JSON object to stderr. Exit codes are `0` for success, `2` for invalid input, `3` when the service is unavailable, `4` for API or response errors, and `5` for conflicts.

## External tool/session traceability

Use the original tool and its full session ID. For Pi, `--session-id` also accepts the full session-file path; prefer an absolute path when copying between working directories. This is stored metadata plus a copy action, not tool launch, authentication, an Agent runtime, or native Codex ownership.

```bash
panelctl issue create --project local --title "Session traceability" \
  --agent-platform claude --session-id '<claude-session-id>' --json

panelctl issue update ISSUE_ID --if-version N \
  --agent-platform pi --session-id '/absolute/session path/session.jsonl' --json

panelctl comment add ISSUE_ID --body 'Implementation notes' \
  --agent-platform agy --session-id '<conversation-id>' --json

panelctl comment update COMMENT_ID --body 'Updated implementation notes' --if-version N \
  --agent-platform grok --session-id '<grok-session-id>' --json
```

The same two options are accepted by `issue move`, `issue archive`, `issue restore`, `issue relation add|remove`, and `comment delete`. A metadata-only `issue update` is supported. Read back with `issue get` and `comment list` (omit `--after` for a full reread). Deleting a comment deletes its metadata; it does not attach that session to another record.

Task/comment JSON exposes `agentSession: { "platform": "pi", "sessionId": "..." }` or `null`. Local SQLite and cloud D1 both store it in nullable `agent_session` TEXT on `tasks` and `comments`. The cloud deployment must apply `0013_agent_sessions.sql` before serving the new worker. Omitting `agentSession` preserves the saved value; supplying a new object replaces the record's external session metadata; HTTP `agentSession: null` clears only that metadata. This field is not an append-only session history. Task `conversationRefs` includes separate external references from the task and its comments.

External attribution never writes to Codex `threadId` or the native five-field `threadBinding`. Existing native bindings remain intact. `issue move` and `comment add` still accept explicit, independent Codex `--binding-*` options; they must describe a real native Codex session, not the external controller. When both metadata and a native binding are present, the UI shows separate entries rather than relabeling a Codex session. Existing author/assignee identities are unchanged; the original tool is identified by the session metadata badge, not inferred from an actor name.

The detail view shows the original tool, ID/path, and copy button for both tasks and comments. The card conversation action copies for external sessions; it never sends them to `codex://` or the embedded Codex host. Copied commands use these fixed official entry points:

| Tool | Command |
| --- | --- |
| Claude Code | `claude --resume <session-id>` |
| Pi coding agent | `pi --session <path-or-id>` |
| Google Antigravity CLI (AGY) | `agy --conversation <conversation-id>` |
| xAI Grok CLI | `grok --resume <id>` |
| Existing Codex | `codex resume <thread-id>` |

The full original value is preserved without trimming or Codex prefix normalization. IDs are limited to 256 characters, or 4096 for Pi paths/IDs. Empty/blank values, control characters, and a leading option dash are rejected. Copying quotes shell metacharacters and apostrophes as **one POSIX-shell argument** for sh/bash/zsh; this is not a PowerShell/cmd quoting mode. Run in the original tool's environment with the original session files, workspace, and credentials available. An ID or a syntactically correct command alone is not evidence of a restored session.

Official syntax evidence (checked 2026-09-17): [Claude sessions](https://code.claude.com/docs/en/sessions), [Pi session management](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md), [AGY resume](https://antigravity.google/docs/cli/commands/resume), [AGY headless](https://antigravity.google/docs/cli/headless/), [Grok CLI reference](https://docs.x.ai/build/cli/reference). Do not substitute `pi resume`, `agy resume`, or `grok resume`. Actual client continuation must be verified independently in an available real client; a clipboard/string check does not verify continuation.

## Read workflow configuration

```bash
panelctl workflow get execution --project PROJECT_ID --json
```

Replace `execution` with `review`, `planning`, or `handoff` for those stages. Use the exact `task.projectId` from `issue get`. This read-only command resolves the current global stage configuration against that project's Skill catalog through the active local service. It returns `appliesWhen`, `prompt`, `rules`, `mode`, ordered `skills` (`id`, `label`, `path`), and `missing` Skill IDs. Read each selected `SKILL.md` before following it. No custom Skills means the returned prompt describes the default method; unavailable selections return the existing default fallback. This command does not start a stage, send a message, or change the issue. Pure research skips execution and code review; query only stages applicable to the authorized work.

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

`ISSUE_ID` may be a Panel ID, Panel identifier, or an unambiguous Jira key. The command requires the running Codex host to provide a complete project, host, and workspace identity. It is idempotent for the current conversation and refuses to replace another conversation's binding. For a Jira requirement it initializes a missing local planning record, even if the same conversation was already bound. Existing plans, Specs, and planning conversations are preserved. Read `jira planning get` again for `plan.version`; binding never changes Jira fields or status.

Use either `--git-branch` or `--worktree-path`/`--worktree-branch`; an issue has only one development context. Issue JSON stores it as `developmentContext`, either `{ "type": "branch", "branch": "..." }` or `{ "type": "worktree", "path": "...", "branch": "..." }`. Its singular `threadId` retains the existing native Codex meaning; external sessions are stored separately in `agentSession`. Recurrence requires a due date. Changing only `--project` preserves the issue's existing linked conversation.

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

## Task planning and sub-issues

```bash
panelctl issue planning get ISSUE_ID --json
panelctl issue planning save ISSUE_ID --spec-file SPEC.md --if-version N --json
```

These commands save and read the task's Spec without replacing its description, changing its status, or starting execution. Read `plan.version` before saving; an ordinary task with no saved Spec returns an empty plan at version 1. A stale save returns `VERSION_CONFLICT`; read and reconcile instead of overwriting. Jira tasks use their existing Jira plan record; linked ordinary execution tasks retain their own Spec.

After approval, split an ordinary main task using the existing Issue and relation commands:

```bash
panelctl issue tree MAIN_ID --direction descendants --depth 1 --json
panelctl issue create --project PROJECT_ID --title "Child scope" --description-file CHILD.md --status backlog --json
panelctl issue relation add CHILD_ID --type parent --issue MAIN_ID --if-version CHILD_VERSION --json
panelctl issue relation add CHILD_ID --type blocked_by --issue PREREQUISITE_ID --if-version LATEST_CHILD_VERSION --json
```

Use returned identifiers and fresh versions; reuse existing children when resuming. The child and parent must belong to the same project. Repeat for the approved child scopes, then verify the main task's tree and child dependencies. Saving a Spec or creating backlog children does not authorize implementation. Ordinary planning can continue into authorized execution in the same conversation.

## Jira planning

`jira planning get` is a read-only context lookup and may also be used by an execution workflow to resolve its linked Jira. Use `save` and `publish` only inside a planning conversation opened from a Jira issue:

```bash
panelctl jira planning get JIRA_OR_LINKED_ISSUE_ID [--json]
panelctl jira repositories list [--json]
panelctl jira repositories set JIRA_ID --projects PROJECT_ID,... --if-version N [--json]
panelctl jira planning save JIRA_ID --spec-file SPEC.md --if-version N [--json]
panelctl jira planning publish JIRA_ID --tickets-file TICKETS.json --if-version N [--json]
```

`jira planning get` accepts a Jira task identity or a linked execution Issue identity and returns the Jira context plus `plan.version`. For a linked execution Issue, read `context.jira.externalKey`; a null `context.jira` means no Jira link exists. During authorized Jira planning, use `jira repositories list` to discover saved projects and unregistered device workspaces. It returns `repositories` with `id`, `name`, `workspacePath`, and `persisted`, without writes. Read project READMEs and relevant repository docs/code to identify responsibilities. Follow the Skill's automatic-association steps: clear evidence permits additions, ambiguity requires a focused question, and native Plan mode must end before writes. Register a selected `persisted: false` candidate with `project create` using its exact returned values. Pass fresh `context.jira.version` to `jira repositories set`; `--projects` replaces the complete set, so include every existing link. Remove links only on explicit request, preserve user exclusions, and record new associations with their reasons in an `AI 仓库关联` comment. Merely reading Jira or sharing its current directory does not authorize association. Save the synthesized Spec first. After the user approves the ticket breakdown, publish a JSON manifest in dependency order:

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
