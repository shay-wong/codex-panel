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
- 本次合并的上游父提交：`01bc2b31973ca8ba1496ebc525e96abe5dec10ce`
- 精确已合并上游基线：`01bc2b31973ca8ba1496ebc525e96abe5dec10ce`
- 比较范围：`01bc2b31973ca8ba1496ebc525e96abe5dec10ce..HEAD`

持续移动的 `upstream/main` 只有在祖先关系证明它与上述 SHA 相同时才是本文档基线；后续新提交仍属于待合并候选。合并提交本身的 Fork 侧父提交不是比较基线。

本次上游合并将基线更新到 `1.1.9`，吸收项目 README、全项目视图、Codex 接管与 Linux 桌面打包、编辑器和显示设置改进、等价的 Issue 跨项目移动、项目切换器搜索与滚动、Recent/New Chat 首次点击导航、Windows Store Codex 可执行文件兼容，以及打包态项目摘要修复。Fork 原有的 Jira CLI、多 provider 与 Scheduled Task 方案已由上游 Jira 模型替代，不再属于活跃 Fork 能力。桌面端继续采用上游 Tauri/Rust 基础并迁入 Fork 现有能力，产品名仍为 `Codex Panel`；自动 updater 安装、上游发布工作流和 `taskctl` 命名未纳入 Fork 产品入口。

本轮继续吸收精确 HTTPS trusted-origin 边界、确定性的 Issue 树查询、Markdown 图片边界修复、Issue 详情控件改进，以及 WSL CLI 发现并访问 Windows launcher runtime 的能力；这些属于上游能力，不新增 Fork 能力条目。Fork 继续使用 `Codex Panel`、`panelctl` 和 `manage-panel` 主命名，并保留 Jira、桌面端、自动化和 Cloud 扩展的不变量。

## Fork 发布版本策略

- 权威上游版本来源：精确合并基线中的 `package.json`
- 当前 Fork 版本来源：`package.json` 和 `package-lock.json` 的根包条目
- 精确基线的上游版本：`1.1.9`
- 当前 Fork 版本：`0.1.0`
- 匹配的 Fork 标签或 GitHub Release：无

每个 Fork 发布版本都必须使用 `<upstream-version>-fork.<N>`。上游版本变化时从 `fork.1` 开始；同一上游版本的后续 Fork 发布递增 `N`。已准备但尚未发布的版本号在未被占用时可以保留。

当前 Fork 版本 `0.1.0` 与精确上游基线版本不一致，也不符合 Fork 发布格式。下一个规范化 Fork 发布版本是 `1.1.9-fork.1`。不得仅因本次合并修改版本文件；只能在已授权的发布任务中更新。

## 活跃 Fork 能力

### 使用 Codex Panel 产品与仓库名

- 生命周期：`长期保留`
- 原始目的：让浏览器标题、中英文仓库入口和 GitHub 仓库使用 Fork 项目名 `Codex Panel` / `codex-panel`，避免继续显示旧 Fork 名或上游通用名称。
- 行为不变量：`web/index.html`、中英文 README、Skill、CLI、环境变量、注入协议、本地存储、SQLite 和尚未部署的 Cloudflare 资源统一使用 `Codex Panel` / `panel` / `manage-panel` / `panelctl` / `CODEX_PANEL_*`，包括反向隧道使用 `CODEX_PANEL_TRUSTED_ORIGINS`，WSL 使用 `CODEX_PANEL_WSL_RUNTIME_FILE` 覆盖自动发现的 Windows runtime；Panel 自有的剪贴板 MIME 与 HTML data 属性使用 `panel` 命名，上游现有的 `taskboard://composer-reference` 持久化协议继续兼容。旧浏览器键、环境变量、自动任务名称及本仓库管理的旧链接必须自动迁移或兼容读取，不能因改名丢失本地状态。数据库只使用已完成改名的 `panel.sqlite`，不再保留旧数据库文件名迁移逻辑；用户级默认数据位置统一为固定支持目录，首次自包含安装只做一次在线快照且保留仓库源数据。
- 代码和测试路径：`web/index.html`、`package.json`、`package-lock.json`、`skills/manage-panel`、`cli/panelctl.mjs`、`server/index.mjs`、`server/app.mjs`、`shared/panel-paths.mjs`、`web/src/storageMigration.ts`、`web/src/components/InlineMediaComposer.tsx`、`integrations/deepseek-harness`、`scripts/install-macos-launcher.mjs`、`scripts/managed-install.mjs`、`scripts/panel-supervisor.mjs`、`scripts/codex-rate-limits.mjs`、`scripts/verify-linux-packages.mjs`、`cloud/src/index.mjs`、`test/panel-supervisor.test.mjs` 和 `test/panel-naming.test.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md`、`docs/fork-capabilities.md` 和 `docs/cloud-collaboration.md`。
- 来源：Fork 初始定制及本次改名；可用 `git log -S'<title>Codex Panel</title>' -- web/index.html` 定位。
- 合并指引：合并上游 HTML、包清单、剪贴板或服务入口改动时保留 Panel 主命名、Panel 自有剪贴板标识和上述单向迁移边界，同时继续接受上游现有的 composer-reference 协议；旧名称不能重新成为其他新写入或用户文档的主入口。
- 移除条件：Fork 更名或停止作为独立产品维护时同步更新或移除。
- 针对性验证：运行 `npm run build:web`，确认 `dist/web/index.html` 包含 `<title>Codex Panel</title>`，并确认 GitHub 仓库与本地目录都使用 `codex-panel`。

