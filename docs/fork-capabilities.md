# Fork capabilities

This page indexes the user-visible differences maintained by `shay-wong/codex-panel` relative to `chuspeeism/dashi-taskboard`.

## Codex Panel product and repository name

The browser title and repository entry points use the `Codex Panel` name, and the repository is named `codex-panel`. The canonical Skill, CLI, environment, integration protocol, local storage, SQLite, and undeployed Cloudflare identifiers now use `manage-panel`, `panelctl`, `CODEX_PANEL_*`, and `panel`. Browser keys, environment variables, automation names, and repository-managed links are migrated or accepted as fallbacks so the rename does not discard existing state. The completed local database rename is represented only by `panel.sqlite`; the one-time legacy file migration is no longer retained.

## Board-style horizontal list

The list view supports horizontal and vertical layouts. Horizontal layout uses the issue board's status colors, workflow arrows, column spacing, scrollable column bodies, and card hierarchy so statuses remain easy to scan. Jira issues show their external key when available, with the title on a separate line and metadata wrapping inside the card. Vertical layout keeps the existing compact rows.

## Tauri/Rust desktop manager

On macOS, the explicit `npm run codex:install` command builds a standalone runtime under `~/Library/Application Support/Codex Panel`, creates or refreshes `~/Applications/Codex Panel.app`, and removes only older launcher installations carrying a Codex Panel ownership marker. Plain `npm ci` continues to install project dependencies without writing user-level integrations. The installed product is the upstream Tauri/Rust desktop foundation under the unchanged `Codex Panel` name; the former SwiftPM launcher is no longer a product or build path.

The app runs from the macOS menu bar. Its menu exposes runtime status; an embedded Panel entry point; one state-aware start/stop item; separate restart, browser, log, and data-directory actions; launch-at-login; and independent connect-on-launch and open-after-connect preferences, with the latter two enabled by default. Restart and browser actions are enabled only while the managed service is running. A fresh renderer heartbeat, matching source hash, startup token, and mounted entry are required before the status becomes healthy. Unexpected integration exits use bounded recovery delays of 2, 5, and 15 seconds, and a fourth failure inside 60 seconds suppresses further automatic recovery.

The management window is local HTML/CSS hosted in Tauri's WebView, while service, process, and filesystem operations remain Rust commands. A compact top surface combines the current state, state-aware Panel action, one start/stop control, separate restart, browser action, and the Panel-service, Codex-connection, and embedded-panel status surfaces without a repeated service-control section. Renderer readiness and actual Panel visibility are tracked separately, and an open request stays queued across renderer transitions until the injector confirms that the page opened. Async action buttons keep loading visible for at least 300 ms before retaining a brief success or failure state; service start, stop, and restart leave the WebView responsive while process lifecycle work completes; and the browser action accepts only the launcher's private loopback URL while preserving its instance-token route. Dependent launch preferences, visible update results and an available-Release action, log and data controls, and expandable runtime paths and process details follow below. The window header and macOS app/Dock icon use matching light and dark Codex assets with the `PANEL` ribbon and switch with the system appearance.

The bundle contains the Rust launcher, official signed Node.js runtime, Panel server and UI, injector, `panelctl`, and both Panel Skills. The macOS installer verifies ownership before replacement, signs the app with `CODEX_PANEL_CODESIGN_IDENTITY`, a reusable local Apple Development identity, or an ad-hoc fallback, and preserves the fixed `~/Library/Application Support/Codex Panel/data` directory. Windows release builds require `CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT`, create an Authenticode-signed NSIS package, and verify the launcher's signer plus a signed-in SHA-256 manifest for Node and all packaged Panel runtime files before execution. Migration from the former Swift app stops its verified injector and exact bundle-owned Panel server before replacement so no PPID 1 process continues to execute a deleted Swift bundle path.

