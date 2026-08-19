# Fork 维护说明

本文档是 `shay-wong/codex-panel` 面向维护者和 AI 编码代理的活跃差异台账，只记录相对于 `chuspeeism/dashi-taskboard` 有意保留的行为差异。

## 维护约定

- 新增、修改或移除 Fork 行为时，必须在同一提交中同步对应条目。
- 对外可见的能力在满足仓库的用户确认和测试授权规则后，必须在同一提交中同步功能代码、已授权的针对性测试、中英文 README 入口、英文详细用户文档及索引、`FORK.md` 和 `CHANGELOG.md`。测试未获授权或无法执行时，应如实记录，不得擅自补充。
- 仅面向维护者、构建、合并或内部兼容性的差异只记录在本文档中，除非仓库规则要求其他内部文档。
- 当上游行为和回归覆盖已经等价时，移除对应条目。
- 解决合并冲突时以行为不变量为准，不以整文件归属或同名字段为准。
- 每项能力使用以下生命周期之一：`长期保留` 表示 Fork 特有的产品或策略契约；`等待上游吸收` 表示上游具备等价行为和测试后即可移除的通用修复。
- 每项能力必须记录生命周期、原始目的、行为不变量、代码和测试路径、中英文 README 入口及英文详细用户文档路径，或仅维护者可见的分类、来源提交、合并指引、移除条件和针对性验证方式。

### 文档职责

根级用户入口同时维护英文 `README.md` 和简体中文 `README.zh-CN.md`，两者必须保持功能、命令、默认值和风险说明一致。详细用户指南暂时仅维护英文，位于 `docs/`；中文 README 可以链接到对应英文指南，因此简体中文当前属于详细文档的链接型语言入口。英文 Fork 能力索引位于 `docs/fork-capabilities.md`，并由中英文 README 共同链接。本文档使用中文，负责 Fork 维护和上游合并；`CHANGELOG.md` 使用英文，记录当前对用户可见的 Fork 变更。

当前没有其他完整维护或链接型语言入口。

## 精确上游基线

- Fork 分支：`main`
- 权威上游：`chuspeeism/dashi-taskboard`
- 上游默认分支：`main`
- GitHub Fork 创建时间：`2026-08-03T14:40:11Z`
- 本次合并的上游父提交：`c1ec1b8fa4ecef5372a50f2e3387cb141faef52a`
- 精确已合并上游基线：`c1ec1b8fa4ecef5372a50f2e3387cb141faef52a`
- 比较范围：`c1ec1b8fa4ecef5372a50f2e3387cb141faef52a..HEAD`

持续移动的 `upstream/main` 只有在祖先关系证明它与上述 SHA 相同时才是本文档基线；后续新提交仍属于待合并候选。合并提交本身的 Fork 侧父提交不是比较基线。

本次上游合并将基线更新到 `1.1.2`，继续吸收富文本粘贴时保留剪贴板 metadata，以及移除思考步骤 hover 背景。Fork 原有的 Jira CLI、多 provider 与 Scheduled Task 方案已由上游 Jira 模型替代，不再属于活跃 Fork 能力。桌面端继续采用上游 Tauri/Rust 基础并迁入 Fork 现有能力，产品名仍为 `Codex Panel`；自动 updater 安装、上游发布工作流和 `taskctl` 命名未纳入 Fork 产品入口。

## Fork 发布版本策略

- 权威上游版本来源：精确合并基线中的 `package.json`
- 当前 Fork 版本来源：`package.json` 和 `package-lock.json` 的根包条目
- 精确基线的上游版本：`1.1.2`
- 当前 Fork 版本：`0.1.0`
- 匹配的 Fork 标签或 GitHub Release：无

每个 Fork 发布版本都必须使用 `<upstream-version>-fork.<N>`。上游版本变化时从 `fork.1` 开始；同一上游版本的后续 Fork 发布递增 `N`。已准备但尚未发布的版本号在未被占用时可以保留。

当前 Fork 版本 `0.1.0` 与精确上游基线版本不一致，也不符合 Fork 发布格式。下一个规范化 Fork 发布版本是 `1.1.2-fork.1`。不得仅因本次合并修改版本文件；只能在已授权的发布任务中更新。

## 活跃 Fork 能力

### 使用 Codex Panel 产品与仓库名