### 看板式横向列表

- 生命周期：`等待上游吸收`
- 原始目的：让横向列表具备与议题看板一致的分栏和卡片信息层级，并避免 Jira 内部长标识挤压标题与元信息。
- 行为不变量：横向列表复用议题看板的状态色、流程箭头、列间距、列内滚动和卡片层级；Jira Issue 有外部 Key 时优先显示外部 Key，标题单独成行，元信息在卡片内换行。所有结构性样式必须限定在横向布局，竖向列表继续使用紧凑行。
- 代码和测试路径：`web/src/components/IssueListView.tsx`、`web/src/styles.css` 和 `test/board-interactions.test.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：`78d2000be19d1f5212bdab3a40fa85e7de78ea00` 及本次扩展；提交后可用 `git log -S'displayIdentifier' -- web/src/components/IssueListView.tsx` 定位本次变更。
- 合并指引：上游修改列表或看板样式时，保留横向列表与议题看板的视觉语义一致性、Jira 外部 Key 优先展示和竖向紧凑布局；避免用整文件覆盖破坏任一布局。
- 移除条件：上游横向列表提供等价的看板式分栏、Jira Key 层级和竖向布局隔离后同步移除。
- 针对性验证：运行 `npm run typecheck` 和 `npm run build:web`；在横向与竖向列表分别确认 Jira Key、卡片层级、状态列滚动和紧凑行，并在窄视口确认页面无横向溢出。

### 项目总结有限梯度重试

- 生命周期：`等待上游吸收`
- 原始目的：避免一次临时 Codex 失败让项目总结保持错误状态 24 小时，同时限制后台自动尝试次数。
- 行为不变量：项目总结生成失败后按 5、15、60 分钟依次等待并自动重试，第四次失败后停止自动重试；失败次数和最后尝试时间保存在 `project_summaries`，服务重启不能重置上限。失败状态始终保留手动重试入口，手动失败继续累计且不得重新开启无限自动重试；任意一次成功都会保存新总结并把失败次数归零。旧数据库中的错误记录迁移为第一次失败，已有总结、时间和错误文本不得丢失。
- 代码和测试路径：`server/project-summary.mjs`、`server/database.mjs`、`server/app.mjs`、`web/src/api.ts`、`web/src/components/DashboardView.tsx`、`web/src/components/DashboardView.css` 和 `test/project-summary.test.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：当前项目总结恢复修复；提交后可用 `git log -S'FAILURE_RETRY_DELAYS_MS' -- server/project-summary.mjs` 定位。
- 合并指引：上游修改 Dashboard 总结生成、轮询或 `project_summaries` schema 时，保留持久化的 5/15/60 分钟有限重试、第四次失败后的停止边界、独立手动重试和成功归零；不得恢复失败后统一等待 24 小时或无上限后台重试。
- 移除条件：上游提供等价的持久化有限梯度重试、手动恢复入口、成功归零和旧数据迁移后同步移除。
- 针对性验证：运行 `node --test test/project-summary.test.mjs`、`npm run typecheck` 和 `npm run build:web`；在隔离数据目录与 fake Codex 下确认第四次失败后不再自动生成，点击重试时显示 loading，成功后总结立即更新且按钮消失。

### Cloud 一次性迁移完整性

