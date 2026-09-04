---
name: manage-panel
description: Manage panel projects, issues, issue relations, and comments through the panelctl CLI. Use when Codex needs to track a new requirement, inspect project work, create or update issues, relate dependent work, add progress notes, begin work on an issue, record completion, or coordinate concurrent updates.
---

# Manage Panel

Use `panelctl` for every project, issue, relation, and comment operation. Consume its JSON output. Use the exact issue identifier returned by Panel or supplied in the prompt; never assume, derive, or rewrite an identifier prefix. Open only the relevant section of [references/cli.md](references/cli.md) when command syntax is needed.

## Select the CLI and active service

- Use the exact `panelctl` binary and Panel URL supplied by the task or injected runtime. Do not replace them with a global CLI, the default port, or another Panel.
- On macOS, when no binary is injected and the desktop app is installed, use `"$HOME/Applications/Codex Panel.app/Contents/Resources/bin/panelctl" issue get ID --json`. Keep the quotes because the path contains a space. The packaged wrapper reads the active launcher runtime; do not reconstruct its tokenized URL.
- On Linux, when no binary is injected and Codex was started by the desktop app, use `panelctl issue get ID --json`. The desktop app adds its packaged wrapper to the managed Codex `PATH`; do not search the filesystem for another CLI or reconstruct the tokenized URL.
- If that exact command reaches a sandbox restriction on the loopback service, retry the same command with the required permission. Do not switch binaries or endpoints.

## Terminology: local companion

In this product, **companion** means the **device-local loopback service** used for cloud mode. Related names include `local companion`, `loopback companion`, and `CODEX_PANEL_COMPANION_URL`. When writing Chinese, use **本地 companion** / **本地配套服务** / **环回代理**; never translate it as **伴侣** or call ordinary Panel HTTP routes a “companion API”.

## Workflow

When any user message supplies an exact Jira task ID, run `jira planning get` with that ID before `context current`, even if the conversation was not opened from Jira. Use the returned `context.issues` as the Jira-linked Panel Issues, then read the relevant Issue, comments, and attachments through the normal workflow. This read-only lookup does not turn the conversation into a Jira planning conversation; `jira planning save` and `jira planning publish` remain limited to the planning workflow below.

When another workflow needs the Jira reference linked to an execution Issue, run `jira planning get` with the exact Panel Issue ID or identifier. Return `context.jira.externalKey` only when present. If `context.jira` is null, the Issue is not linked to Jira; never substitute the Panel `id` or `identifier` as a Jira key. This is also a read-only lookup and does not authorize planning writes.

1. For an existing issue, first run `issue get`, `comment list`, and `attachment list --task`. On the first handoff, omit `--after`, read the full lists, and keep each response's separate `nextCursor`. When the same task resumes, run `issue get` again and pass each saved cursor to its matching list with `--after` to read only new or modified entries. Comment lists include attachments on returned comments; use `attachment list --comment` with its own cursor when a known comment's attachment list can grow.
2. Search for an existing issue before creating one. Use `context current`, then list the project issues and compare their identifiers, titles, descriptions, and status.
   - If an issue already tracks the same requirement, append the new requirement or acceptance detail to that issue without discarding its existing scope.
   - If the work depends on, blocks, is blocked by, or is closely related to another issue, add the matching issue relation.
   - Use a parent/sub-issue relation when one requirement is a contained part of a larger issue. A child has one parent; a parent may have many sub-issues.
   - Create a new issue only when no existing issue reasonably tracks the requirement.
   - Do not create, append, or relate a tiny or trivial request that does not benefit from durable tracking.
3. Before executing an issue, read the latest issue content and all comments. Treat comments as part of the current requirements, especially when completed work has been returned for changes.
   - A comment headed `AI 对话交接` is a handoff summary from a prior Codex conversation, created either by embedded chat or `$handoff-panel`. Use the latest such comment as prior discussion context, while newer issue content and later comments take precedence.
   - In a description or comment, `![alt](/api/attachments/<id>/content)` marks an inline image at that exact position in the text.
   - When understanding that image is necessary, use `attachment download` to save it locally, then inspect the saved file with an available image-viewing tool.
   - Execute the requested work in the issue's bound branch or worktree when one is present.