- 生命周期：`长期保留`
- 原始目的：让浏览器标题、中英文仓库入口和 GitHub 仓库使用 Fork 项目名 `Codex Panel` / `codex-panel`，避免继续显示旧 Fork 名或上游通用名称。
- 行为不变量：`web/index.html`、中英文 README、Skill、CLI、环境变量、注入协议、本地存储、SQLite 和尚未部署的 Cloudflare 资源统一使用 `Codex Panel` / `panel` / `manage-panel` / `panelctl` / `CODEX_PANEL_*`；旧浏览器键、环境变量、自动任务名称及本仓库管理的旧链接必须自动迁移或兼容读取，不能因改名丢失本地状态。数据库只使用已完成改名的 `panel.sqlite`，不再保留旧数据库文件名迁移逻辑；用户级默认数据位置统一为固定支持目录，首次自包含安装只做一次在线快照且保留仓库源数据。
- 代码和测试路径：`web/index.html`、`package.json`、`package-lock.json`、`skills/manage-panel`、`cli/panelctl.mjs`、`server/index.mjs`、`server/app.mjs`、`shared/panel-paths.mjs`、`web/src/storageMigration.ts`、`scripts/install-macos-launcher.mjs`、`scripts/managed-install.mjs`、`scripts/panel-supervisor.mjs`、`scripts/codex-rate-limits.mjs`、`cloud/src/index.mjs`、`test/panel-supervisor.test.mjs` 和 `test/panel-naming.test.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md`、`docs/fork-capabilities.md` 和 `docs/cloud-collaboration.md`。
- 来源：Fork 初始定制及本次改名；可用 `git log -S'<title>Codex Panel</title>' -- web/index.html` 定位。
- 合并指引：合并上游 HTML、包清单和服务入口改动时保留 Panel 主命名和上述单向迁移边界；旧名称不能重新成为新写入或用户文档的主入口。
- 移除条件：Fork 更名或停止作为独立产品维护时同步更新或移除。
- 针对性验证：运行 `npm run build:web`，确认 `dist/web/index.html` 包含 `<title>Codex Panel</title>`，并确认 GitHub 仓库与本地目录都使用 `codex-panel`。

### 看板式横向列表

