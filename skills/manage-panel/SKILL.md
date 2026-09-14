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
   - Read `issue planning get ISSUE_ID` for its saved Spec; for a sub-issue, also read the parent task's Spec through `task.relations.parent.id` and apply only the child's authorized scope. Then follow **Select applicable workflow stages** below. An execution entry does not automatically authorize implementation or code review.
   - A comment headed `AI 对话交接` is a handoff summary from a prior Codex conversation, created either by embedded chat or `$handoff-panel`. Use the latest such comment as prior discussion context, while newer issue content and later comments take precedence.
   - In a description or comment, `![alt](/api/attachments/<id>/content)` marks an inline image at that exact position in the text.
   - When understanding that image is necessary, use `attachment download` to save it locally, then inspect the saved file with an available image-viewing tool.
   - Execute the requested work in the issue's bound branch or worktree when one is present.
4. For complex work, run `project readme get [PROJECT_ID]` before planning or implementation to inspect repository architecture, constraints, and conventions. Keep the root project README concise; detailed multi-page documentation belongs in the repository's `docs/` directory.
5. Create or update issues with the CLI; consume its JSON output.
   Issues created through `panelctl` are assigned to Codex Agent by default. Later CLI updates do not change the assignee.
6. Let `panelctl` attribute every issue, relation, or comment mutation to the current Codex conversation through `CODEX_THREAD_ID`. Outside Codex, pass the exact conversation id with `--thread-id`. This attribution alone is not a complete task binding.
   When the user explicitly asks to bind the current conversation to an Issue or Jira key, run `conversation bind ISSUE_ID`. Do not infer binding from invoking this Skill, mentioning an Issue, reading it, commenting on it, or sharing its repository. Jira binding initializes a missing local planning record using the current conversation, including on a repeated binding. An existing plan, its Spec, and its planning conversation are preserved. Read `jira planning get` again for `plan.version`; binding does not change Jira fields or status.
   When the user explicitly asks to link repositories to a Jira requirement, resolve their exact IDs with `project list`, read the latest Jira context with `jira planning get`, then run `jira repositories set JIRA_ID --projects PROJECT_ID,... --if-version CONTEXT_JIRA_VERSION`. The command replaces the complete linked-repository set, so an additive request must include the existing `context.projects` IDs; remove or replace links only when the user explicitly asks. Never infer or silently add a repository from the current directory, conversation project, or generated tickets.
7. To claim a `todo` issue, move it to `in_progress` with `--if-version` from the latest read before starting implementation. The claim and every later owned `issue move` must pass the complete saved `threadBinding`: `threadId`, `codexProjectId`, `codexProjectKind`, `codexHostId`, and `workspacePath`, using all five explicit `--binding-*` options. If any identity field is unavailable, stop before claiming; never create a legacy binding containing only `threadId`. Preserve an existing complete binding exactly and never take over a binding owned by another conversation. If the claim reports a version conflict or a new read shows changed status or requirements, skip the issue and do not implement it.
8. Include `--if-version <version>` on every concurrent update, using the version returned by the latest read.
9. Before requesting review, verify the requested work and acceptance criteria.
10. After the applicable work and self-verification, add a comment summarizing the key changes, verification, result, and remaining risks; then move the issue to `in_review`. For research, include sources, findings, and uncertainties instead of a code-review result. Never move it directly to `done`.
11. Move an issue from `in_review` to `done` only when the user explicitly confirms acceptance or explicitly asks to mark it complete. Codex self-verification alone is not sufficient.
12. Move work that cannot continue to `blocked`, and work that will not continue to `canceled`.

Use `issue list --archived true|false|all` when archived state matters. Issue creation and updates support `--start-date`; `issue update --project` moves an issue to another project while preserving its linked conversation when no other conversation change is requested.

For version conflicts outside the initial claim, read the issue again, reconcile the newer state, and retry with its current version.

## Select applicable workflow stages

After reading the issue and comments, determine the requested work from its content and the user's authorization, not its title, status, or the name of the entry button. Do not require the user to classify the issue.

