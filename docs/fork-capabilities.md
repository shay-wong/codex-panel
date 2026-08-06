# Fork capabilities

This page indexes the user-visible differences maintained by `shay-wong/codex-panel` relative to `chuspeeism/dashi-taskboard`.

## Codex Panel product and repository name

The browser title and repository entry points use the `Codex Panel` name, and the repository is named `codex-panel`. The canonical Skill, CLI, environment, integration protocol, local storage, SQLite, and undeployed Cloudflare identifiers now use `manage-panel`, `panelctl`, `CODEX_PANEL_*`, and `panel`. Browser keys, environment variables, automation names, and repository-managed links are migrated or accepted as fallbacks so the rename does not discard existing state. The completed local database rename is represented only by `panel.sqlite`; the one-time legacy file migration is no longer retained.

## Generated macOS launcher

On macOS, the explicit `npm run codex:install` command builds a standalone runtime under `~/Library/Application Support/Codex Panel` and creates or refreshes the existing `~/Applications/Codex.app` launcher with its Codex name and icon. A stable definition marker and signature verification let an unchanged launcher bundle survive routine reinstallations without changing its ad-hoc designated requirement or macOS permission identity. The generated bundle removes AppleScript's default `CFBundleIconName=applet` override so Finder and pinned Dock entries use the copied Codex icon on both first-time and repeated installation, opts its native dialogs into the current macOS appearance instead of forcing Aqua, and marks the short-lived bootstrap as an `LSUIElement` agent so it cannot leave a second temporary Dock application behind. Plain `npm ci` only installs project dependencies. Opening the generated launcher runs the installed runtime directly, so the official `/Applications/ChatGPT.app` installation starts with CDP, the local Panel service starts, and the embedded sidebar entry opens without a terminal command. The service started by this launcher stops after that Codex instance exits.

Clicking the launcher while its CDP-enabled Codex is already running reuses a healthy resident injector and opens the embedded Panel before focusing the existing window. A missing or stale resident is replaced; the recovery reloads the Codex renderer once after enabling the CSP bypass, and the retired local service closes active connections before releasing SQLite.

Install or refresh the app after updating the repository or changing the Node.js installation:

```bash
npm run codex:install
```

The launcher never modifies the official `ChatGPT.app`. Moving or deleting the source repository does not break an already installed runtime. A Codex instance already running without CDP must still be quit before using the generated `Codex.app`.

## Reliable initial Codex injection

The standalone launcher waits up to 30 seconds for Codex's main renderer after CDP becomes reachable. It ignores auxiliary renderers such as global dictation and the avatar overlay, then waits for the main renderer's initial `app://` document to reach `complete`. Only then does it enable the CSP bypass and reload once, allowing the registered document-start injection to run without aborting the official desktop bootstrap. The automatic Panel-open request is a one-shot latch claimed by the first available main renderer, so a later iframe failure keeps the supervised service and manual retry available without repeatedly overriding native conversation navigation.

Chromium 151 applies Local Network Access checks to loopback subframe navigation. The generated launcher therefore passes `--disable-features=LocalNetworkAccessForSubframeNavigations`, and the managed iframe delegates `local-network-access`, `loopback-network`, and `local-network`. The compatibility switch is limited to subframe navigation; fetch, WebSocket, and other Local Network Access checks are not disabled.

Run the launcher as documented in [Embed in Codex](../README.md#embed-in-codex):

```bash
CODEX_PANEL_HOST=127.0.0.1 npm run codex
```

The wait duration is fixed. If no main renderer appears within 30 seconds, the launcher exits with `Timed out waiting for a Codex renderer target`.

## Open Panel from any native page

The Panel sidebar entry opens from conversations as well as native pages such as Plugins and Sites. No configuration or migration is required.

This fix accepts a main content frame that covers most of the Codex viewport even when that frame also includes the native titlebar region.

## Link embedded AI conversations to issues

An existing local AI conversation can be linked, moved, or unlinked through the issue menu in its header while no turn is running. Opening the menu loads active issues directly from the conversation's original project, independent of the project currently shown on the board. Linked conversations appear in the matching issue activity stream and open that exact local chat; the conversation history also shows the linked issue identifier.

Send `/handoff` or `/交接` in an embedded conversation to summarize its current conclusions into a Codex Agent comment. The linked issue is the default target; `--issue ISSUE-ID` selects another active issue. Optional text after the command can emphasize specific details.

The original `$handoff` Skill remains unchanged. The separately installed `$handoff-panel --issue ISSUE-ID [handoff focus]` wrapper works from any Codex conversation: it completes the installed base Skill first, then validates the selected Issue and uses `panelctl` to attach the resulting document verbatim. Validation or publication failure preserves the temporary document and is reported as a partial failure. “Open in conversation” includes the latest handoff in the new native Codex prompt, tells the task to refresh the issue and all comments through `panelctl`, and automatically writes the new native thread ID back to the issue after the first message creates the task.

## Managed iframe trust boundary

The launcher-managed Panel origin receives Codex project, user, thread, and workspace context and may invoke native thread navigation, task creation, sidebar expansion, and automation. A custom `window.__CODEX_PANEL_URL__` origin remains display-only: it receives theme updates and may report titlebar drag regions to the host, but it cannot cross that native Codex boundary. `window.__CODEX_PANEL_MANAGED_ORIGIN__` identifies the trusted origin and defaults to the local Panel service.

## Explicit Panel integration installation

After `npm ci`, run `npm run codex:install` to copy the repository's `manage-panel` and `handoff-panel` Skills into `~/.agents/skills`, install a real `~/.local/bin/panelctl` wrapper, build the standalone runtime, and generate the macOS launcher. The installed files carry ownership markers and never point back to repository files. Existing user-managed paths are preserved. On first install, the repository's current `.data` is copied through a live SQLite snapshot into the fixed user data directory without deleting the source. Plain dependency installation does not write any of these user-level integrations.

## Theme-aware issue property menus

Issue status, priority, assignee, workflow, development context, and recurrence controls use Panel-owned menus rather than browser-native dropdowns. Their surfaces, icons, focus states, and placement follow the current light or dark theme and remain inside the available desktop or mobile viewport.