- 生命周期：`等待上游吸收`
- 原始目的：让横向列表具备与议题看板一致的分栏和卡片信息层级，并避免 Jira 内部长标识挤压标题与元信息。
- 行为不变量：横向列表复用议题看板的状态色、流程箭头、列间距、列内滚动和卡片层级；Jira Issue 有外部 Key 时优先显示外部 Key，标题单独成行，元信息在卡片内换行。所有结构性样式必须限定在横向布局，竖向列表继续使用紧凑行。
- 代码和测试路径：`web/src/components/IssueListView.tsx`、`web/src/styles.css` 和 `test/board-views.test.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：`78d2000be19d1f5212bdab3a40fa85e7de78ea00` 及本次扩展；提交后可用 `git log -S'displayIdentifier' -- web/src/components/IssueListView.tsx` 定位本次变更。
- 合并指引：上游修改列表或看板样式时，保留横向列表与议题看板的视觉语义一致性、Jira 外部 Key 优先展示和竖向紧凑布局；避免用整文件覆盖破坏任一布局。
- 移除条件：上游横向列表提供等价的看板式分栏、Jira Key 层级和竖向布局隔离后同步移除。
- 针对性验证：运行 `npm run typecheck` 和 `npm run build:web`；在横向与竖向列表分别确认 Jira Key、卡片层级、状态列滚动和紧凑行，并在窄视口确认页面无横向溢出。

### Tauri/Rust Codex Panel 桌面管理器

- 生命周期：`长期保留`
- 原始目的：以跟随上游维护的 Tauri/Rust 桌面基础承载 `~/Applications/Codex Panel.app`，同时保留 Fork 的 Panel、Jira、Skills、`panelctl`、固定数据目录和 Codex 内嵌能力，不再维护独立 Swift 产品路径。
- 行为不变量：macOS 上只有显式 `npm run codex:install` 创建或刷新 `~/Applications/Codex Panel.app`，`npm ci` 不得写入用户应用或全局集成。产品名和 bundle id 固定为 `Codex Panel` 与 `com.shay.codex-panel`；SwiftPM 源码和构建脚本不再是产品路径。Tauri App 常驻菜单栏，提供运行状态、内嵌 Panel、根据服务进程状态切换的同一个启动/停止项、独立的重启服务、浏览器、日志、数据目录、开机自启动，以及默认开启的“启动时连接 Codex”和“连接后自动打开 Panel”；重启和浏览器项只在服务运行时启用。管理窗口必须用一个紧凑的顶部控制面组合当前状态、Panel 主操作、同一个启动/停止按钮、独立重启、浏览器入口，以及 Panel 服务、Codex 连接与内嵌面板状态，不得再重复单独的服务控制区；Codex 连接与 Panel 页面实际可见必须分开判断，打开请求在 renderer 切换期间保持排队，只有 injector 重新读取状态并确认 `pageVisible=true` 后才能完成；异步操作按钮必须至少显示 300ms loading，再短暂保留清晰的成功或失败状态，服务启动、停止和重启必须在阻塞线程池执行，不能冻结 WebView 或使 loading 无法绘制；浏览器入口只接受启动器写入的私有回环 URL，并必须保留其中的实例 token 路径，不能降级为裸 origin；旧管理器已有的位置操作、启动偏好依赖关系、可见的更新结果与 Release 入口，以及可展开的运行详情保留在下方。管理窗口和 macOS 应用/Dock 图标使用同一套带 `PANEL` 角标的官方 Codex 明暗资源，并随系统主题切换。bundle 必须携带 Rust launcher、官方签名 Node、Panel runtime、`panelctl` 和两个 Panel Skills；数据始终保存在 `~/Library/Application Support/Codex Panel/data`。安装器只能覆盖带 Codex Panel marker 的 App；从旧 Swift App 升级时，必须先通过私有 descriptor、启动 token 和精确命令验证并停止旧 injector，再停止旧 bundle 内精确匹配的 Panel server，不能遗留执行已删除路径的 PPID 1 进程。启动前必须验证当前 Codex Panel App 签名和打包 runtime，按 `Identifier=com.openai.codex`、`Identifier=codex` 和 `TeamIdentifier=2DC432GLL2` 校验官方 App 与内置 CLI，拒绝符号链接，并移除 Node、shell 与动态加载器注入变量；Windows 环境变量名必须按不区分大小写的语义过滤。Windows 正式发行必须通过 `CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT` 指定证书并由 Tauri 生成 Authenticode 签名的 NSIS 包；launcher 启动 runtime 前必须验证自身签名证书指纹，并用编译进签名 launcher 的 SHA-256 清单验证 Node、Panel runtime、`panelctl` 和 Skills，拒绝篡改或未列出的 runtime 文件。Panel 监听器由 Rust 预占并仅绑定回环地址，服务使用私有实例 token 和 secret；macOS injector 使用权限仅限当前用户的 v2 descriptor 与 token-authenticated Unix socket，Windows 必须保留供 `panelctl` 发现服务的 runtime descriptor，但 open/status/stop 只使用启动器持有的子进程控制管道，不得尝试创建 Unix socket。Tauri 必须持有 injector 进程组，只有 renderer 的当前 source hash、启动 token、挂载点和新鲜心跳全部匹配时才显示运行正常。macOS TCP 路径必须以 `--attach-existing` 发现并复用当前 Codex 的真实 CDP 端口，包括旧 Swift 迁移现场；没有可用 CDP 时才通过 LaunchServices 用随机回环端口启动官方 App，已经无 CDP 运行的 Codex 仍需完全退出后重试。停止或退出只终止 Tauri 拥有的 injector 和 Panel server，不退出官方 ChatGPT/Codex，也不修改 `ChatGPT.app` 或 `app.asar`。意外退出按 2、5、15 秒恢复，60 秒内第四次失败后停止。更新检查最多每 24 小时自动执行一次并持久化缓存，普通失败只缓存 5 分钟，匿名 API 限流缓存到 GitHub 返回的重置时间，手动检查必须绕过缓存；优先使用本机已登录的 `gh` CLI，失败后回退匿名 GitHub API，并区分额度耗尽、网络失败、暂无 Release、当前版本和可用更新。只接受 `shay-wong/codex-panel` 下规范化 `vX.Y.Z-fork.N` 标签和精确 Release URL，只能打开页面，不得下载或安装更新。macOS 签名优先级为 `CODEX_PANEL_CODESIGN_IDENTITY`、可复用的本机 Apple Development 身份、最后 ad-hoc；发布前必须运行 bundle preflight 校验 App、Node 签名与 Node JIT entitlement。非 macOS 环境应成功跳过 macOS App 安装。
- CI 触发约束：PR 分支只通过 `pull_request` 运行 `Check`，`push` 仅验证 `main`，避免同一提交产生两组相同检查；`workflow_dispatch` 继续允许手动重跑。
- 代码和测试路径：`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/Entitlements.plist`、`src-tauri/release.json`、`src-tauri/src/main.rs`、`src-tauri/icons`、`src-tauri/ui`、`.codex/environments/environment.toml`、`.github/workflows/check.yml`、`scripts/prepare-tauri-app.mjs`、`scripts/preflight-macos-app.mjs`、`scripts/verify-packaged-taskctl.mjs`、`scripts/install-macos-launcher.mjs`、`scripts/codex-injector-control.mjs`、`scripts/codex-injector.mjs`、`scripts/codex-injector-runtime.mjs`、`scripts/panel-supervisor.mjs`、`server/app.mjs`、`test/launcher-ui.test.mjs`、`test/injector-control.test.mjs`、`test/injector.test.mjs`、`test/injector-host-runtime.test.mjs` 和 `package.json`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：上游 Tauri/Rust 桌面基础与本次 Fork 能力迁移；提交后可用 `git log -S'panelManagedReady' -- src-tauri/src/main.rs scripts/codex-injector.mjs` 定位。
- 合并指引：上游调整 Tauri、安装器或 injector 时，优先采用上游桌面基础，同时保留 `Codex Panel` 名称、固定数据目录、Panel/Jira/Skills/`panelctl` 打包、官方签名校验、净化环境、launcher-owned loopback listener、token-authenticated control、真实 renderer 就绪、现有 TCP CDP 接管、有限恢复和只打开可信 Release 页面。不得恢复 Swift 产品路径、自动 updater 安装、`taskctl` 主命名、外部可写 runtime 执行、仅凭 HTTP/CDP 可达报告正常，或在升级后遗留旧 bundle 进程。
- 移除条件：Fork 不再提供桌面端 Codex 内嵌，或上游完整提供上述品牌、扩展打包、安全边界和迁移契约时同步删除对应 Fork 差异。
- 针对性验证：运行 `node --check scripts/install-macos-launcher.mjs`、`node --check scripts/preflight-macos-app.mjs`、`node --check scripts/prepare-tauri-app.mjs`、`node --check scripts/build-windows-app.mjs` 和 `node --check scripts/verify-packaged-taskctl.mjs`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo check --manifest-path src-tauri/Cargo.toml`、`npm run app:build:local` 和 `npm run codex:install`；再对完成最终签名的 `~/Applications/Codex Panel.app` 运行 `npm run app:preflight -- "$HOME/Applications/Codex Panel.app"` 与 `npm run app:verify-packaged-panelctl -- "$HOME/Applications/Codex Panel.app"`。安装后确认主进程为 `codex-panel-launcher`，子进程从 `Contents/Resources/app` 启动，runtime descriptor 使用固定数据目录且实际 CDP 端口与当前 Codex 一致，control `status` 返回 `ready: true`，日志出现 `panelManagedReady:true`，旧 `CodexPanelLauncher`、旧 bundle injector 和旧 Panel server 均不存在。Windows 正式发行还必须在 Windows 主机上设置证书指纹后运行 `npm run app:build:windows`，确认未配置证书时立即失败、NSIS 与 launcher 的 Authenticode 签名有效，并确认篡改 `node.exe` 或 `app/scripts/codex-injector.mjs` 后 launcher 拒绝启动 runtime。

