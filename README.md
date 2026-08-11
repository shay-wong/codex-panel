# Codex Panel

[简体中文](README.zh-CN.md) | [Fork capabilities](docs/fork-capabilities.md)

A local-first issue board that runs in a browser and can be embedded in Codex through the standalone CDP launcher or its injection script. The same HTTP API powers the React UI and the `panelctl` CLI used by the bundled Codex Skill.

The board includes dashboard, list, Gantt, and archived-issue workflows. Issues can carry start and due dates and can be moved from their detail view while retaining their linked conversation. Jira settings discover local Jira CLI configs before falling back to manual provider entry, and support separate aliases, config paths, JQL, preview, and completion policies; when JQL changes while preview is disabled, Panel asks whether to re-enable it. Synchronization is added by the later Jira workflow rather than provider registration itself.

## Requirements

- Node.js 22.5 or newer

## Run locally

```bash
npm install
npm run build
npm start
```

Open <http://127.0.0.1:47823>. On macOS, the SQLite database is stored at `~/Library/Application Support/Codex Panel/data/panel.sqlite` by default.

For development with live frontend reload:

```bash
npm run dev
```

The Vite UI runs at <http://127.0.0.1:5173> and proxies API requests to the local service.

## Use the CLI

Run it from the project:

```bash
npm run panelctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run panelctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

`npm run panelctl -- ...` works without installing a user command. Run `npm run codex:install` to install a managed `panelctl` launcher at `~/.local/bin/panelctl`; this also installs the Codex Skills, standalone runtime, and generated app described below. Set `CODEX_PANEL_URL` to point the CLI at another local or LAN service. Cloud deployments are configured through the loopback companion with `panelctl cloud login`.

## Install the Codex Skills

Install dependencies first, then explicitly install the Codex integration:

```bash
npm ci
npm run codex:install
```

The integration command builds and copies a standalone runtime to `~/Library/Application Support/Codex Panel/runtime`, copies `manage-panel` and `handoff-panel` into the standard user Skill directory at `~/.agents/skills`, installs `panelctl` in `~/.local/bin`, and generates the macOS launcher. The launcher receives its own signed copy of that runtime inside the app bundle. The installed files are real managed copies, not symbolic links back to the Git repository. Plain `npm ci` only installs project dependencies and does not write these user-level integrations. Start a new Codex task after installation to use `$manage-panel` and `$handoff-panel`.

On the first install, if the fixed data directory does not exist, the installer snapshots the existing repository `.data/panel.sqlite` and copies its attachments and local configuration without deleting the source. It also removes old repository-managed `~/.codex/skills` and Node-bin links. Re-running the command atomically refreshes only files carrying the Codex Panel ownership marker; user-managed files and directories are never overwritten. Moving or deleting the repository does not break the already installed runtime. Run the command again after pulling code updates or replacing Node.js to install a new version.

Existing browser settings and drafts are migrated from `taskboard.*` keys to `panel.*`. Legacy `CODEX_TASKBOARD_*` environment variables remain fallback aliases, but new configuration should use `CODEX_PANEL_*`.

`$manage-panel` teaches Codex to inspect an issue, move it to `in_progress`, use optimistic versions, verify the work, and then move it to `in_review`; it moves the issue to `done` only after the user explicitly confirms acceptance or asks to mark it complete.

`$handoff-panel --issue PROJECT-123 preserve the acceptance decisions` works from any Codex conversation. It first follows the installed `~/.agents/skills/handoff/SKILL.md` contract to create the normal temporary handoff document, then validates the target Issue and attaches that document verbatim to the Issue as an `AI 对话交接` Codex Agent comment. The original `$handoff` Skill remains unchanged, and a later Panel validation or publication failure does not remove its temporary document.

## Embed in Codex

### Recommended: use the native Codex Panel manager

`npm run codex:install` creates or refreshes `~/Applications/Codex Panel.app` and removes the previous managed `~/Applications/Codex.app` bootstrap. The native SwiftUI manager uses the installed runtime and data directory, so moving or deleting the source repository does not break it. Open it from Finder, the Dock, or the explicit path:

```bash
open "$HOME/Applications/Codex Panel.app"
```

The manager stays open as a normal Dock application. Its main window shows the Panel service, Codex/CDP, and embedded-integration status, with controls to open Panel, start, restart, or stop the managed processes, open the browser view or log, and reveal the data directory. “Connected” means the current signed injection is mounted in a renderer and publishing the manager's live heartbeat; a reachable HTTP service or CDP port alone is not reported as a successful embed. If the managed integration exits unexpectedly, the manager retries after 2, 5, and 15 seconds, then stops automatic recovery after more than three exits within 60 seconds and points to the log. Settings can register the app as a macOS login item and independently control whether launch connects Codex and opens Panel automatically. Both automatic options default to on.

The Update tab displays the full Fork version, checks the Fork's GitHub Releases once per launch, and supports a manual check. Only normalized `vX.Y.Z-fork.N` tags are update candidates; an available update opens only the validated `shay-wong/codex-panel` Release page. The app does not download or replace itself because this Fork does not yet publish a signed and notarized updater archive with a pinned public key.

The app icon is built from the official light and dark Codex resources in `ChatGPT.app`, with a diagonal `PANEL` corner ribbon. Installation fails clearly if either official appearance resource is unavailable, and the running Dock icon follows the current macOS appearance. When a valid Apple Development identity matching the global Git email is available, the installer signs with that identity so updates keep a stable macOS permission requirement; `CODEX_PANEL_CODESIGN_IDENTITY` can select a specific identity. It records the actual designated requirement and reuses an unchanged bundle only when that requirement and the real signer still match. Without a stable identity, installation falls back to ad-hoc signing and rebuilds the launcher on explicit reinstall, so macOS may request file access again.

On launch, the manager validates its own app signature and bundled runtime, the recorded Node.js hash, and the official signing requirements, fixed bundle paths, and real executable paths of `ChatGPT.app` and its bundled Codex CLI before starting code. A normal ChatGPT update signed with the same OpenAI identity remains valid without reinstalling Panel; unsigned modifications, a changed signing identity, symlinks, and executable paths outside the signed app bundle are rejected. It starts the loopback-only Panel service and either attaches to the actual CDP port of an existing Codex or starts the official `/Applications/ChatGPT.app` with CDP before injecting the Panel sidebar. Cold starts are delegated to macOS LaunchServices instead of executing the ChatGPT binary as an injector child, so ChatGPT/Codex owns its own TCC permission requests rather than having them attributed to Codex Panel. Manager status, open, and shutdown requests use a startup-token-protected Unix socket whose descriptor and socket are user-only; stale-process cleanup verifies the fixed Node path, absolute injector path, watch mode, and startup token again before signaling. It retires Panel injectors only on the selected port and never replaces its managed injector with a detached process. A normally opened Codex cannot gain CDP after startup; if the manager reports that Codex must restart, quit Codex completely and use **Start Service** again. Stopping or quitting waits for only the injector and Panel service it owns to exit, while the official ChatGPT/Codex application and its CDP endpoint remain running until you quit ChatGPT itself. The Swift manager intentionally retains loopback TCP CDP rather than the upstream private pipe: the injector would have to own that pipe for the entire ChatGPT lifetime, but this manager deliberately lets ChatGPT outlive it and reconnects on its next launch. It never modifies the official app or its `app.asar`.

Re-run `npm run codex:install` after updating the repository or replacing Node.js. A normal OpenAI-signed `ChatGPT.app` update does not require reinstalling Panel. `npm run launcher:install` remains available as a compatibility alias. The latest manager log is written to `~/Library/Logs/Codex Panel.log`.

### Alternative: run the launcher in a terminal

Quit every running Codex window, then run:

```bash
CODEX_PANEL_HOST=127.0.0.1 npm run codex
```

This runs the same lifecycle in the foreground. Keep the command running while using the embedded panel.

### Advanced: keep your current window and open a separate Panel window

Keep the existing Codex window open. From the Panel repository, start a second Codex instance with a dedicated CDP port:

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231 \
  --disable-features=LocalNetworkAccessForSubframeNavigations
```

