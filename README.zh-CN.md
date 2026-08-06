# Codex Panel

[English](README.md) | [Fork 能力（英文）](docs/fork-capabilities.md)

一个本地优先的 Issue 看板，可在浏览器中运行，也可以通过独立 CDP 启动器或注入脚本嵌入 Codex。React UI 与随附 Codex Skill 使用的 `panelctl` CLI 共用同一套 HTTP API。

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

集成命令会构建独立 runtime 并复制到 `~/Library/Application Support/Codex Panel/runtime`，把 `manage-panel` 和 `handoff-panel` 复制到标准用户 Skill 目录 `~/.agents/skills`，把 `panelctl` 安装到 `~/.local/bin`，然后生成 macOS 启动器。安装结果都是带所有权标记的真实副本，不是指回 Git 仓库的符号链接。单独运行 `npm ci` 只安装项目依赖，不会写入这些用户级集成。安装完成后启动一个新的 Codex 任务即可使用 `$manage-panel` 和 `$handoff-panel`。

首次安装时，如果固定数据目录尚不存在，安装器会在线快照仓库现有的 `.data/panel.sqlite`，并复制附件和本地配置，不删除原数据。它还会清理原来由本仓库管理的 `~/.codex/skills` 和 Node 可执行目录软链接。重复运行时只会原子更新带 Codex Panel 所有权标记的文件；用户自己维护的文件和目录不会被覆盖。移动或删除仓库不会破坏已经安装的 runtime。拉取代码更新或替换 Node.js 后，再运行该命令安装新版本。

浏览器中的 `taskboard.*` 设置和草稿会迁移为 `panel.*`。旧 `CODEX_TASKBOARD_*` 环境变量仍可作为回退别名，但新配置应统一使用 `CODEX_PANEL_*`。

`$manage-panel` 会指导 Codex 检查 Issue、将其移动到 `in_progress`、使用乐观版本控制、验证工作并移动到 `in_review`；只有用户明确确认验收或要求标记完成时，才会将 Issue 移动到 `done`。

`$handoff-panel --issue PROJECT-123 重点保留验收结论` 可以在任意 Codex 对话中使用。它会先完整遵循已安装的 `~/.agents/skills/handoff/SKILL.md` 契约生成原有的临时交接文档，再验证目标 Issue，并把该文档逐字作为 Codex Agent 的 `AI 对话交接` 评论附加到 Issue。原 `$handoff` Skill 的行为保持不变；之后的 Panel 校验或发布失败也不会删除临时文档。

## 嵌入 Codex

### 推荐：使用自动生成的 Codex 启动器

`npm run codex:install` 会重建 `~/Applications` 中现有的 `Codex.app` 启动器，保留它的 Codex 名称和图标，并让它指向已安装的 runtime 和数据目录。完全退出所有正在运行的 Codex 窗口，然后从现有 Dock 图标、Finder 或明确的命令行路径打开该启动器：

```bash
open "$HOME/Applications/Codex.app"
```

启动器会以仅监听回环地址的 CDP 端口启动官方 `/Applications/ChatGPT.app` Codex 应用，启动本地 Panel 服务，注入 Panel 侧边栏入口，并跟随这次 Codex 的生命周期运行。由它启动的 Codex 退出后，其启动的本地服务也会退出。它不会修改官方应用或其 `app.asar`。

如果 Codex 已经通过该启动器的 CDP 端口运行，再次点击 `Codex.app` 会复用健康的 resident injector、打开 Panel 入口并聚焦现有 Codex 窗口。缺失或过期的 injector 会被替换；恢复过程会在启用 CSP bypass 后重载一次 Codex renderer，确保内嵌 frame 仍可用。退役的本地服务会关闭活跃连接，不会继续占用 SQLite 数据库。

移动仓库不会影响已安装的启动器。更新仓库代码或替换该 Node.js 安装后，请重新运行 `npm run codex:install`。`npm run launcher:install` 仍作为兼容别名保留。最近一次启动日志位于 `~/Library/Logs/Codex Panel.log`。

正常打开且未启用 CDP 的 Codex 无法在运行中补开 CDP。如果 Codex 已经以这种方式运行，请完全退出后再打开生成的 `Codex.app`。

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
  --remote-allow-origins=http://127.0.0.1:9231
```

新的 Codex 窗口出现后，在另一个终端中运行注入器：

```bash
CODEX_PANEL_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

