# Codex Panel

[简体中文](README.zh-CN.md) | [Fork capabilities](docs/fork-capabilities.md)

A local-first issue board that runs in a browser and can be embedded in Codex through the standalone CDP launcher or its injection script. The same HTTP API powers the React UI and the `panelctl` CLI used by the bundled Codex Skill.

Each project dashboard generates a daily Codex summary. If generation fails, Panel retries after 5, 15, and 60 minutes, then stops automatic attempts; the dashboard keeps a manual retry action available, and any successful generation resets the retry sequence.

The board includes dashboard, list, Gantt, and archived-issue workflows. The horizontal list follows the issue-board column and card hierarchy, while the vertical list remains compact; synced Jira issues show their external key when available. Issues can carry start and due dates and can be moved from their detail view while retaining their linked conversation. A local Jira connection can sync open issues assigned to the signed-in Jira user into a dedicated Jira project. Each Jira requirement can select one or more repository projects and link existing execution issues from those repositories; an execution issue can belong to at most one Jira requirement, and Jira refreshes do not overwrite its local work. The linked Jira card on an execution issue returns to the requirement inside Panel; its detail view retains the separate external Jira action. A waiting Jira requirement with saved repository links can create one execution issue and one idle AI conversation per repository, move Jira to in progress, and release the issues to waiting only after every repository is ready; retrying a partial failure continues the same operation without duplicating work. Complex requirements can instead open a read-only AI planning conversation that uses `grill-me`, `to-spec`, and `to-tickets`, stores the Spec on the Jira requirement, and publishes confirmed repository tickets as linked backlog issues with their dependencies. Planning remains available before a repository is selected, and a Codex startup failure shows its actual diagnostic. Jira description lines whose numbered items begin with `#` render as an ordered list without changing ordinary Panel Issue Markdown. Jira or repository changes require review before another publication, pause unstarted issues from entering execution, and cancel only superseded work that has not started; started work remains visible as a planning constraint. Opening the Jira project refreshes it at most once per minute, and users can also sync manually. Panel applies a refresh only after every Jira search page succeeds, keeps cached issues visible when Jira is unavailable, and requires confirmation before switching to a different Jira account. The Jira header and settings show the last attempt, last success, open and unknown counts, and actionable failures. Changes to a synced Jira issue's title, description, priority, labels, due date, or status are written directly back to Jira. The connection supports Basic Auth with an account password or Jira Cloud email and API token, and Bearer Auth with a Jira Data Center or Server personal access token. Credentials are stored in the local Panel data directory, and Jira is unavailable in Cloud mode; use HTTPS unless the Jira server is on a trusted private network.

Jira status controls execution authorization separately from planning. Entering in progress releases only dependency-frontier backlog issues to waiting. If Jira returns to waiting or ends while linked work remains, Panel asks whether to pause it; pausing moves waiting issues back to backlog, blocks active issues, and attempts to interrupt their active Codex turns without deleting code, conversations, or worktrees. A failed interruption does not roll back the issue pause, and Panel reports how many turns still need attention. A later in-progress transition resumes eligible paused issues. Reopened Jira requirements keep their historical issues and conversations and can create new rework issues or start a new planning conversation. A failed planning start preserves the previous plan for retry, while concurrent Jira sync and relationship changes wait until the reopened action finishes. Duplicate Jira requirements record their canonical issue and require confirmation before moving existing links. Panel probes canonical issues that are not assigned to the current user and preserves existing links only when the current Jira account cannot read the canonical issue.

Jira settings can enable **Automatically complete Jira**, which is off by default. Panel acts only when at least one execution issue is linked and every linked issue is unarchived and done. It rereads Jira's status and update timestamp, requires exactly one available transition that maps to done, and rereads Jira again to confirm success. A remote change after the last sync is never overwritten silently: the Jira detail lets the user accept the remote state or complete it anyway. Failures keep local issues done and preserve a manual retry action.

Jira settings can also enable **Automatically archive conversations**, which is off by default. When enabled, Panel archives its managed planning and execution conversations after Jira and every linked execution issue are done. The Jira detail also provides **Archive conversations** for the same completed state even when automatic archiving is disabled. Existing runs, messages, and Codex thread IDs remain stored and readable; a turn already running stays visible until it finishes. Disabling automatic archiving does not restore archived conversations, and reopened Jira work creates new rework or planning conversations instead of continuing archived history.

