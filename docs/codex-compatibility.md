# Codex compatibility, 2026-09-30

## Release baseline

- Desktop: **26.928.20755**, downloaded from the macOS link on the [official app page](https://learn.chatgpt.com/docs/app). Its packaged CLI reports **0.159.0**.
- Standalone CLI: **0.159.2**, the latest stable release returned by the [official release API](https://api.github.com/repos/openai/codex/releases/latest) on 2026-09-30. See the [release](https://github.com/openai/codex/releases/tag/rust-v0.159.2) and [changelog](https://learn.chatgpt.com/docs/changelog).
- Repository baseline: `shay-wong/codex-panel`, commit `9628e79`.

Desktop and CLI versions are separate. The installed desktop version was not used as the compatibility target. This is a dated baseline, not a guarantee for future releases.

## Changes

The macOS launcher previously checked `Contents/Resources/codex`, which no longer exists in the latest desktop bundle. Executable discovery and native signature verification now select `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`. This is the real signed executable, not the shell wrapper in `codex-cli/bin`. Existing flat bundles remain supported. OpenAI application and executable signing identities are still checked.

The default-off custom-provider sending adapter recognizes the expanded native composer gate in `app-primary-92c16ff2fe4e.js`. It retains the additional pending-session, unavailable-thread, service-tier-loading, and policy checks. The switch still affects only the two account quota conditions for a known local non-OpenAI provider. It does not change official account limits, provider credentials, remote execution, or the installed application.

The project model menu and host validation include `gpt-6.1-sol`, `gpt-6-sol`, and `gpt-6-luna`. Efforts and defaults were checked against the real `model/list` response from CLI 0.159.2. Saved selections and the automation default are unchanged. Account availability can differ; the desktop's bundled 0.159.0 catalog does not yet contain `gpt-6.1-sol` in a signed-out session.

## Verification

- Real desktop packaged CLI: executable discovery, initialization, `model/list`, `skills/list`, and ephemeral `thread/start` succeeded with disposable state and workspace directories.
- Real standalone CLI 0.159.2: the same operations succeeded; new model efforts and defaults match the returned metadata.
- Official desktop bundle and nested executable passed strict signature verification outside the filesystem sandbox. The executable identity is `codex`, team `2DC432GLL2`.
- The real 26.928.20755 composer source is recognized, its non-quota blockers remain in the replacement, and the replacement passes JavaScript syntax checking.
- `npm run typecheck`, `npm run build:web`, and `npm run build:launcher` passed. The web build retains existing CSS pseudo-element and chunk-size warnings.
- Focused automation/executable checks: 12 passed, one Windows-only case skipped on macOS.
- A browser preview with isolated Panel data loaded successfully. The project automation menu displayed all three new models and saved a selection of 6.1 Sol while automatic execution remained disabled.
- Composer/injector checks: 30 passed, including the latest gate's loading/session conditions and live switch changes. The filesystem-watch check required running outside the sandbox after sandboxed `fs.watch` returned `EMFILE`.

## CI verification

GitHub Actions [Check run 36660877729](https://github.com/InTheManXG/codex-panel/actions/runs/36660877729), dispatched for code commit `5aaf896b04398fd52f4cc7d21044ccb0ef4ad54d`, completed successfully: the complete code check, macOS universal native build, packaged CLI/listener verification, ad-hoc signing and bundle verification, Windows tests and unsigned NSIS installer build, and Ubuntu package build/content verification all passed. This supplements the local checks above; the local machine itself still lacks Rust and Xcode command-line tools. The subsequent verification-record commit changes documentation only.

## Remaining validation

No signed-in desktop injection or real model submission was performed. Windows/Linux desktop interaction was not exercised. These steps remain necessary before claiming a fully verified desktop release. No installed app, production Panel data, login credentials, or existing conversations were modified. CI verification is not a published or notarized release.

To build the macOS launcher on a machine with the required toolchain, install Node.js 22.5+, Xcode command-line tools, and Rust, then follow the repository's `npm ci` and `npm run app:build:local` instructions. Install only after reviewing the resulting build.

## Recovery after desktop updates

Native confirmations and messages first restore the Panel manager window on macOS. Isolated tests on macOS 27.2 reproduced blank or unclickable alerts without an ordinary main window; activating the application alone did not fix them. Restoring the ordinary window alone also failed with Panel’s manual alert-window display. The host is now shown and restored from minimization, and the alert uses AppKit’s sheet lifecycle attached to that host. Error and update-result messages use non-blocking display so menu callbacks keep processing events. This diagnosis does not establish an internal Apple defect or behavior on other OS versions.

On macOS, Codex can restart after an update without the debugging arguments that Panel supplied. A desktop version allowlist is not involved: Panel still verifies the official application signature and reconnects automatically if it finds a usable port.

The recovery prompt uses the short text **Codex 已经更新，请点击下方按钮重新启动**. This copy does not change the existing launch-parameter detection.

When an ordinary Codex process is running without those arguments, Panel brings its management window forward once and offers **重启 Codex 并连接** (Restart Codex and connect). Confirm **重启 Codex 并连接** to relaunch with the connection arguments; running tasks may be interrupted, so save work first. **稍后** leaves both Codex and the existing Panel service running, including port discovery. Panel does not modify the installed Codex application or automatically terminate active work.

Verification uses isolated launcher state and simulated port recovery. This does not guarantee compatibility with future changes to Codex's internal UI, and the next official updater cycle still requires field confirmation.
