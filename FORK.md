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
- 本次合并的上游父提交：`0ddec1f2ccc2effa420882ef7a2d84e5d22258dd`
- 精确已合并上游基线：`0ddec1f2ccc2effa420882ef7a2d84e5d22258dd`
- 比较范围：`0ddec1f2ccc2effa420882ef7a2d84e5d22258dd..HEAD`

持续移动的 `upstream/main` 只有在祖先关系证明它与上述 SHA 相同时才是本文档基线；后续新提交仍属于待合并候选。合并提交本身的 Fork 侧父提交不是比较基线。

本次上游合并吸收了 `0.2.0` 的 Dashboard、列表、甘特图、日期、项目移动、完整活动流、云端迁移、AI 进程回收、私有 CDP pipe 与不透明 iframe 加固，并继续吸收 `0.2.1` 的 Dashboard 运行会话对齐、归档删除原子性、自动认领生命周期、搜索清除、Gantt 响应与清理、暗黑图标等修复。上游的 Tauri App、updater、发布工作流和 `taskctl` 打包链与 Fork 已有 Swift 管理器冲突，未纳入 Fork 产品入口；其中有价值的有限恢复、运行状态和更新发现能力已按 Swift 管理器现有生命周期重新实现。私有 CDP pipe 仍保留在 Node 启动器中，但没有用于 Swift 管理器，因为它无法在管理器退出而 ChatGPT 继续运行后重新接管。

## Fork 发布版本策略

- 权威上游版本来源：精确合并基线中的 `package.json`
- 当前 Fork 版本来源：`package.json` 和 `package-lock.json` 的根包条目
- 精确基线的上游版本：`0.2.1`
- 当前 Fork 版本：`0.1.0`
- 匹配的 Fork 标签或 GitHub Release：无

每个 Fork 发布版本都必须使用 `<upstream-version>-fork.<N>`。上游版本变化时从 `fork.1` 开始；同一上游版本的后续 Fork 发布递增 `N`。已准备但尚未发布的版本号在未被占用时可以保留。

当前不带后缀的 `0.1.0` 不是有效的 Fork 发布版本，并且落后于已合并上游的 `0.2.1`。下一个规范化 Fork 发布版本是 `0.2.1-fork.1`。不得仅因本次合并修改版本文件；只能在已授权的发布任务中更新。

## 活跃 Fork 能力

### 使用 Codex Panel 产品与仓库名

- 生命周期：`长期保留`
- 原始目的：让浏览器标题、中英文仓库入口和 GitHub 仓库使用 Fork 项目名 `Codex Panel` / `codex-panel`，避免继续显示旧 Fork 名或上游通用名称。
- 行为不变量：`web/index.html`、中英文 README、Skill、CLI、环境变量、注入协议、本地存储、SQLite 和尚未部署的 Cloudflare 资源统一使用 `Codex Panel` / `panel` / `manage-panel` / `panelctl` / `CODEX_PANEL_*`；旧浏览器键、环境变量、自动任务名称及本仓库管理的旧链接必须自动迁移或兼容读取，不能因改名丢失本地状态。数据库只使用已完成改名的 `panel.sqlite`，不再保留旧数据库文件名迁移逻辑；用户级默认数据位置统一为固定支持目录，首次自包含安装只做一次在线快照且保留仓库源数据。
- 代码和测试路径：`web/index.html`、`package.json`、`package-lock.json`、`skills/manage-panel`、`cli/panelctl.mjs`、`server/index.mjs`、`server/app.mjs`、`shared/panel-paths.mjs`、`web/src/storageMigration.ts`、`scripts/install-macos-launcher.mjs`、`scripts/managed-install.mjs`、`scripts/panel-supervisor.mjs`、`scripts/codex-rate-limits.mjs`、`cloud/src/index.mjs`、`test/integration-installer.test.mjs`、`test/panel-supervisor.test.mjs` 和 `test/panel-naming.test.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md`、`docs/fork-capabilities.md` 和 `docs/cloud-collaboration.md`。
- 来源：Fork 初始定制及本次改名；可用 `git log -S'<title>Codex Panel</title>' -- web/index.html` 定位。
- 合并指引：合并上游 HTML、包清单和服务入口改动时保留 Panel 主命名和上述单向迁移边界；旧名称不能重新成为新写入或用户文档的主入口。
- 移除条件：Fork 更名或停止作为独立产品维护时同步更新或移除。
- 针对性验证：运行 `npm run build:web`，确认 `dist/web/index.html` 包含 `<title>Codex Panel</title>`，并确认 GitHub 仓库与本地目录都使用 `codex-panel`。