- Pure research, explanations, comparisons, and findings reports: investigate, check sources and evidence, state uncertainties, and deliver the findings. Do not load or invoke implementation or code-review Skills. Saving a research report alone does not turn it into a coding task. `in_review` means awaiting user confirmation, not that a code-review Skill ran.
- Authorized implementation: before editing, run `panelctl workflow get execution --project PROJECT_ID --json` using `task.projectId` from `issue get`.
- Code changes or an explicit code-review request: before review, run `panelctl workflow get review --project PROJECT_ID --json`. A read-only review of existing code can use this stage without first entering implementation.
- Planning, Spec creation, or task decomposition for any task: use `planning`, regardless of Jira association. An explicit handoff uses `handoff`, retaining its authorization boundary in `$handoff-panel`.

For each applicable stage, read the current configuration at stage entry. Check `appliesWhen`, apply `prompt` together with `rules`, and read each returned `skills[].path` (`SKILL.md`) in order before following it. Skill paths come from the target project's catalog; do not guess paths or substitute an installed Skill by name. These instructions do not authorize editing the Skills themselves. When `mode` is `default`, follow the returned default method in `prompt`; if `missing` is nonempty, report the unavailable Skills and follow the returned fallback. A failed configuration read is not an empty configuration: report the failure before proceeding with that stage.

Skip stages that do not apply, even when they have configured Skills or custom prompts. If research later leads to authorized code changes, enter the execution and review stages then; a recommendation to change code is not authorization. Record the stages used or skipped briefly in the final result, without claiming a skipped review was completed.

## Planning and Specs for all tasks

Planning is available for ordinary tasks, including backlog tasks and research, as well as Jira requirements. Read `workflow get planning --project PROJECT_ID --json`, the latest issue, comments, attachments, `issue planning get ISSUE_ID --json`, and `issue tree ISSUE_ID --direction descendants --depth 1 --json` before forming a plan. An execution Issue linked to Jira still owns its own Spec; only a task whose `source` is `jira` uses the Jira publication flow below.

Save an approved ordinary-task Spec with `issue planning save ISSUE_ID --spec-file SPEC.md --if-version N --json`, using `plan.version` from a fresh `issue planning get`. A never-saved ordinary Spec has version 1. Keep the Spec on the main task; do not replace its description or create a separate Spec Issue. On a version conflict, reconcile with the saved Spec before retrying.

An ordinary main task can be split into multiple sub-issues. After the user approves the breakdown, use `issue create --project PROJECT_ID --status backlog` for each missing child, then `issue relation add CHILD_ID --type parent --issue MAIN_ID --if-version CHILD_VERSION`. Add `blocked_by` or `blocks` relations for the approved dependencies, reading each issue's latest version before the relation write. Use the existing task tree and Spec to reuse children when continuing a partially completed breakdown. Ordinary parent and dependency relations currently require the same project. Report the created identifiers and verify them with `issue tree` and `issue get`.

Planning preparation only fills a draft. The user sends it manually; binding that conversation and saving the Spec do not start implementation or change the task's status. Native Plan mode is read-only: after approval, leave Plan mode to save the Spec or create children. Saving or approving a plan does not itself authorize implementation. If the user subsequently authorizes execution, read the saved Spec and applicable execution configuration, and continue in the same bound conversation. Child creation alone never starts those children.

## Jira planning conversations

When the conversation was opened from a Jira issue and the initial instruction provides its exact Jira task ID:

1. Treat Jira as the requirement and the generated Panel Issues as repository-owned execution work. Do not edit repository code in the planning conversation.
2. After the Spec is approved, save it as the Jira planning artifact with `jira planning save`; do not create a Panel Issue for the Spec. Follow the planning Skills selected in Panel global workflow settings, or Codex Plan when none are selected. Native Plan mode is read-only: wait until the user approves the plan and exits Plan mode before saving or publishing.
3. After explicit user approval of the ticket breakdown, publish one manifest with `jira planning publish`; do not create the tickets one by one. Personal `to-spec` or `to-tickets` Skills are optional.
4. Read `jira planning get` immediately before each planning save or publish and pass the returned `plan.version` with `--if-version`.
5. Every ticket must target a repository already linked to the Jira issue. If the user explicitly names the missing repository in this conversation, link it with `jira repositories set` before saving or publishing; otherwise stop and ask the user to select one. Published tickets start in `backlog`; dependency keys become blocking relations, including across linked repositories.
6. If Jira content or linked repositories changed, stop publication and continue the planning conversation so the user can review the updated plan.