Before connecting, Rust validates the signed Codex Panel bundle and packaged runtime, validates the official `ChatGPT.app` and bundled Codex executable against OpenAI's identifiers and Team ID, rejects symlinks, and starts the bundled Node process with Node, shell, and dynamic-loader injection variables removed. The Panel server receives a launcher-owned loopback listener, private URL token, and private instance secret. The injector uses a user-only version 2 runtime descriptor and token-authenticated Unix control socket on macOS, while Windows uses the launcher's owned child control pipe for open, status, and stop. If the current Codex command line exposes a reachable CDP endpoint, `--attach-existing` discovers and reuses that real port, including during Swift-to-Tauri migration; otherwise the official app is launched through macOS LaunchServices with a random loopback CDP port. A Codex process running without CDP must still be quit before relaunch. Stop and quit terminate only Tauri's injector and Panel server, leaving the official app untouched.

The app checks `shay-wong/codex-panel` Releases automatically at most once every 24 hours using a persistent cached result, while manual checks bypass the cache. It prefers a locally authenticated `gh` CLI and falls back to the anonymous GitHub API, with distinct rate-limit, network, no-release, current-version, and available-update states. It accepts only normalized `vX.Y.Z-fork.N` candidates and exact HTTPS release-tag URLs. An available update opens the trusted Release page; updater download and installation are not compiled into the product.

Install or refresh the app after updating the repository or changing the Node.js installation:

```bash
npm run codex:install
```

Moving or deleting the source repository does not break an already installed runtime. A Codex instance already running without CDP must still be quit before the manager can start or attach the embedded integration.

## Reliable initial Codex injection

The standalone launcher waits up to 30 seconds for Codex's main renderer after CDP becomes reachable. It ignores auxiliary renderers such as global dictation and the avatar overlay, then waits for the main renderer's initial `app://` document to reach `complete`. Only then does it enable the CSP bypass and reload once, allowing the registered document-start injection to run without aborting the official desktop bootstrap. The automatic Panel-open request is a one-shot latch claimed by the first available main renderer, so a later iframe failure keeps the supervised service and manual retry available without repeatedly overriding native conversation navigation.

Chromium 151 applies Local Network Access checks to loopback subframe navigation. The manager-owned injector therefore passes `--disable-features=LocalNetworkAccessForSubframeNavigations`, and the managed iframe delegates `local-network-access`, `loopback-network`, and `local-network`. The compatibility switch is limited to subframe navigation; fetch, WebSocket, and other Local Network Access checks are not disabled.

