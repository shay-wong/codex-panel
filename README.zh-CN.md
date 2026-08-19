# Codex Panel

[English](README.md) | [Fork 能力（英文）](docs/fork-capabilities.md)

一个本地优先的 Issue 看板，可在浏览器中运行，也可以通过独立 CDP 启动器或注入脚本嵌入 Codex。React UI 与随附 Codex Skill 使用的 `panelctl` CLI 共用同一套 HTTP API。

面板支持概览、列表、甘特图和归档 Issue 工作流。横向列表沿用议题看板的分栏与卡片层级，竖向列表保持紧凑；同步自 Jira 的 Issue 会优先显示外部 Key。Issue 可以设置开始与截止日期，也可以从详情页移动到其他项目并保留关联对话。本地 Jira 连接会把分配给当前 Jira 登录用户的任务同步到固定 Jira 项目。每个 Jira 需求可以选择一个或多个仓库项目，并关联这些仓库中已有的执行 Issue；每个执行 Issue 最多属于一个 Jira 需求，Jira 刷新不会覆盖本地工作内容。打开 Jira 项目时最多每分钟刷新一次，也可以手动同步。修改已同步 Jira Issue 的标题、描述、优先级、标签、截止日期或状态时，Panel 会直接回写 Jira。连接支持账号密码或 Jira Cloud 邮箱与 API Token 的 Basic Auth，也支持 Jira Data Center 或 Server Personal Access Token 的 Bearer Auth。凭据保存在 Panel 本地数据目录中，云端模式不可用；除非 Jira 位于受信任的内网，否则应使用 HTTPS。

## 环境要求

- Node.js 22.5 或更高版本

## 本地运行

```bash
npm install
npm run build
npm start
```

打开 <http://127.0.0.1:47823>。在 macOS 上，SQLite 数据库默认保存在 `~/Library/Application Support/Codex Panel/data/panel.sqlite`。

如需启用前端热更新进行开发：

```bash
npm run dev
```

Vite UI 运行在 <http://127.0.0.1:5173>，并将 API 请求代理到本地服务。

## 使用 CLI

在项目目录中运行：

