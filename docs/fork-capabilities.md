# Fork capabilities

The project model picker supports **6 Astra** (`gpt-6-astra`) with `low`, `medium`, `high`, `xhigh`, `max`, and `ultra` reasoning levels. Its default effort is `low`; existing saved model selections remain unchanged.

This page indexes the user-visible differences maintained by `shay-wong/codex-panel` relative to `chuspeeism/dashi-taskboard`.

## Configurable AI workflows

Search by Skill name or ID, with or without a leading `$` (for example, `$shay-skills:review`).

In the Codex Panel App, open **Preferences → Workflow → Configure workflows**. The Panel service must be running. A dedicated workflow editor opens inside the App; it does not open an external browser or change the selected board project. The four ordered Skill selections are stored in the local Panel database and shared by every project on that installation; they are not Cloud settings.

| Stage | Default when no custom Skills are available |
| --- | --- |
| AI planning | Native Codex Plan mode, with an editable draft that you send manually. Approve the plan and leave Plan mode before saving its Spec or publishing tickets. |
| Task execution | Codex's default agent follows the issue and Panel execution instructions. |
| Code review | The execution agent invokes the official Codex CLI reviewer: `codex review --uncommitted` before committing, or `codex review --base <development base SHA>` for committed changes. This is not the App's inline `/review` action. |
| Task handoff | Panel creates a redacted temporary Markdown summary and attaches it to the chosen issue through `$handoff-panel`. |

Select installed Skills in the order they should run. A stage accepts up to 20 Skill IDs; execution and review together accept up to 20 distinct IDs. Panel resolves their current paths from the target project's catalog when the operation starts rather than persisting machine-specific paths. If any configured Skill is missing, the entire stage falls back to its default with a notice; it does not run a partial custom chain or require the author's personal Skills.

Existing conversations keep their bindings and context. Saving settings affects new operations, and an upgrade does not infer preferences from installed Skills. To retain the previous custom planning flow, select `grill-with-docs`, `to-spec`, and `to-tickets` in that order; select `implement` for execution if desired. The bundled `manage-panel` and `handoff-panel` integration Skills remain installed independently of these choices. Custom Skills may have their own dependencies or behavior.

Agents can inspect the effective selection with `panelctl workflow get planning --project PROJECT_ID --json` (also `execution`, `review`, or `handoff`); the result includes `skills`, `missing`, and `mode`. The local API exposes `GET/PUT /api/local/workflow-settings` for the four stage arrays and `GET /api/local/workflow?stage=planning&projectId=PROJECT_ID` for resolution.

Native Plan selection still depends on Codex's composer controls, and default review requires an installed Codex CLI with its review command. Configurable Skills remove personal workflow dependencies, not the requirement for Codex or the version coupling of native integration.

## Codex Panel product and repository name

The browser title and repository entry points use the `Codex Panel` name, and the repository is named `codex-panel`. The canonical Skill, CLI, environment, integration protocol, local storage, SQLite, and undeployed Cloudflare identifiers now use `manage-panel`, `panelctl`, `CODEX_PANEL_*`, and `panel`. Browser keys, environment variables, automation names, and repository-managed links are migrated or accepted as fallbacks so the rename does not discard existing state. The completed local database rename is represented only by `panel.sqlite`; the one-time legacy file migration is no longer retained.

## Stable Project Keys and Issue identifiers

Each project stores one globally unique Project Key containing 1-12 letters or numbers. New Issues use that Key as their `KEY-N` prefix, so similarly named projects never share a prefix or numbering sequence. The create-project UI accepts an explicit Key; CLI and automatic repository registration can allocate one when omitted. **Project Settings**, immediately after **Project Docs**, can atomically migrate a local project's Key and historical local `PREFIX-N` identifiers while preserving internal task ids, relations, and conversation links. Issues moved from another project retain their original identifier.

Read-only issue, Jira planning, activity, comment, attachment, and tree lookups accept an internal task UUID, a Panel Issue identifier, or a unique linked Jira key. An ambiguous Jira key returns an explicit conflict instead of selecting a task.

Existing Issue identifiers are never rewritten. During local or Cloud migration, Panel keeps a project's first valid historical prefix when possible and gives later collisions a deterministic numeric suffix. The same Key is included in local-to-Cloud migration bundles.

