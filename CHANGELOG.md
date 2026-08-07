# Changelog

This file records user-visible changes introduced by the fork.

## Unreleased

- Standardized the fork on `Panel` naming across the product, `$manage-panel` Skill, `panelctl` CLI, environment variables, integration protocol, local data, and undeployed Cloudflare resources, with migrations for existing local state and managed links.
- Added a native `~/Applications/Codex Panel.app` manager with service, Codex/CDP, and embedded-integration status; start, restart, stop, Panel, browser, log, and data controls; optional launch at login; and independent automatic connect and Panel-open settings.
- Added official light and dark Codex icon resources with the same clipped 45-degree `PANEL` corner ribbon, including live Dock icon switching with the current macOS appearance.
- Hardened launcher updates so the app executes a signed bundled runtime, hash-checks Node.js and the official Codex CLI, pins and verifies the official ChatGPT bundle requirement plus its main-executable path and hash, requires both official icon variants, binds reuse to the real signer and designated requirement, and never treats an ad-hoc signature as a stable permission identity.
- Fixed manager-driven cold starts by tracking the official app's real bundle executable, preserving CDP arguments and the supervised Panel service for the actual Codex process lifetime, and reporting unreadable bundle metadata instead of guessing an executable name.
- Fixed manager-driven cold starts so the injector waits for Codex's initial `app://` document to finish loading before performing the one CSP-bypass reload required by the Panel iframe, avoiding both the official fallback error page and `ERR_BLOCKED_BY_CSP`.
- Fixed Chromium 151 loopback iframe blocking by applying the narrow subframe-navigation compatibility switch, delegating local-network permissions to the managed Panel frame, and consuming the initial automatic open only once so a failed frame cannot repeatedly pull users away from conversations.
- Fixed resident injector refreshes so they reload Codex after enabling the CSP bypass, reuse a healthy resident on repeated launcher clicks, and fully close retired local-service connections.
- Fixed manager status and lifecycle handling so “embedded” requires a live renderer heartbeat, existing Codex CDP ports are discovered without stopping other ports, Panel opens never detach the managed injector, stop or quit waits for owned child processes to exit, and a manager-launched ChatGPT/Codex remains running after the manager closes.
- Documented the intentional lifecycle tradeoff that closing Panel leaves the manager-launched ChatGPT and its unauthenticated local CDP running until ChatGPT itself exits, and that updating ChatGPT requires reinstalling Panel to refresh the pinned application identity.
- Fixed standalone launcher startup so it waits for Codex's main renderer and ignores auxiliary avatar renderers instead of failing before Panel is embedded.
- Fixed the Panel sidebar entry so it opens from Codex conversation pages as well as Plugins and Sites.
- Added issue linking and durable handoff summaries for embedded AI conversations, including cross-project-safe loading from the conversation's original project, `/handoff`, `/交接`, the global base-first `$handoff-panel --issue ISSUE-ID` wrapper that publishes the unchanged temporary document verbatim, activity-stream entries, handoff context in new native Codex tasks, and automatic native thread association after the first message.
- Restricted Codex project, user, thread, workspace, native navigation, task creation, sidebar, and automation privileges to the launcher-managed Panel iframe origin; custom UI origins remain display-only.
- Replaced browser-native issue property dropdowns with light- and dark-theme menus that match the Panel UI.
- Added an explicit `npm run codex:install` command that builds a repository-independent user runtime, copies `manage-panel` and `handoff-panel` into `~/.agents/skills`, installs `panelctl` in `~/.local/bin`, snapshots existing local data into the fixed support directory, and generates the macOS launcher without making `npm ci` write user-level integrations.
