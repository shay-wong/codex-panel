# Changelog

This file records user-visible changes introduced by the fork.

## Unreleased

- Standardized the fork on `Panel` naming across the product, `$manage-panel` Skill, `panelctl` CLI, environment variables, integration protocol, local data, and undeployed Cloudflare resources, with migrations for existing local state and managed links.
- Added automatic rebuilding of the existing `~/Applications/Codex.app` launcher so its Codex name and icon open the official app with the embedded Panel, restore a missing Panel entry on repeated launches, and stop its local service when that Codex instance exits.
- Fixed first-time and repeated launcher installation so macOS uses the copied Codex icon instead of the default AppleScript applet icon.
- Fixed generated-launcher dialogs so they follow the current macOS light or dark appearance.
- Fixed routine integration reinstalls so an unchanged signed launcher bundle is reused, preserving its macOS permission identity instead of triggering authorization again through a new ad-hoc signature.
- Fixed cold launcher shutdowns by starting and tracking the official app's real bundle executable instead of the transient `/usr/bin/open` helper, preserving CDP arguments and the supervised Panel service for the actual Codex process lifetime, and reporting unreadable bundle metadata instead of guessing an executable name.
- Fixed generated-launcher cold starts so the injector waits for Codex's initial `app://` document to finish loading and embeds Panel without reloading that renderer, preventing the official desktop bootstrap from being aborted into its fallback error page.
- Fixed Chromium 151 loopback iframe blocking by applying the narrow subframe-navigation compatibility switch, delegating local-network permissions to the managed Panel frame, and keeping the supervised service alive while an initial frame failure is retried.
- Fixed resident injector refreshes so they reload Codex after enabling the CSP bypass, reuse a healthy resident on repeated launcher clicks, and fully close retired local-service connections.
- Fixed standalone launcher startup so it waits for Codex's main renderer and ignores auxiliary avatar renderers instead of failing before Panel is embedded.
- Fixed the Panel sidebar entry so it opens from Codex conversation pages as well as Plugins and Sites.
- Added issue linking and durable handoff summaries for embedded AI conversations, including cross-project-safe loading from the conversation's original project, `/handoff`, `/交接`, the global base-first `$handoff-panel --issue ISSUE-ID` wrapper that publishes the unchanged temporary document verbatim, activity-stream entries, handoff context in new native Codex tasks, and automatic native thread association after the first message.
- Restricted Codex project, user, thread, workspace, native navigation, task creation, sidebar, and automation privileges to the launcher-managed Panel iframe origin; custom UI origins remain display-only.
- Replaced browser-native issue property dropdowns with light- and dark-theme menus that match the Panel UI.
- Added an explicit `npm run codex:install` command that builds a repository-independent user runtime, copies `manage-panel` and `handoff-panel` into `~/.agents/skills`, installs `panelctl` in `~/.local/bin`, snapshots existing local data into the fixed support directory, and generates the macOS launcher without making `npm ci` write user-level integrations.