```bash
npm run panelctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run panelctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

不安装用户级命令也可以使用 `npm run panelctl -- ...`。运行 `npm run codex:install` 后，安装器会把受管的 `panelctl` 启动文件安装到 `~/.local/bin/panelctl`；该命令还会安装下文所述的 Codex Skills、独立 runtime 和生成式应用。通过 `CODEX_PANEL_URL` 可让 CLI 连接到其他本地或局域网服务。云端部署通过回环地址上的本地伴随服务配置，使用 `panelctl cloud login` 登录。

## 安装 Codex Skills

先安装依赖，再显式安装 Codex 集成：

```bash
npm ci
npm run codex:install
```

集成命令会构建独立 runtime 并复制到 `~/Library/Application Support/Codex Panel/runtime`，把 `manage-panel` 和 `handoff-panel` 复制到标准用户 Skill 目录 `~/.agents/skills`，把 `panelctl` 安装到 `~/.local/bin`，然后生成 macOS 启动器；启动器还会在自己的 App bundle 中保存一份受签名保护的 runtime 副本。安装结果都是带所有权标记的真实副本，不是指回 Git 仓库的符号链接。单独运行 `npm ci` 只安装项目依赖，不会写入这些用户级集成。安装完成后启动一个新的 Codex 任务即可使用 `$manage-panel` 和 `$handoff-panel`。

首次安装时，如果固定数据目录尚不存在，安装器会在线快照仓库现有的 `.data/panel.sqlite`，并复制附件和本地配置，不删除原数据。它还会清理原来由本仓库管理的 `~/.codex/skills` 和 Node 可执行目录软链接。重复运行时只会原子更新带 Codex Panel 所有权标记的文件；用户自己维护的文件和目录不会被覆盖。移动或删除仓库不会破坏已经安装的 runtime。拉取代码更新或替换 Node.js 后，再运行该命令安装新版本。

浏览器中的 `taskboard.*` 设置和草稿会迁移为 `panel.*`。旧 `CODEX_TASKBOARD_*` 环境变量仍可作为回退别名，但新配置应统一使用 `CODEX_PANEL_*`。

`$manage-panel` 会指导 Codex 检查 Issue、将其移动到 `in_progress`、使用乐观版本控制、验证工作并移动到 `in_review`；只有用户明确确认验收或要求标记完成时，才会将 Issue 移动到 `done`。

`$handoff-panel --issue PROJECT-123 重点保留验收结论` 可以在任意 Codex 对话中使用。它会先完整遵循已安装的 `~/.agents/skills/handoff/SKILL.md` 契约生成原有的临时交接文档，再验证目标 Issue，并把该文档逐字作为 Codex Agent 的 `AI 对话交接` 评论附加到 Issue。原 `$handoff` Skill 的行为保持不变；之后的 Panel 校验或发布失败也不会删除临时文档。

## 嵌入 Codex

### 推荐：使用 Codex Panel 桌面端

`npm run codex:install` 会创建或刷新 `~/Applications/Codex Panel.app`，删除之前由本项目管理的 `~/Applications/Codex.app` 引导器，并迁移旧 Swift 启动器。桌面端基于 Tauri/Rust，固定使用 `~/Library/Application Support/Codex Panel/data` 数据目录，因此移动或删除源仓库也不会使它失效。可以从 Finder 或明确路径打开：

```bash
open "$HOME/Applications/Codex Panel.app"
```

应用常驻 macOS 菜单栏。菜单会显示当前运行状态，并提供打开内嵌 Panel、一个随状态切换的启动/停止项、独立的重启服务操作，以及浏览器、日志和数据目录入口；浏览器和重启操作只在服务运行时启用。菜单还可分别控制开机自启动、应用启动时连接 Codex、连接后自动打开 Panel；后两项默认开启。只有当前注入已挂载到 renderer 并持续发布新鲜心跳时，状态才显示“正常”。受管集成意外退出后会按 2、5、15 秒重试；60 秒内第四次失败后停止自动恢复。

可见的管理窗口是由 Tauri WebView 承载的本地 HTML/CSS 界面；服务、进程和文件操作仍由 Rust command 执行。紧凑的顶部控制面把当前状态、Panel 主操作、同一个启动/停止按钮、独立的重启服务、浏览器入口，以及 Panel 服务、Codex 连接和内嵌面板状态放在一起，不再重复单独的服务控制区；Codex 连接就绪与内嵌 Panel 实际可见会分别显示，等待 renderer 的打开请求会保持排队而不是误报失败。异步操作按钮会至少显示 300ms loading，再短暂保留清晰的成功或失败状态，浏览器入口会校验并保留启动器的私有回环地址。启动偏好、更新与 Release、日志、数据目录和运行详情位于下方。窗口标题区与 macOS App/Dock 使用同一套带 `PANEL` 角标的 Codex 明暗图标，并跟随系统外观切换。

应用最多每 24 小时自动检查一次 Fork 的 GitHub Releases，成功结果缓存 24 小时；临时失败 5 分钟后重试，匿名 API 限流则缓存到 GitHub 返回的重置时间。手动检查始终绕过缓存。检查会优先使用本机已登录的 `gh` CLI，无法使用时才回退到匿名 GitHub API，并分别提示额度耗尽、网络失败、暂无 Release、已是最新版本或发现新版本。只有规范化的 `vX.Y.Z-fork.N` 标签会成为更新候选，发现新版本时只会打开经过校验的 `shay-wong/codex-panel` Release 页面；应用不会自动下载或安装更新。

App bundle 内包含 Panel runtime、`panelctl`、两个 Panel Skills，以及用于运行它们的官方签名 Node.js runtime。macOS 安装器优先使用 `CODEX_PANEL_CODESIGN_IDENTITY`，其次使用可复用的本机 Apple Development 身份；两者都不可用时回退到 ad-hoc 签名。Windows 正式发行要求配置 `CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT`，并生成带 Authenticode 签名的 NSIS 安装包。

连接前，应用会先校验自身 App 签名和打包 runtime，再按 OpenAI 的 Identifier 和 Team ID 校验官方 `ChatGPT.app` 及其内置 Codex 可执行文件，拒绝符号链接，并从子进程环境中移除 Node、shell 和动态加载器注入变量。Windows 还会在执行前校验 launcher 的 Authenticode 证书，以及编译进签名 launcher、覆盖 Node 和全部 Panel runtime 文件的 SHA-256 清单。Panel 服务通过启动器持有的监听器和私有实例 token 仅绑定回环地址。如果正在运行的 Codex 已暴露有效 CDP，包括旧 Swift 启动器留下的端口，新 injector 会接管真实端口；否则通过 macOS LaunchServices 使用随机私有 CDP 端口启动官方应用。已经在无 CDP 模式下运行的 Codex 仍需完全退出后才能重新以 CDP 启动。运行状态、打开和停止请求在 macOS 使用受启动 token 保护且仅当前用户可访问的 Unix socket，在 Windows 使用启动器持有的子进程控制管道。停止或退出 Tauri 只会等待自己负责的 injector 和 Panel 服务退出，官方 ChatGPT/Codex 应用继续运行。应用不会修改 `ChatGPT.app` 或 `app.asar`。

更新仓库代码或替换 Node.js 后，请重新运行 `npm run codex:install`。OpenAI 正常签名的 `ChatGPT.app` 更新无需重新安装 Panel。`npm run launcher:install` 仍作为兼容别名保留。最近一次管理器日志位于 `~/Library/Logs/Codex Panel.log`。

### 备选：在终端运行启动器

完全退出所有正在运行的 Codex 窗口，然后运行：

```bash
CODEX_PANEL_HOST=127.0.0.1 npm run codex
```

该命令会在前台运行同一套生命周期。使用嵌入面板期间请保持命令运行。

### 高级用法：保留当前窗口并单独打开 Panel 窗口

保持现有 Codex 窗口开启。在 Panel 仓库中，以独立 CDP 端口启动第二个 Codex 实例：

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231 \
  --disable-features=LocalNetworkAccessForSubframeNavigations
```

