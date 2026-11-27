# Codex Panel

Use **Preferences → Models & advanced → 配置上下文 → 刷新模型目录** to fetch the current provider's full model catalog on every refresh, while keeping saved context, compaction and subagent settings. Only GPT IDs supported by both the provider and the current Codex CLI's official catalog are offered; missing metadata uses the same official model's defaults. Check the models you want to keep, then save to apply only those models; later refreshes keep your selection and leave newly discovered models unchecked. Official OpenAI reuses the current Codex subscription or API-key account with file credential storage; custom providers use their own configured credentials. The candidate list updates immediately. Refresh distinguishes an unchanged catalog, updated candidates awaiting selection, and active catalog changes that require restarting Codex. Refreshing and saving preserve enabled Ultrafast tiers; JSON field order and model enumeration order alone do not count as updates. The model table keeps its header visible while scrolling. Panel's lists and Codex's main model picker put newer numeric versions first without changing the saved provider source. See [per-model context windows](docs/fork-capabilities.md#per-model-context-windows) for selection, catalog responses and supported authentication.

Open **Preferences → Chat → 新聊天默认不带项目** to start ordinary new chats and chats created from **Recent** without a project. This option is off by default. Starting a chat from a specific project keeps that project. Existing chats are unchanged; after the adapter's initial reload, changing the switch applies to the next new chat immediately. See [new chats outside projects](docs/codex-compatibility.md#new-chats-outside-projects).