## Board-style horizontal list

The list view supports horizontal and vertical layouts. Horizontal layout uses the issue board's status colors, workflow arrows, column spacing, scrollable column bodies, and card hierarchy so statuses remain easy to scan. Jira issues show their external key when available, with the title on a separate line and metadata wrapping inside the card. Vertical layout keeps the existing compact rows.

## Readable GFM task lists

Read-only issue descriptions and comments keep task-list text and inline code together beside the checkbox instead of placing later inline fragments into the checkbox column. Editing retains the structured task-list layout used by the Markdown composer.

## Bounded project-summary retries

Each project dashboard asks Codex for a daily progress summary. A failed generation is retried after 5, 15, and 60 minutes; after the fourth failure, Panel stops automatic attempts and leaves a manual retry button in the summary bubble. The button shows progress until that attempt finishes. A successful automatic or manual generation resets the failure count, while existing failed summaries migrate into the first retry stage without losing their stored text or error.

## Tauri/Rust desktop manager

The launcher and its embedded workflow editor use React with Radix Themes for consistent controls in light and dark mode. Runtime actions still use the existing Tauri command/event interface. For source builds, `npm run build:launcher` generates `dist/launcher`; `npm run app:prepare` builds both the Panel Web UI and launcher before packaging the runtime.

### Exhausted-usage banner visibility

When switching conversations, new banners and updated banner text are hidden before the deferred page refresh runs.

The launcher separates **运行概览** (Runtime overview), with service status and maintenance actions, from **偏好设置** (Preferences), with distinct connection, display, and system groups. Open **偏好设置 → 显示** and enable **隐藏额度耗尽提示** (Hide exhausted-usage banner). The preference defaults to off and is saved across restarts. While connected, changes reach Codex on the next host heartbeat, normally within two seconds. Turning it off restores the banner; no service restart is needed.

This hides only the current English and Chinese Codex-and-Work exhausted-usage banner. It leaves other errors, model/image limits, account quotas, and usage enforcement unchanged. Other locales or a future Codex banner structure may remain visible. Panel does not patch the installed Codex application.

On macOS, the explicit `npm run codex:install` command builds a standalone runtime under `~/Library/Application Support/Codex Panel`, creates or refreshes `~/Applications/Codex Panel.app`, and removes only older launcher installations carrying a Codex Panel ownership marker. Plain `npm ci` continues to install project dependencies without writing user-level integrations. The installed product is the upstream Tauri/Rust desktop foundation under the unchanged `Codex Panel` name; the former SwiftPM launcher is no longer a product or build path.

The app runs from the macOS menu bar. Its menu exposes runtime status; an embedded Panel entry point; one state-aware start/stop item; separate restart, browser, log, and data-directory actions; launch-at-login; and independent connect-on-launch and open-after-connect preferences, with the latter two enabled by default. Restart and browser actions are enabled only while the managed service is running. A fresh renderer heartbeat, matching source hash, startup token, and mounted entry are required before the status becomes healthy. Unexpected integration exits use bounded recovery delays of 2, 5, and 15 seconds, and a fourth failure inside 60 seconds suppresses further automatic recovery.

The management window uses React and Radix Themes inside Tauri's WebView. Runtime overview, grouped preferences, and the dedicated workflow editor share neutral controls and light/dark styling. Service, process, and filesystem operations retain the existing Rust commands and events. A fixed sidebar separates Runtime overview, Preferences, and About, with Open Panel at the bottom. About contains the app version, update checks, installation, and release notes; logs and runtime diagnostics remain in Runtime overview. Runtime overview uses a status summary, labeled service actions, and three compact status rows. Preferences uses grouped form rows and one highlighted global-workflow entry. Renderer readiness and actual Panel visibility are tracked separately, and an open request stays queued across renderer transitions until the injector confirms that the page opened. Native Codex actions triggered just after Panel appears wait briefly for the first host-bridge heartbeat instead of immediately reporting that the launcher is unavailable. Async action buttons keep loading visible for at least 300 ms before retaining a brief success or failure state; service start, stop, and restart leave the WebView responsive while process lifecycle work completes; and the browser action accepts only the launcher's private loopback URL while preserving its instance-token route. Dependent launch preferences, visible update results and an available-Release action, log and data controls, and expandable runtime paths and process details follow below. The window header and macOS app/Dock icon use matching light and dark Codex assets with the `PANEL` ribbon and switch with the system appearance.