Repository projects use a Panel-owned persistent execution queue instead of Codex Scheduled Tasks. Enable automatic claiming from the project automation menu to scan unlinked waiting issues every 5, 10, 15, 30, or 60 minutes and execute Jira-linked issues after their Jira requirement authorizes work. A waiting local issue can also be queued with **Run now** without enabling automatic scans; disabling automatic claiming stops new automatic entries without freezing existing work, while pausing the project holds every queued item. The global default permits three concurrent executions per project and can be set from 1 through 8; each project may follow it or choose its own 1-8 limit, with no cross-project total cap. Panel creates an isolated Git worktree for new execution conversations, keeps one active execution per normalized workspace, and falls back to safe serial execution when worktree creation fails. It reuses one AI conversation per issue, invokes `implement`, retries transient startup or connection failures twice, resumes interrupted work only when its conversation and development context still match, and waits for a user comment or completed user turn when execution is blocked. Manual and resumed work run first; Jira-authorized and scanned work are then ordered by issue priority. The automation menu shows waiting, running/capacity, blocked, and failed totals. Worktrees remain through review and are removed after completion only when clean and merged.

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

### Recommended: use the Codex Panel desktop app

`npm run codex:install` creates or refreshes `~/Applications/Codex Panel.app`, removes the previous managed `~/Applications/Codex.app` bootstrap, and migrates installations of the former Swift launcher. The desktop app is built with Tauri/Rust and uses the fixed data directory at `~/Library/Application Support/Codex Panel/data`, so moving or deleting the source repository does not break it. Open it from Finder or the explicit path:

```bash
open "$HOME/Applications/Codex Panel.app"
```

The app runs from the macOS menu bar. Its menu shows the current runtime state and can open the embedded or browser Panel, uses one state-aware start/stop item plus a separate restart action, opens the log, and reveals the data directory. Browser and restart actions are disabled until the service is running. It also provides independent toggles for launch at login, connecting Codex when the app starts, and opening Panel after connection; the last two default to on. “Running normally” is reported only after the current injection is mounted in a renderer and publishes a fresh heartbeat. If the managed integration exits unexpectedly, the app retries after 2, 5, and 15 seconds, then stops automatic recovery after a fourth failure inside 60 seconds.

The visible management window is a local HTML/CSS interface hosted by Tauri's WebView; service, process, and file operations remain Rust commands. Its compact top control surface combines the current state, Panel action, one start/stop control, separate restart, browser entry, and the three component states without repeating a service-control section. Codex connection and actual embedded-Panel visibility are reported separately; queued opens wait for renderer readiness instead of being reported as failures. Action buttons keep loading visible for at least 300 ms, then briefly retain a visible success or failure state; service start, stop, and restart keep the window responsive while process lifecycle work completes; and the browser entry validates and preserves the launcher's private loopback URL. Launch preferences, update and Release actions, log and data controls, and expandable runtime details follow below. Its header and the macOS app/Dock icon use matching light and dark Codex icons with the `PANEL` ribbon and follow the system appearance.

The app checks the Fork's GitHub Releases automatically at most once every 24 hours and caches successful results for that period; temporary failures are retried after 5 minutes, while anonymous API rate limits are cached until GitHub's reset time. Manual checks always bypass the cache. It first uses a locally installed, authenticated `gh` CLI and falls back to the anonymous GitHub API when unavailable. Rate limits, network failures, no releases, current versions, and available updates are reported separately. Only normalized `vX.Y.Z-fork.N` tags are update candidates; an available update opens only the validated `shay-wong/codex-panel` Release page. The app never downloads or installs an update automatically.

The app bundle contains the Panel runtime, `panelctl`, both Panel Skills, and the official signed Node.js runtime used to run them. The macOS installer prefers `CODEX_PANEL_CODESIGN_IDENTITY`, then a reusable local Apple Development identity, and falls back to ad-hoc signing when neither is available. Windows release builds require `CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT` and produce an Authenticode-signed NSIS package.

Before connecting, the app verifies its own signed bundle and packaged runtime, verifies the official `ChatGPT.app` and bundled Codex executable against OpenAI's identifiers and Team ID, rejects symlinks, and removes Node, shell, and dynamic-loader injection variables from the child environment. Windows additionally verifies the launcher's Authenticode certificate and a signed-in SHA-256 manifest covering Node and every packaged Panel runtime file before execution. It binds the Panel service to loopback with a launcher-owned listener and private instance token. If the running Codex already exposes a valid CDP endpoint, including one left by the former Swift launcher, the new injector attaches to that real port; otherwise it starts the official app through macOS LaunchServices with a private random CDP port. A Codex process started without CDP still has to be quit before it can be relaunched with CDP. Runtime status, open, and shutdown requests use a startup-token-protected user-only Unix socket on macOS and the owned child control pipe on Windows. On Windows, Panel lifecycle actions interrupt native Codex turns through a startup-token-authenticated named pipe. Stopping or quitting waits for the injector and Panel service owned by Tauri, while the official ChatGPT/Codex app continues running. The app never modifies `ChatGPT.app` or `app.asar`.