### 自包含安装 Panel runtime、Skills 与 CLI

- 生命周期：`长期保留`
- 原始目的：让用户通过一个明确的集成安装命令得到不依赖 Git 仓库路径的可运行副本，无需手工复制 Skill 或执行 `npm link`；新的 Codex 任务可以直接调用 `$manage-panel` 和 `$handoff-panel`，并能从 shell 找到两者依赖的 `panelctl`。
- 行为不变量：`npm ci` 只安装项目依赖，不得调用集成安装器。显式 `npm run codex:install` 必须先构建最小生产 runtime 并原子复制到固定用户支持目录，再把 `manage-panel` 与 `handoff-panel` 作为真实受管副本安装到标准 `~/.agents/skills`，把真实受管 wrapper 安装到 `~/.local/bin/panelctl`，最后清理确认属于本项目的旧 `~/.codex/skills`、`taskctl` 和 Node-bin 软链接。runtime、Skills、CLI 和启动器均不得指回源仓库；重复安装只更新带 Panel 所有权标记的目标，其他软链接、真实文件和目录必须保留或拒绝覆盖。首次安装且固定数据目录不存在时，必须使用 SQLite 在线备份复制仓库现有数据，并保留源数据；已有目标数据不得覆盖。`handoff-panel` 只读取 `~/.agents/skills/handoff/SKILL.md`，不得复制或修改第三方 `$handoff`；必须先完成基础 Skill 并保留其临时文档，再校验和发布 Panel 评论，评论中的文档内容不得裁剪或重写，后续失败不得破坏基础交接结果。
- 代码和测试路径：`scripts/install-macos-launcher.mjs`、`scripts/managed-install.mjs`、`shared/panel-paths.mjs`、`package.json`、`skills/manage-panel/SKILL.md`、`skills/handoff-panel/SKILL.md`、`skills/handoff-panel/scripts/publish-handoff.mjs`、`test/handoff-panel-skill.test.mjs` 和 `cli/panelctl.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：本次 Fork 能力；可用 `git log -S'handoff-panel' -- scripts/install-macos-launcher.mjs skills/handoff-panel package.json` 定位。
- 合并指引：上游修改依赖或启动器安装时，保留“依赖安装不触发用户级写入”“runtime、两个 Panel Skills、CLI、启动器由显式同一入口安装”“安装副本不依赖仓库路径”“受管目标可原子刷新”“用户目标不覆盖”“第三方 `$handoff` 不修改”六个不变量，不能只保留启动器生成。
- 移除条件：上游提供等价的自包含 Panel runtime、Skills 与 CLI 安装能力，或 Fork 不再通过本地 Skill 管理及交接 Issue 时同步移除。
- 针对性验证：运行 `node --check scripts/install-macos-launcher.mjs`、`node --test test/handoff-panel-skill.test.mjs test/panel-naming.test.mjs`、`npm run app:build:local` 和 `npm run codex:install`；再对完成最终签名的 `~/Applications/Codex Panel.app` 运行 `npm run app:preflight -- "$HOME/Applications/Codex Panel.app"` 与 `npm run app:verify-packaged-panelctl -- "$HOME/Applications/Codex Panel.app"`。确认包清单没有 `postinstall` 且仍保留 `codex:install`；首次安装不覆盖已有数据，重复安装只刷新受管 runtime、两个 Skills、`panelctl` 和带 marker 的 App，用户自有同名路径保持不变；最后确认 `codex-panel-launcher.json` 和安装结果都不含源仓库路径。

### 启动时等待 Codex renderer

- 生命周期：`等待上游吸收`
- 原始目的：修复 Electron 已开放 CDP `/json/version`、但 `/json/list` 尚未出现主 Codex 页面，或头像浮层 renderer 先出现时，独立启动器报错且未完成嵌入的问题。
- 行为不变量：首次注入最多等待 30 秒，排除全局听写和头像浮层等辅助 renderer，并等待主 renderer 的 `app://` 文档进入 `complete` 后才执行一次 CSP-bypass reload，使 document-start 注入生效但不得中断 Codex 初始 bootstrap；后续驻留监控仍按原有节奏处理替换后的 renderer。
- 代码和测试路径：`scripts/codex-injector.mjs`、`test/injector.test.mjs`。
- 用户文档：`README.md` 和 `README.zh-CN.md` 的“Embed in Codex”/“嵌入 Codex”章节，以及 `docs/fork-capabilities.md`；两种入口都记录 30 秒等待行为。
- 来源：本次 Fork 修复；可用 `git log -S'waitForCodexTargets' -- scripts/codex-injector.mjs test/injector.test.mjs` 定位。
- 合并指引：若上游重构启动器，必须保留“CDP 就绪不等于主 renderer 就绪”“辅助 renderer 不能作为注入目标”以及“首次 reload 必须晚于官方 bootstrap 完成”的不变量，并用辅助窗口先出现、主窗口延迟出现和主文档先 loading 后 complete 的检查验证。
- 移除条件：上游实现等价的主 renderer 等待和辅助窗口过滤逻辑，并包含能覆盖该启动顺序的回归测试。
- 针对性验证：运行 `node --test test/injector.test.mjs`，再运行 `CODEX_PANEL_HOST=127.0.0.1 npm run codex` 验证真实首次嵌入。