The bundle contains the Rust launcher, official signed Node.js runtime, Panel server and UI, injector, `panelctl`, and both Panel Skills. The macOS installer verifies ownership before replacement, signs the app with `CODEX_PANEL_CODESIGN_IDENTITY`, a reusable local Apple Development identity, or an ad-hoc fallback, and preserves the fixed `~/Library/Application Support/Codex Panel/data` directory. Windows release builds require `CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT`, create an Authenticode-signed NSIS package, and verify the launcher's signer plus a signed-in SHA-256 manifest for Node and all packaged Panel runtime files before execution. Migration from the former Swift app stops its verified injector and exact bundle-owned Panel server before replacement so no PPID 1 process continues to execute a deleted Swift bundle path.

Inside WSL, `panelctl` discovers the Windows launcher descriptor from `%LOCALAPPDATA%\Codex Panel\data` and uses Windows `curl.exe` to reach the loopback service. `CODEX_PANEL_WSL_RUNTIME_FILE` provides an explicit WSL-path override.

The launcher-owned Panel listener prefers `127.0.0.1:47823` and falls back to a private random port when that port is unavailable. Codex CDP remains on a separate random endpoint.

Before connecting, Rust validates the signed Codex Panel bundle and packaged runtime, validates the official `ChatGPT.app` and bundled Codex executable against OpenAI's identifiers and Team ID, rejects symlinks, and starts the bundled Node process with Node, shell, and dynamic-loader injection variables removed. The Panel server receives a launcher-owned loopback listener, private URL token, and private instance secret. The injector uses a user-only version 2 runtime descriptor and token-authenticated Unix control socket on macOS. Windows keeps the launcher's owned child control pipe for open, status, and stop, and uses a startup-token-authenticated named pipe for Panel lifecycle actions that interrupt native Codex turns. If the current Codex command line exposes a reachable CDP endpoint, `--attach-existing` discovers and reuses that real port, including during Swift-to-Tauri migration; otherwise the official app is launched through macOS LaunchServices with a random loopback CDP port. A Codex process running without CDP must still be quit before relaunch. Stop and quit terminate only Tauri's injector and Panel server, leaving the official app untouched.