The launcher-owned Panel listener prefers `127.0.0.1:47823` and falls back to a private random port when that port is unavailable. The Codex CDP endpoint remains separate and random.

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

### Linux App: Ubuntu 24.04 x64 packages

The first Linux desktop release supports Ubuntu 24.04 LTS on x64 only. Install the official ChatGPT desktop `.deb` first and confirm that `chatgpt` opens it. Then download either the Codex Panel `.deb` or `.AppImage` from the Fork's [GitHub Releases](https://github.com/shay-wong/codex-panel/releases/latest). Replace `<file>` below with the downloaded filename.

Install the `.deb` package:

```bash
sudo apt install ./<file>.deb
```

Or run the AppImage:

```bash
chmod +x ./<file>.AppImage
./<file>.AppImage
```

To build both packages on Ubuntu 24.04 x64, run:

```bash
npm ci
npm run app:build:linux:x64
```

This first release does not support ARM64, Fedora, RPM packages, or other Linux distributions.

### Windows code signing

Official Windows releases require `CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT` and produce an Authenticode-signed NSIS installer. A release build without the configured certificate fails instead of publishing an unsigned installer. See the [Privacy policy](PRIVACY.md) and [Windows uninstall instructions](docs/windows-uninstall.md).

The local build uses ad-hoc code signing for direct verification. A public macOS download still needs Developer ID signing and Apple notarization.

### Windows App: tray launcher and bundled Panel

Install the official Codex App from the Microsoft Store. To build the current-user NSIS installer on Windows x64, run:

```powershell
npm ci
npm run app:build:windows
```

The installer is written to `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`. It installs a tray launcher, bundled Node runtime, local service, built web UI, `manage-panel` Skill, `panelctl.cmd`, and injection script. Panel data is stored in `%LOCALAPPDATA%\Codex Panel\data`; logs are stored in `%LOCALAPPDATA%\Codex Panel\Logs`; the Skill is copied to `%USERPROFILE%\.agents\skills\manage-panel`.

When `panelctl` runs inside WSL, it automatically finds the Windows launcher descriptor under `%LOCALAPPDATA%\Codex Panel\data` and sends requests through Windows `curl.exe`, so it can use the running Windows desktop app. Set `CODEX_PANEL_WSL_RUNTIME_FILE` to a WSL path only when the descriptor must be overridden explicitly.

Windows builds do not auto-update. Official installers must pass the Authenticode and packaged-runtime verification described above. See [Windows uninstall](docs/windows-uninstall.md) for retained-data behavior.

Codex 26.715.52143 ships a renderer CSP that blocks arbitrary HTTP iframes. The launcher therefore enables CDP CSP bypass, reloads that renderer once, installs the document-start script, and waits until the Panel OOPIF is actually loaded. CDP is unauthenticated to other processes on the same machine, so only run trusted local code while the launcher is active.

To inject into a Codex instance that was already launched with CDP by another method, run:

```bash
npm run codex:inject -- --port 9229 --open
```

This command also stays resident so the injected tab can restart Panel after a service exit. Stop it with `Ctrl-C`.

The script adds a Panel entry to the Codex sidebar and renders the iframe across Codex's complete main workspace, including the contextual titlebar area so Panel's own header does not leave an empty strip. That full rectangular header is placed above Electron's draggable layer and marked `no-drag`; because the native contextual actions are suppressed while Panel is active, its own actions use their normal edge padding without an artificial right-side gap. The native sidebar stays mounted, while the previous page selection and contextual header are temporarily suppressed; choosing another Codex page restores them.

The Panel entry can be opened directly from a conversation as well as from native pages such as Plugins and Sites. While Panel is active, native destinations selected from Codex's global command menu, including Chat, Plugins, Settings, Sites, Pull Requests, and Scheduled Tasks, restore the Codex view for both mouse and Enter selection. Opening Activity or selecting a notification also restores the native destination instead of leaving it behind Panel. Utility commands such as theme changes do not close Panel. Commands whose route does not change currently recognize Simplified Chinese, Traditional Chinese, and English labels; other UI languages remain pending until Codex exposes stable command identifiers in the menu DOM.