新的 Codex 窗口出现后，在另一个终端中运行注入器：

```bash
CODEX_PANEL_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

使用嵌入面板期间，请保持注入器终端运行。原 Codex 窗口不会受到影响，新窗口会显示 Panel 侧边栏入口。如果端口 `9231` 已被占用，请在两条命令中使用同一个其他端口。

CDP 可以访问后，启动器会等待最多 30 秒，让 Codex 创建主 renderer，再等待初始 `app://` 文档完成加载，然后启用 CSP bypass 并受控重载一次 renderer。它会忽略头像浮层等辅助 renderer；把这次重载推迟到 `complete` 后，既能让 Codex 完成桌面 bootstrap，也不会进入 fallback 错误页。启动器在第一次主 renderer 尝试时就会消费自动打开请求；如果 frame 仍失败，本地服务和页面上的重试入口会保留，但不会循环把用户从对话拉回 Panel。

Codex 自带的渲染器 CSP 会阻止任意 HTTP iframe。CDP CSP bypass 不会追溯改变已经加载的文档，因此启动器启用 bypass 后必须执行上面的 bootstrap 后受控重载，再打开 Panel。Chromium 151 还会对回环地址的子框架导航执行 Local Network Access 检查，因此启动器只关闭 `LocalNetworkAccessForSubframeNavigations`，并由受管 iframe 显式委派对应的本地网络权限；其他 Local Network Access 检查仍保持启用。接管或刷新已有 resident renderer 时也遵循同一个单次重载规则。同一台设备上的其他进程无需认证即可访问 CDP。由于关闭 Panel 后会按设计保留由管理器启动的 ChatGPT，因此在这个启用了 CDP 的 ChatGPT 实例整个运行期间，都只能运行可信的本地代码。

如果 Codex 已通过其他方式启用了 CDP，可运行：

```bash
npm run codex:inject -- --port 9229 --open
```

该命令也会持续运行，以便注入的标签页在服务退出后重新启动 Panel。使用 `Ctrl-C` 停止。

脚本会在 Codex 侧边栏中添加 Panel 入口，并让 iframe 覆盖 Codex 的整个主工作区，包括上下文标题栏区域，从而避免 Panel 自身标题栏上方出现空白。完整的矩形标题栏位于 Electron 可拖拽层之上，并标记为 `no-drag`；Panel 激活时会隐藏原生上下文操作，因此其自身操作可以保持正常的边缘间距，不需要额外的右侧留白。原生侧边栏会继续保留，之前的页面选择和上下文标题栏会暂时隐藏；选择其他 Codex 页面后会恢复。

无论当前位于会话页，还是 Plugins、Sites 等原生页面，都可以直接点击 Panel 入口打开任务面板。Panel 激活时，通过 Codex 全局命令菜单选择对话、插件、设置、站点、Pull Requests、已安排任务等原生目的地，会在鼠标点击和 Enter 选择后恢复 Codex 原生界面；切换主题等工具命令不会关闭 Panel。不会改变路由的命令目前匹配简体中文、繁体中文和英文标题，其他界面语言留待 Codex 在菜单 DOM 中提供稳定命令标识后支持。

“在对话中打开”会选择对应的原生 Codex 项目，并在本地和 SSH 项目中都打开尚未发送的输入框。本地草稿使用 `$manage-panel`，包含 Issue 编号、标题、最新“AI 对话交接”和 `panelctl` 读取位置，并在执行前刷新 Issue；SSH worker 无法调用本机 `panelctl`，所以远程草稿直接包含当前 Issue 描述、评论和开发上下文。两种草稿都跟随 Panel 界面语言、不显示内部路由标记且不会自动发送；只有第一次真实发送创建 Codex 任务后，Panel 才会写回对应的本地或 SSH thread binding，SSH Issue 也只在此时移到处理中。记录的 ID 可通过 Codex 原生路由桥接点击打开。每个 Issue 可以绑定一个 Git 分支或一个 worktree；选项从所选 Codex 项目的仓库中扫描，而不是手工输入。该集成复用 Codex 现有的项目、输入框和路由标记，不会修改 React、替换 `fetch`、加载私有代码块或编辑 Codex 数据文件。