### 原生 macOS Codex Panel 管理器

- 生命周期：`长期保留`
- 原始目的：提供一个可见、可持续运行的 `~/Applications/Codex Panel.app` 原生管理器，让用户查看本地服务与内嵌状态、控制启动和停止、配置登录项，并在不运行终端命令的情况下启动带 Panel 的官方 Codex。
- 行为不变量：macOS 上只有显式 `npm run codex:install` 创建或刷新 `~/Applications/Codex Panel.app`；`npm ci` 不得写入用户应用或全局集成。安装器只删除带本项目 marker 或旧兼容 bundle id 的受管 `~/Applications/Codex.app`，不得覆盖其他同名用户应用。管理器使用 bundle id `com.shay.codex-panel`，作为普通前台 Dock 应用提供 Panel 服务、Codex/CDP 和内嵌集成状态，以及打开 Panel、启动、重启、停止、打开浏览器、日志和数据目录的控制；设置通过 `SMAppService` 管理登录项，并分别保存“启动时连接 Codex”和“连接后打开 Panel”，两项默认开启。意外退出恢复固定使用 2、5、15 秒退避，60 秒内超过三次后停止恢复并显示日志提示。更新页必须显示完整 Fork 版本，在启动时至多检查一次并支持手动检查；只有 `https://github.com/shay-wong/codex-panel/releases/tag/<version>` 可打开，在存在固定 updater 公钥、签名且已公证的发布 archive 前不得自动下载或替换 App。`CFBundleShortVersionString` 只保存数字核心版本，完整 prerelease 必须写入 `CodexPanelVersion` 并纳入 bundle 复用 marker 与元数据校验。SwiftPM 源码、构建脚本和 Codex Run action 分别位于 `macos/CodexPanelLauncher`、`script/build_and_run.sh` 和 `.codex/environments/environment.toml`。安装 bundle 必须包含受签名保护的 runtime，只通过相对资源路径读取，不得执行支持目录或源仓库中的可写脚本；每次启动子进程前必须验证管理器 App 签名、runtime 无符号链接和安装时固定的 Node.js SHA-256。官方 `ChatGPT.app` 及其内置 Codex CLI 必须分别通过安装时记录的 OpenAI designated requirement，路径必须是无符号链接且位于固定的已签名 App bundle 内；同一 OpenAI 身份签名的正常版本更新无需重新安装 Panel，未签名修改、签名身份变化和路径逃逸必须拒绝。管理器还必须从继承环境中移除 `NODE_OPTIONS`、`NODE_PATH`、`NPM_CONFIG_NODE_OPTIONS`、`BASH_ENV`、`ENV`、`ZDOTDIR` 和所有 `DYLD_*` / `LD_*` 加载器变量；子进程的 `CODEX_PANEL_PORT` 必须强制使用安装配置中的端口，旧 `CODEX_TASKBOARD_PORT` 不得覆盖它。明暗图标必须精确取自官方 `ChatGPT.app` 的 `icon-codex-light.png` 与 `icon-codex-dark-color.png`，缺少任一资源即失败；两个变体使用同一套两端贴边裁切的 45 度右上角 `PANEL` 色带，运行中的 Dock 图标必须随 `effectiveAppearance` 切换。签名优先级固定为 `CODEX_PANEL_CODESIGN_IDENTITY`、当前 bundle 的真实且仍可用 signer、唯一匹配全局 Git 邮箱的 Apple Development 身份、最后才是 ad-hoc；marker 必须记录真实 designated requirement，只有真实 signer、requirement、bundle 元数据和内容摘要全部匹配的稳定签名 bundle 才能跳过重建，ad-hoc 不得冒充稳定权限身份。启用自动连接或手动启动时必须发现 Codex 实际 CDP 端口；所有一次性 injector 命令必须分离 stdout 与 stderr，只解析纯 stdout，并在有限超时后终止，不能让 Node 警告污染 JSON 或永久阻塞启动。renderer 返回的 WebSocket 地址必须是同一选定端口上的精确 `ws://127.0.0.1:<port>/devtools/` 地址。Swift 管理器继续使用可重连的回环 TCP CDP；私有 pipe 只能由同一 injector 持有整个 ChatGPT 生命周期，因此在“管理器退出但 ChatGPT 保留”的产品约束下不得启用。只退役命令行包含当前绝对 injector 路径、`--watch` 和选定端口的 Panel resident，并在发信号前重新验证这三项；相对路径、其他仓库副本及其他端口进程均视为用户或外部进程。管理器拥有的 injector 另通过固定数据目录下权限为 `0600` 的 v2 描述文件和 Unix socket 接受 `status`、`open`、`shutdown`，请求必须携带启动 token；控制客户端写入请求后必须保持连接，直到异步 handler 回包或超时，不能提前半关闭 socket。控制或发信号前必须验证固定 Node 路径、injector 绝对路径、`--watch` 与启动 token，`SIGTERM` 和 `SIGKILL` 前分别再次验证，v1 描述文件只能退回精确 resident 清理而不能直接控制进程。启动前如描述文件 PID 仍存在但首次命令校验已不属于当前 Panel injector，必须只删除旧描述文件并继续，不得向该 PID 发信号；进入受管停止流程后仍须在每次信号前重新校验，失败时必须中止。关闭自动连接时不得清理 resident。管理器必须持有 injector 进程所有权，打开 Panel 只能请求现有 renderer，不得切换为 detached resident。“内嵌集成已连接”必须同时验证当前 source hash、管理器启动 token、renderer 挂载点和新鲜心跳，不能只凭进程、CDP 与 HTTP。停止、退出和开发重装必须按顺序等待 injector 与 Panel 子进程结束并关闭对应日志句柄；开发重装至少等待 30 秒，超时后只可强制终止启动时捕获且仍精确匹配 `CodexPanelLauncher` 可执行文件的 PID，绝不能操作 ChatGPT。不得遗留 PPID 1 Panel 服务；由管理器冷启动的官方 ChatGPT/Codex 必须通过 `/usr/bin/open` 交给 macOS LaunchServices 启动，不得由 injector 直接 `spawn` 官方可执行文件，使 ChatGPT/Codex 自己承担 TCC 权限归因，并使用独立进程组脱离 injector 生命周期；关闭管理器不得退出官方应用。为满足这一产品约束，启用 CDP 的 ChatGPT 及其无认证本机 CDP 会持续到用户退出 ChatGPT，因此该实例整个运行期间只能运行可信本地代码。正常打开且无 CDP 的 Codex 必须提示完全退出后重试；官方 `/Applications/ChatGPT.app` 和 `app.asar` 不得修改。首次 renderer 注入必须等待初始 `app://` 文档进入 `complete`，再启用 CSP bypass、注册 document-start 脚本并受控 `Page.reload` 一次；首次注入和接管已有 renderer 都不得省略这次 reload。显式自动打开请求必须与 reload 前已有可见状态取并集，不能在接管 renderer 时被丢弃。Local Network Access 兼容、自动打开单次消费和退役连接释放继续遵守既有不变量。非 macOS 环境应成功跳过 App 生成。
- 代码和测试路径：`macos/CodexPanelLauncher`、`macos/CodexPanelLauncher/Sources/CodexPanelLauncher/Services/OneShotCommandRunner.swift`、`macos/CodexPanelLauncher/Tests/CodexPanelLauncherTests/LauncherConfigurationTests.swift`、`macos/CodexPanelLauncher/Tests/CodexPanelLauncherTests/OneShotCommandRunnerTests.swift`、`macos/CodexPanelLauncher/Tests/CodexPanelLauncherTests/PanelProcessEnvironmentTests.swift`、`script/build_and_run.sh`、`.codex/environments/environment.toml`、`.github/workflows/check.yml`、`scripts/install-macos-launcher.mjs`、`scripts/codex-cdp-pipe.mjs`、`scripts/codex-injector-control.mjs`、`scripts/codex-injector.mjs`、`scripts/codex-injector-runtime.mjs`、`scripts/panel-supervisor.mjs`、`scripts/codex-rate-limits.mjs`、`server/app.mjs`、`test/integration-installer.test.mjs`、`test/codex-cdp-pipe.test.mjs`、`test/injector-control.test.mjs`、`test/injector.test.mjs`、`test/injector-host-runtime.test.mjs`、`test/ai-chat-server.test.mjs` 和 `package.json`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：原自动生成启动器能力及本次原生管理器替换；提交后可用 `git log -S'CodexPanelLauncher' -- macos/CodexPanelLauncher scripts/install-macos-launcher.mjs` 定位。
- 合并指引：上游调整安装、注入器或 macOS 入口时，保留“显式安装原生前台管理器”“签名 bundle runtime、Node 哈希固定、ChatGPT 与内置 CLI 跨版本签名身份及包内路径校验、净化执行环境”“服务状态与控制 UI”“有限恢复与可信 Release 检查”“完整 Fork 版本与数字 macOS 版本分离”“登录项和两个独立自动连接选项”“官方明暗图标和对称斜角标”“真实 signer 与 designated requirement 一致才复用”“CDP HTTP 与 WebSocket 精确同端点”“受 token 保护的用户专属 socket、进程所有权和信号前二次校验”“resident 绝对路径、端口和发信号前身份复核”“renderer token/心跳就绪”“打开不脱管”“退出等待受管子进程且保留官方应用”“开发超时只强制终止原启动器 PID”“管理器冷启动经 LaunchServices 且 TCC 不归因给 Panel”“受管旧入口才可删除”“首次注入等待 bootstrap 后单次 reload”“自动打开只消费一次”这些行为不变量；不得恢复短生命周期 AppleScript 引导器、由 injector 直接执行官方 ChatGPT 可执行文件、执行外部可写 runtime、把正常 OpenAI 签名更新误判为必须重装、在发布信任链不完整时自动替换 App、仅靠变化的 ad-hoc `cdhash` 维持权限身份，或把 CDP 可达误报为注入成功。
- 移除条件：Fork 不再支持 macOS Codex 内嵌，或上游提供等价的原生本地管理器能力时同步移除。
- 针对性验证：运行 `node --test test/integration-installer.test.mjs test/injector-host-runtime.test.mjs test/injector.test.mjs`、`/usr/bin/xcrun swift test --package-path macos/CodexPanelLauncher`、`/usr/bin/xcrun swift build --package-path macos/CodexPanelLauncher --configuration release` 和 `./script/build_and_run.sh --verify`。检查 `~/Applications/Codex Panel.app/Contents/Info.plist` 的 bundle id、可执行文件、`CFBundleIconFile=CodexPanel` 与 `NSRequiresAquaSystemAppearance=false`，确认两个生成图标、两个官方基础 PNG、`launcher-config.json` 和 `Resources/runtime` 存在。使用 `codesign --verify --deep --strict` 和 `codesign -d -r-` 检查签名与 requirement；稳定签名环境立即重复安装时必须输出 `Codex Panel launcher already current` 且可执行 inode 和 requirement 不变。篡改 Node 或改为符号链接时 Swift 测试必须拒绝；同一 requirement 重新签名的 ChatGPT 测试更新必须接受，未重新签名修改、不同身份和包外路径必须拒绝。环境测试必须证明 Node、shell 和动态加载器注入变量被移除，Panel 端口固定为安装配置。CDP 测试必须拒绝远端主机、错误端口、凭据、fragment 和非精确回环别名；resident 测试必须拒绝相对路径及其他仓库副本；开发重装测试必须证明生产等待固定为至少 30 秒，并且超时只终止目标启动器且保留无关进程。管理器冷启动测试必须证明 TCP 路径调用 `/usr/bin/open -W -n -a <ChatGPT.app> --args ...`，且不直接 `spawn` 官方可执行文件；真实冷启动后 ChatGPT 应由 LaunchServices 托管，后续 TCC 请求不得归因给 `com.shay.codex-panel`。打开管理器确认状态只有在 renderer 心跳就绪后显示已连接，并确认 frame tree 中不存在 `chrome-error://chromewebdata/` 或 `ERR_BLOCKED_BY_CSP`；复用非 9229 CDP 时不得停止其他端口；从管理器打开 Panel 不得产生 detached injector。最后停止和退出管理器，确认其负责的服务与 injector 均退出且没有 PPID 1 残留，同时官方 ChatGPT/Codex 仍继续运行。