4. For complex work, run `project readme get [PROJECT_ID]` before planning or implementation to inspect repository architecture, constraints, and conventions. Keep the root project README concise; detailed multi-page documentation belongs in the repository's `docs/` directory.
5. Create or update issues with the CLI; consume its JSON output.
   Issues created through `panelctl` are assigned to Codex Agent by default. Later CLI updates do not change the assignee.
6. Let `panelctl` attribute every issue, relation, or comment mutation to the current Codex conversation through `CODEX_THREAD_ID`. Outside Codex, pass the exact conversation id with `--thread-id`. This attribution alone is not a complete task binding.
   When the user explicitly asks to bind the current conversation to an Issue or Jira key, run `conversation bind ISSUE_ID`. Do not infer binding from invoking this Skill, mentioning an Issue, reading it, commenting on it, or sharing its repository. Jira binding starts or resumes that Jira requirement's local planning record without changing Jira fields or status.
   When the user explicitly asks to link repositories to a Jira requirement, resolve their exact IDs with `project list`, read the latest Jira context with `jira planning get`, then run `jira repositories set JIRA_ID --projects PROJECT_ID,... --if-version CONTEXT_JIRA_VERSION`. The command replaces the complete linked-repository set, so an additive request must include the existing `context.projects` IDs; remove or replace links only when the user explicitly asks. Never infer or silently add a repository from the current directory, conversation project, or generated tickets.
7. To claim a `todo` issue, move it to `in_progress` with `--if-version` from the latest read before starting implementation. The claim and every later owned `issue move` must pass the complete saved `threadBinding`: `threadId`, `codexProjectId`, `codexProjectKind`, `codexHostId`, and `workspacePath`, using all five explicit `--binding-*` options. If any identity field is unavailable, stop before claiming; never create a legacy binding containing only `threadId`. Preserve an existing complete binding exactly and never take over a binding owned by another conversation. If the claim reports a version conflict or a new read shows changed status or requirements, skip the issue and do not implement it.
8. Include `--if-version <version>` on every concurrent update, using the version returned by the latest read.
9. Before requesting review, verify the requested work and acceptance criteria.
10. After implementation and self-verification, add a comment summarizing the key changes, verification, result, and remaining risks; then move the issue to `in_review`. Never move it directly to `done`.
11. Move an issue from `in_review` to `done` only when the user explicitly confirms acceptance or explicitly asks to mark it complete. Codex self-verification alone is not sufficient.
12. Move work that cannot continue to `blocked`, and work that will not continue to `canceled`.

Use `issue list --archived true|false|all` when archived state matters. Issue creation and updates support `--start-date`; `issue update --project` moves an issue to another project while preserving its linked conversation when no other conversation change is requested.

For version conflicts outside the initial claim, read the issue again, reconcile the newer state, and retry with its current version.

## Jira planning conversations

When the conversation was opened from a Jira issue and the initial instruction provides its exact Jira task ID:

1. Treat Jira as the requirement and the generated Panel Issues as repository-owned execution work. Do not edit repository code in the planning conversation.
2. After `to-spec`, save the Spec as the Jira planning artifact with `jira planning save`; do not create a Panel Issue for the Spec.
3. After `to-tickets` and explicit user approval of the breakdown, publish one manifest with `jira planning publish`; do not create the tickets one by one.
4. Read `jira planning get` immediately before each planning save or publish and pass the returned `plan.version` with `--if-version`.
5. Every ticket must target a repository already linked to the Jira issue. If the user explicitly names the missing repository in this conversation, link it with `jira repositories set` before saving or publishing; otherwise stop and ask the user to select one. Published tickets start in `backlog`; dependency keys become blocking relations, including across linked repositories.
6. If Jira content or linked repositories changed, stop publication and continue the planning conversation so the user can review the updated plan.