- 生命周期：`等待上游吸收`
- 原始目的：确保把现有本地 Panel 数据一次性迁移到 Cloudflare 时，不会在迁移成功的表象下丢失 Project README 内联图片或改变由 Issue mention 自动生成的关系语义。
- 行为不变量：Cloud 迁移包必须完整包含项目 README、`project_readme_attachments` 元数据、普通附件和 README 附件字节、任务开始日期，以及 `task_relations.origin`；两类附件都必须写入并校验 R2，D1 计数必须覆盖 README 附件。缺少这些数据的 v2 包必须要求用户重新导出，不能静默导入不完整数据。
- 代码和测试路径：`scripts/migrate-to-cloud.mjs`、`scripts/wrangler-cloud-adapter.mjs`、`test/cloud-migration.test.mjs`、`cloud/migrations/0010_project_readme_attachments.sql` 和 `cloud/migrations/0010_task_relation_origin.sql`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/cloud-collaboration.md`。
- 来源：本次上游合并后的完整性修复；提交后可用 `git log -S'project_readme_attachments' -- scripts/migrate-to-cloud.mjs` 定位。
- 合并指引：上游调整本地或 Cloud schema、迁移包版本、D1 导入或 R2 附件存储时，必须以当前生产 schema 的用户数据表和语义字段为清单核对迁移覆盖；不能只验证行数而忽略附件字节、关系来源或新表。
- 移除条件：上游迁移工具等价保留 Project README 附件、关系来源和对应完整性验证后同步删除。
- 针对性验证：运行 `node --test test/cloud-migration.test.mjs`，确认隔离的真实 D1/R2 模拟迁移后可以下载 Project README 图片，mention 关系仍为 `origin='mention'`，且 v2 包被明确拒绝。

### Tauri/Rust Codex Panel 桌面管理器

- 生命周期：`长期保留`
- 原始目的：以跟随上游维护的 Tauri/Rust 桌面基础承载 `~/Applications/Codex Panel.app`，同时保留 Fork 的 Panel、Jira、Skills、`panelctl`、固定数据目录和 Codex 内嵌能力，不再维护独立 Swift 产品路径。
- 行为不变量：macOS 上只有显式 `npm run codex:install` 创建或刷新 `~/Applications/Codex Panel.app`，`npm ci` 不得写入用户应用或全局集成。产品名和 bundle id 固定为 `Codex Panel` 与 `com.shay.codex-panel`；SwiftPM 源码和构建脚本不再是产品路径。Tauri App 常驻菜单栏，提供运行状态、内嵌 Panel、根据服务进程状态切换的同一个启动/停止项、独立的重启服务、浏览器、日志、数据目录、开机自启动，以及默认开启的“启动时连接 Codex”和“连接后自动打开 Panel”；重启和浏览器项只在服务运行时启用。管理窗口必须用一个紧凑的顶部控制面组合当前状态、Panel 主操作、同一个启动/停止按钮、独立重启、浏览器入口，以及 Panel 服务、Codex 连接与内嵌面板状态，不得再重复单独的服务控制区；Codex 连接与 Panel 页面实际可见必须分开判断，打开请求在 renderer 切换期间保持排队，只有 injector 重新读取状态并确认 `pageVisible=true` 后才能完成；异步操作按钮必须至少显示 300ms loading，再短暂保留清晰的成功或失败状态，服务启动、停止和重启必须在阻塞线程池执行，不能冻结 WebView 或使 loading 无法绘制；浏览器入口只接受启动器写入的私有回环 URL，并必须保留其中的实例 token 路径，不能降级为裸 origin；旧管理器已有的位置操作、启动偏好依赖关系、可见的更新结果与 Release 入口，以及可展开的运行详情保留在下方。管理窗口和 macOS 应用/Dock 图标使用同一套带 `PANEL` 角标的官方 Codex 明暗资源，并随系统主题切换。bundle 必须携带 Rust launcher、官方签名 Node、Panel runtime、`panelctl` 和两个 Panel Skills；数据始终保存在 `~/Library/Application Support/Codex Panel/data`。安装器只能覆盖带 Codex Panel marker 的 App；从旧 Swift App 升级时，必须先通过私有 descriptor、启动 token 和精确命令验证并停止旧 injector，再停止旧 bundle 内精确匹配的 Panel server，不能遗留执行已删除路径的 PPID 1 进程。启动前必须验证当前 Codex Panel App 签名和打包 runtime，按 `Identifier=com.openai.codex`、`Identifier=codex` 和 `TeamIdentifier=2DC432GLL2` 校验官方 App 与内置 CLI，拒绝符号链接，并移除 Node、shell 与动态加载器注入变量；Windows 环境变量名必须按不区分大小写的语义过滤。Windows 正式发行必须通过 `CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT` 指定证书并由 Tauri 生成 Authenticode 签名的 NSIS 包；launcher 启动 runtime 前必须验证自身签名证书指纹，并用编译进签名 launcher 的 SHA-256 清单验证 Node、Panel runtime、`panelctl` 和 Skills，拒绝篡改或未列出的 runtime 文件。Panel 监听器由 Rust 预占并仅绑定回环地址，服务使用私有实例 token 和 secret；macOS injector 使用权限仅限当前用户的 v2 descriptor 与 token-authenticated Unix socket，Windows 必须保留供 `panelctl` 发现服务的 runtime descriptor，但 open/status/stop 只使用启动器持有的子进程控制管道，不得尝试创建 Unix socket。Tauri 必须持有 injector 进程组，只有 renderer 的当前 source hash、启动 token、挂载点和新鲜心跳全部匹配时才显示运行正常。macOS TCP 路径必须以 `--attach-existing` 发现并复用当前 Codex 的真实 CDP 端口，包括旧 Swift 迁移现场；没有可用 CDP 时才通过 LaunchServices 用随机回环端口启动官方 App，已经无 CDP 运行的 Codex 仍需完全退出后重试。停止或退出只终止 Tauri 拥有的 injector 和 Panel server，不退出官方 ChatGPT/Codex，也不修改 `ChatGPT.app` 或 `app.asar`。意外退出按 2、5、15 秒恢复，60 秒内第四次失败后停止。更新检查最多每 24 小时自动执行一次并持久化缓存，普通失败只缓存 5 分钟，匿名 API 限流缓存到 GitHub 返回的重置时间，手动检查必须绕过缓存；优先使用本机已登录的 `gh` CLI，失败后回退匿名 GitHub API，并区分额度耗尽、网络失败、暂无 Release、当前版本和可用更新。只接受 `shay-wong/codex-panel` 下规范化 `vX.Y.Z-fork.N` 标签和精确 Release URL，只能打开页面，不得下载或安装更新。macOS 签名优先级为 `CODEX_PANEL_CODESIGN_IDENTITY`、可复用的本机 Apple Development 身份、最后 ad-hoc；发布前必须运行 bundle preflight 校验 App、Node 签名与 Node JIT entitlement。非 macOS 环境应成功跳过 macOS App 安装。
- 打包依赖不变量：Tauri App 必须从实际打包的运行时代码自动发现并携带其直接导入的全部生产依赖；macOS、Linux 和 Windows 包验证必须在发布前检查这些依赖存在，不能依赖人工同步白名单，也不能让源码测试通过但安装态服务因 `ERR_MODULE_NOT_FOUND` 退出。
- Codex Skill mention 不变量：Panel 通过 Codex 原生 composer 创建 Skill mention 后，必须同时按 Skill 名称（允许 Codex 返回命名空间前缀）和规范化真实路径确认身份；用户 Skills 通过符号链接安装时，不能因为 catalog 的别名/链接路径与 composer 的命名空间 ID/真实路径不同而误报创建超时。
- Codex Skill mention 时序不变量：Codex 已接受 Skill 选择但异步渲染 mention 时，Panel 必须等待 mention 在 composer 中稳定落地后再继续；外层 host 请求预算必须覆盖该等待，不能先报错并留下半完成输入框。
- Panel 服务端口不变量：launcher-owned listener 优先绑定 `127.0.0.1:47823`，端口被占用时回退到随机回环端口；Codex CDP 始终使用独立的随机端口。
- Windows 上的 Panel 生命周期中断使用由 runtime 路径和启动 token 派生、并再次校验启动 token 的 named pipe；它只承载需要响应的 native Codex turn 中断，不替代 Tauri 持有的 open/status/stop 子进程控制管道。
- CI 触发约束：PR 分支通过 `pull_request` 运行完整 `Check`；`main` 的 `push` 先通过 GitHub REST 判断当前 SHA 是否为已合并 PR 的 `merge_commit_sha`，是则跳过已经在 PR 中完成的 Linux、macOS 和 Windows 检查，直接 push 则继续完整运行；来源判断失败必须使工作流失败，`workflow_dispatch` 继续完整手动重跑。
- 代码和测试路径：`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/Entitlements.plist`、`src-tauri/release.json`、`src-tauri/src/main.rs`、`src-tauri/icons`、`src-tauri/ui`、`.codex/environments/environment.toml`、`.github/workflows/check.yml`、`cli/panelctl.mjs`、`scripts/prepare-tauri-app.mjs`、`scripts/preflight-macos-app.mjs`、`scripts/verify-packaged-taskctl.mjs`、`scripts/install-macos-launcher.mjs`、`scripts/codex-injector-control.mjs`、`scripts/codex-injector.mjs`、`scripts/codex-injector-runtime.mjs`、`scripts/panel-supervisor.mjs`、`server/app.mjs`、`test/cli.test.mjs`、`test/launcher-ui.test.mjs`、`test/injector-control.test.mjs`、`test/injector.test.mjs`、`test/injector-host-runtime.test.mjs` 和 `package.json`。
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
- 窗口布局不变量：桌面端内嵌对话必须支持通过标题栏拖动、从上边和左边调整大小以及最大化或还原，并持久化普通窗口位置、尺寸和最大化状态；移动端保持全屏且不得覆盖桌面布局记录。对应路径为 `web/src/components/AiChat.tsx`、`web/src/styles.css` 和 `test/ai-chat-ui.test.mjs`；针对性验证应覆盖拖动、缩放、最大化、关闭重开、整页刷新和移动端全屏。
- 行为不变量：只允许把空闲对话关联到其原始项目中的活跃 Issue，运行中的对话不能改绑；打开关联菜单时必须按对话原始项目直接加载活跃 Issue，不得复用当前看板项目的任务数组。关联同时持久化 Issue ID 和编号。Issue 活动时间线只显示实际关联到当前 Issue 的本地对话，按最近活动时间与评论排序并计入活动数量，点击时必须打开对应线程；对话历史应显示关联编号。内嵌聊天中的 `/handoff` 和 `/交接` 必须复用同一 Codex 线程总结既有上下文，只在该轮成功并返回摘要后，以带稳定标记的 Codex Agent 评论写入 Issue 并广播活动更新；`--issue ISSUE-ID` 可以覆盖默认的关联 Issue。原 `$handoff` 在所有位置都只保留临时文档行为；独立的全局 `$handoff-panel --issue ISSUE-ID` 必须先完整执行原 Skill，再校验目标 Issue，并把同一份临时文档逐字通过 `panelctl` 写入 Issue；校验或写入失败时保留文档并报告部分失败。打开本地原生对话时必须按 Panel 当前界面语言预填 `$manage-panel`、Issue 编号、标题、最新交接和 `panelctl` 读取位置；打开 SSH 对话时必须按同一界面语言预填完整 Issue 快照。两种路径均不得显示内部路由标记或自动发送；未发送的输入框不算任务，第一次真实发送产生新 thread ID 后才能写回对应 binding，SSH Issue 同时才能变为处理中。
- 代码和测试路径：`server/ai-chat.mjs`、`server/app.mjs`、`server/database.mjs`、`inject/codex-panel.user.js`、`scripts/codex-injector.mjs`、`scripts/codex-injector-runtime.mjs`、`skills/manage-panel/SKILL.md`、`skills/handoff-panel/SKILL.md`、`skills/handoff-panel/scripts/publish-handoff.mjs`、`web/src/api.ts`、`web/src/App.tsx`、`web/src/components/AiChat.tsx`、`web/src/components/TaskDetail.tsx`、`web/src/styles.css`、`test/ai-chat-runner.test.mjs`、`test/handoff-panel-skill.test.mjs`、`test/injector-composer-prefill.test.mjs`、`test/injector-host-runtime.test.mjs` 和 `test/server.test.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：本次 Fork 能力；可用 `git log -S'bindThreadToIssue' -- web/src/components/AiChat.tsx server/ai-chat.mjs` 定位。
- 合并指引：上游调整 AI 对话模型、Issue 活动时间线或原生任务创建协议时，保留“按对话原项目加载活跃 Issue、运行时只读、双字段持久化、活动时间线反向入口、同线程交接摘要、显式目标路由、原 `$handoff` 不变、全局 `$handoff-panel` 基础优先且逐字复用临时文档、最新交接预填和新 thread 自动写回”的完整路径，不能只保留创建时关联。
- 移除条件：上游提供等价的对话改绑、取消关联、Issue 反向展示、交接记录、上下文预填和原生 thread 自动关联能力后同步移除。
- 针对性验证：运行 `node --test test/ai-chat-runner.test.mjs test/handoff-panel-skill.test.mjs test/injector-composer-prefill.test.mjs test/injector-host-runtime.test.mjs`、`npm run typecheck` 和 `npm run build`；在任意 Codex 对话中发送 `$handoff-panel --issue ISSUE-ID 重点说明`，确认原 `$handoff` 临时文档照常生成，随后目标 Issue 收到内容一致的交接评论；分别对本地和 SSH 项目点击“在对话中打开”，确认本地输入框包含 `$manage-panel`、Issue 编号、标题和最新交接，SSH 输入框包含完整 Issue 快照，两者均跟随 Panel 界面语言、不显示 `e-panel`、不自动发送；第一次真实发送后两者才显示新原生任务关联，SSH Issue 同时才变为处理中。