Run the launcher as documented in [Embed in Codex](../README.md#embed-in-codex):

```bash
CODEX_PANEL_HOST=127.0.0.1 npm run codex
```

The wait duration is fixed. If no main renderer appears within 30 seconds, the launcher exits with `Timed out waiting for a Codex renderer target`.

## Switch between Panel and native Codex destinations

The Panel sidebar entry opens from conversations as well as native pages such as Plugins and Sites. No configuration or migration is required.

This fix accepts a main content frame that covers most of the Codex viewport even when that frame also includes the native titlebar region.

While Panel is active, selecting a native destination from Codex's global command menu restores the native view for both mouse and Enter selection. Chat, Work, Codex, Settings, Skills, Scheduled Tasks, new conversations, and other commands that change the native route are covered. Opening Activity or selecting a notification also restores its native destination instead of leaving it behind Panel. Utility commands such as theme changes leave Panel open. Route-neutral commands currently recognize Simplified Chinese, Traditional Chinese, and English labels because the command menu DOM exposes localized titles but no stable command identifier. Other UI languages remain pending until that identifier is available.

## Link embedded AI conversations to issues

An existing local AI conversation can be linked, moved, or unlinked through the issue menu in its header while no turn is running. Opening the menu loads active issues directly from the conversation's original project, independent of the project currently shown on the board. Linked conversations appear in the matching issue activity stream and open that exact local chat; the conversation history also shows the linked issue identifier.

Send `/handoff` or `/交接` in an embedded conversation to summarize its current conclusions into a Codex Agent comment. The linked issue is the default target; `--issue ISSUE-ID` selects another active issue. Optional text after the command can emphasize specific details.

The original `$handoff` Skill remains unchanged. The separately installed `$handoff-panel --issue ISSUE-ID [handoff focus]` wrapper works from any Codex conversation: it completes the installed base Skill first, then validates the selected Issue and uses `panelctl` to attach the resulting document verbatim. Validation or publication failure preserves the temporary document and is reported as a partial failure. “Open in conversation” opens an unsent, Panel-localized draft without internal routing markers. Local drafts include `$manage-panel`, the latest handoff, and instructions to refresh the issue through `panelctl`; SSH drafts include the current issue snapshot because the remote worker cannot access local `panelctl`. Panel stores the local or SSH thread binding only after the user sends the draft and Codex creates the thread; SSH issues also move to in progress at that point.

## Managed iframe trust boundary

The launcher-managed Panel origin receives Codex project, user, thread, and workspace context and may invoke native thread navigation, task creation, sidebar expansion, and automation. A custom `window.__CODEX_PANEL_URL__` origin remains display-only: it receives theme updates and may report titlebar drag regions to the host, but it cannot cross that native Codex boundary. `window.__CODEX_PANEL_MANAGED_ORIGIN__` identifies the trusted origin and defaults to the local Panel service.

## Explicit Panel integration installation

After `npm ci`, run `npm run codex:install` to copy the repository's `manage-panel` and `handoff-panel` Skills into `~/.agents/skills`, install a real `~/.local/bin/panelctl` wrapper, build the standalone runtime, and generate the macOS launcher. The installed files carry ownership markers and never point back to repository files. Existing user-managed paths are preserved. On first install, the repository's current `.data` is copied through a live SQLite snapshot into the fixed user data directory without deleting the source. Plain dependency installation does not write any of these user-level integrations.

## Move an issue from its detail view

The issue detail sidebar shows the current Panel project and lets the user move the issue to another project, including from Global to a repository-backed project. After a successful move, Panel opens the target project with the same issue detail and linked native conversation intact.

Panel rejects the move before mutation when the issue has relations, an issue-linked local AI conversation tied to the source project, or a branch/worktree development context. The displayed error identifies what must be removed or cleared before retrying. Status, description, labels, scheduling fields, and other issue properties remain unchanged.

## Jira Bearer token authentication

Jira connection settings provide two explicit authentication modes. Account / API token uses Basic Auth for an account password or a Jira Cloud email and API token. Bearer token uses a Jira Data Center or Server personal access token without sending a username. Basic Auth requires a username or email, and switching modes requires entering the credential again.

Credentials remain in the local Panel data directory with the existing local file protections and are never returned to the browser. Jira integration remains unavailable in Cloud mode. Use HTTPS unless the Jira server is on a trusted private network because HTTP exposes either authentication mode to network observers.

## Reliable Jira open-issue synchronization

Panel searches only for open issues assigned to the signed-in Jira user. It reads every search page before applying one database transaction, then rechecks previously synced issues that disappeared from the open result. Confirmed completed or out-of-scope issues are archived from the Jira project; issues that cannot be confirmed remain visible and are marked with an unknown synchronization state.

Authentication, permission, network, and partial-page failures never clear the last successful Jira data. Cached issues remain available while a compact Jira status bar and the connection dialog show the last attempt, last success, open and unknown counts, and an actionable failure. Panel also compares Jira's stable `/myself` account identity and asks for confirmation before it searches or stores issues from a different account. Opening the Jira project retains the existing one-minute refresh throttle; manual synchronization remains uncached and may be run repeatedly.

## Link Jira requirements to repository issues

A synced Jira issue remains an external requirement in the dedicated Jira project. Open its detail view and choose **Manage Jira links** to select one or more Panel projects that have local workspaces. Repository changes are shown as a pending difference and take effect only after **Save repositories**; saving never creates, moves, or deletes execution issues.

The same dialog can link existing active issues from the selected repositories. One Jira requirement may link multiple execution issues across repositories, while each execution issue may link to only one Jira requirement. Linked Jira details appear compactly on the execution issue with a direct Jira link, and both detail views can remove the relationship. A linked execution issue may move only among repositories selected by its Jira requirement. Archiving keeps the relationship, while permanent deletion requires unlinking first.

Jira synchronization updates the external requirement's Jira key, title, original status, URL, last synchronization time, and synchronization error. It does not change the linked execution issue's title, description, status, or other local work fields.