### 自包含安装 Panel runtime、Skills 与 CLI

- 生命周期：`长期保留`
- 原始目的：让用户通过一个明确的集成安装命令得到不依赖 Git 仓库路径的可运行副本，无需手工复制 Skill 或执行 `npm link`；新的 Codex 任务可以直接调用 `$manage-panel` 和 `$handoff-panel`，并能从 shell 找到两者依赖的 `panelctl`。
- 行为不变量：`npm ci` 只安装项目依赖，不得调用集成安装器。显式 `npm run codex:install` 必须先构建最小生产 runtime 并原子复制到固定用户支持目录，再把 `manage-panel` 与 `handoff-panel` 作为真实受管副本安装到标准 `~/.agents/skills`，把真实受管 wrapper 安装到 `~/.local/bin/panelctl`，最后清理确认属于本项目的旧 `~/.codex/skills`、`taskctl` 和 Node-bin 软链接。runtime、Skills、CLI 和启动器均不得指回源仓库；重复安装只更新带 Panel 所有权标记的目标，其他软链接、真实文件和目录必须保留或拒绝覆盖。首次安装且固定数据目录不存在时，必须使用 SQLite 在线备份复制仓库现有数据，并保留源数据；已有目标数据不得覆盖。`handoff-panel` 只读取 `~/.agents/skills/handoff/SKILL.md`，不得复制或修改第三方 `$handoff`；必须先完成基础 Skill 并保留其临时文档，再校验和发布 Panel 评论，评论中的文档内容不得裁剪或重写，后续失败不得破坏基础交接结果。
- 代码和测试路径：`scripts/install-macos-launcher.mjs`、`scripts/managed-install.mjs`、`shared/panel-paths.mjs`、`package.json`、`skills/manage-panel/SKILL.md`、`skills/handoff-panel/SKILL.md`、`skills/handoff-panel/scripts/publish-handoff.mjs`、`test/integration-installer.test.mjs`、`test/handoff-panel-skill.test.mjs` 和 `cli/panelctl.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：本次 Fork 能力；可用 `git log -S'handoff-panel' -- scripts/install-macos-launcher.mjs skills/handoff-panel package.json` 定位。
- 合并指引：上游修改依赖或启动器安装时，保留“依赖安装不触发用户级写入”“runtime、两个 Panel Skills、CLI、启动器由显式同一入口安装”“安装副本不依赖仓库路径”“受管目标可原子刷新”“用户目标不覆盖”“第三方 `$handoff` 不修改”六个不变量，不能只保留启动器生成。
- 移除条件：上游提供等价的自包含 Panel runtime、Skills 与 CLI 安装能力，或 Fork 不再通过本地 Skill 管理及交接 Issue 时同步移除。
- 针对性验证：运行 `node --test test/integration-installer.test.mjs test/handoff-panel-skill.test.mjs test/panel-naming.test.mjs`，确认包清单没有 `postinstall` 且仍保留 `codex:install`；使用临时用户目录运行两次安装逻辑，确认 runtime、两个 Skill 和 `panelctl` 都是可原子更新的真实副本，旧托管链接被清理，用户自有同名目录被保留，并确认在线 SQLite 快照不覆盖已有目标数据。最后检查安装结果和 `launcher-config.json` 均不含源仓库路径。

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
- 原始目的：修复 Codex 会话页的主内容 frame 覆盖原生标题栏时，Panel 入口变为选中但页面没有挂载，以及 Panel 激活后通过全局命令菜单无法返回对话、插件、设置等原生目的地的问题。
- 行为不变量：主内容 frame 只要覆盖大部分 viewport 就可以作为挂载锚点，不得因其顶部位于原生标题栏上方而拒绝；会话页、Plugins 和 Sites 均能直接切换到 Panel。Panel 激活时，从全局命令菜单以鼠标或 Enter 选择对话、工作、Codex、设置、技能、已安排任务、新会话等简中、繁中或英文原生目的地，或选择会改变原生页面路径的其他命令，都必须先恢复原生内容；主题、复制等非导航命令及普通 History 状态同步不得关闭 Panel。当前 App DOM 只暴露本地化标题而不暴露稳定命令 ID，因此其他界面语言留待 Codex 提供稳定标识后支持。
- 代码和测试路径：`inject/codex-panel.user.js`、`test/inject.test.mjs`。
- 用户文档：`README.md` 和 `README.zh-CN.md` 的“Embed in Codex”/“嵌入 Codex”章节，以及 `docs/fork-capabilities.md`。
- 来源：本次 Fork 修复；可用 `git log -S'conversation content frames can host Panel' -- test/inject.test.mjs` 和 `git log -S'handleNativeDestinationCommand' -- inject/codex-panel.user.js` 定位。
- 合并指引：上游调整 Codex 主内容 DOM 或命令菜单时，应以页面实际覆盖范围和真实命令选择事件为准，不能重新要求 frame 位于原生标题栏下方，也不能通过全局 History 包装判断命令导航；若命令菜单暴露稳定命令 ID，应以 ID 替代本地化标题并补全其他语言。
- 移除条件：上游提供等价的跨会话页和原生页面双向切换逻辑，并覆盖会话 frame 从 viewport 顶部开始、命令菜单鼠标与 Enter、非导航命令和 History 状态同步场景。
- 针对性验证：运行 `node --test --test-name-pattern='conversation content frames|command-menu native destinations' test/inject.test.mjs`，并从实际 Codex 会话点击 Panel，再通过全局命令菜单分别选择对话、插件和设置，确认原生目的地可见；执行主题切换时 Panel 应保持打开。

### 内嵌 AI 对话关联议题

- 生命周期：`等待上游吸收`
- 原始目的：允许已有本地 AI 对话在创建后继续关联、改绑或取消关联 Issue，让 Issue 活动时间线直接显示和打开处理它的内嵌对话，并把讨论结论可靠交接给后续原生 Codex 任务。
- 行为不变量：只允许把空闲对话关联到其原始项目中的活跃 Issue，运行中的对话不能改绑；打开关联菜单时必须按对话原始项目直接加载活跃 Issue，不得复用当前看板项目的任务数组。关联同时持久化 Issue ID 和编号。Issue 活动时间线只显示实际关联到当前 Issue 的本地对话，按最近活动时间与评论排序并计入活动数量，点击时必须打开对应线程；对话历史应显示关联编号。内嵌聊天中的 `/handoff` 和 `/交接` 必须复用同一 Codex 线程总结既有上下文，只在该轮成功并返回摘要后，以带稳定标记的 Codex Agent 评论写入 Issue 并广播活动更新；`--issue ISSUE-ID` 可以覆盖默认的关联 Issue。原 `$handoff` 在所有位置都只保留临时文档行为；独立的全局 `$handoff-panel --issue ISSUE-ID` 必须先完整执行原 Skill，再校验目标 Issue，并把同一份临时文档逐字通过 `panelctl` 写入 Issue；校验或写入失败时保留文档并报告部分失败。打开原生对话时必须预填 Issue 编号、标题、最新交接和 `panelctl` 读取位置；未发送的输入框不算任务，第一次发送产生新 thread ID 后才自动写回 Issue。
- 代码和测试路径：`server/ai-chat.mjs`、`server/app.mjs`、`server/database.mjs`、`inject/codex-panel.user.js`、`skills/manage-panel/SKILL.md`、`skills/handoff-panel/SKILL.md`、`skills/handoff-panel/scripts/publish-handoff.mjs`、`web/src/api.ts`、`web/src/App.tsx`、`web/src/components/AiChat.tsx`、`web/src/components/TaskDetail.tsx`、`web/src/styles.css`、`test/ai-chat-runner.test.mjs` 和 `test/handoff-panel-skill.test.mjs`。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：本次 Fork 能力；可用 `git log -S'bindThreadToIssue' -- web/src/components/AiChat.tsx server/ai-chat.mjs` 定位。
- 合并指引：上游调整 AI 对话模型、Issue 活动时间线或原生任务创建协议时，保留“按对话原项目加载活跃 Issue、运行时只读、双字段持久化、活动时间线反向入口、同线程交接摘要、显式目标路由、原 `$handoff` 不变、全局 `$handoff-panel` 基础优先且逐字复用临时文档、最新交接预填和新 thread 自动写回”的完整路径，不能只保留创建时关联。
- 移除条件：上游提供等价的对话改绑、取消关联、Issue 反向展示、交接记录、上下文预填和原生 thread 自动关联能力后同步移除。
- 针对性验证：运行 `node --test test/ai-chat-runner.test.mjs test/handoff-panel-skill.test.mjs`、`npm run typecheck` 和 `npm run build`；在任意 Codex 对话中发送 `$handoff-panel --issue ISSUE-ID 重点说明`，确认原 `$handoff` 临时文档照常生成，随后目标 Issue 收到内容一致的交接评论；点击“在对话中打开”，确认输入框包含最新交接，第一次发送后 Issue 自动显示新原生任务关联。

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

### 主题化 Issue 属性菜单

- 生命周期：`等待上游吸收`
- 原始目的：替换 Chromium 原生下拉层，修复暗黑模式下菜单变白且视觉与 Codex / Panel 不一致的问题。
- 行为不变量：状态、优先级、负责人、工作流、开发上下文和重复周期使用同一套 Panel 菜单；菜单必须使用现有主题变量，保留选中图标、键盘导航、点击外部关闭和上下自适应定位，并在桌面与窄屏视口内完整显示。`Escape` 只关闭当前菜单，不关闭 Issue 详情。
- 代码和测试路径：`web/src/components/TaskPropertyPicker.tsx`、`web/src/components/TaskDetail.tsx` 和 `web/src/styles.css`。本次按仓库直接路径确认规则未新增自动化测试。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：本次 Fork 修复；可用 `git log -S'TaskPropertyPicker' -- web/src/components/TaskDetail.tsx web/src/components/TaskPropertyPicker.tsx` 定位。
- 合并指引：上游调整 Issue 侧栏属性控件时，不得退回依赖浏览器原生 `<select>` 弹层；继续复用主题变量和紧凑属性行布局，并验证暗色、窄屏和 `Escape` 行为。
- 移除条件：上游提供等价的主题化属性选择控件及明暗主题、键盘和响应式行为后同步移除。
- 针对性验证：运行 `npm run typecheck` 和 `npm run build`；在暗色 Issue 详情中打开状态菜单，确认浮层颜色、图标和间距与 Panel 一致，再按 `Escape` 确认只关闭菜单；以 600px 宽视口确认菜单不溢出。

### 本地 Jira provider 注册

- 生命周期：`长期保留`
- 原始目的：为后续由 Jira CLI 和 Scheduled Task 驱动的导入与回写提供多实例、非凭据型配置入口，同时保持 Jira 凭据由 CLI 自己管理。
- 行为不变量：每个 provider 使用不可变的 lowercase key 标识 Jira 实例，alias 可独立修改；配置只保存 Jira CLI 配置文件的绝对路径、JQL、启用、预览、自动完成和目标状态，不保存凭据。默认 JQL 为 `assignee = currentUser() AND resolution IS EMPTY`，新 provider 默认启用预览并关闭自动完成；JQL 变化必须重新启用预览，自动完成必须先有目标状态。禁用只改变后续同步资格并保留 provider 配置。注册本身不得调用 Jira 或创建同步任务。
- 代码和测试路径：`server/app.mjs`、`server/database.mjs`、`web/src/api.ts`、`web/src/types.ts`、`web/src/components/JiraProviderSettings.tsx` 和 `web/src/styles.css`。本次按仓库直接路径确认规则未新增自动化测试。
- 用户文档：`README.md`、`README.zh-CN.md` 和 `docs/fork-capabilities.md`。
- 来源：当前 Jira 集成能力；提交后可用 `git log -S'jira_providers' -- server/database.mjs web/src/components/JiraProviderSettings.tsx` 定位。
- 合并指引：上游调整设置页、本地 companion 或数据库初始化时，保留“多实例 key 身份、alias 与身份分离、凭据只由 Jira CLI 管理、JQL 变化重开预览、自动完成显式目标状态、本地配置不经 Cloud API”这些不变量；不得让 provider 注册隐式执行同步。
- 移除条件：Fork 停止 Jira CLI 集成，或上游提供等价的多实例、本地凭据边界和预览/回写策略后同步移除。
- 针对性验证：运行 `npm run typecheck` 和 `npm run build:web`；通过 Jira 设置创建两个不同 key 的 provider，修改 alias 和 JQL 后确认 key 不变、预览重新开启，重启服务后确认配置仍存在，并确认未配置目标状态时无法开启自动完成。

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
- 上游 `0.2.0` 的 `src-tauri/`、macOS updater/release 脚本、`release-macos.yml`、`rust-toolchain.toml` 和 `taskctl` 打包验证属于被替代的重复产品链；Fork 只维护 `macos/CodexPanelLauncher` Swift 管理器及对应 CI。
