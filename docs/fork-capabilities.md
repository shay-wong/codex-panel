# Fork capabilities

This page indexes the user-visible differences maintained by `shay-wong/codex-panel` relative to `chuspeeism/dashi-taskboard`.

## Codex Panel product and repository name

The browser title and repository entry points use the `Codex Panel` name, and the repository is named `codex-panel`. The canonical Skill, CLI, environment, integration protocol, local storage, SQLite, and undeployed Cloudflare identifiers now use `manage-panel`, `panelctl`, `CODEX_PANEL_*`, and `panel`. Browser keys, environment variables, automation names, and repository-managed links are migrated or accepted as fallbacks so the rename does not discard existing state. The completed local database rename is represented only by `panel.sqlite`; the one-time legacy file migration is no longer retained.

## Native macOS manager

On macOS, the explicit `npm run codex:install` command builds a standalone runtime under `~/Library/Application Support/Codex Panel` and creates or refreshes `~/Applications/Codex Panel.app`. It removes only the previous managed `~/Applications/Codex.app` bootstrap. Plain `npm ci` continues to install project dependencies without writing user-level integrations.

The SwiftUI manager is a normal foreground Dock application. It displays the Panel service, Codex/CDP, and embedded-integration status; starts, restarts, or stops the managed processes; opens the embedded or browser Panel, log, and data directory; and uses `SMAppService` for the optional macOS login item. Connecting Codex and opening Panel automatically are independent preferences and both default to enabled. The app runs a signed runtime copied into its own bundle and never depends on the source repository after installation. Its embedded status becomes healthy only when the current source hash, manager startup token, mounted renderer entry, and fresh host heartbeat all match. Unexpected integration exits use bounded recovery delays of 2, 5, and 15 seconds; a fourth attempt inside 60 seconds is suppressed and surfaced through the UI and log.

The app icon is generated from the official `icon-codex-light.png` and `icon-codex-dark-color.png` resources in `ChatGPT.app`. Both variants use the same clipped 45-degree `PANEL` corner ribbon, and the running Dock icon switches with the effective macOS appearance. Missing official light or dark resources are installation errors rather than silent fallbacks. The installer honors `CODEX_PANEL_CODESIGN_IDENTITY`, otherwise reuses the real current signer when it remains available or selects the single valid Apple Development identity matching the global Git email. It records and verifies the actual designated requirement before reusing an unchanged bundle. Systems without a stable identity fall back to ad-hoc signing, rebuild on explicit reinstall, and may need to approve file access again.

On launch, the manager verifies its bundle signature and bundled runtime, the pinned Node.js hash, and the official signing requirements plus fixed bundle-contained executable paths of `ChatGPT.app` and its bundled Codex CLI before executing code. A normal update signed with the same OpenAI identity remains valid without reinstalling Panel; unsigned changes, identity changes, symlinks, and executable paths outside the signed app are rejected. It starts the loopback Panel service and either discovers and attaches to the active Codex CDP port or starts the official application with CDP. A cold start uses `/usr/bin/open` and macOS LaunchServices instead of making ChatGPT a direct injector child, keeping ChatGPT/Codex TCC permission attribution separate from `com.shay.codex-panel`. Status, open, and shutdown actions use a startup-token-protected Unix socket. Its runtime descriptor and socket are `0600`, their paths are fixed under the user data directory, and the manager validates the exact Node executable, absolute injector path, watch mode, and startup token before control or signaling, including a second validation immediately before `SIGTERM` or `SIGKILL`. Version 1 runtime descriptors are accepted only for transition into the existing exact resident cleanup path; control requests require version 2. Only Panel residents on the selected CDP port are retired. Opening an already managed Panel uses the socket request against the existing renderer and never replaces the owned injector with a detached resident. Stop, quit, and development reinstall paths wait for only the managed injector and Panel service to exit. The official ChatGPT/Codex process and its unauthenticated local CDP endpoint intentionally remain running until the user quits ChatGPT; only trusted local code should run during that full interval. The Swift manager therefore retains reconnectable loopback TCP CDP rather than enabling the upstream private pipe, which cannot be reclaimed after its owning injector exits. The `ChatGPT.app` bundle remains unmodified.

The manager displays the complete Fork version from `CodexPanelVersion` while keeping the macOS `CFBundleShortVersionString` numeric. It checks `shay-wong/codex-panel` Releases once at startup and on demand, accepts only normalized `vX.Y.Z-fork.N` candidates, compares their prerelease identifiers, and accepts only HTTPS GitHub URLs under the repository's exact release-tag path. It opens the trusted Release page but does not download or install an update. Automatic replacement remains disabled until the Fork publishes signed and notarized archives backed by a pinned updater public key.

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

While Panel is active, selecting a native destination from Codex's global command menu restores the native view for both mouse and Enter selection. Chat, Work, Codex, Settings, Skills, Scheduled Tasks, new conversations, and other commands that change the native route are covered; utility commands such as theme changes leave Panel open. Route-neutral commands currently recognize Simplified Chinese, Traditional Chinese, and English labels because the command menu DOM exposes localized titles but no stable command identifier. Other UI languages remain pending until that identifier is available.

## Link embedded AI conversations to issues

An existing local AI conversation can be linked, moved, or unlinked through the issue menu in its header while no turn is running. Opening the menu loads active issues directly from the conversation's original project, independent of the project currently shown on the board. Linked conversations appear in the matching issue activity stream and open that exact local chat; the conversation history also shows the linked issue identifier.

Send `/handoff` or `/交接` in an embedded conversation to summarize its current conclusions into a Codex Agent comment. The linked issue is the default target; `--issue ISSUE-ID` selects another active issue. Optional text after the command can emphasize specific details.

The original `$handoff` Skill remains unchanged. The separately installed `$handoff-panel --issue ISSUE-ID [handoff focus]` wrapper works from any Codex conversation: it completes the installed base Skill first, then validates the selected Issue and uses `panelctl` to attach the resulting document verbatim. Validation or publication failure preserves the temporary document and is reported as a partial failure. “Open in conversation” includes the latest handoff in the new native Codex prompt, tells the task to refresh the issue and all comments through `panelctl`, and automatically writes the new native thread ID back to the issue after the first message creates the task.

## Managed iframe trust boundary

The launcher-managed Panel origin receives Codex project, user, thread, and workspace context and may invoke native thread navigation, task creation, sidebar expansion, and automation. A custom `window.__CODEX_PANEL_URL__` origin remains display-only: it receives theme updates and may report titlebar drag regions to the host, but it cannot cross that native Codex boundary. `window.__CODEX_PANEL_MANAGED_ORIGIN__` identifies the trusted origin and defaults to the local Panel service.

## Explicit Panel integration installation

After `npm ci`, run `npm run codex:install` to copy the repository's `manage-panel` and `handoff-panel` Skills into `~/.agents/skills`, install a real `~/.local/bin/panelctl` wrapper, build the standalone runtime, and generate the macOS launcher. The installed files carry ownership markers and never point back to repository files. Existing user-managed paths are preserved. On first install, the repository's current `.data` is copied through a live SQLite snapshot into the fixed user data directory without deleting the source. Plain dependency installation does not write any of these user-level integrations.

## Move an issue from its detail view

The issue detail sidebar shows the current Panel project and lets the user move the issue to another project, including from Global to a repository-backed project. After a successful move, Panel opens the target project with the same issue detail and linked native conversation intact.

Panel rejects the move before mutation when the issue has relations, an issue-linked local AI conversation tied to the source project, or a branch/worktree development context. The displayed error identifies what must be removed or cleared before retrying. Status, description, labels, scheduling fields, and other issue properties remain unchanged.
