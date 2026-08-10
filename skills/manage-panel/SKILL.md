---
name: manage-panel
description: Manage panel projects, issues, issue relations, and comments through the panelctl CLI. Use when Codex needs to track a new requirement, inspect project work, create or update issues, relate dependent work, add progress notes, begin work on an issue, record completion, or coordinate concurrent updates.
---

# Manage Panel

Use `panelctl` for every project, issue, relation, and comment operation. Consume its JSON output. Use the exact issue identifier returned by Panel or supplied in the prompt; never assume, derive, or rewrite an identifier prefix. Open only the relevant section of [references/cli.md](references/cli.md) when command syntax is needed.

## Workflow

1. Search for an existing issue before creating one. Use `context current`, then list the project issues and compare their identifiers, titles, descriptions, and status.
   - If an issue already tracks the same requirement, append the new requirement or acceptance detail to that issue without discarding its existing scope.
   - If the work depends on, blocks, is blocked by, or is closely related to another issue, add the matching issue relation.
   - Use a parent/sub-issue relation when one requirement is a contained part of a larger issue. A child has one parent; a parent may have many sub-issues.
   - Create a new issue only when no existing issue reasonably tracks the requirement.
   - Do not create, append, or relate a tiny or trivial request that does not benefit from durable tracking.
2. Before executing an issue, read the latest issue content and all comments. Treat comments as part of the current requirements, especially when completed work has been returned for changes.
   - A comment headed `AI 对话交接` is a handoff summary from a prior Codex conversation, created either by embedded chat or `$handoff-panel`. Use the latest such comment as prior discussion context, while newer issue content and later comments take precedence.
   - In a description or comment, `![alt](/api/attachments/<id>/content)` marks an inline image at that exact position in the text.
   - When understanding that image is necessary, use `attachment download` to save it locally, then inspect the saved file with an available image-viewing tool.
   - Execute the requested work in the issue's bound branch or worktree when one is present.
3. Create or update issues with the CLI; consume its JSON output.
   Issues created through `panelctl` are assigned to Codex Agent by default. Later CLI updates do not change the assignee.
4. Let `panelctl` attribute every issue, relation, or comment mutation to the current Codex conversation through `CODEX_THREAD_ID`. Outside Codex, pass the exact conversation id with `--thread-id`.
5. To claim a `todo` issue, move it to `in_progress` with `--if-version` from the latest read before starting implementation. If this claim reports a version conflict or a new read shows that its status changed, skip the issue and do not implement it.
6. Include `--if-version <version>` on every concurrent update, using the version returned by the latest read.
7. Before requesting review, verify the requested work and acceptance criteria.
8. After implementation and self-verification, add a comment summarizing the key changes, verification, result, and remaining risks; then move the issue to `in_review`. Never move it directly to `done`.
9. Move an issue from `in_review` to `done` only when the user explicitly confirms acceptance or explicitly asks to mark it complete. Codex self-verification alone is not sufficient.
10. Move work that cannot continue to `blocked`, and work that will not continue to `canceled`.

Use `issue list --archived true|false|all` when archived state matters. Issue creation and updates support `--start-date`; `issue update --project` moves an issue to another project while preserving its linked conversation when no other conversation change is requested.

For version conflicts outside the initial claim, read the issue again, reconcile the newer state, and retry with its current version.