### 在 Panel 与 Codex 原生页面之间切换

- 生命周期：`等待上游吸收`
- 原始目的：修复 Codex 会话页的主内容 frame 覆盖原生标题栏时，Panel 入口变为选中但页面没有挂载，以及 Panel 激活后通过全局命令菜单、活动视图或通知无法返回原生目的地的问题。
- 行为不变量：主内容 frame 只要覆盖大部分 viewport 就可以作为挂载锚点，不得因其顶部位于原生标题栏上方而拒绝；会话页、Plugins 和 Sites 均能直接切换到 Panel。Panel 激活时，从全局命令菜单以鼠标或 Enter 选择对话、工作、Codex、设置、技能、已安排任务、新会话等简中、繁中或英文原生目的地，打开活动视图，或由通知切换当前原生对话，都必须先恢复原生内容；主题、复制等非导航命令、相同对话的普通刷新及普通 History 状态同步不得关闭 Panel。当前 App DOM 只暴露本地化标题而不暴露稳定命令 ID，因此其他界面语言留待 Codex 提供稳定标识后支持。
- 代码和测试路径：`inject/codex-panel.user.js`、`test/inject.test.mjs`。
- 用户文档：`README.md` 和 `README.zh-CN.md` 的“Embed in Codex”/“嵌入 Codex”章节，以及 `docs/fork-capabilities.md`。
- 来源：本次 Fork 修复；可用 `git log -S'conversation content frames can host Panel' -- test/inject.test.mjs`、`git log -S'handleNativeDestinationCommand' -- inject/codex-panel.user.js` 和 `git log -S'closePanelForNativeThreadChange' -- inject/codex-panel.user.js` 定位。
- 合并指引：上游调整 Codex 主内容 DOM 或命令菜单时，应以页面实际覆盖范围和真实命令选择事件为准，不能重新要求 frame 位于原生标题栏下方，也不能通过全局 History 包装判断命令导航；若命令菜单暴露稳定命令 ID，应以 ID 替代本地化标题并补全其他语言。
- 移除条件：上游提供等价的跨会话页和原生页面双向切换逻辑，并覆盖会话 frame 从 viewport 顶部开始、命令菜单鼠标与 Enter、活动通知、非导航命令和 History 状态同步场景。
- 针对性验证：运行 `node --test --test-name-pattern='conversation content frames|native destinations' test/inject.test.mjs`，并从实际 Codex 会话点击 Panel，再通过全局命令菜单分别选择对话、插件和设置，确认原生目的地可见；打开活动视图并选择一条通知，确认通知目标可见；执行主题切换时 Panel 应保持打开。

### 内嵌 AI 对话关联议题