After the new Codex window appears, run the injector in another terminal:

```bash
CODEX_PANEL_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

Keep the injector terminal running while using the embedded panel. The original Codex window remains unchanged, and the new window receives the Panel sidebar entry. If port `9231` is occupied, use another port in both commands.

After CDP becomes reachable, the launcher waits up to 30 seconds for Codex to create its main renderer, then waits for the initial `app://` document to finish loading before applying the CSP bypass and reloading that renderer once. It ignores auxiliary renderers such as the avatar overlay, and delaying this controlled reload until `complete` lets Codex finish its desktop bootstrap instead of entering the fallback error page. The launcher consumes its automatic Panel-open request after the first main-renderer attempt; a frame failure therefore leaves the local service and retry control available without repeatedly pulling the user away from a conversation.

Codex ships a renderer CSP that blocks arbitrary HTTP iframes. CDP CSP bypass does not retroactively change the already-loaded document, so the launcher enables it and performs the controlled post-bootstrap reload above before opening Panel. Chromium 151 also applies Local Network Access checks to loopback subframe navigation, so the launcher disables only `LocalNetworkAccessForSubframeNavigations` and the managed iframe explicitly delegates the corresponding local-network permissions. Other Local Network Access checks remain enabled. Taking over or refreshing an existing resident renderer uses the same one-reload rule. CDP is unauthenticated to other processes on the same machine. Because closing Panel intentionally leaves a manager-launched ChatGPT running, run only trusted local code for the full lifetime of that CDP-enabled ChatGPT instance.

