# Fork capabilities

This page indexes the user-visible differences maintained by `shay-wong/codex-taskboard` relative to `chuspeeism/dashi-taskboard`.

## Codex Taskboard product name

The browser title and repository entry points use the `Codex Taskboard` name. This is a long-lived fork identity difference and requires no configuration or migration.

## Reliable initial Codex injection

The standalone launcher waits up to 30 seconds for Codex's main renderer after CDP becomes reachable. It ignores auxiliary renderers such as global dictation and the avatar overlay.

Run the launcher as documented in [Embed in Codex](../README.md#embed-in-codex):

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

The wait duration is fixed. If no main renderer appears within 30 seconds, the launcher exits with `Timed out waiting for a Codex renderer target`.

## Open Taskboard from any native page

The Taskboard sidebar entry opens from conversations as well as native pages such as Plugins and Sites. No configuration or migration is required.

This fix accepts a main content frame that covers most of the Codex viewport even when that frame also includes the native titlebar region.