- 生命周期：`等待上游吸收`
- 原始目的：允许已有本地 AI 对话在创建后继续关联、改绑或取消关联 Issue，让 Issue 活动时间线直接显示和打开处理它的内嵌对话，并把讨论结论可靠交接给后续原生 Codex 任务。
- 行为不变量：只允许把空闲对话关联到其原始项目中的活跃 Issue，运行中的对话不能改绑；打开关联菜单时必须按对话原始项目直接加载活跃 Issue，不得复用当前看板项目的任务数组。关联同时持久化 Issue ID 和编号。Issue 活动时间线只显示实际关联到当前 Issue 的本地对话，按最近活动时间与评论排序并计入活动数量，点击时必须打开对应线程；对话历史应显示关联编号。内嵌聊天中的 `/handoff` 和 `/交接` 必须复用同一 Codex 线程总结既有上下文，只在该轮成功并返回摘要后，以带稳定标记的 Codex Agent 评论写入 Issue 并广播活动更新；`--issue ISSUE-ID` 可以覆盖默认的关联 Issue。原 `$handoff` 在所有位置都只保留临时文档行为；独立的全局 `$handoff-panel --issue ISSUE-ID` 必须先完整执行原 Skill，再校验目标 Issue，并把同一份临时文档逐字通过 `panelctl` 写入 Issue；校验或写入失败时保留文档并报告部分失败。打开本地原生对话时必须按 Panel 当前界面语言预填 `$manage-panel`、Issue 编号、标题、最新交接和 `panelctl` 读取位置；打开 SSH 对话时必须按同一界面语言预填完整 Issue 快照。两种路径均不得显示内部路由标记或自动发送；未发送的输入框不算任务，第一次真实发送产生新 thread ID 后才能写回对应 binding，SSH Issue 同时才能变为处理中。
- 代码和测试路径：`server/ai-chat.mjs`、`server/app.mjs`、`server/database.mjs`、`inject/codex-panel.user.js`、`scripts/codex-injector.mjs`、`scripts/codex-injector-runtime.mjs`、`skills/manage-panel/SKILL.md`、`skills/handoff-panel/SKILL.md`、`skills/handoff-panel/scripts/publish-handoff.mjs`、`web/src/api.ts`、`web/src/App.tsx`、`web/src/components/AiChat.tsx`、`web/src/components/TaskDetail.tsx`、`web/src/styles.css`、`test/ai-chat-runner.test.mjs`、`test/handoff-panel-skill.test.mjs`、`test/injector-composer-prefill.test.mjs`、`test/injector-host-runtime.test.mjs` 和 `test/server.test.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：本次 Fork 能力；可用 `git log -S'bindThreadToIssue' -- web/src/components/AiChat.tsx server/ai-chat.mjs` 定位。
- 合并指引：上游调整 AI 对话模型、Issue 活动时间线或原生任务创建协议时，保留“按对话原项目加载活跃 Issue、运行时只读、双字段持久化、活动时间线反向入口、同线程交接摘要、显式目标路由、原 `$handoff` 不变、全局 `$handoff-panel` 基础优先且逐字复用临时文档、最新交接预填和新 thread 自动写回”的完整路径，不能只保留创建时关联。
- 移除条件：上游提供等价的对话改绑、取消关联、Issue 反向展示、交接记录、上下文预填和原生 thread 自动关联能力后同步移除。
- 针对性验证：运行 `node --test test/ai-chat-runner.test.mjs test/handoff-panel-skill.test.mjs test/injector-composer-prefill.test.mjs test/injector-host-runtime.test.mjs`、`npm run typecheck` 和 `npm run build`；在任意 Codex 对话中发送 `$handoff-panel --issue ISSUE-ID 重点说明`，确认原 `$handoff` 临时文档照常生成，随后目标 Issue 收到内容一致的交接评论；分别对本地和 SSH 项目点击“在对话中打开”，确认本地输入框包含 `$manage-panel`、Issue 编号、标题和最新交接，SSH 输入框包含完整 Issue 快照，两者均跟随 Panel 界面语言、不显示 `e-panel`、不自动发送；第一次真实发送后两者才显示新原生任务关联，SSH Issue 同时才变为处理中。

### 受管 iframe 的 Codex 原生权限边界

- 生命周期：`长期保留`
- 原始目的：允许用户替换 Panel UI 来源，同时避免任意自定义 HTTP(S) iframe 获取本机 Codex 用户、项目、thread 和绝对路径，或调用原生任务与自动化能力。
- 行为不变量：只有 `frameOrigin === managedPanelOrigin()` 的启动器受管来源可以接收 `panel:host-context` 和 thread 关联消息，并请求打开原生任务、创建任务、展开侧边栏或操作自动化；其他自定义来源只可接收主题和标题栏拖拽区域消息并显示看板。Cloud 模式仍通过本地 companion 提供的受管来源使用原生能力，不能以“来源可显示”替代“来源受信任”的判断。
- 代码和测试路径：`inject/codex-panel.user.js` 和 `test/inject.test.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：本次 Fork 安全修复；可用 `git log -S'isTrustedPanelOrigin' -- inject/codex-panel.user.js test/inject.test.mjs` 定位。
- 合并指引：上游调整 iframe URL、自定义来源或原生消息协议时，继续把显示层消息与 Codex 原生权限分开；新增原生能力必须放在受管来源检查之后，宿主上下文不得发往普通自定义来源。
- 移除条件：上游提供等价或更严格的显式来源授权模型，并覆盖宿主上下文与每项原生消息能力后同步移除。
- 针对性验证：运行 `node --test test/inject.test.mjs`；分别使用默认受管来源和不同来源的 `window.__CODEX_PANEL_URL__`，确认前者可以接收宿主上下文并操作原生能力，后者只能收到主题和拖拽区域消息。

### Issue 详情页项目切换

- 生命周期：`等待上游吸收`
- 原始目的：让导入到“全局”的待分配 Issue 以及普通 Issue 可以直接在详情页移动到正确项目，无需切换到 CLI。
- 行为不变量：详情属性栏必须显示当前项目并复用现有项目移动 API；成功后打开目标项目并保持同一 Issue 详情和原生关联对话。有关联、绑定源项目的本地 AI 对话或 branch/worktree 开发上下文时，移动必须在写入前拒绝并显示可执行错误；状态、描述、标签、日期和其他属性不得改变。
- 代码和测试路径：`web/src/App.tsx`、`web/src/components/TaskDetail.tsx`、`web/src/components/TaskPropertyPicker.tsx`、`server/database.mjs` 和 `test/task-project-move.test.mjs`。本次按仓库直接路径确认规则未新增 UI 自动化测试。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：当前项目重分配能力；提交后可用 `git log -S'propertyMenu === "project"' -- web/src/components/TaskDetail.tsx` 定位。
- 合并指引：上游调整详情属性栏或项目导航时，继续复用服务器项目移动完整性规则，保留“成功后目标项目继续打开同一 Issue、对话不变、开发上下文先清理”的完整路径，不得只改变前端当前项目标签。
- 移除条件：上游提供等价的详情页项目切换、错误展示和上下文保持行为后同步移除。
- 针对性验证：运行 `node --test test/task-project-move.test.mjs`、`npm run typecheck` 和 `npm run build:web`；在详情页移动无阻塞 Issue，确认 URL、顶部项目和属性栏都指向目标项目且对话入口仍存在；再对带开发上下文的 Issue 操作，确认错误要求先清理上下文且项目未变。

### Jira Bearer Token 认证