To inject into a Codex instance that was already launched with CDP by another method, run:

```bash
npm run codex:inject -- --port 9229 --open
```

This command also stays resident so the injected tab can restart Panel after a service exit. Stop it with `Ctrl-C`.

The script adds a Panel entry to the Codex sidebar and renders the iframe across Codex's complete main workspace, including the contextual titlebar area so Panel's own header does not leave an empty strip. That full rectangular header is placed above Electron's draggable layer and marked `no-drag`; because the native contextual actions are suppressed while Panel is active, its own actions use their normal edge padding without an artificial right-side gap. The native sidebar stays mounted, while the previous page selection and contextual header are temporarily suppressed; choosing another Codex page restores them.

The Panel entry can be opened directly from a conversation as well as from native pages such as Plugins and Sites. While Panel is active, native destinations selected from Codex's global command menu, including Chat, Plugins, Settings, Sites, Pull Requests, and Scheduled Tasks, restore the Codex view for both mouse and Enter selection. Utility commands such as theme changes do not close Panel. Commands whose route does not change currently recognize Simplified Chinese, Traditional Chinese, and English labels; other UI languages remain pending until Codex exposes stable command identifiers in the menu DOM.

“Open in conversation” selects the corresponding native Codex project when one is available and opens an unsent native composer with a `$manage-panel` prompt. Panel first reads the issue's latest “AI conversation handoff” comment and prefills the issue identifier, title, read location, and handoff content; the new task still refreshes the latest issue and every comment through `panelctl` before acting. An unsent composer is not yet a Codex task, so Panel writes the new native thread ID back to the issue immediately after the first message creates that thread. Recorded IDs are clickable through Codex's native route bridge. Each issue can bind either one Git branch or one worktree; the options are scanned from the selected Codex project's repository instead of being typed by hand. The integration uses Codex's existing project, composer, and route markers; it does not patch React, replace `fetch`, load private chunks, or edit Codex data files.