使用嵌入面板期间，请保持注入器终端运行。原 Codex 窗口不会受到影响，新窗口会显示 Panel 侧边栏入口。如果端口 `9231` 已被占用，请在两条命令中使用同一个其他端口。

CDP 可以访问后，启动器会等待最多 30 秒，让 Codex 创建主 renderer，再注入 Panel，并忽略头像浮层等辅助 renderer。这样可以避免 Electron 已开放调试端点、但 Codex 页面尚未就绪时启动失败。

Codex 26.715.52143 自带的渲染器 CSP 会阻止任意 HTTP iframe。因此，启动器会通过 CDP 绕过 CSP，重新加载一次渲染器，安装 document-start 脚本，并等待 Panel OOPIF 真正加载完成。同一台设备上的其他进程无需认证即可访问 CDP，因此仅应在启动器运行期间执行可信的本地代码。

如果 Codex 已通过其他方式启用了 CDP，可运行：

```bash
npm run codex:inject -- --port 9229 --open
```

该命令也会持续运行，以便注入的标签页在服务退出后重新启动 Panel。使用 `Ctrl-C` 停止。

脚本会在 Codex 侧边栏中添加 Panel 入口，并让 iframe 覆盖 Codex 的整个主工作区，包括上下文标题栏区域，从而避免 Panel 自身标题栏上方出现空白。完整的矩形标题栏位于 Electron 可拖拽层之上，并标记为 `no-drag`；Panel 激活时会隐藏原生上下文操作，因此其自身操作可以保持正常的边缘间距，不需要额外的右侧留白。原生侧边栏会继续保留，之前的页面选择和上下文标题栏会暂时隐藏；选择其他 Codex 页面后会恢复。

无论当前位于会话页，还是 Plugins、Sites 等原生页面，都可以直接点击 Panel 入口打开任务面板。

“在对话中打开”会在存在对应项目时选择原生 Codex 项目，并打开一个尚未发送的 `$manage-panel` 输入框。Panel 会先读取 Issue 的最新“AI 对话交接”评论，把 Issue 编号、标题、读取位置和交接内容预填给新任务；新任务仍会先通过 `panelctl` 重新读取最新 Issue 内容和全部评论。未发送的输入框还不是 Codex 任务，因此第一次发送创建出原生 thread 后，Panel 才会自动把该 thread ID 写回 Issue。记录的 ID 可通过 Codex 原生路由桥接点击打开。每个 Issue 可以绑定一个 Git 分支或一个 worktree；选项从所选 Codex 项目的仓库中扫描，而不是手工输入。该集成复用 Codex 现有的项目、输入框和路由标记，不会修改 React、替换 `fetch`、加载私有代码块或编辑 Codex 数据文件。

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

`npm start` 会输出本地 URL 和可用的局域网 URL。同一受信任网络中的协作者可以打开局域网 URL，共用同一个 Panel 服务。任务、评论和附件变更会通过服务器发送事件广播到所有已打开的客户端；重新连接的客户端会执行完整刷新，避免遗漏断线期间的变更。协作者可设置 `CODEX_PANEL_URL=http://<host-ip>:47823`，让 `panelctl` 连接共享服务。

局域网模式没有账户认证：受信任局域网中任何能够访问该 URL 的人都可以读写 Panel。通过公网访问或部署到云端时，必须设置经过认证的访问边界。

## 通过 Cloudflare 共享

两位相互信任的协作者可以在 Cloudflare 上运行 Panel：Worker Static Assets 和 API 路由负责提供服务，D1 作为权威业务数据库，私有 R2 Bucket 保存附件。部署使用带共享密码的 HTTPS Basic Authentication，并在全局修订号变化后刷新已打开的看板。

仓库没有预先配置可用的远端资源 ID 或自定义域名。提交的 Wrangler 文件只是本地开发和 dry-run 模板；执行任何远端迁移或部署前，必须自行创建 Cloudflare 资源并替换其中的全零 D1 ID。

每台设备保留各自的项目检出路径映射，并继续通过本地伴随服务提供 Codex、Git/worktree、Skill 和 MCP 能力。云端模式不会回退到本地 SQLite 数据库，也不会同时写入本地和云端数据库。

有关所有者部署、现有 GitHub 安装配置、密码轮换、本地路径映射和一次性本地数据迁移流程，请参阅英文版 [Cloud collaboration](docs/cloud-collaboration.md) 指南。

## 验证

```bash
npm run check
```

该命令会运行 TypeScript 检查、生产前端构建，以及服务器、CLI 和注入脚本测试套件。