- 生命周期：`等待上游吸收`
- 原始目的：支持不使用 Jira 用户名和密码、只提供 Personal Access Token 的 Jira Data Center 或 Server 连接，同时保留 Jira Cloud 邮箱与 API Token 等 Basic Auth 用法。
- 行为不变量：Basic Auth 必须有非空用户名或邮箱，并且只发送 `Authorization: Basic ...`；Bearer Auth 不发送用户名，并且只发送 `Authorization: Bearer ...`。切换认证方式时必须重新输入密码或 Token；凭据不得通过配置状态或错误信息返回前端，配置文件继续保持 `0600` 权限。
- 代码和测试路径：`server/app.mjs`、`server/jira-config.mjs`、`server/jira-integration.mjs`、`web/src/App.tsx`、`web/src/api.ts`、`web/src/components/JiraConnectionDialog.tsx`、`web/src/styles.css` 和 `web/src/types.ts`。本次按仓库直接路径确认规则未新增持久化测试。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：当前 Jira 认证扩展；提交后可用 `git log -S'JIRA_USERNAME_REQUIRED' -- server/jira-integration.mjs` 定位。
- 合并指引：上游调整 Jira 配置或请求封装时，保留显式认证方式、Basic 非空用户名校验、Bearer 不发送用户名、认证方式切换重输凭据及响应不泄漏凭据的边界，不能根据空白用户名静默切换认证方式。
- 移除条件：上游提供等价的 Bearer PAT 支持、认证切换和凭据边界后同步移除。
- 针对性验证：使用定向请求 harness 确认空白 Basic 用户名在网络请求前返回 `JIRA_USERNAME_REQUIRED`，合法 Basic 和 Bearer 分别只发送对应认证头；运行 `npm run typecheck`、`npm run build:web` 和 `git diff --check`，并在安装态设置界面确认两种认证方式可以切换且切换后要求重新输入凭据。

### Jira 未完成任务可靠同步

- 生命周期：`等待上游吸收`
- 原始目的：稳定同步当前 Jira 登录用户的全部未完成任务，并在分页失败、任务消失、权限变化或账号切换时保留上次可信数据和明确的用户控制。
- 行为不变量：JQL 只读取 `assignee = currentUser()` 且 `statusCategory != Done` 的任务；全部搜索分页成功后才在一个事务中落库。搜索结果中消失的已有 Jira 必须按 Key 复查，能确认已完成或离开范围时归档，无法确认时保留并标记同步状态未知。认证、权限、网络和分页失败不得清理缓存任务，进入 Jira 项目时仍返回缓存并展示持久化错误。`/myself` 稳定身份变化必须在搜索新账号任务前要求确认。打开 Jira 项目沿用一分钟节流，手动同步始终强制执行且不限次数。顶部紧凑状态栏和 Jira 设置必须显示最后尝试、最后成功、未完成数量、未知数量及可执行失败原因。
- 代码和测试路径：`server/app.mjs`、`server/database.mjs`、`server/jira-config.mjs`、`server/jira-integration.mjs`、`web/src/App.tsx`、`web/src/api.ts`、`web/src/components/JiraConnectionDialog.tsx`、`web/src/styles.css`、`web/src/types.ts` 和 `test/jira-integration.test.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：当前 Jira 可靠同步扩展；提交后可用 `git log -S'jira_sync_state' -- server/database.mjs` 定位。
- 合并指引：上游调整 Jira 搜索、任务列表入口、配置格式或同步 UI 时，保留“完整分页后单事务写入、消失任务逐项复查、失败继续读取缓存、账号变化先确认、状态持久可见”五个边界；不得让自动同步失败阻断已有 Jira 任务读取，也不得恢复 Scheduled Task 或多 provider 设计。
- 移除条件：上游提供等价的未完成任务原子同步、缺失复查、缓存回退、账号切换确认和同步健康展示后同步移除。
- 针对性验证：运行 `node --test test/jira-integration.test.mjs`、`npm run typecheck`、`npm run build:web` 和 `git diff --check`；使用本地 Jira 响应端确认分页成功、失败缓存、账号变化确认前无搜索，以及桌面和 390px 窄视口的状态栏与详情布局。

### Jira 外部需求与仓库执行 Issue 关联

- 生命周期：`等待上游吸收`
- 原始目的：把 Jira 保持为独立外部需求，同时允许一个需求跨多个仓库拆成多个本地执行 Issue，避免 Jira 刷新覆盖仓库内的实施内容。
- 行为不变量：一个 Jira 可以选择一个或多个具有本地 workspace 的项目并关联其中多个执行 Issue；每个执行 Issue 最多关联一个 Jira。仓库变更必须先展示差异并等待显式保存；普通关联不自动创建、迁移或删除 Issue。只有已保存至少一个仓库的待认领 Jira 才可一键创建并开始：Jira 先回写为进行中，每仓库复用唯一执行 Issue 或创建一个 backlog Issue 及独立空闲 AI 对话，全部仓库就绪后才统一释放到待认领。部分失败必须持久化保留进度，重试复用预留 Issue 与会话 ID、已有关联和对话，不重复回写或创建。关联 Issue 只能移动到该 Jira 已选项目；归档保留关系，永久删除前必须解除。Jira 同步只更新外部需求镜像的 key、标题、原始状态、URL、同步时间和错误，不修改关联执行 Issue 的本地字段。
- 代码和测试路径：`server/database.mjs`、`server/app.mjs`、`server/jira-integration.mjs`、`web/src/App.tsx`、`web/src/api.ts`、`web/src/components/TaskDetail.tsx`、`web/src/styles.css`、`web/src/types.ts` 和 `test/jira-integration.test.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：当前 Jira 外部需求关联能力；提交后可用 `git log -S'jira_task_links' -- server/database.mjs` 定位。
- 合并指引：上游调整 Jira 同步、任务 schema、项目移动或详情侧栏时，保留外部需求与本地执行单元的边界、Jira 对执行 Issue 的一对多关系、执行 Issue 对 Jira 的至多一关系、仓库约束和显式保存，以及一键创建的持久化幂等重试和全部就绪后再释放行为；不得把专用关系退化为同项目 Issue 关系或让同步写入执行 Issue。
- 移除条件：上游提供等价的跨仓库 Jira 需求关联、双向详情维护、同步隔离和生命周期约束后同步移除。
- 针对性验证：运行 `node --test test/jira-integration.test.mjs test/server.test.mjs`、`npm run typecheck` 和 `npm run build:web`；在 Jira 详情选择多个仓库、保存并关联执行 Issue，确认双方详情可打开和解除关系，仓库差异不会在保存前生效，普通 Issue 详情保持紧凑。使用本地 Jira 响应端让第二个仓库首次失败并重试，确认 Jira 只转换一次、每仓库只有一个 Issue 和一个对话，而且首次失败时没有 Issue 提前进入待认领。