本地内嵌 AI 对话也可以通过聊天标题栏中的关联菜单绑定到 Issue。打开菜单时会直接加载对话原始项目中的活跃 Issue，即使当前看板正在查看另一个项目，也可以正常改绑或取消关联。关联后的对话会显示在 Issue 的活动时间线中，点击即可打开对应的本地聊天。发送 `/handoff` 或 `/交接` 可以让同一 Codex 线程总结当前讨论；命令后还可以追加需要重点保留的内容。加入 `--issue ISSUE-ID` 可以把交接记录到指定的活跃 Issue，而不是当前关联的 Issue，例如 `/交接 --issue PROJECT-123 重点保留验收结论`。

原 `$handoff` Skill 在所有位置都只保留既有的临时文档行为。需要把同一份交接附加到 Panel Issue 时，使用 `$handoff-panel --issue ISSUE-ID [交接重点]`；原生和内嵌 Codex 对话都适用。基础 Skill 会先完成，生成的文档不会被裁剪或重写；之后的 Issue 校验或发布失败时，临时文档仍会保留，命令会明确报告部分失败。成功的交接会进入 Issue 活动流程，供后续 Codex 任务读取。Issue 的状态、优先级、负责人、工作流、开发上下文和重复周期使用跟随 Panel 明暗主题的菜单，不再依赖浏览器原生下拉层。

如需使用其他 UI 来源，请在用户脚本运行前设置 `window.__CODEX_PANEL_URL__`。自定义来源只有显示权限：可以接收主题更新，并向宿主报告标题栏拖拽区域；但不会收到 Codex 项目、用户身份、thread ID、绝对工作区路径，也不能打开或创建原生任务、展开侧边栏或操作自动化。只有 `window.__CODEX_PANEL_MANAGED_ORIGIN__` 指定的启动器受管来源（默认是本地 Panel 来源）拥有这些原生能力。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_PANEL_HOST` | `0.0.0.0` | HTTP 监听地址；使用 `127.0.0.1` 可禁用局域网访问 |
| `CODEX_PANEL_PORT` | `47823` | 本地 HTTP 端口 |
| `CODEX_PANEL_HOME` | macOS 上为 `~/Library/Application Support/Codex Panel` | 已安装 runtime 和默认数据根目录 |
| `CODEX_PANEL_DATA_DIR` | `$CODEX_PANEL_HOME/data` | SQLite 数据目录 |
| `CODEX_PANEL_URL` | `http://127.0.0.1:47823` | CLI API 地址 |
| `CODEX_PANEL_CODESIGN_IDENTITY` | 匹配的本机 Apple Development 身份，否则为 `-` | 签名 `Codex Panel.app` 时显式指定身份名称或证书哈希 |

`npm start` 会输出本地 URL 和可用的局域网 URL。同一受信任网络中的协作者可以打开局域网 URL，共用同一个 Panel 服务。任务、评论和附件变更会通过服务器发送事件广播到所有已打开的客户端；重新连接的客户端会执行完整刷新，避免遗漏断线期间的变更。协作者可设置 `CODEX_PANEL_URL=http://<host-ip>:47823`，让 `panelctl` 连接共享服务。

局域网模式没有账户认证：受信任局域网中任何能够访问该 URL 的人都可以读写 Panel。通过公网访问或部署到云端时，必须设置经过认证的访问边界。

## 通过 Cloudflare 共享

两位相互信任的协作者可以在 Cloudflare 上运行 Panel：Worker Static Assets 和 API 路由负责提供服务，D1 作为权威业务数据库，私有 R2 Bucket 保存附件。部署使用带共享密码的 HTTPS Basic Authentication，并在全局修订号变化后刷新已打开的看板。

仓库没有预先配置可用的远端资源 ID 或自定义域名。提交的 Wrangler 文件只是本地开发和 dry-run 模板；执行任何远端迁移或部署前，必须自行创建 Cloudflare 资源并替换其中的全零 D1 ID。

每台设备保留各自的项目检出路径映射，并继续通过本地伴随服务提供 Codex、Git/worktree、Skill 和 MCP 能力。云端模式不会回退到本地 SQLite 数据库，也不会同时写入本地和云端数据库。

有关所有者部署、现有 GitHub 安装配置、密码轮换、本地路径映射和一次性本地数据迁移流程，请参阅英文版 [Cloud collaboration](docs/cloud-collaboration.md) 指南。

## Issue Markdown

Issue 描述和评论支持 GFM，包括表格和任务列表。带 `mermaid` 标记的围栏代码块会在加载后渲染为只读图表；渲染失败时保留源码。Markdown HTML 注释不会显示，原始 HTML 默认禁用。

## 验证

```bash
npm run check
```

该命令会运行 TypeScript 检查、生产前端构建、组件测试，以及服务器、CLI 和注入脚本测试套件。
