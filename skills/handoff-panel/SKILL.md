---
name: handoff-panel
description: Create the standard temporary conversation handoff and attach the same redacted handoff to a specified Codex Panel issue. Use when the user explicitly invokes $handoff-panel or asks to hand off the current conversation to a Panel issue from any Codex surface.
---

# Handoff Panel

Use `$handoff-panel --issue ISSUE-ID [handoff focus]` from any Codex conversation.

## Workflow

1. Parse exactly one `--issue ISSUE-ID` or `--issue=ISSUE-ID` option. Require it. Treat all remaining text as the optional focus passed to the base handoff; never include the routing option or Issue ID in that focus unless the user repeats it separately.
2. Read the installed base Skill at `~/.agents/skills/handoff/SKILL.md` at execution time. Follow all of its instructions exactly, using the optional focus from step 1 as its arguments. Do not copy, replace, or modify that Skill.
3. Capture the absolute path of the temporary handoff document produced by the base Skill. Do not create the document in the workspace.
4. Resolve this Skill's directory from the loaded `SKILL.md` path, then publish the document with:

   ```bash
   node <handoff-panel-skill-dir>/scripts/publish-handoff.mjs \
     --issue ISSUE-ID \
     --handoff-file /absolute/path/to/handoff.md
   ```

5. The publisher validates that the target is an existing, non-archived Issue before adding the comment. Consume the JSON emitted by `panelctl`, then report both the Issue identifier and temporary document path after a successful write.

## Boundaries

- Reuse the base handoff document verbatim inside the `AI 对话交接` comment. Do not generate a second summary or add conversation details that are absent from that document.
- Let `panelctl` attribute the comment to the current Codex conversation through `CODEX_THREAD_ID`. Do not invent or substitute a thread ID.
- Add only the handoff comment. Do not change the Issue description, status, assignee, labels, relations, or development context.
- If Panel publication fails after the base handoff succeeds, keep the temporary document, report the publication failure and its path, and do not report the overall operation as fully successful.
- Never change the behavior or files of the original `$handoff` Skill. The same workflow applies inside and outside embedded Panel chat.