“Open in conversation” selects the corresponding native Codex project and opens an unsent composer in both local and SSH projects. Local drafts use `$manage-panel`, include the issue identifier, title, latest “AI conversation handoff,” and `panelctl` read location, and refresh the issue before acting. SSH drafts include the current issue description, comments, and development context because the remote worker cannot call the local `panelctl`. Both drafts follow the Panel interface language, omit internal routing markers, and remain unsent; only the first real send creates the Codex task and writes the new local or SSH thread binding back to the issue, with SSH issues moving to in progress at that point. Recorded IDs are clickable through Codex's native route bridge. Each issue can bind either one Git branch or one worktree; the options are scanned from the selected Codex project's repository instead of being typed by hand. The integration uses Codex's existing project, composer, and route markers; it does not patch React, replace `fetch`, load private chunks, or edit Codex data files.

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
| `CODEX_PANEL_WSL_RUNTIME_FILE` | auto-discovered from Windows `LOCALAPPDATA` | WSL path to a Windows launcher descriptor |
| `CODEX_PANEL_CODESIGN_IDENTITY` | Matching local Apple Development identity, otherwise `-` | Explicit identity or certificate hash for signing `Codex Panel.app` |
| `CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT` | none | Required Authenticode certificate thumbprint for official Windows builds |
| `CODEX_PANEL_TRUSTED_ORIGINS` | unset | Comma-separated exact HTTPS origins allowed through a loopback reverse tunnel |

`npm start` prints both the local URL and the available LAN URLs. Teammates on the same trusted network can open one of those LAN URLs and use the same panel service. Task, comment, and attachment changes are broadcast to every open client through server-sent events; reconnecting clients perform a full refresh so changes made while disconnected are not missed. A teammate using `panelctl` can point it at the shared service with `CODEX_PANEL_URL=http://<host-ip>:47823`.

LAN mode has no account authentication: anyone on the trusted local network who can reach the URL can read and write the panel. Public internet and cloud deployment require an authenticated deployment boundary.

For a reverse tunnel that connects to the local listener, set `CODEX_PANEL_TRUSTED_ORIGINS` to the tunnel's public HTTPS origin, for example `https://board.example.test`. Multiple origins are comma-separated. The variable cannot be empty, and duplicate origins (including normalized forms such as a trailing slash or default HTTPS port) are rejected at startup. Entries must otherwise be exact HTTPS origins; paths, queries, fragments, credentials, and wildcards are rejected. A reverse proxy or tunnel must preserve a loopback socket connection, rewrite `Host` to a local/private host, preserve any `Origin` supplied by the browser, and add that exact public HTTPS origin only when the header is absent, including for `GET` and `HEAD`; forwarded headers are not used for this decision. Configured trusted origins can use ordinary Panel HTTP and realtime endpoints, but device-local capability routes remain unavailable even though the tunnel socket is loopback. Requests from direct local or private-LAN origins keep their existing behavior. The legacy `CODEX_TASKBOARD_TRUSTED_ORIGINS` name remains a fallback.

## Share through Cloudflare

For two trusted collaborators, the panel can run on Cloudflare with Worker Static Assets and API routes, D1 as the authoritative business database, and a private R2 bucket for attachments. The deployment uses HTTPS Basic Authentication with a shared password and refreshes open boards after a global revision changes.

No usable remote resource ID or custom domain is preconfigured. The committed Wrangler file is a local/dry-run template; provision your own Cloudflare resources and replace its all-zero D1 ID before any remote migration or deployment.

Each device keeps its own project checkout mapping and continues to use a local companion for Codex, Git/worktree, Skill, and MCP capabilities. Cloud mode never falls back to or double-writes the local SQLite database.

See [Cloud collaboration](docs/cloud-collaboration.md) for owner deployment, existing GitHub installation setup, password rotation, local path mapping, and the one-time local-data migration flow.

## Issue Markdown

Issue descriptions and comments support GFM, including tables and task lists. Fenced `mermaid` blocks render as read-only diagrams after loading; their source remains visible if rendering fails. Markdown HTML comments are hidden, and raw HTML is disabled.

## Verify

```bash
npm run check
```

This runs TypeScript checking, a production frontend build, the component tests, and the server/CLI/injection test suite.
