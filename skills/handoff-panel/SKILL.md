---
name: handoff-panel
description: Create the standard temporary conversation handoff and attach the same redacted handoff to a specified Codex Panel issue. Use when the user explicitly invokes $handoff-panel or asks to hand off the current conversation to a Panel issue from any Codex surface.
---

# Handoff Panel

Use `$handoff-panel --issue ISSUE-ID [handoff focus]` from any Codex conversation.

## Workflow

1. Parse exactly one `--issue ISSUE-ID` or `--issue=ISSUE-ID` option. Require it. Treat all remaining text as the optional handoff focus; never include the routing option or Issue ID in that focus unless the user repeats it separately.
2. Use the packaged `panelctl issue get ISSUE-ID --json` to resolve the issue and its `task.projectId`, then run `panelctl workflow get handoff --project PROJECT_ID --json`. If `skills` is nonempty, read the returned Skill paths and follow them in order with the optional focus. Never assume a personal `handoff` Skill is installed. If `missing` is nonempty, tell the user those configured Skills are unavailable and the built-in handoff will be used.
3. Without custom Skills, summarize the goal, accepted decisions, completed work, validation, remaining work and exact next action. Redact secrets. Save the summary as a temporary Markdown document outside the workspace, and capture its absolute path. With custom Skills, reuse their resulting document, or save their summary to such a temporary document.
4. Resolve this Skill's directory from the loaded `SKILL.md` path, then publish the document with:

   ```bash
   node <handoff-panel-skill-dir>/scripts/publish-handoff.mjs \
     --issue ISSUE-ID \
     --handoff-file /absolute/path/to/handoff.md
   ```

5. The publisher validates that the target is an existing, non-archived Issue before adding the comment. Consume the JSON emitted by `panelctl`, then report both the Issue identifier and temporary document path after a successful write.

## Boundaries

- Reuse the temporary handoff document verbatim inside the `AI 对话交接` comment. Do not generate a second summary or add conversation details that are absent from that document.
- Let `panelctl` attribute the comment to the current Codex conversation through `CODEX_THREAD_ID`. Do not invent or substitute a thread ID.
- Add only the handoff comment. Do not change the Issue description, status, assignee, labels, relations, or development context.
- If Panel publication fails after the temporary document is created, keep the temporary document, report the publication failure and its path, and do not report the overall operation as fully successful.
- Never modify selected or other installed Skills. This `$handoff-panel` workflow applies inside and outside embedded Panel chat.