### 本地化交付审查

- 生命周期：`长期保留`
- 原始目的：让 Fork 的交付审查不依赖 ChatGPT 网页、浏览器自动化或外部交互式登录，避免本地已完成并通过 CI 的工作被不可用的网页会话阻塞。
- 行为不变量：每个执行会话都必须对自己的最终候选进行本地代码审查，审查深度随实现风险增加，但不增加第二个强制审查入口。实质性候选变化会使旧 SHA 的审查失效；协调会话只核验审查证据，不重复审查。用户 UI 确认仍按实际视觉影响执行，但不再等待任何外部审查服务或 ChatGPT 网页审查。
- 代码和测试路径：`AGENTS.md`；这是仅面向维护者和 AI 编码代理的交付策略，不涉及产品代码或持久化测试。
- 来源：当前 Fork 交付策略调整；提交后可用 `git log -S'Fork delivery must not depend on ChatGPT web' -- AGENTS.md` 定位。
- 合并指引：上游调整审查流程时，保留“执行 Agent 本地审查覆盖全部实现、风险只影响审查深度、结果绑定精确 SHA、无第二审查服务或外部网页登录依赖”四个不变量，不恢复强制 ChatGPT 网页审查。
- 移除条件：Fork 明确重新采用可靠且非交互的外部审查基础设施，或停止维护独立交付流程时同步移除。
- 针对性验证：确认 `AGENTS.md` 的 Review by risk 和 Acceptance 段落不要求第二个审查服务、ChatGPT 网页、浏览器或外部登录，并仍要求执行 Agent 本地审查、按风险增加深度及 SHA 失效规则。

## 上游合并检查清单

1. 每次实际完成上游合并后，根据 Git 祖先关系重新确定精确基线，不得用持续移动的上游分支头替代。
2. 按能力审计新的 `baseline..HEAD` 范围，以及已暂存、未暂存和未跟踪的工作区变更。
3. 分别审查 `长期保留` 的不变量和 `等待上游吸收` 的候选项；只有上游行为和测试等价后才移除条目。
4. 按行为和不变量解决冲突。只有手工合并结果可能携带 Fork 行为时，才检查 `git show --remerge-diff`。
5. 根据精确合并基线中的上游版本确定下一个发布版本。上游版本变化时使用 `fork.1`；否则递增同一上游版本已发布的最高 Fork 修订号。
6. 仓库规则要求时，从源定义重新生成产物。
7. 在同一提交中同步代码、已授权的测试和 `FORK.md`。公开变更还必须同步中英文 README 入口、英文详细用户文档及索引和 `CHANGELOG.md`。
8. 更新本文档的基线部分，并在完成合并任务前运行针对性验证。

## 明确排除项

- 仓库现有的云端协作、本地 AI 聊天、自动化、Issue 编辑器和 UI 行为在 Fork 创建基线中已属于上游，不是 Fork 差异。
- 仅存在于上游的轻量标签 `pre-cloud-collaboration-2026-07-24` 不是 Fork 发布版本。
- 不含有意 Fork 解决结果的纯上游合并、生成产物噪声、被忽略的本地状态，以及最终效果已被回退的行为都不属于 Fork 能力。
- 尚未合并的上游独有工作属于待合并输入，不属于 Fork 能力。
- 截至上游 `1.1.2`，Tauri/Rust 桌面基础、新版 AI Composer、Agent/Skill/命令补全、可搜索 Issue 关系选择器和富文本剪贴板 metadata 保留已经进入 Fork；自动 updater 安装、上游发布工作流、`taskctl` 主命名和与 Fork 发布策略冲突的打包入口仍明确排除。
- 上游 `1.1.2` 的单连接 Jira REST 基础同步、直接回写及主题化 Issue 属性菜单已经等价吸收；Fork 仅继续维护本文记录的可靠同步、Bearer 认证和跨仓库关联扩展。