The app checks `shay-wong/codex-panel` Releases automatically at most once every 24 hours using a persistent cached result, while manual checks bypass the cache. It prefers a locally authenticated `gh` CLI and falls back to the anonymous GitHub API, with distinct rate-limit, network, no-release, current-version, and available-update states. It accepts only normalized `vX.Y.Z-fork.N` candidates and exact HTTPS release-tag URLs. Available updates are downloaded and signature-verified in the app, then installed only after user confirmation. The trusted Release page remains available separately. See [Signed in-app updates](#signed-in-app-updates).

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

The Panel sidebar entry opens from conversations as well as native pages such as Plugins and Sites. Panel remembers every selected project, including **All projects**, and restores it the next time the sidebar entry opens without a `project` query parameter. An explicit `project` query parameter still takes priority. No configuration or migration is required.

This fix accepts a main content frame that covers most of the Codex viewport even when that frame also includes the native titlebar region.

While Panel is active, selecting a native destination from Codex's global command menu restores the native view for both mouse and Enter selection. Chat, Work, Codex, Settings, Skills, Scheduled Tasks, new conversations, and other commands that change the native route are covered. Opening Activity or selecting a notification also restores its native destination instead of leaving it behind Panel. Utility commands such as theme changes leave Panel open. Route-neutral commands currently recognize Simplified Chinese, Traditional Chinese, and English labels because the command menu DOM exposes localized titles but no stable command identifier. Other UI languages remain pending until that identifier is available.

## Signed in-app updates

Panel uses Tauri's updater to download and verify an available fork release before installation. Click **Install update** and confirm to replace the App and restart Panel. Download or signature failure leaves the installed App and data intact; installation failure attempts to restore the owned Panel service. Windows continues to use the Release page, matching upstream's current limitation. Linux requires a supported signed package in that release's metadata.

Release builds must supply `CODEX_PANEL_UPDATER_PUBLIC_KEY` with the fork's Tauri/minisign public key; never use the upstream public key. A build without this key reports that in-app installation is unavailable. Keep the corresponding `TAURI_SIGNING_PRIVATE_KEY` and optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the release environment only. Public-key configuration is compiled into the launcher, not loaded from mutable user settings.

For macOS, set all release version fields to `X.Y.Z-fork.N`, build and sign the App with the public key configured, then run `node scripts/create-macos-updater.mjs <Codex Panel.app> <output-directory> vX.Y.Z-fork.N`. The script checks the bundle identity/version and platform signatures, detects its actual architectures, signs the archive, verifies the updater signature against the public key, and writes `latest.json`. Upload the DMG first, then the generated `.app.tar.gz`, `.sig`, and `latest.json` to that exact `shay-wong/codex-panel` release. Publishing is a separate action; running the script does not upload anything. Normal local installs do not require the signing secret.

The updater reads `releases/download/<selected-fork-tag>/latest.json`, so GitHub's handling of prerelease tags does not redirect it to another channel. An actual signed release and a launcher built with its public key are required before the installed application can update itself.

## Link embedded AI conversations to issues

An existing local AI conversation can be linked, moved, or unlinked through the issue menu in its header while no turn is running. Opening the menu loads active issues directly from the conversation's original project, independent of the project currently shown on the board. Linked conversations appear in the matching issue activity stream and open that exact local chat; the conversation history also shows the linked issue identifier.

On desktop, the embedded chat window can be moved by dragging its header, resized from its top or left edges, and maximized or restored. Panel remembers the normal position, size, and maximized state across close and reload; mobile remains full-screen without replacing the saved desktop layout.

Send `/handoff` or `/交接` in an embedded conversation to summarize its current conclusions into a Codex Agent comment. The linked issue is the default target; `--issue ISSUE-ID` selects another active issue. Optional text after the command can emphasize specific details.

The bundled `$handoff-panel --issue ISSUE-ID [handoff focus]` works from any Codex conversation: it resolves the selected Issue and global handoff configuration, creates a redacted temporary document with the selected Skills or the built-in summary, then uses `panelctl` to attach it verbatim. Publication failure preserves the temporary document and is reported as a partial failure. No personal `handoff` Skill is required or modified. “Open in conversation” opens an unsent, Panel-localized draft without internal routing markers. Local drafts include `$manage-panel`, the latest handoff, and instructions to refresh the issue through `panelctl`; SSH drafts include the current issue snapshot because the remote worker cannot access local `panelctl`. Panel stores the local or SSH thread binding only after the user sends the draft and Codex creates the thread; SSH issues also move to in progress at that point.

## Display local images in embedded AI conversations

Embedded AI messages render Markdown images that reference absolute local PNG, JPEG, GIF, or WebP paths, including `file:` URLs. Paths containing spaces must be URI-encoded or enclosed in Markdown angle brackets. Images scale down to the conversation width without being enlarged beyond their intrinsic size.

Panel rewrites only local image targets to a loopback-only endpoint tied to the saved message event and the image's Markdown source position. The server reparses that stored message, reads only the referenced path, and verifies the file signature before returning it. The browser cannot submit an arbitrary filesystem path through this endpoint, and normal HTTP(S) images keep their original URL.

## Managed iframe trust boundary

The launcher-managed Panel origin receives Codex project, user, thread, and workspace context and may invoke native thread navigation, task creation, sidebar expansion, and automation. A custom `window.__CODEX_PANEL_URL__` origin remains display-only: it receives theme updates and may report titlebar drag regions to the host, but it cannot cross that native Codex boundary. `window.__CODEX_PANEL_MANAGED_ORIGIN__` identifies the trusted origin and defaults to the local Panel service.

## Explicit Panel integration installation

After `npm ci`, run `npm run codex:install` to copy the repository's `manage-panel` and `handoff-panel` Skills into `~/.agents/skills`, install a real `~/.local/bin/panelctl` wrapper, build the standalone runtime, and generate the macOS launcher. The installed files carry ownership markers and never point back to repository files. Existing user-managed paths are preserved. On first install, the repository's current `.data` is copied through a live SQLite snapshot into the fixed user data directory without deleting the source. Plain dependency installation does not write any of these user-level integrations.

## Jira Bearer token authentication

Jira connection settings provide two explicit authentication modes. Account / API token uses Basic Auth for an account password or a Jira Cloud email and API token. Bearer token uses a Jira Data Center or Server personal access token without sending a username. Basic Auth requires a username or email, and switching modes requires entering the credential again.

Credentials remain in the local Panel data directory with the existing local file protections and are never returned to the browser. Jira integration remains unavailable in Cloud mode. Use HTTPS unless the Jira server is on a trusted private network because HTTP exposes either authentication mode to network observers.

## Reliable Jira open-issue synchronization

Panel searches only for open issues assigned to the signed-in Jira user. It reads every search page before applying one database transaction, then rechecks previously synced issues that disappeared from the open result. Confirmed completed or out-of-scope issues are archived from the Jira project; issues that cannot be confirmed remain visible and are marked with an unknown synchronization state.

Authentication, permission, network, and partial-page failures never clear the last successful Jira data. Cached issues remain available while a compact Jira status bar and the connection dialog show the last attempt, last success, open and unknown counts, and an actionable failure. Panel also compares Jira's stable `/myself` account identity and asks for confirmation before it searches or stores issues from a different account. Opening the Jira project retains the existing one-minute refresh throttle; manual synchronization remains uncached and may be run repeatedly.

## Link Jira requirements to repository issues

After an explicit request, `panelctl conversation bind JIRA_KEY` binds the current Codex conversation and initializes a missing planning record, including when the conversation was already bound. Read `jira planning get` again for `plan.version` before saving the Spec and publishing tickets. An existing plan, its Spec, and its planning conversation remain unchanged; binding does not send a prompt, start execution, or change Jira status.

A synced Jira issue remains an external requirement in the dedicated Jira project. Open its detail view and choose **Manage Jira links** to select one or more repositories discovered from local Codex workspace mappings or existing Panel project workspaces. The searchable, independently scrollable picker shares the project menu's controls and selection style. A discovered repository that is not yet a Panel project remains only a candidate until **Save repositories** registers it; saving never creates, moves, or deletes execution issues. Repository changes are shown as a pending difference and activity entries resolve saved project IDs back to their project names, falling back to the ID only when the project is no longer available.

A planning conversation may also save repository links after the user explicitly names the Jira requirement and repositories. The bundled Skill resolves exact Panel project IDs, reads the latest Jira context, and runs `panelctl jira repositories set` with `context.jira.version`; the supplied list replaces the complete repository selection, so additive requests retain existing links and removal requires an explicit request. Panel never infers this mutation from the current directory, conversation project, or generated tickets.

The same dialog can link existing active issues from the selected repositories. One Jira requirement may link multiple execution issues across repositories, while each execution issue may link to only one Jira requirement. Linked Jira details appear compactly on the execution issue and return to the requirement inside Panel; the requirement detail keeps a separate action for opening external Jira. Jira activity entries for both linking and unlinking an execution issue open that Panel issue directly, including historical entries whose repository is not loaded in the current Jira view. When several repositories are linked, the summary shows the first repository plus `+N` and keeps the full list in its tooltip. Both detail views can remove the relationship. A linked execution issue may move only among repositories selected by its Jira requirement. Archiving keeps the relationship, while permanent deletion requires unlinking first.

Jira synchronization updates the external requirement's Jira key, title, original status, URL, last synchronization time, and synchronization error. It does not change the linked execution issue's title, description, status, or other local work fields.

For a simple requirement, first save at least one repository selection while the Jira issue is waiting. **Create and start** then moves Jira to in progress, creates or reuses one backlog execution issue and one formal native Codex task per selected repository, links them to the Jira requirement, and releases every execution issue to waiting only after all repositories are ready. While creation is running, the action shows progress; after a partial failure it becomes **Continue creating**, and after success it remains disabled as **Created and started**. Retries reuse the persisted operation, reserved issue and conversation IDs, existing links, and existing conversations instead of creating duplicates.

For a complex requirement, choose **Plan with AI** to open a formal native Codex task with the Jira description, requirement links, and selected repositories. With no linked repository the task is projectless, with one it opens directly in that project, and with several Panel asks which project to use. Newly created planning tasks default to **Approve selected actions** (`workspace-write`); an existing planning task keeps its saved permission. Panel applies the global planning Skill selection, or native Codex Plan by default, fills the generated prompt into the editable composer, and leaves it unsent for review. After approving a native plan, leave Plan mode before saving the Spec or publishing tickets. If Codex omits direct symbolic-link directories under `~/.agents/skills` from `skills/list`, Panel adds their valid `SKILL.md` metadata to the local catalog so those selections remain structured Skill references; an existing Codex catalog entry with the same name keeps priority. Codex starts only after the user sends that draft. Planning and execution tasks open through Codex's native task route and do not appear in the bottom-right embedded chat, which is reserved for temporary questions. If the renderer reloads after sending but before Panel records the binding, the pending intent survives and the next planning click recovers the unique Codex conversation containing the exact Jira key instead of creating a duplicate. Planning remains available before a repository is selected; Panel explicitly allows that managed non-Git workspace, and a Codex startup failure after sending shows its actual diagnostic. The resulting Spec is stored on the Jira requirement rather than becoming a claimable issue. Publishing requires user approval and a selected linked repository for every ticket. It creates linked backlog issues, preserves declared blocking relationships across repositories, and does not authorize execution. Jira description lines whose numbered items begin with `#` render as an ordered list without changing ordinary Panel Issue Markdown.

Changing the Jira title, description, requirement links, or selected repositories marks the plan for review before another publication and prevents unstarted linked issues from entering execution. Replanning cancels only superseded backlog or waiting issues; work already in progress, review, blocked, or done remains linked, stays visible as a warning, and is preserved as a constraint. A planning Jira cannot also use the simple create-and-start path.

Jira status controls execution authorization separately from planning. Moving Jira to in progress releases only linked backlog issues with no unfinished prerequisite. If Jira returns to waiting, or ends while linked work remains unfinished, its detail shows a confirmation notice. Choosing **Pause linked issues** moves waiting work back to backlog, blocks active work, and attempts to interrupt its active Codex turn while preserving code, conversations, and worktrees. An interruption failure does not undo the issue pause; Panel reports how many turns still need attention. Returning Jira to in progress releases eligible paused work again.

When a completed Jira requirement is reopened, historical execution issues and conversations remain unchanged. A simple requirement can create new rework issues and independent conversations; a previously planned requirement can either do that or choose **Plan again** to create a new planning conversation that also defaults to **Approve selected actions** while retaining the previous planning conversation. Panel replaces the saved plan after the new conversation and editable draft are prepared; creating that draft does not send or start a Codex turn. A preparation failure preserves the previous plan for a clean retry. Sync, repository, link, and lifecycle changes for that Jira are rejected while the reopened action is being applied. Jira issues resolved as duplicates record their canonical Jira. Existing repository and issue links move only after confirmation; Panel probes canonical issues that are not assigned to the current user, and preserves the links on the duplicate only when the current Jira account cannot read the canonical issue.

Jira settings can enable automatic completion, which remains off by default. A Jira requirement is eligible only when it has at least one linked execution issue and every linked issue is unarchived and done. Panel rereads the Jira status and `updated` timestamp, fetches the currently available transitions, and proceeds only when exactly one transition maps to done. It rereads Jira after the transition to confirm the final state. If Jira changed after the last Panel sync, the requirement detail offers **Accept remote** and **Complete anyway** instead of overwriting the remote edit. Temporary server, timeout, or rate-limit failures retry twice; final failures keep local issues done and expose **Retry**.

Jira settings can enable automatic conversation archiving, which remains off by default. When enabled, Panel archives the Jira planning conversation and the Panel-managed execution conversations associated through simple start, automatic claiming, or rework after Jira and every linked execution issue are done. The Jira detail exposes **Archive conversations** under the same eligibility rules even when the automatic setting is disabled. Archived conversations leave the active list but retain their local thread, run, event, and Codex thread records for direct historical reads. A currently running turn remains visible until it settles. Disabling automatic archiving does not restore history, and reopened work creates a new rework or planning conversation instead of resuming an archived one.

## Persistent automatic execution queue

Tickets from the same Jira requirement and repository execute sequentially in one native Codex conversation, branch, and worktree. The first ticket creates the worktree through Codex; subsequent tickets resume the saved conversation with structured Skills and retain its permissions and workspace. Each ticket still has its own binding, activity, status, and attempts. An active or blocked execution holds the group's next ticket. Same-repository prerequisites with an execution binding can unblock the next ticket at `in_review`; other dependencies wait until completion. Only authorized work is released, and a pending Jira decision or paused project still prevents dispatch. With a published plan, reuse stays within its current ticket set; reopened work does not adopt completed historical conversations. Existing separately bound tickets retain their bindings rather than moving code or messages automatically.

A busy native conversation uses the existing bounded retry policy, while a missing or mismatched workspace stops execution instead of creating a replacement. When the original conversation binds itself and takes over after a launcher timeout, Panel reconciles the queue with its actual status and clears the stale current error; historical comments and attempts remain. Upgrading removes the queue's old one-conversation-per-ticket uniqueness constraint without deleting records. Shared worktrees are retained while their group has unfinished tickets.

When older tickets already have different execution conversations, Panel prefers the current ticket's bound direct prerequisite. If no unique execution context can be selected, it asks for an explicit conversation binding rather than choosing an arbitrary worktree. Disabling automatic claiming still releases authorized dependencies to `todo` for **Run now**, without automatically enqueuing them.

Native conversation entries in issue activity use the board's session-progress polling, including conversations shown in an open detail even when the issue is not in progress. Running and idle reflect the actual conversation; unavailable session data displays **Status unknown**. This display does not move issues or modify the execution queue.

Each repository project has a Panel-owned automation policy stored with the local Panel database. The automation menu can enable or disable automatic claiming, pause all dispatch for the project, choose a 5, 10, 15, 30, or 60 minute scan interval, and select the model and reasoning effort. It also sets the global default project parallelism, which starts at 3 and accepts 1 through 8, and lets the current project follow that default or override it with another 1-8 value. Projects do not share a total device limit. The menu shows queued, running/effective-capacity, blocked, and failed totals. Jira and Cloud projects do not expose this policy.

Automatic scans queue waiting local issues that are not linked to Jira. A Jira-linked execution issue enters the queue only after its Jira requirement is in progress and has no pending lifecycle decision. **Run now** queues any waiting local issue immediately without requiring automatic scans to be enabled, including execution issues created by the Jira simple-start action. Disabling automatic claiming stops new automatic entries but lets the current queue drain; pausing a project keeps every queued item waiting until the project resumes.

The queue persists its source, state, selected conversation, attempts, next retry time, and last error. Dispatch prefers manual and resumed work; Jira-authorized and scanned work then share the issue-priority and board-order queue. Capacity keeps an issue waiting in `todo`. Formal execution opens the selected repository in Codex, selects the visible native **New local worktree** menu item, and submits the prepared `manage-panel` prompt with the configured execution and review Skills, or their Codex defaults. Codex therefore owns worktree creation and runs the project's configured environment setup; Panel stores the actual native thread binding, worktree path, and branch only after Codex returns them. Jira-linked execution uses the Jira external key in its task title, prompt, and branch naming instruction instead of the Panel issue identifier. A successful execution must leave the issue in review or done. Execution that needs input shows **Waiting for your reply** and resumes only after a user comment or completed user turn. Other execution failures show **Run again** for an explicit retry, while automatic scans ignore blocked work. Jira-paused work stays disabled until its Jira requirement returns to in progress. Transient connection or startup failures retry after 30 seconds and 2 minutes.

A service restart records the interrupted attempt and returns the issue to waiting. It resumes only when the stored conversation, execution history, and development context still agree; uncertainty blocks the issue instead of creating another conversation. Worktrees remain attached through `in_review` and are removed after `done` only when clean and merged into `origin/main` or local `main`. These limits apply only to Panel-managed one-click and automatic execution. Panel does not limit, scan, or change user-created Codex tasks or Scheduled Tasks, except that migration may pause the one exact legacy automation ID previously saved by Panel.