### 内嵌 AI 对话显示本地图片

- 生命周期：`等待上游吸收`
- 原始目的：让 AI 在本地生成的二维码、截图等图片可以直接显示在 Panel 内嵌对话中，不再被浏览器误解析为 Panel HTTP 路径。
- 行为不变量：只把已保存 AI 消息中由 Markdown AST 明确标识的绝对本地图片路径或 `file:` URL 改写为仅允许回环访问的 Panel API；请求只能携带 event ID 和该图片在原 Markdown 中的起始偏移，服务端必须重新解析已保存事件来取得路径，浏览器不能直接提交任意文件路径。只返回通过文件头确认的 PNG、JPEG、GIF 或 WebP，缺失或伪装文件必须拒绝；HTTP(S) 图片保留原地址，本地图片按对话宽度响应式缩放。
- 代码和测试路径：`server/ai-chat.mjs`、`server/app.mjs`、`server/database.mjs`、`web/src/api.ts`、`web/src/components/AiChat.tsx`、`web/src/styles.css`、`test/ai-chat-server.test.mjs` 和 `test/ai-chat-ui.test.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：本次 Fork 修复；可用 `git log -S'AI_CHAT_LOCAL_IMAGE_UNSUPPORTED' -- server/app.mjs test/ai-chat-server.test.mjs` 定位。
- 合并指引：上游调整 AI 消息 Markdown 渲染或本地资源访问时，继续保留“事件与源码偏移绑定、服务端重新解析、回环限制和真实图片格式校验”的读取边界，不能退化为接受浏览器绝对路径的通用文件接口。
- 移除条件：上游提供等价的本地图片显示能力，并保留事件绑定、回环访问和格式校验边界后同步移除。
- 针对性验证：运行 `node --test test/ai-chat-server.test.mjs test/ai-chat-ui.test.mjs`、`npm run typecheck` 和 `git diff --check`；在全新隔离数据目录中写入包含 URI 编码本地 PNG 路径的 AI 消息，确认图片显示且普通 HTTP(S) 图片不被改写，再确认伪装成图片的文本文件被拒绝。

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
- 行为不变量：一个 Jira 可以选择一个或多个具有本地 workspace 的项目并关联其中多个执行 Issue；每个执行 Issue 最多关联一个 Jira。仓库候选必须合并本机 Codex workspace 映射与已有 Panel 项目，使用与顶部项目菜单相同的可搜索、独立滚动选择组件；搜索过滤只能改变内部候选列表，不能改变管理弹窗的外框尺寸。尚未持久化的候选只能在用户显式保存关联时按需创建 Panel 项目。执行 Issue 的关联卡片必须返回 Panel 内的 Jira 需求，外部 Jira 入口保留在需求详情页。仓库变更必须先展示差异并等待显式保存，活动记录必须优先显示项目名称而不是内部 ID；普通关联不自动创建、迁移或删除 Issue。详情摘要关联多个仓库时必须稳定显示首个仓库和 `+N`，完整列表保留在悬停提示中。只有已保存至少一个仓库的待认领 Jira 才可一键创建并开始：Jira 先回写为进行中，每仓库复用唯一执行 Issue 或创建一个 backlog Issue 及独立正式 Codex 任务，全部仓库就绪后才统一释放到待认领。部分失败必须持久化保留进度，重试复用预留 Issue 与会话 ID、已有关联和对话，不重复回写或创建。右下角内嵌聊天只承载 `temporary` 临时问答；Jira 新建或重新规划、简单创建和队列执行必须登记为 `formal` 原生 Codex 任务并通过原生路由打开，不得回退到内嵌聊天或出现在临时聊天历史。规划未关联仓库时创建无项目任务，关联一个仓库时必须先选择对应的 Codex 项目再应用仓库 workspace，关联多个仓库时必须先选择目标项目；仅设置活动 workspace 不等同于关联 Codex 项目。新建与重新规划任务默认使用“帮我批准”（`workspace-write`）权限，已有规划任务继续复用其已保存权限。Panel 必须把 `grill-with-docs`、`to-spec`、`to-tickets` 和规划 prompt 填入可编辑输入框并保持未发送，只有用户手动发送后才启动 Codex；宿主预填确认成功后，injector 不得以重复且更严格的 DOM Skill mention 校验否定该结果或丢失 Jira 会话关联。Codex `skills/list` 漏掉 `~/.agents/skills` 下的直接符号链接目录时，Panel 必须从有效 `SKILL.md` 补齐本地 catalog；Codex 已返回的同名 Skill 保持优先，补齐项必须继续作为结构化 Skill 引用发送，不能退化为普通 `$名称` 文本。Spec 属于 Jira 的本地规划产物，发布前必须获得用户确认并为每个 ticket 选择已关联仓库。发布后的 Issue 以 backlog 创建，保留跨仓库阻塞关系并关联同一 Jira；规划不授权执行，与一键创建互斥。Jira 标题、描述、需求链接或仓库变化后必须复核，未开始 Issue 在此期间不得进入 `in_progress`；重新发布只取消被替代的 backlog 或 todo，保留 `in_progress`、`in_review`、`done` 和 `blocked` 成果、关系和可见告警，并把这些成果继续作为新规划约束。关联 Issue 只能移动到该 Jira 已选项目；归档保留关系，永久删除前必须解除。Jira 同步只更新外部需求镜像的 key、标题、原始状态、URL、同步时间和错误，不修改关联执行 Issue 的本地字段。
- Jira ID 路由不变量：任何对话收到完整 Jira ID 后都必须先通过 `jira planning get` 解析 `context.issues`，不得先用工作目录和 `context current` 猜测关联 Issue；该只读解析不授权 `jira planning save` 或 `jira planning publish`。
- 显式会话绑定不变量：主动创建的 Codex 会话只有在用户明确要求时才可通过 `panelctl conversation bind ISSUE_ID` 绑定 Panel Issue 或 Jira 需求；调用 Skill、提及或读取 Issue、评论 Issue、处于相同仓库均不得隐式绑定。本地已保存会话必须从其 Codex project assignment 与 session metadata 解析完整项目、主机和实际 worktree 身份，不得依赖当前打开 Panel 的其他会话；远端会话仍必须使用宿主提供的完整身份。普通 Issue 禁止覆盖其他会话；绑定 Jira 时只写需求自身的关联会话，不得新建、替换或恢复规划记录，也不修改 Jira 字段或状态。立即执行、自动认领和手动绑定产生的任务级对话统一显示在活动区，不得在详情正文重复提供固定入口；Jira 活动必须按真实 Codex thread ID 去重并同时显示规划会话与关联会话。
- 描述格式不变量：Jira 纯文本描述中以 `#` 开始的编号项必须按有序列表显示，普通 Panel Issue 的 Markdown 不得被改写。
- 规划启动与诊断不变量：即使尚未关联仓库，也必须允许规划会话在 Panel 管理的非 Git 工作目录启动；Codex 无法启动时必须显示其实际诊断，而不是只显示退出码。
- 生命周期控制不变量：Jira 进入进行中时只释放没有未完成前置依赖的 backlog frontier；回到待认领或在关联工作未完成时提前结束必须生成非破坏性确认。确认暂停后，`todo` 回到 `backlog`、`in_progress` 进入 `blocked`，macOS 和 Windows 上的活动 Codex turn 都会尝试中断，但代码、对话和 worktree 保留；个别 turn 中断失败不得回滚 Issue 暂停，必须显示失败数量供用户处理。Jira 再次进行中时恢复符合依赖条件的暂停 Issue。已完成 Jira 重新打开时保留历史 Issue 和对话，允许创建新的返工 Issue 与独立对话，既有复杂规划还可选择新的默认“帮我批准”规划会话；重新规划只有在新会话与可编辑草稿成功准备后才能替换旧计划并清除提醒，准备失败必须保留旧计划且允许重试，准备草稿不得自动启动 Codex。执行期间必须拒绝同一 Jira 的同步、仓库、关联和生命周期并发写入。重复 Jira 必须记录 canonical Jira，禁止一键执行与规划；已关闭但仍有关联且等待确认的重复 Jira 保持可见，迁移已有仓库和 Issue 关系必须显式确认，canonical 在当前同步账号不可访问时保留原关系。
- 自动完成不变量：Jira 设置中的自动完成默认关闭；只有至少一个关联 Issue 且所有关联 Issue 均为未归档的 `done` 时才可触发。Panel 必须先按 Jira `fields.updated` 重新读取远端，只有版本未变化且实时 transitions 中恰好一个操作映射到 `done` 时才回写，成功后再次读取确认。远端变化必须保留本地 `done` 并让用户选择接受完整远端状态或按最新远端版本仍然完成；transition 缺失、歧义或最终失败不得猜测或回滚本地 Issue。5xx、超时与 429 最多按 30 秒、2 分钟重试两次，最终错误和手动重试入口持久化可见。
- 对话归档不变量：Jira 设置中的自动归档默认关闭，只有开启后才在完成、同步或关联变化时自动执行；手动归档不受该开关影响。自动与手动都必须要求 Jira 为 `done`、至少关联一个执行 Issue、全部关联 Issue 都是未归档的 `done`，且仍存在未归档的相关对话，并统一归档该 Jira 的规划对话以及通过简单创建、自动认领或返工建立的执行对话。归档只把本地 AI 对话移出活跃列表，必须保留 thread、run、event 和 Codex thread ID；运行中的 turn 保留可见直到收尾，归档对话不得再启动新 turn。关闭开关不恢复已归档对话；Jira 重开后的返工或重新规划必须创建新的未归档对话，不能复用历史线程。
- 代码和测试路径：`shared/domain.mjs`、`server/database.mjs`、`server/ai-chat-catalog.mjs`、`server/ai-chat.mjs`、`server/ai-chat-process.mjs`、`server/app.mjs`、`server/jira-auto-complete.mjs`、`server/jira-integration.mjs`、`scripts/codex-injector.mjs`、`scripts/codex-injector-control.mjs`、`scripts/codex-injector-runtime.mjs`、`cli/panelctl.mjs`、`skills/manage-panel`、`web/src/App.tsx`、`web/src/api.ts`、`web/src/components/AiChat.tsx`、`web/src/components/JiraConnectionDialog.tsx`、`web/src/components/ProjectSelectionMenu.tsx`、`web/src/components/TaskDetail.tsx`、`web/src/styles.css`、`web/src/types.ts`、`test/ai-chat-runner.test.mjs`、`test/injector-control.test.mjs`、`test/injector-host-runtime.test.mjs`、`test/jira-auto-complete.test.mjs`、`test/jira-integration.test.mjs`、`test/jira-lifecycle.test.mjs` 和 `test/jira-planning.test.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：当前 Jira 外部需求关联、AI 规划与生命周期控制能力；提交后可用 `git log -S'jira_lifecycles' -- server/database.mjs` 定位生命周期扩展。
- 合并指引：上游调整 Jira 同步、Skill catalog、任务 schema、AI 对话列表、项目移动或详情侧栏时，保留外部需求与本地执行单元的边界、Jira 对执行 Issue 的一对多关系、执行 Issue 对 Jira 的至多一关系、仓库约束和显式保存，以及一键创建的幂等重试、正式任务与临时聊天隔离、0/1/多仓库规划选路、符号链接用户 Skill 的结构化引用、规划默认“帮我批准”但必须由用户发送草稿并显式发布、依赖 frontier 授权、非破坏性暂停和恢复、默认关闭的自动归档与独立手动入口、完成后仅隐藏活跃对话而不删除历史、重新打开后的新对话、重复任务 canonical 确认迁移、默认关闭且带远端版本检查的自动完成行为；不得把正式任务回退到内嵌聊天、把专用关系退化为同项目 Issue 关系、把显式 Skill 退化为普通文本、让规划隐式授权执行、让 Jira 回退删除本地状态，或让同步写入执行 Issue。
- 移除条件：上游提供等价的跨仓库 Jira 需求关联、双向详情维护、同步隔离和生命周期约束后同步移除。
- 针对性验证：运行 `node --test test/inject.test.mjs test/board-interactions.test.mjs test/jira-auto-complete.test.mjs test/jira-integration.test.mjs test/jira-lifecycle.test.mjs test/jira-planning.test.mjs test/server.test.mjs`、`npm run typecheck` 和 `npm run build:web`；在 Jira 详情选择多个仓库、保存并关联执行 Issue，确认双方详情可打开和解除关系，仓库差异不会在保存前生效，普通 Issue 详情保持紧凑。使用本地 Jira 响应端让第二个仓库首次失败并重试，确认 Jira 只转换一次、每仓库只有一个 Issue 和一个对话，而且首次失败时没有 Issue 提前进入待认领。在隔离预览中验证 Jira 规划会话、Spec、生命周期提醒和 390px 关联弹窗；确认单仓库规划会话同时选中对应 Codex 项目并使用其 workspace，仓库搜索前后弹窗外框尺寸不变。确认 Jira 回退后的暂停会中断活动 turn 并保留本地状态，再次进行中只释放依赖 frontier，重新打开可创建返工 Issue 或新的规划会话，重复任务迁移前要求确认且 canonical 不可访问时保留原关联。开启 Jira 自动完成后，验证全部关联 Issue 为 `done` 才触发唯一完成 transition，远端变化显示接受远端与仍然完成，失败保留本地 `done` 和重试入口。自动归档保持默认关闭，手动按钮只在完成条件满足时可用；开启后立即扫描既有资格项，关闭后不恢复历史。整体验收使用全新隔离 Panel 数据、Codex 状态、临时仓库和进程内 Jira fake，实测一个待认领 Jira 一次创建两个仓库 Issue 和两个不同对话，暂停与恢复保留关联 worktree，重复 Jira 禁止规划与执行，自动完成冲突保留本地完成状态并显示远端/Panel 版本；在 `1280x720` 深浅主题和 `390x844` 窄视口确认关键状态、操作和提示无横向溢出。

### Panel 持久化自动执行队列

- 生命周期：`等待上游吸收`
- 原始目的：由 Panel 自己保存自动认领策略、执行队列和尝试记录，统一承接普通 Issue、Jira 授权 Issue 与手动立即执行，不再让 Codex Scheduled Task 充当执行核心。
- 行为不变量：仓库项目的自动化策略必须持久化保存开关、项目暂停、5/10/15/30/60 分钟扫描间隔、模型和推理强度，并展示排队、运行、阻塞和失败数量；Jira 项目和 Cloud 模式不可配置。全局默认项目并行数为 `3`，用户可在 `1-8` 内修改；每个项目可跟随默认值或设置自己的 `1-8` 覆盖值，不设跨项目总上限。周期扫描只纳入未关联 Jira 的本地 `todo` Issue；Jira 关联 Issue 只有在 Jira 为进行中且没有待处理生命周期决定时才可进入队列。关闭自动认领只阻止新的自动入队，已有队列继续调度；详情页“立即执行”和 Jira 简单一键创建使用 `manual` 来源，即使自动扫描关闭也可入队，但项目暂停仍阻止全部调度。队列先处理手动与恢复来源，Jira 与扫描来源再按 Issue 优先级、看板顺序和入队时间调度；达到项目容量时 Issue 保持 `todo` 并显示等待槽位。正式执行必须在关联仓库对应的 Codex 原生项目中选择“新建本地工作树”后提交包含 `manage-panel` 与 `implement` 的提示，使 Codex 环境初始化脚本生效；Panel 不得自行创建 worktree，只能在 Codex 返回后持久化真实 thread binding、worktree 路径和分支。Jira 关联 Issue 必须以 Jira external key 作为任务标题、执行提示和分支命名要求，不能以 Panel Issue 标识替代。临时启动或连接失败最多按 30 秒、2 分钟重试两次；其他失败将 Issue 和队列移入阻塞并记录 Agent 评论。用户评论或用户对话完成后恢复阻塞执行；如果评论早于运行 turn 完全收尾，恢复请求必须先持久化并在收尾时消费，不能丢失。服务重启必须记录中断尝试，只在原对话、执行记录和开发上下文一致时恢复，否则阻塞且不得创建替代对话。worktree 在 `in_review` 保留；Issue 为 `done` 后只在 worktree 干净且分支已合入 `origin/main` 或本地 `main` 时自动移除。项目容量只约束 Panel 的一键执行与自动认领，不限制用户自建 Codex 任务或 Scheduled Task；迁移旧自动化时也只能暂停 Panel 本地记录的具体 automation ID。
- 代码和测试路径：`server/ai-chat.mjs`、`server/app.mjs`、`server/database.mjs`、`server/claim-queue.mjs`、`web/src/App.tsx`、`web/src/api.ts`、`web/src/components/ProjectAutomationMenu.tsx`、`web/src/components/TaskDetail.tsx`、`web/src/styles.css`、`web/src/types.ts`、`test/claim-queue.test.mjs` 和 `test/project-automation-settings.test.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：当前 Panel 持久化自动执行能力；提交后可用 `git log -S'default_project_parallelism' -- server/database.mjs` 定位本次项目并行扩展。
- 合并指引：上游调整项目自动化、原生 Codex 对话、开发上下文或 Jira 放行路径时，保留“Panel 持久化策略与队列、四类来源稳定排序、默认与项目覆盖容量、无跨项目总上限、Codex 原生 worktree 与环境初始化、真实 thread/worktree/branch 回写、Jira Key 分支上下文、保守重启、有限重试、用户输入恢复、项目暂停总闸、只处理已知旧 automation ID”的边界；不得恢复 Panel 自建 worktree、由 Scheduled Task prompt 查询和认领 Issue，也不得触碰或宣称限制用户自建任务。
- 移除条件：上游提供等价的 Panel 持久化队列、项目容量、workspace/worktree 隔离、手动与 Jira 入队、对话复用、保守重启、有限重试、阻塞恢复和安全旧自动化迁移后同步移除。
- 针对性验证：运行 `node --test test/claim-queue.test.mjs test/inject.test.mjs test/injector-composer-prefill.test.mjs test/injector-host-runtime.test.mjs test/project-automation-settings.test.mjs`、`npm run typecheck`、`npm run build:web` 和 `npm test`；测试必须同时证明默认项目并行数和项目覆盖独立生效、不同项目不共享总上限、槽位释放后等待项继续运行、原生 claim reservation 不会重复派发、Codex 返回前 Issue 与开发上下文不提前变更、返回后真实 thread/worktree/branch 一次性绑定，以及 Jira Key 进入任务和分支上下文。在全新隔离数据目录和临时仓库中确认 Codex 原生“新建本地工作树”触发项目环境初始化、Panel 不自行创建 worktree、多 Skill mention 按 name 与 path 正确插入、等待槽位保持 `todo`，并确认 `done` 仅清理干净且已合并的 worktree。

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
- 截至上游 `1.1.6`，Tauri/Rust 桌面基础、新版 AI Composer、Agent/Skill/命令补全、可搜索 Issue 关系选择器、富文本剪贴板、项目 README、全项目视图、Linux 桌面打包、WSL CLI 访问 Windows launcher 和 Issue 跨项目移动已经进入 Fork；自动 updater 安装、上游发布工作流、`taskctl` 主命名和与 Fork 发布策略冲突的打包入口仍明确排除。
- 上游 `1.1.6` 的单连接 Jira REST 基础同步、直接回写、主题化 Issue 属性菜单和 Issue 跨项目移动已经等价吸收；Fork 仅继续维护本文记录的可靠同步、Bearer 认证和跨仓库关联扩展。
