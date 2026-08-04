# Fork capabilities

This page indexes the user-visible differences maintained by `shay-wong/codex-panel` relative to `chuspeeism/dashi-taskboard`.

## Codex Panel product and repository name

The browser title and repository entry points use the `Codex Panel` name, and the repository is named `codex-panel`. This is a long-lived fork identity difference. Existing `CODEX_TASKBOARD_*` environment variables and Taskboard integration identifiers remain unchanged for compatibility.

## Generated macOS launcher

On macOS, `npm ci` rebuilds the existing `~/Applications/Codex.app` launcher with its Codex name and icon. Opening it runs the repository's existing launcher flow, so the official `/Applications/ChatGPT.app` installation starts with CDP, the local Panel service starts, and the embedded sidebar entry opens without a terminal command. The service started by this launcher stops after that Codex instance exits.

Clicking the launcher while its CDP-enabled Codex is already running reuses a healthy resident injector and opens the embedded Panel before focusing the existing window. A missing or stale resident is replaced; the recovery reloads the Codex renderer once after enabling the CSP bypass, and the retired local service closes active connections before releasing SQLite.

Regenerate the app after moving the repository or changing the Node.js installation:

```bash
npm run launcher:install
```

The launcher never modifies the official `ChatGPT.app`. A Codex instance already running without CDP must still be quit before using the generated `Codex.app`.

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