Local embedded AI conversations can also be linked to an issue from the link menu in the chat header. When opened, the menu loads active issues directly from the conversation's original project, even if another project is currently visible, and can switch or remove the link while Codex is idle. Linked conversations appear in the issue activity stream and open the exact local chat when selected. Send `/handoff` or `/交接` to have the same Codex thread summarize the discussion; optional text after the command tells it what to emphasize. Add `--issue ISSUE-ID` to record the handoff on a specific active issue instead of the linked issue, for example `/交接 --issue PROJECT-123 preserve the acceptance decisions`.

The original `$handoff` Skill always keeps its existing temporary-document-only behavior. Use `$handoff-panel --issue ISSUE-ID [handoff focus]` when the same handoff must also be attached to a Panel Issue, whether the current conversation is native or embedded. The base Skill runs first, and the resulting document is embedded without trimming or rewriting. If later Issue validation or publication fails, the temporary document remains available and the command reports the partial failure. Successful handoffs are recorded in the activity stream for the next Codex task. Issue status, priority, assignee, workflow, development context, and recurrence use themed menus that follow the Panel's light or dark appearance instead of browser-native dropdowns.

To use a different UI origin, set `window.__CODEX_PANEL_URL__` before the user script runs. A custom origin is display-only: it receives theme updates and may report its titlebar drag regions to the host, but it does not receive Codex projects, user identity, thread IDs, absolute workspace paths, native thread navigation or creation, sidebar expansion, or automation access. Those native capabilities are available only to the launcher-managed origin in `window.__CODEX_PANEL_MANAGED_ORIGIN__` (the local Panel origin by default).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_PANEL_HOST` | `0.0.0.0` | HTTP bind address; use `127.0.0.1` to disable LAN access |
| `CODEX_PANEL_PORT` | `47823` | Local HTTP port |
| `CODEX_PANEL_HOME` | `~/Library/Application Support/Codex Panel` on macOS | Installed runtime and default data root |
| `CODEX_PANEL_DATA_DIR` | `$CODEX_PANEL_HOME/data` | SQLite data directory |
| `CODEX_PANEL_URL` | `http://127.0.0.1:47823` | CLI API origin |
| `CODEX_PANEL_CODESIGN_IDENTITY` | Matching local Apple Development identity, otherwise `-` | Explicit identity or certificate hash for signing `Codex Panel.app` |

`npm start` prints both the local URL and the available LAN URLs. Teammates on the same trusted network can open one of those LAN URLs and use the same panel service. Task, comment, and attachment changes are broadcast to every open client through server-sent events; reconnecting clients perform a full refresh so changes made while disconnected are not missed. A teammate using `panelctl` can point it at the shared service with `CODEX_PANEL_URL=http://<host-ip>:47823`.

LAN mode has no account authentication: anyone on the trusted local network who can reach the URL can read and write the panel. Public internet and cloud deployment require an authenticated deployment boundary.

## Share through Cloudflare

For two trusted collaborators, the panel can run on Cloudflare with Worker Static Assets and API routes, D1 as the authoritative business database, and a private R2 bucket for attachments. The deployment uses HTTPS Basic Authentication with a shared password and refreshes open boards after a global revision changes.

No usable remote resource ID or custom domain is preconfigured. The committed Wrangler file is a local/dry-run template; provision your own Cloudflare resources and replace its all-zero D1 ID before any remote migration or deployment.

Each device keeps its own project checkout mapping and continues to use a local companion for Codex, Git/worktree, Skill, and MCP capabilities. Cloud mode never falls back to or double-writes the local SQLite database.

See [Cloud collaboration](docs/cloud-collaboration.md) for owner deployment, existing GitHub installation setup, password rotation, local path mapping, and the one-time local-data migration flow.

## Verify

```bash
npm run check
```

This runs TypeScript checking, a production frontend build, and the server/CLI/injection test suite.