In **Preferences → General → Codex 设置界面**, choose **跟随 Codex** (default), **弹窗** (dialog), or **整页** (full page). The choice applies when you reopen native settings, without restarting Codex. Direct settings links keep their native routing. See [native settings presentation](docs/fork-capabilities.md#native-settings-presentation).

**App and CLI shared sessions** is an optional, default-off setting for macOS and Windows. In **Preferences → Models & advanced → App 与 CLI 共享会话**, enable it while Panel is connected to Codex, then choose **复制共享 CLI 命令** and run the copied command in your terminal. It connects the terminal to the App's existing backend without restarting Codex. Ordinary `codex` commands still use their own backend and can conflict on the same chat. Keep both Panel and Codex running; handle approval and question prompts in the App. Turning sharing off disconnects shared terminal views without canceling App tasks. Create or fork chats in the App first. See the [shared-session guide](docs/shared-sessions.md); the isolated macOS main flow passed, while Windows runtime acceptance is pending.

In **Preferences → General → 终端布局** (Terminal layout), choose **跟随 Codex** (Follow Codex), **底部** (Bottom, default), or **右侧** (Right). Bottom restores the terminal below the conversation on Codex builds that only offer a right-side terminal. While connected and the terminal adapter is ready, the saved choice applies on the next host heartbeat, normally within two seconds, without restarting or refreshing Codex. Existing terminal tabs and sessions move with the layout. Open the terminal through its native action or your existing shortcut; Panel preserves native and user-defined keybindings. The bottom terminal and right-side files can stay open together. Drag its upper edge to resize it; hiding it keeps terminal sessions running, while closing a tab uses the native close action. The packaged Rust runtime includes this layout and the fix for adaptation reloads leaving the terminal on the right despite choosing Bottom. See [bottom terminal layout](docs/fork-capabilities.md#bottom-terminal-layout).

Open **宠物** in the sidebar to browse built-in and imported resources as preview cards. Use the built-in **Lumi** with **使用 Lumi** while connected to Codex. Lumi appears once, combining the built-in pet and identical imported copies. Importing the bundled animation again uses the built-in resource directly; it does not create another override or a restore button. Its **正在使用** badge reflects the native selection; **取消使用** restores the default Codex pet. The pack includes nine native states, sixteen look directions and an 18.75-second hover heart-and-dance sequence, shared by main and floating pets. Its updated artwork cleans up hair edges, keeps the curved outfit hem consistent, and aligns the arm-lowering transition with the dance. See the [pet guide](docs/pet-animations.md).

Import a pet pack from **宠物 → 导入宠物包**, then click **使用** on its card to select the new local pet. Reimport the same ID to replace its resources; removing a selected local pet first restores the default Codex pet. Packs may include per-action audio. Lumi’s music plays from the start; a 2.813-second raise-heart-lower preparation leads into fourteen dance loops and a four-beat closing gesture, with animation following the music clock and music fading out on the final beat; **播放宠物声音** controls playback and takes effect immediately. Keep Panel connected for main and floating pets. See the [pet pack guide](docs/pet-animations.md) and [capability index](docs/fork-capabilities.md#imported-pet-animations).

In native **Settings → Git → Branch prefix**, choose **Configure by repository…** to view saved repositories in separated rows, with names and paths on the left and prefix fields and delete icons on the right. Narrow layouts move each input below its repository; hover or focus a shortened path to read it in full. Edit a prefix directly in its row; leaving the field or pressing Enter saves it, and an empty field means **No prefix**. **Add** offers repositories that are not yet configured; choose a custom prefix or **No prefix**, then save to return to the list. Unconfigured repositories use the global setting; deleting a configuration restores it. The choice applies to new chats and suggested branch names; **No prefix** also overrides the native `codex/` default. Existing chats may retain earlier instructions; start a new chat to ensure the choice applies. See [repository branch prefixes](docs/fork-capabilities.md#repository-branch-prefixes).

New Codex chats and existing conversations have **Quick phrases** in a native floating card on the right, independently of the project summary's visibility. When the summary is visible, the card appears below it. Opening a file or preview in the right sidebar hides quick phrases; closing the sidebar restores them. Click the card heading to collapse or expand the list; **Configure** remains available while collapsed. Choose **Configure**, enter one phrase per line, and save; click a phrase to send it through the current native composer, including the first message of a new chat. The card and Configure dialog show the same current mode beside a switch icon; changing it in either place immediately updates both, including the short explanation below the mode. Click it to cycle through **Add to queue** (default), **Steer now**, and **Fill composer**. Queue and steer send immediately when the conversation is idle; during an active task they use the native queue or steer action. This choice and phrases are saved locally in the same Codex profile. Use the **Base phrases** and **Current repository: repository name** tabs in Configure to edit the shared base list or the current repository's complete replacement. The repository tab shows its actual name; while the catalog loads, it shows **Current repository** without an internal ID. Choose **Apply to all customized repositories…**, select one or more phrases or **Select all**, then confirm. This adds only those phrases to existing custom lists without duplicating identical entries; the editor’s cursor and text selection do not control the operation. Use **Other repositories…** to open multiple repositories in separate tabs and edit them without changing the current conversation. Selecting an open repository focuses its existing tab; the tab row scrolls horizontally as more repositories open. Use **Use base phrases** to remove the selected repository override. Type `@` or `$` in the configuration editor to filter available Skill commands as you type; matching names rank above description matches, with exact matches first. Insert one with the arrow keys plus Enter/Tab or a click. Backspace at a line’s start joins the previous line for continuous editing. Backspace or Delete also removes selected text across multiple lines, including Skill mentions or the entire list. Entries can include Skill links such as `[$shay-skills:commit](/path/SKILL.md)`, alone or followed by instructions. The card and configuration editor display the same native Skill labels and icons, preserving them through saving and reopening along with each full reference; clicking an entry sends it through the native composer. Existing drafts and attachments are not overwritten. See [quick phrases](docs/fork-capabilities.md#quick-phrases). When the summary has an animation container, quick phrases move with it; otherwise the card keeps its independent position.

Tasks can be implemented in a new conversation after explicit authorization: `panelctl conversation bind ISSUE_ID --replace-thread-id OLD_ID` replaces the freshly read binding and retains the old conversation in activity history, preserving the Spec, status, branch and worktree. See [conversation workflow](docs/fork-capabilities.md#configurable-ai-workflows).

On macOS, choose a target in the **Codex 更新** card and select **Download update**. Available targets have an official delta for the installed build, system, and architecture. Panel preselects the newest target marked **已验证源码适配** (source adapters verified) when available. Checks query the official release feed independently of the native update dialog and skipped versions; manual checks refresh the result. Downloading uses the feed snapshot from that check so rollout routing cannot change its target. A failed download shows **Check for updates**; a successful recheck restores **Download update**. Panel downloads the matching official delta through macOS system networking while Codex keeps running. You can pause, resume, or cancel. After a network interruption or timeout, retrying the same version during the current Panel run resumes the retained bytes; closing Panel clears that resume state. Once verified and applied in a staging directory, the install action appears. After downloading, use **Overview → Features & maintenance → 安装 Codex 更新并重启**. After confirmation, Panel quits Codex normally, installs the verified app and reconnects, avoiding a second manual restart. Busy or timed-out checks allow manual retry. See [Codex updates through Panel](docs/fork-capabilities.md#codex-updates-through-panel).

On macOS, **Overview → Features & maintenance → Codex 更新 → 禁止 Codex 自动更新** disables Codex’s built-in updater the next time Panel launches Codex. It defaults to off; Panel’s manual update controls remain available. An update already downloaded by the current Codex process may still install when that process quits. See [update controls](docs/fork-capabilities.md#codex-updates-through-panel).

Network failures during Codex update checks or downloads show a short retry message. Open **运行日志** (Runtime log) for full system diagnostics.

Connection notifications keep the last Codex update result visible; they do not reset it to “Reading update status” between checks.

Launcher inputs on macOS support native editing shortcuts: `⌘C` copy, `⌘V` paste, `⌘X` cut and `⌘A` select all.

Open **Preferences → Models & advanced → 配置上下文** to set a separate context token count for each model, with a fixed `tokens` unit label. Leave a field empty to use its default, then save and restart Codex. Panel corrects the native GPT-6.1 Sol catalog’s old 272000-token default to the official 500000, including after resetting all settings; external catalogs and explicit values are preserved. The **Subagent reasoning effort** selector edits that model’s `multi_agent_reasoning_effort`; options come from the provider catalog with missing values filled from the same official model, and **Default** shows that resolved value. Each model also has an independent automatic compaction threshold: click the input’s right-side `tokens` / `%` button to switch between a token count and a percentage of its context window (greater than 0%, up to 90%). Per-model fields show their own configuration separately from global values. Percentages are retained and recalculated when the model context size changes; leave it empty to use that model's default. Existing global context or compaction settings take precedence; Panel displays each field’s current source in fixed summary cards (global with its token count, or per-model) and allows saving per-model settings and leaves global configuration unchanged. The effective compaction threshold is the smaller of the configured token count and 90% of the context window, in either mode; percentages are converted to whole tokens, rounded down. Pending restart reminders survive reopening or reinstalling Panel. **Later** hides the notice for the current window. Confirming a restart in Panel clears it once startup begins; cancellation or startup failure keeps it pending. An external Codex restart also clears it when detected. Values must fit the model service's actual limits. See [per-model context windows](docs/fork-capabilities.md#per-model-context-windows).

The model context dialog has **Model settings / Subagents** tabs. In **Subagents**, choose the global default model and reasoning effort, or configure each personal role separately, including `reviewer`, `explorer` and `docs_researcher`. Select **Inherit default** to remove a role override. Role settings take precedence over explicit spawn choices and global defaults. Save and restart Codex to apply changes. See [model and subagent settings](docs/fork-capabilities.md#per-model-context-windows).

Open a conversation, then right-click another Codex conversation in the sidebar to choose **Open in new tab** or **Open side by side** in the same window. Existing chats reuse one view; sidebar clicks focus the matching input and highlight that conversation without changing the layout. Plain conversation notifications also return to the existing tab or split pane. **Restore as standalone page** removes the tab and returns to the full conversation page. The menu adapter also supports Codex 26.1106.51428, which removed the previous active-conversation helper, and 26.1111.71704, which moved sidebar conversation rows into a separate module. See [conversation tabs and split view](docs/fork-capabilities.md#conversation-tabs-and-split-view).

Codex builds using Rspack numeric modules are supported for the custom-provider send-limit switch, Ultrafast, Dot, conversation tabs and update status. Adapters retain existing settings. Compatibility, including Codex 26.1117.31558, follows syntax trees, exports and calls rather than generated filenames, module co-location, adjacent declarations or field order. Changes to native interfaces or behavior still require review. Conversation tabs also support Codex 26.1111.21308’s tab-ID focus convention and sidebar rows that keep the conversation ID in their input rather than forwarding it to the presentation component. The packaged Rust runtime gives each native adaptation feature its own persistent cache for the installed Codex package contents and its actual adapter dependencies. Copying the same package or changing its file attributes does not invalidate the cache. UI, quick-phrase and media changes reuse those results; changing one adapter rebuilds that feature, while shared dependency changes rebuild the affected features. Successful features remain cached if another fails, and only failed features retry. Main and pet-only windows share feature results while keeping separate combined plans. Panel connects first and prepares native adapters in the background. Connection readiness remains independent of pending or failed update checks. The launcher’s main status panel keeps the connection status above a full-width adaptation area with module details and the progress bar. Resource reading is labeled separately; long paths stay on one line with the full text available on hover. The bar shows the current stage’s measured progress from processed module counts, or activity when no count is available. A three-dimensional graph in the same status card shows live module states, including repository branch prefixes. Nodes and curved light flows use gray for waiting, blue for adapting, yellow for prepared but awaiting application, green for enabled, and red for failed, with a text legend. Up to ten module names remain visible, prioritizing selected or hovered, failed, and adapting modules; all nodes remain available through hover or selection. Drag to rotate or select a node for details; adding modules does not increase the graph height. Only an overall ready state gathers the light flows back to the core, briefly shows success, and collapses the adaptation area; partial or failed results do not show success. Independent adapters run concurrently in up to four workers sharing the native source catalog. Native services and update descriptors apply concurrently as they finish without blocking adaptation progress, while overlapping interface patches share at most one final reload; pet-window preparation then reuses the main window’s results without blocking its connection. Codex 26.1103.60933's send-blocking reasons are supported: the switch only excludes account quota reasons for local custom providers, preserving other send blockers. Native queued messages refresh when Codex settings or core queue capabilities finish loading after a Panel update, without switching chats or restarting Codex. Queued messages hidden by a stuck collapsed panel on Codex 26.1111.21308 also display correctly. Codex 26.1106.51428 is supported for custom-provider quota and Fast/Ultrafast controls, the renamed Additional settings worktree menu, GPT-6 Plus quota banners, and pausing legacy native automations. The separate worktree switch, native workspace and legacy automation services remain supported. See [Rspack compatibility](docs/fork-capabilities.md#rspack-based-codex-builds).

The injected entry follows the Codex language. Windows Panel opens bring the launched Codex window forward while preserving maximization. See [sidebar language and Windows activation](docs/fork-capabilities.md#sidebar-language-and-windows-window-activation).

Local task planning and new conversations navigate by the saved Codex project ID without depending on rendered or expanded sidebar rows. Panel confirms the target project and workspace before prefilling the draft. Newer Codex builds, including Rspack builds, read live project selection through the native project catalog, avoiding false switch timeouts and empty drafts after the legacy API was removed. A rejected legacy fetch request is cleaned up immediately; a removed HTTP fetch service disables only that fallback, so the native catalog can still become ready later.

On macOS, quitting cleans up managed processes once in the background so the interface can remain responsive. Panel selects an available sidebar when hidden or inactive copies coexist, keeping its existing entry position. Injection retries reuse prepared custom-provider module mappings before the composer loads. See [desktop manager](docs/fork-capabilities.md#taurirust-desktop-manager) and [sidebar navigation](docs/fork-capabilities.md#switch-between-panel-and-native-codex-destinations).

Opening Panel automatically reads the available account name and avatar without opening the native profile menu.
The Panel entry follows sidebar layout changes, showing only its icon in the navigation rail without widening it. The Panel rail entry keeps its native icon alignment and inactive color, with its selected color unchanged. Native destination clicks no longer restore a cached Panel entry. Native state updates on the same page keep Panel open from either the sidebar or the App. The connection indicator remains ready while other Codex windows are still mounting; opening Panel is not required to refresh it. Standalone Page document windows, including hidden prewarmed windows, are excluded from injection; Pages inside the main window remain supported. Mount retries and Panel service restarts preserve the current Codex page and draft when the patch code is unchanged. Installing or updating the patch still reloads once.
Use **Overview → Codex connection → 重启 Codex** (Restart Codex) to quit and relaunch Codex after confirmation, reloading core configuration such as the Ultrafast catalog. Running tasks will be interrupted. **Restart service** only restarts Panel and reconnects when Codex is already connected.
After Codex updates on macOS, Panel reconnects when a debugging port is available. If launch parameters were lost, the manager offers **重启 Codex 并连接** (Restart Codex and connect); restarting Codex requires confirmation. See [update recovery](docs/codex-compatibility.md#recovery-after-desktop-updates). On macOS, native confirmations and messages first restore the Panel manager window, including when it is hidden or minimized.

Open **Preferences → Models & advanced → 恢复 Dot 入口** (Restore Dot entry) to bypass Dot’s client-side account and provider restrictions. This independent switch defaults to off and takes effect while connected to Panel. Server authorization is unchanged and may still reject Dot operations. Changes apply immediately once the adapter is loaded; first installation or an adapter update uses the existing one-time interface reload. The capability path was checked against ChatGPT 26.1016.62342 source; real-account Dot availability has not been verified. See [custom-provider Dot entry](docs/fork-capabilities.md#custom-provider-dot-entry).

Open **Preferences → Models & advanced → 显示 Fast / Ultrafast 选项** to expose Ultrafast for `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.2-astra`, and `gpt-6.2-sol` on local OpenAI and custom providers. The switch defaults to off. The switch first reads your user Codex `config.toml`. Enabling prompts only when `[features].api_key_model_discovery` is absent or false; disabling prompts only when the field exists. Each prompt has two choices: update the configuration along with the switch, or only toggle. Otherwise the switch saves directly. Escape dismisses the prompt. Model discovery must be enabled to read the adapted catalog; removing the field restores default or other configuration-layer behavior. It updates the native speed menu and core model catalog; after saving, a reminder offers to restart Codex now or later. Custom providers keep the existing catalog proxy behavior. OpenAI uses a managed local catalog while preserving its existing authentication and original catalog setting. Restart Codex for full core configuration changes to take effect, and keep Panel running. Selection uses the native save/request path, including the outgoing `service_tier` field. Remote hosts retain their native rules. The option exposes the client setting; the service still decides whether to accept it. First installation or an adapter update requires one reload; switching off restores the original provider catalog configuration and native checks without deleting the saved speed preference. Provider support, latency and billing remain provider-controlled; unsupported client structures keep native behavior and log adapter unavailability. See [Fast / Ultrafast](docs/fork-capabilities.md#custom-provider-ultrafast).

The custom-provider send-limit switch retains its adapter when reconnecting to a window whose composer already loads through a module mapping.

Panel also supports sidebars without Plugins or pets, including Free accounts, by placing its entry after New chat when needed. Panel appears on its own row below the complete New chat row, preserving New chat and Quick chat.

Local build 0.4.4-fork adapts the sidebar entry to desktop 26.928.20755. DOM checks cover navigation rows outside the old scroll area and link/role-button entries. Actual signed-in desktop mounting still requires confirmation.

Compatibility target (2026-09-30): ChatGPT desktop **26.928.20755** and standalone Codex CLI **0.159.2**. The macOS launcher recognizes the new packaged CLI layout; project model choices include **6.1 Sol**, **6 Sol**, and **6 Luna**. See [verification scope](docs/codex-compatibility.md) before building or installing.

macOS releases provide a universal DMG for Apple Silicon and Intel, ad-hoc signed without Apple notarization. First launch may require allowing the app in System Settings → Privacy & Security.

**Create and start** also works without linked repositories: a read-only Codex check selects repositories and their individual scopes, then starts the existing execution queue. Ambiguities are answered inline before any execution; no Spec is required for this execution path. A single linked repository goes straight to execution, while multiple linked repositories retain their selection and receive separate scopes. The analysis itself does not create a planning conversation, but **Plan with AI** remains available afterward so you can create a formal planning conversation and save a Spec while keeping the existing execution work.

Jira AI planning can identify and associate one or several repositories from the requirement and repository documentation. Clear selections are saved with reasons; ambiguous choices are clarified, existing manual links are retained, and native Plan mode remains read-only until exited. No fixed Jira-project mapping is required. See [Jira repository association](docs/fork-capabilities.md#link-jira-requirements-to-repository-issues).

Jira conversation binding, planning initialization, and chat model selection use paginated model metadata, avoiding failures caused by exporting large model prompts. See [Jira planning and binding](docs/fork-capabilities.md#link-jira-requirements-to-repository-issues).


Continue planning recognizes the active native conversation even when the window URL remains unchanged. During manual execution, the detail action follows the board's conversation activity and opens the existing conversation. Tasks with an existing conversation hide the new-conversation shortcut.
Planning and manual execution recognize the visible Codex run-location label, so hidden responsive text no longer blocks composer prefill.
Local task drafts use the visible composer and retain conversation linking when sent immediately after prefill, without reporting a missing Skill after successful submission.
If navigation rebuilds the composer or an unsent draft is restored, Enter and Send recover the matching issue association and continue normal conversation naming and confirmation.

The project model picker includes **6 Astra** (`gpt-6-astra`), with reasoning levels through `max` and `ultra`.

Ordinary tasks also support **Plan with AI**, persistent inline Specs, and approved breakdowns into backlog sub-issues with dependencies. Planning can continue into authorized execution in the same conversation: the agent records **In progress** before implementation and **In review** after verification, without another Panel execution click. Jira planning can also continue in the same conversation when explicitly requested, after resolving and binding the published repository-owned execution Issue. Spec approval or ticket publication alone does not start implementation. See [task planning](docs/fork-capabilities.md#plan-ordinary-tasks-and-split-sub-issues).

New Jira planning conversations use `Jira ID · Jira 规划 · task title`; replanning uses `Jira ID · Jira 重新规划 · task title`. Panel confirms the saved native title after submission without requiring a rendered sidebar row.

After sharing a planning conversation, choose **Implement together in the same repository** in **Manage Jira links** to reuse an execution conversation, branch and worktree per repository. This does not start execution; each Jira retains its own authorization and task progress. Existing execution bindings are preserved.

Related Jira requirements can share planning across repositories through **Join existing planning conversation** or explicit `panelctl conversation bind JIRA_ID` (when no plan exists). Execution repositories remain independently linked.

Related Jira requirements can explicitly **Join existing planning conversation** from their detail view. Discussion is shared; Specs, publication and execution stay separate. Jira links never join conversations automatically.

Explicit Jira conversation binding initializes a missing planning record so the same conversation can save its Spec and publish tickets. Existing plans are preserved. See [Jira planning](docs/fork-capabilities.md#link-jira-requirements-to-repository-issues).

[简体中文](README.zh-CN.md) | [Fork capabilities](docs/fork-capabilities.md) | [Changelog (Chinese)](CHANGELOG.md)

A local-first issue board that runs in a browser and can be embedded in Codex through the standalone CDP launcher or its injection script. The same HTTP API powers the React UI and the `panelctl` CLI used by the bundled Codex Skill.

Panel participates in Codex’s native navigation history: Back returns to the page before Panel, Forward reopens Panel, and navigating from Panel to a native destination adds that destination to the same history. Route changes control visibility without matching button or command labels; utility actions that do not navigate leave Panel open.

If Panel fails to load, choose **Reload** to retry within the current page. If the launcher is disconnected, start or restart the service in Codex Panel first. See [Panel navigation and recovery](docs/fork-capabilities.md#switch-between-panel-and-native-codex-destinations).

Each project dashboard generates a daily Codex summary. If generation fails, Panel retries after 5, 15, and 60 minutes, then stops automatic attempts; the dashboard keeps a manual retry action available, and any successful generation resets the retry sequence.

Jira issue-link activity opens the corresponding Panel issue for both current links and historical unlink records, even when the target repository is not loaded in the Jira view.

The board includes dashboard, list, Gantt, and archived-issue workflows. The horizontal list follows the issue-board column and card hierarchy, while the vertical list remains compact; synced Jira issues show their external key when available. Issues can carry start and due dates and can be moved from their detail view while retaining their linked conversation. A local Jira connection can sync open issues assigned to the signed-in Jira user into a dedicated Jira project. Each Jira requirement can select one or more repository projects and link existing execution issues from those repositories; the searchable, scrollable repository picker includes every local Codex repository and registers an unlisted Panel project only when the selection is saved. An execution issue can belong to at most one Jira requirement, and Jira refreshes do not overwrite its local work. Repository changes in activity use project names rather than internal IDs. Click the Jira overview card to open link management and access its linked execution issues. The linked Jira card on an execution issue returns to the requirement inside Panel; its detail view retains the separate external Jira action and shows many repositories as the first repository plus `+N`, with the full list in its tooltip. A waiting Jira requirement with saved repository links can create one execution issue and one formal native Codex task per repository, move Jira to in progress, and release the issues to waiting only after every repository is ready; retrying a partial failure continues the same operation without duplicating work. Complex requirements can instead open a formal native Codex planning task that defaults to **Approve selected actions** (`workspace-write`). With no linked repository the task is projectless, with one it opens in that project, and with several Panel first asks which project to use. Panel fills the editable composer with the generated planning prompt and the globally selected planning Skills, or uses native Codex Plan when none are available; the user sends it manually. After approving a native plan, leave Plan mode before saving the Spec or publishing tickets. Formal planning and execution tasks open through Codex's native task route and stay out of the bottom-right embedded chat, which is reserved for temporary questions. User Skills installed as direct symbolic links under `~/.agents/skills` remain real selected Skill references instead of plain `$name` text. If the renderer reloads after sending but before Panel records the binding, the pending intent survives and the next planning click recovers the unique Codex conversation containing the exact Jira key instead of creating a duplicate. The resulting Spec is stored on the Jira requirement, and confirmed repository tickets publish as linked backlog issues with their dependencies. Planning remains available before a repository is selected, and a Codex startup failure after sending shows its actual diagnostic. Jira description lines whose numbered items begin with `#` render as an ordered list without changing ordinary Panel Issue Markdown. Jira or repository changes require review before another publication, pause unstarted issues from entering execution, and cancel only superseded work that has not started; started work remains visible as a planning constraint. Opening the Jira project refreshes it at most once per minute, and users can also sync manually. Panel applies a refresh only after every Jira search page succeeds, keeps cached issues visible when Jira is unavailable, and requires confirmation before switching to a different Jira account. The Jira header and settings show the last attempt, last success, open and unknown counts, and actionable failures. Changes to a synced Jira issue's title, description, priority, labels, due date, or status are written directly back to Jira. The connection supports Basic Auth with an account password or Jira Cloud email and API token, and Bearer Auth with a Jira Data Center or Server personal access token. Credentials are stored in the local Panel data directory, and Jira is unavailable in Cloud mode; use HTTPS unless the Jira server is on a trusted private network.

Jira status controls execution authorization separately from planning. Entering in progress releases only dependency-frontier backlog issues to waiting. If Jira returns to waiting or ends while linked work remains, Panel asks whether to pause it; pausing moves waiting issues back to backlog, blocks active issues, and attempts to interrupt their active Codex turns without deleting code, conversations, or worktrees. A failed interruption does not roll back the issue pause, and Panel reports how many turns still need attention. A later in-progress transition resumes eligible paused issues. Reopened Jira requirements keep their historical issues and conversations and can create new rework issues or start a new planning conversation. A failed planning start preserves the previous plan for retry, while concurrent Jira sync and relationship changes wait until the reopened action finishes. Duplicate Jira requirements record their canonical issue and require confirmation before moving existing links. Panel probes canonical issues that are not assigned to the current user and preserves existing links only when the current Jira account cannot read the canonical issue.

Jira settings can enable **Automatically complete Jira**, which is off by default. Panel acts only when at least one execution issue is linked and every linked issue is unarchived and done. It rereads Jira's status and update timestamp, requires exactly one available transition that maps to done, and rereads Jira again to confirm success. A remote change after the last sync is never overwritten silently: the Jira detail lets the user accept the remote state or complete it anyway. Failures keep local issues done and preserve a manual retry action.

Jira settings can also enable **Automatically archive conversations**, which is off by default. When enabled, Panel archives its managed planning and execution conversations after Jira and every linked execution issue are done. The Jira detail also provides **Archive conversations** for the same completed state even when automatic archiving is disabled. Existing runs, messages, and Codex thread IDs remain stored and readable; a turn already running stays visible until it finishes. Disabling automatic archiving does not restore archived conversations, and reopened Jira work creates new rework or planning conversations instead of continuing archived history.

Repository projects use a Panel-owned persistent execution queue instead of Codex Scheduled Tasks. Enable automatic claiming from the project automation menu to scan unlinked waiting issues every 5, 10, 15, 30, or 60 minutes and execute Jira-linked issues after their Jira requirement authorizes work. For manual work, **Prepare execution** opens an unsent Codex draft with **Manage Panel**. After reading the issue, the agent loads configured implementation and review stages only when applicable. Choose **Current directory** (the default) or **New worktree**; existing execution contexts are reused. The issue is linked and moves to in progress only after you send the draft. Automatic claiming still submits automatically; disabling automatic claiming stops new automatic entries without freezing existing work, while pausing the project holds every queued item. Issues labeled `ssh-import` or `no-auto-claim` are excluded from automatic scan/Jira enqueueing and dispatch, ignoring label case and surrounding whitespace. Adding either label holds an already queued automatic candidate; removing it restores eligibility. Manual work, resumes and retries of already started work keep their existing rules, and running work is not canceled. The global default permits three concurrent executions per project and can be set from 1 through 8; each project may follow it or choose its own 1-8 limit, with no cross-project total cap. New automatic execution selects the visible native **New local worktree** menu item, so the project's Codex environment setup runs; Panel then stores the actual thread, worktree, and branch returned by Codex instead of creating its own worktree. Jira-linked execution uses the Jira key in the native task title, prompt, and branch naming instruction rather than the Panel issue identifier. Applicable implementation and code-review stages use the global selections, defaulting to Codex execution and the official Codex CLI reviewer, and retries transient startup or connection failures twice. Execution that needs input shows **Waiting for your reply** and resumes only after a comment or completed user turn; other execution failures show **Prepare again** for an explicit retry. Automatic scans ignore blocked work, Jira-paused work stays disabled, and service restarts resume only when the original conversation and development context still match. Manual and resumed work run first; Jira-authorized and scanned work are then ordered by issue priority. The automation menu shows waiting, running/capacity, blocked, and failed totals. Worktrees remain through review and are removed after completion only when clean and merged.

New projects include `no-auto-claim` in their available labels. Apply it to the issues you want to exclude from automatic claiming; it is not applied to issues automatically. Existing projects can create it in the label picker.

Jira tickets in the same repository reuse one native execution conversation, branch, and worktree in sequence. Each ticket keeps its own status and activity. Same-repository dependencies can continue after review; cross-repository dependencies still wait for completion. A confirmed execution takeover clears stale queue errors. Existing separate conversations are not moved or merged automatically.

Native conversation activity uses the same live session progress as the board. Unavailable session data shows **Status unknown**, rather than idle.

Board filters support name and priority sorting, and display settings can show creation dates. When synchronized Jira issues are present, the Jira projects filter accepts multiple project keys (such as JR and JD), with All projects to reset it. Ordinary task details can create child issues; dashboard progress weights top-level issues equally and includes their completed children. Tasks and comments can record external Agent sessions and copy terminal resume commands. See [task organization and external sessions](docs/fork-capabilities.md#task-organization-and-external-sessions).

Use **Relations → Add blocker / Add blocked issue** to select issues across repository projects. These are native dependencies visible from both issues and honored by execution; parent and related-issue links remain within one project. The same contract applies to `panelctl issue relation add` with `--type blocks|blocked_by`. See [cross-repository blocking](docs/fork-capabilities.md#cross-repository-blocking).

Open **Preferences → Chat → Configure conversation usage** to manage visibility, position, number style and animation speed in one dialog. **Show conversation usage** controls the entire row and defaults to on. Changes apply without restarting; disabling also stops usage reads. **Conversation usage position** selects **Above composer** or **Composer toolbar** (default), and the saved position applies immediately. Toolbar statistics sit between permissions and model controls, using a compact layout in narrow windows; older composer layouts without that slot keep the row below. **Use dot-matrix numbers** defaults to on; turn it off for ordinary numbers without changing the statistics. **Animation effect** defaults to **Continuous tracking**, preserving the existing rolling effect. Dot-matrix numbers offer **Continuous tracking** and **Dot morph**; morphing rearranges dots over 500ms, including loading dots becoming the first number. Ordinary numbers always use a 120ms fade-out plus 180ms fade-in. Their animation selector and speed controls are hidden; switching back to dots restores the saved dot animation. Speed controls apply only to dot-matrix continuous tracking. In that mode, TPS and cache hit rate each continuously follow one latest target: new readings redirect the current motion without resetting the displayed value. Motion is faster farther from the target and slower near it; same-direction target changes retain velocity, while reversals start from zero and accelerate toward the new target without drifting away. **Number animation speed** saves a shared minimum and maximum in scale units per second (defaults: 5 and 40); changes apply immediately. Both animations stop when the latest value is reached; active TPS receives a new target only when response text arrives. Starting, stopping and reversing may pass below the minimum during the transition. Dot-matrix continuous tracking uses these speed limits; reduced-motion settings display the target immediately. Local Codex composers display response-text receive rate (tok/s) and cache hit rate from native usage, with speedometer and database icons. The speedometer needle moves with the TPS digits on a 0–100 tok/s scale; higher rates keep only the needle at the right end while the number still shows the actual rate; missing data resets the needle to zero. Before any response text arrives, the rate shows `-- tok/s`; the first fragment immediately produces a reading; cache usage awaiting data shows three bouncing dots. The first available reading appears immediately. Numbers retain their compact 12px size. Labels and units use ordinary 12px text; icons retain their outline style. Both animations respect reduced-motion settings; a turn without any observed response text keeps `--` after it ends. TPS is the estimated response tokens received within the current message’s last three seconds divided by a fixed three seconds, with one decimal place. Only `item/agentMessage/delta` participates; reasoning text, reasoning summaries, plans and tool content are excluded. Newer Codex clients provide these fragments through the native notification subscription; older clients retain the broadcast path, with duplicate counting prevented. No second arrival or minimum interval is required, so short replies and fragments delivered together still produce a reading without dividing by a millisecond callback gap. New response text updates the measured rate; the last valid rate stays visible between arrivals, including pauses longer than three seconds. On each new fragment, only fragments received within the same message’s last three seconds enter the count. A new response message starts a fresh window; its first fragment updates the rate, while the previous reading remains visible until then. A new turn resets the rate. Completion keeps the last receive-rate sample, or shows `--` if no response text was observed. Previously completed chats without observed response samples also show `--`. ASCII text uses roughly four characters per token and other characters one per token. This measures received text, not the model’s exact generation speed: client-side batching cannot reveal the original generation timing, and short-reply readings cannot estimate backend throughput. Native usage updates the turn totals and cache hit rate without entering the speed calculation. Dot morph and ordinary digits update on fresh readings; log reads remain once per second. Estimates use the same numeric display (no approximation symbol), with their status in the tooltip. Cache hit rate uses actual input-weighted usage. Unavailable values show `--`; requests and caching are unchanged. Native session logs with an additional UUID after the conversation ID are supported. Remote sessions are not supported.

A failed or empty usage read keeps the current turn’s statistics and live updates. Timed-out Panel connections are released so the existing reconnect loop can recover.

## Requirements

- For source builds: Rust 1.88 or newer and Node.js 22.22.3 or newer in the 22.x line, or 24.8 or newer. Packaged apps run on the native Rust runtime and do not require Node.js.

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
  --issue-key MY \
  --workspace-path /absolute/path/to/repository

npm run panelctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

Each project has one globally unique Project Key containing 1-32 characters: letters, numbers, and single internal hyphens or dots (for example, `TP-A-B`, `TP.ADMIN`, or `TP-A.B` produces `TP-A.B-1`). Leading, trailing, and adjacent separators are not allowed. New Issues use it as their stable `KEY-N` prefix. The create-project UI requires the Key; CLI and automatic repository registration may omit `--issue-key` to allocate the next available Key. **Project Settings**, immediately after **Project Docs**, can migrate a local project's Key and historical local Issue identifiers atomically while keeping task and conversation links intact. Read-only CLI lookups accept either the Panel Issue ID or its linked Jira key.

`npm run panelctl -- ...` works without installing a user command. Run `npm run codex:install` to install a managed `panelctl` launcher at `~/.local/bin/panelctl`; this also installs the Codex Skills, standalone runtime, and generated app described below. Set `CODEX_PANEL_URL` to point the CLI at another local or LAN service. Cloud deployments are configured through the loopback companion with `panelctl cloud login`.

In a Jira planning conversation, an explicitly requested repository link can be saved with `panelctl jira repositories set JIRA_ID --projects PROJECT_ID,... --if-version N`; read `context.jira.version` with `jira planning get` immediately before the write. Repository links are never inferred from the current conversation or directory.

## Configure AI workflows

If the local Codex CLI is missing, the AI catalog returns an unavailable state with empty model, Skill and command lists. When models load successfully, an unavailable optional Skill or command catalog leaves only that list empty; model discovery remains required. Creating and running conversations still requires a working CLI. See [local AI catalog availability](docs/fork-capabilities.md#local-ai-catalog-availability).

For linked Feishu/Lark Docx or Wiki content, Manage Panel directs the agent to `lark-doc` and `lark-cli docs +fetch --as user`. Existing access is reused; missing authorization or scopes are explained before asking whether you can authorize the required access. Browser fallback requires your explicit choice.

Task entry attaches only **Manage Panel**. It reads the issue first, then fetches applicable stages with `panelctl workflow get <stage> --project PROJECT_ID --json`. Pure research checks sources and conclusions without loading implementation or code-review Skills, even when saving a report. Authorized code changes use the configured execution and review stages; an explicit code-review request can use review directly. `in_review` also means a research report awaits your confirmation.

Each stage has a complete editable workflow template alongside its Skill selection. Customize the steps and output format, or restore the default. `{{skill_instructions}}` inserts the selected Skill order or the stage's default method. Custom templates replace the default steps; task context and fixed Panel rules are attached separately and explained in the editor.

In the Codex Panel App, open **Preferences → Workflow → Configure workflows** while the Panel service is running. The editor opens in the pane to the right of the sidebar. Save or use **Back to preferences** to return to the **Workflow** tab. Planning, execution, code review, and task handoff each accept an ordered selection of installed Skills, shared by all local projects. Leave a stage empty to use native Codex Plan, default Codex execution, the official Codex CLI reviewer, or Panel's built-in handoff. If any selected Skill is unavailable in the target project, the entire stage uses its default and reports the missing selection. The current configuration is read when an applicable stage begins, including later stages in an existing conversation; already completed stages are not rerun. To retain the previous planning flow, select `grill-with-docs`, `to-spec`, and `to-tickets` in that order; `implement` is an optional execution choice. Nothing is selected automatically from your installed Skills. See [workflow defaults and limits](docs/fork-capabilities.md#configurable-ai-workflows).

## Install the Codex Skills

Install dependencies first, then explicitly install the Codex integration:

```bash
npm ci
npm run codex:install
```

Each local package build receives an increasing build number. `codex:install` prints `Codex Panel local Build N` before preparing resources and shows build output as it runs. Open **About** to see `版本 0.5.17-fork · Build N`; macOS also records it as `CFBundleVersion`. Builds from worktrees of the same repository share the counter. A failed packaging attempt can consume a number. See [local build numbers](docs/fork-capabilities.md#local-build-numbers).

The integration command builds and copies a standalone runtime to `~/Library/Application Support/Codex Panel/runtime`, copies `manage-panel` and `handoff-panel` into the standard user Skill directory at `~/.agents/skills`, installs `panelctl` in `~/.local/bin`, and generates the macOS launcher. The launcher receives its own signed copy of that runtime inside the app bundle. The installed files are real managed copies, not symbolic links back to the Git repository. Plain `npm ci` only installs project dependencies and does not write these user-level integrations. Start a new Codex task after installation to use `$manage-panel` and `$handoff-panel`.

On the first install, if the fixed data directory does not exist, the installer snapshots the existing repository `.data/panel.sqlite` and copies its attachments and local configuration without deleting the source. It also removes old repository-managed `~/.codex/skills` and Node-bin links. Re-running the command atomically refreshes only files carrying the Codex Panel ownership marker; user-managed files and directories are never overwritten. Moving or deleting the repository does not break the already installed runtime. Run the command again after pulling code updates to install a new version.

Existing browser settings and drafts are migrated from `taskboard.*` keys to `panel.*`. Legacy `CODEX_TASKBOARD_*` environment variables remain fallback aliases, but new configuration should use `CODEX_PANEL_*`.

`$manage-panel` teaches Codex to inspect an issue, move it to `in_progress`, use optimistic versions, verify the work, and then move it to `in_review`; it moves the issue to `done` only after the user explicitly confirms acceptance or asks to mark it complete.

`$handoff-panel --issue PROJECT-123 preserve the acceptance decisions` works from any Codex conversation. It resolves the target Issue and global handoff selection, then creates a redacted temporary document using the selected Skills or Panel's built-in summary. It attaches that document verbatim as an `AI 对话交接` Codex Agent comment; publication failure keeps the document available. No personal `handoff` Skill is required or modified.

## Embed in Codex

Workflow Skill search accepts a leading `$`, such as `$shay-skills:review`.
The workflow picker shows one entry per real Skill file, preferring namespaced IDs and retaining existing selections.

Click **Panel** in the Codex sidebar to show the task panel. Click it again to return to the previous Codex page while the Panel app and background service keep running. See [Panel navigation](docs/fork-capabilities.md#switch-between-panel-and-native-codex-destinations).

With banner hiding enabled, switching conversations hides new usage banners without waiting for the delayed page refresh.

### Recommended: use the Codex Panel desktop app

The launcher separates **Runtime overview** from **Preferences**. In **Preferences → Chat**, **Hide exhausted-usage banner** is off by default. Enable it to hide the Codex and Work exhausted-usage banner while connected; disable it to restore the banner. The choice survives restarts and does not change account limits. See [banner visibility](docs/fork-capabilities.md#exhausted-usage-banner-visibility).

For ChatGPT desktop (verified source layouts: 26.917.51856 and 26.917.71314), enable **移除账号额度不足时 API 发送限制** in **Preferences → Models & advanced**. The adapter reloads the Codex interface once when first installed. Later switch changes apply immediately without restarting the Panel service or refreshing Codex, preserving the current draft. Launcher preference switches, including this setting and pet sounds, change only through the switch itself or keyboard activation; clicking titles, descriptions or surrounding rows does not toggle them. This independent switch defaults to off; disabling it immediately restores the original quota checks. Panel adapts the local Codex composer so an exhausted ChatGPT account does not disable sending through a custom model provider. Panel discovers the current composer module and matches its quota/provider code structure, so asset hashes and minified variable renames do not require a version entry. Unrecognized structures retain native behavior. The existing login and provider credentials are preserved. See [custom-provider sending](docs/fork-capabilities.md#custom-provider-send-availability) for compatibility and verification limits.

`npm run codex:install` creates or refreshes `~/Applications/Codex Panel.app`, removes the previous managed `~/Applications/Codex.app` bootstrap, and migrates installations of the former Swift launcher. The desktop app is built with Tauri/Rust and uses the fixed data directory at `~/Library/Application Support/Codex Panel/data`, so moving or deleting the source repository does not break it. Open it from Finder or the explicit path:

```bash
open "$HOME/Applications/Codex Panel.app"
```

The app runs from the macOS menu bar. Its menu shows the current runtime state and can open the embedded or browser Panel, uses one state-aware start/stop item plus a separate restart action, opens the log, and reveals the data directory. Browser and restart actions are disabled until the service is running. It also provides independent toggles for launch at login, connecting Codex when the app starts, and opening Panel after connection; the last two default to on. “Running normally” is reported only after the current injection is mounted in a renderer and publishes a fresh heartbeat. If the managed integration exits unexpectedly, the app retries after 2, 5, and 15 seconds, then stops automatic recovery after a fourth failure inside 60 seconds.

The management window uses React and Radix Themes in Tauri's WebView. Runtime overview and grouped preferences share the same neutral controls and light/dark theme as the embedded workflow editor; service, process, and file operations retain the existing Rust commands. A fixed left sidebar separates Runtime overview, Preferences, and About; Runtime overview places Open Panel with the status summary and service actions. Version information, update checks, installation, and release notes live in About; logs and runtime diagnostics remain in Runtime overview. The main area separates Service & connection from Features & maintenance, with three equal-height connection cards and two compact horizontal maintenance cards. Card actions use icons with hover labels; conversation-menu diagnostics expand on demand, and the update card switches between checking and installation. Preferences opens on **General**, which contains launch at login, Codex connection, auto-opening the task panel, and system appearance. Use the tabs below the page title to switch to **Chat**, **Models & advanced**, or **Workflow**. Codex connection and actual embedded-Panel visibility are reported separately; queued opens wait for renderer readiness instead of being reported as failures, and native Codex actions wait briefly for the first host-bridge heartbeat when Panel has just appeared. Action buttons keep loading visible for at least 300 ms, then briefly retain a visible success or failure state; service start, stop, and restart keep the window responsive while process lifecycle work completes; and the browser entry validates and preserves the launcher's private loopback URL. Launch preferences, update and Release actions, log and data controls, and expandable runtime details follow below. Its header and the macOS app/Dock icon use matching light and dark Codex icons with the `PANEL` ribbon and follow the system appearance.

The conversation-menu card in Runtime overview shows loading status and offers a manual retry after failure without restarting Codex.

After a release is published, the workflow automatically commits the seven version files and the Chinese [changelog](CHANGELOG.md) to main. Released entries move under their version headings using the tag snapshot; later changes stay in `未发布` (Unreleased). Pull main before building or reinstalling locally to use that version.

Fork versions are independent of upstream, starting at `0.0.1-fork` with tag `v0.0.1-fork`. Upstream merges do not change the Fork version. Existing local `0.1.0` development builds require a one-time manual installation to switch to this version line.

On each Panel startup, the app checks the Fork's GitHub Releases unless a cached result is still valid; successful results are cached for 24 hours, temporary failures for 5 minutes, and API rate limits until GitHub's reset time. This cache is checked again on the next startup. Manual checks can bypass successful results; every update entry respects an active rate-limit cache. Checks use the GitHub account signed into Panel first, then a locally authenticated `gh` CLI when Panel has no account, and otherwise the anonymous GitHub API. A rejected Panel token asks you to sign in again rather than silently retrying anonymously. Rate limits, network failures, no releases, current versions, and available updates are reported separately. Only normalized `vX.Y.Z-fork` tags are update candidates; **About → Version updates → 自动下载** (Automatic download) is on by default. Turn it off to check versions without downloading; use **下载更新** (Download update) to download the selected release manually. The saved preference applies to startup, menu and About checks. Downloads are signature-verified, and installation still requires confirmation. On macOS, the confirmation uses a native foreground dialog; other platforms retain the Tauri dialog. Official Fork builds include the public verification key; a custom build may override it with `CODEX_PANEL_UPDATER_PUBLIC_KEY`. See [update packaging](docs/fork-capabilities.md#signed-in-app-updates).

In **About → Version updates → GitHub 账号**, choose **登录 GitHub**, copy the displayed code, and confirm it on the official GitHub authorization page. After authorization, Panel shows your `@username`; **退出登录** removes its stored credentials. Login is optional and only enables authenticated public-release checks. Tokens stay in the system credential store; Linux requires `secret-tool` and an unlocked Secret Service. Signing in or out clears the previous update-check cache without starting a check or download. See [GitHub update login](docs/fork-capabilities.md#github-login-for-update-checks).

Opening About reads only locally saved account metadata. Existing logins without a saved username show **已保存 GitHub 登录** until an update check reads the credentials. Accessing credentials for update checks or sign-in/out can still require system authorization after installing a different ad-hoc build.

When an update is available, **About → Version updates** displays its release notes with Markdown headings, lists, inline formatting, and scrolling for long content. A release without notes shows “该版本暂无版本说明。” (No release notes provided). **View release notes** still opens the GitHub release. After download and signature verification, the installation confirmation shows only the target version, confirmation message, and **Later / Install and restart** buttons; it does not repeat the release notes.

The app bundle contains the native Rust Panel runtime, `panelctl`, both Panel Skills, and the built web UI. Node.js and host-side JavaScript dependencies are not bundled; JavaScript continues to run in the web UI and the injected Codex renderer. The macOS installer prefers `CODEX_PANEL_CODESIGN_IDENTITY` (including `-` for ad-hoc signing), then `APPLE_SIGNING_IDENTITY`, then a reusable matching local certificate; otherwise it uses ad-hoc signing. Windows releases are built by GitHub Actions. Authenticode signing is optional: configure `CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT` and the certificate secrets to sign the installer, or leave them unset to build an unsigned installer. Tauri updater packages remain signed in both modes. macOS and Windows build in parallel; publication waits for both outcomes and includes only successful platforms.

Before connecting, the app verifies its own signed bundle and packaged runtime, verifies the official `ChatGPT.app` and bundled Codex executable against OpenAI's identifiers and Team ID, rejects symlinks, and removes Node, shell, and dynamic-loader injection variables from the child environment. Windows verifies the embedded SHA-256 manifest covering the native runtime and every packaged Panel resource before execution. Builds configured with an Authenticode certificate additionally verify the launcher's signer. It binds the Panel service to loopback with a launcher-owned listener and private instance token. If the running Codex already exposes a valid CDP endpoint, including one left by the former Swift launcher, the new injector attaches to that real port; otherwise it starts the official app through macOS LaunchServices with a private random CDP port. A Codex process started without CDP still has to be quit before it can be relaunched with CDP. Runtime status, open, and shutdown requests use a startup-token-protected user-only Unix socket on macOS and the owned child control pipe on Windows. On Windows, Panel lifecycle actions interrupt native Codex turns through a startup-token-authenticated named pipe. Stopping or quitting waits for the injector and Panel service owned by Tauri, while the official ChatGPT/Codex app continues running. The app never modifies `ChatGPT.app` or `app.asar`.

The launcher-owned Panel listener prefers `127.0.0.1:47823` and falls back to a private random port when that port is unavailable. The Codex CDP endpoint remains separate and random.

Re-run `npm run codex:install` after updating the repository. A normal OpenAI-signed `ChatGPT.app` update does not require reinstalling Panel. `npm run launcher:install` remains available as a compatibility alias. The latest manager log is written to `~/Library/Logs/Codex Panel.log`.

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

Windows NSIS installers can be built and used without an Authenticode certificate. Windows may show an unknown-publisher warning or block unsigned applications under its security policies. Configure the certificate and `CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT` to enable signing; incomplete or invalid signing configuration fails rather than silently switching modes. `npm run app:build:windows:unsigned` explicitly builds without Authenticode. Tauri updater signatures and packaged-runtime integrity checks remain required. See the [Privacy policy](PRIVACY.md) and [Windows uninstall instructions](docs/windows-uninstall.md).

For a local macOS build, `CODEX_PANEL_CODESIGN_IDENTITY` takes precedence over `APPLE_SIGNING_IDENTITY`; both preparation and `app:sign` default to `-` (ad-hoc) when unset. Use the same identity for the build and `npm run app:sign -- /absolute/path/to/Codex\ Panel.app`. The runtime is signed before its integrity manifest is generated; the final step signs the launcher and App. The build command alone does not complete App signing. The separate release signing policy remains unchanged.

### Windows App: tray launcher and bundled Panel

Install the official Codex App from the Microsoft Store. To build the current-user NSIS installer on Windows x64, run:

```powershell
npm ci
npm run app:build:windows
```

The installer is written to `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`. It installs a tray launcher, native Rust runtime, local service, built web UI, `manage-panel` Skill, `panelctl.cmd`, and injection script. Panel data is stored in `%LOCALAPPDATA%\Codex Panel\data`; logs are stored in `%LOCALAPPDATA%\Codex Panel\Logs`; the Skill is copied to `%USERPROFILE%\.agents\skills\manage-panel`.

When `panelctl` runs inside WSL, it automatically finds the Windows launcher descriptor under `%LOCALAPPDATA%\Codex Panel\data` and sends requests through Windows `curl.exe`, so it can use the running Windows desktop app. Set `CODEX_PANEL_WSL_RUNTIME_FILE` to a WSL path only when the descriptor must be overridden explicitly.

Windows supports verified in-app updates. Authenticode is optional; Tauri updater signatures and packaged-runtime integrity checks remain required. See [Windows uninstall](docs/windows-uninstall.md) for retained-data behavior.

Codex 26.715.52143 ships a renderer CSP that blocks arbitrary HTTP iframes. The launcher therefore enables CDP CSP bypass, reloads that renderer once, installs the document-start script, and waits until the Panel OOPIF is actually loaded. CDP is unauthenticated to other processes on the same machine, so only run trusted local code while the launcher is active.

To inject into a Codex instance that was already launched with CDP by another method, run:

```bash
npm run codex:inject -- --port 9229 --open
```

This command also stays resident so the injected tab can restart Panel after a service exit. Stop it with `Ctrl-C`.

The script adds an independent Panel entry before Explore in Codex’s navigation rail, with the existing sidebar entry retained for older layouts. Panel fills the workspace beside the rail and below the native titlebar, preserving window dragging and native navigation. The previous page’s contextual actions and selection are hidden while Panel is active and restored when you return. Compact account menus provide the user name and avatar for issue activity. Notifications share a stack: hover or keyboard focus expands it and pauses dismissal; swipe to dismiss or use the available Undo action.

The Panel entry can be opened directly from a conversation as well as from native pages such as Plugins and Sites. It restores the last selected project, including **All projects**, unless the Panel URL contains an explicit `project` query parameter. Panel participates in Codex’s native navigation history: Back returns to the page before Panel, Forward reopens Panel, and navigating from Panel to a native destination adds that destination to the same history. Route changes control visibility without matching button or command labels; utility actions that do not navigate leave Panel open.

For local tasks, **Open in new conversation** also works with an existing binding. It opens a new unsent draft with task and handoff context; the first manual send updates the binding. See [conversation workflow](docs/fork-capabilities.md#configurable-ai-workflows).

“Open in conversation” selects the corresponding native Codex project and opens an unsent composer in both local and SSH projects. Local drafts use `$manage-panel`, include the issue identifier, title, latest “AI conversation handoff,” and `panelctl` read location, and refresh the issue before acting. SSH drafts include the current issue description, comments, and development context because the remote worker cannot call the local `panelctl`. Both drafts follow the Panel interface language, omit internal routing markers, and remain unsent; only the first real send creates the Codex task and writes the new local or SSH thread binding back to the issue, with SSH issues moving to in progress at that point. Recorded IDs are clickable through Codex's native route bridge. Each issue can bind either one Git branch or one worktree; the options are scanned from the selected Codex project's repository instead of being typed by hand. The integration uses Codex's existing project, composer, and route markers; navigation locates the existing MemoryRouter through React ancestor props and observes its push, replace, and go methods. It does not replace `fetch`, load private chunks, or edit Codex data files.

Local embedded AI conversations can also be linked to an issue from the link menu in the chat header. When opened, the menu loads active issues directly from the conversation's original project, even if another project is currently visible, and can switch or remove the link while Codex is idle. Linked conversations appear in the issue activity stream and open the exact local chat when selected. On desktop, drag the chat header to move the window, resize it from the top or left edges, or maximize and restore it; Panel remembers the normal position, size, and maximized state the next time it opens. Mobile keeps the chat full-screen without replacing the saved desktop layout. Markdown images that reference local PNG, JPEG, GIF, or WebP files render through Panel's loopback-only image endpoint; paths containing spaces must use URI encoding or angle brackets. Send `/handoff` or `/交接` to have the same Codex thread summarize the discussion; optional text after the command tells it what to emphasize. Add `--issue ISSUE-ID` to record the handoff on a specific active issue instead of the linked issue, for example `/交接 --issue PROJECT-123 preserve the acceptance decisions`.

Use `$handoff-panel --issue ISSUE-ID [handoff focus]` to attach a handoff from a native or embedded Codex conversation. It uses the global handoff selection or built-in summary, preserves the redacted temporary document verbatim, and reports publication failure without removing that document. Personal Skills remain unchanged. Successful handoffs are recorded in the activity stream for the next Codex task. Issue status, priority, assignee, workflow, development context, and recurrence use themed menus that follow the Panel's light or dark appearance instead of browser-native dropdowns.

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
| `CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT` | none | Optional Authenticode certificate thumbprint; unset builds an unsigned Windows installer |
| `CODEX_PANEL_TRUSTED_ORIGINS` | unset | Comma-separated exact HTTPS origins allowed through a loopback reverse tunnel |

`npm start` prints both the local URL and the available LAN URLs. Teammates on the same trusted network can open one of those LAN URLs and use the same panel service. Task, comment, and attachment changes are broadcast to every open client through server-sent events; reconnecting clients perform a full refresh so changes made while disconnected are not missed. A teammate using `panelctl` can point it at the shared service with `CODEX_PANEL_URL=http://<host-ip>:47823`.

LAN mode has no account authentication: anyone on the trusted local network who can reach the URL can read and write the panel. Public internet and cloud deployment require an authenticated deployment boundary.

For a reverse tunnel that connects to the local listener, set `CODEX_PANEL_TRUSTED_ORIGINS` to the tunnel's public HTTPS origin, for example `https://board.example.test`. Multiple origins are comma-separated. The variable cannot be empty, and duplicate origins (including normalized forms such as a trailing slash or default HTTPS port) are rejected at startup. Entries must otherwise be exact HTTPS origins; paths, queries, fragments, credentials, and wildcards are rejected. A reverse proxy or tunnel must preserve a loopback socket connection and either preserve the exact configured public `Host` or rewrite it to a local/private host. It must preserve any `Origin` supplied by the browser and add the configured public HTTPS origin only when the header is absent, including for `GET` and `HEAD`; forwarded headers are not used for this decision. Requests using a configured public Host or Origin can use ordinary Panel HTTP and realtime endpoints, but device-local capability routes remain unavailable even though the tunnel socket is loopback. Requests from direct local or private-LAN origins keep their existing behavior. The legacy `CODEX_TASKBOARD_TRUSTED_ORIGINS` name remains a fallback.

## Share through Cloudflare

For two trusted collaborators, the panel can run on Cloudflare with Worker Static Assets and API routes, D1 as the authoritative business database, and a private R2 bucket for attachments. The deployment uses HTTPS Basic Authentication with a shared password and refreshes open boards after a global revision changes.

No usable remote resource ID or custom domain is preconfigured. The committed Wrangler file is a local/dry-run template; provision your own Cloudflare resources and replace its all-zero D1 ID before any remote migration or deployment.

Each device keeps its own project checkout mapping and continues to use a local companion for Codex, Git/worktree, Skill, and MCP capabilities. Cloud mode never falls back to or double-writes the local SQLite database.

See [Cloud collaboration](docs/cloud-collaboration.md) for owner deployment, existing GitHub installation setup, password rotation, local path mapping, and the one-time local-data migration flow.

## Issue Markdown

Issue descriptions and comments support GFM, including tables and task lists. Task-list labels keep inline code in the normal text flow beside the checkbox. Fenced `mermaid` blocks render as read-only diagrams after loading; their source remains visible if rendering fails. Markdown HTML comments are hidden, and raw HTML is disabled.

## Verify

Local Rust debug builds retain file/line information without full debug data and disable incremental compilation to limit disk use; tests inherit these settings. Release builds are unchanged. To remove old debug artifacts while retaining release/install caches:

```bash
cargo clean --manifest-path src-tauri/Cargo.toml --profile dev
cargo clean --manifest-path src-tauri/Cargo.toml --profile dev --target-dir src-tauri/target/aarch64-apple-darwin
```

The second command clears the explicit Apple Silicon target when present. Debug artifacts regenerate on demand; the next debug build takes longer. Installed apps and Panel data are unaffected.

```bash
npm run check
```

This runs TypeScript checking, a production frontend build, the component tests, and the server/CLI/injection test suite.

Run the browser E2E suite separately:

```bash
npx --yes playwright@1.64.0 install chromium
npm run build:web
E2E_TELEMETRY_DISABLED=1 npm run test:e2e
```

The suite starts a local Panel on a random loopback port with disposable data, workspace, and skill directories. Codex execution and Jira/cloud requests are disabled. CI runs it for code PRs and manual checks, and retains failure artifacts for 14 days.

## Task Markdown

Task descriptions and comments support GFM, including tables and task lists. Fenced `mermaid` blocks are rendered as read-only diagrams after the viewer loads; the diagram source remains available when rendering fails. Markdown HTML comments, such as `<!-- trace-analysis:v1 ... -->`, are hidden from the rendered document. Raw HTML is not enabled.

## Acknowledgements

Thanks to [Lingshan21](https://github.com/Lingshan21) for:

- The parent-based project completion proposal and initial implementation in [#371](https://github.com/chuspeeism/dashi-taskboard/pull/371), which weighted top-level parent issues equally regardless of how many children each had.
- The priority organization proposal and initial implementation in [#372](https://github.com/chuspeeism/dashi-taskboard/pull/372). The final board sorting controls were adapted to the maintainer's requirements instead of adopting the proposed priority swimlanes.

The management window restores its last normal size after restarting; fullscreen and maximized sizes do not replace it.
