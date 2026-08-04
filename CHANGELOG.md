# Changelog

This file records user-visible changes introduced by the fork.

## Unreleased

- Renamed the fork product and repository to `Codex Panel` and `codex-panel` while retaining existing Taskboard compatibility identifiers.
- Added automatic rebuilding of the existing `~/Applications/Codex.app` launcher so its Codex name and icon open the official app with the embedded Panel, restore a missing Panel entry on repeated launches, and stop its local service when that Codex instance exits.
- Fixed standalone launcher startup so it waits for Codex's main renderer and ignores auxiliary avatar renderers instead of failing before Taskboard is embedded.
- Fixed the Taskboard sidebar entry so it opens from Codex conversation pages as well as Plugins and Sites.
