# Codex Taskboard

[English](README.md)

一个本地优先的 Issue 看板，可在浏览器中运行，也可以通过独立 CDP 启动器或注入脚本嵌入 Codex。React UI 与随附 Codex Skill 使用的 `taskctl` CLI 共用同一套 HTTP API。

## 环境要求

- Node.js 22.5 或更高版本

## 本地运行

```bash
npm install
npm run build
npm start
```

打开 <http://127.0.0.1:47823>。SQLite 数据库保存在 `.data/taskboard.sqlite`。

如需启用前端热更新进行开发：

```bash
npm run dev
```

Vite UI 运行在 <http://127.0.0.1:5173>，并将 API 请求代理到本地服务。

## 使用 CLI

在项目目录中运行：

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

如果希望直接在终端中使用 `taskctl`，可以运行 `npm link`。通过 `CODEX_TASKBOARD_URL` 可让 CLI 连接到其他本地或局域网服务。云端部署通过回环地址上的本地伴随服务配置，使用 `taskctl cloud login` 登录。

## 安装 Codex Skill

将 `skills/manage-taskboard` 复制或软链接到 Codex Skills 目录，然后启动一个新的 Codex 任务：

```bash
ln -s /absolute/path/to/codex-taskboard/skills/manage-taskboard \
  ~/.codex/skills/manage-taskboard
```

该 Skill 会指导 Codex 检查 Issue、将其移动到 `in_progress`、使用乐观版本控制、验证工作并移动到 `in_review`；只有用户明确确认验收或要求标记完成时，才会将 Issue 移动到 `done`。

## 嵌入 Codex

### 推荐：保留当前窗口并单独打开 Taskboard 窗口

保持现有 Codex 窗口开启。在 Taskboard 仓库中，以独立 CDP 端口启动第二个 Codex 实例：

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

新的 Codex 窗口出现后，在另一个终端中运行注入器：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

使用嵌入面板期间，请保持注入器终端运行。原 Codex 窗口不会受到影响，新窗口会显示 Taskboard 侧边栏入口。如果端口 `9231` 已被占用，请在两条命令中使用同一个其他端口。

### 备选：使用独立启动器重启 Codex

退出所有正在运行的 Codex 窗口，然后运行：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

该命令会在需要时启动本地 Taskboard 服务，以仅监听回环地址的 CDP 端口启动官方 macOS Codex 应用，注入一个位于 Plugins 之后、外观与原生界面一致的 Taskboard 入口，并持续监控服务及替换后的渲染进程。打开 Taskboard 时，启动器会检查固定本地服务的健康状态，在需要时重启服务，并在 iframe 加载失败时重新构建。使用期间请保持该命令运行。启动器不会修改 `ChatGPT.app` 或其 `app.asar`。

Codex 26.715.52143 自带的渲染器 CSP 会阻止任意 HTTP iframe。因此，启动器会通过 CDP 绕过 CSP，重新加载一次渲染器，安装 document-start 脚本，并等待 Taskboard OOPIF 真正加载完成。同一台设备上的其他进程无需认证即可访问 CDP，因此仅应在启动器运行期间执行可信的本地代码。

如果 Codex 已通过其他方式启用了 CDP，可运行：

```bash
npm run codex:inject -- --port 9229 --open
```

该命令也会持续运行，以便注入的标签页在服务退出后重新启动 Taskboard。使用 `Ctrl-C` 停止。

脚本会在 Codex 侧边栏中添加 Taskboard 入口，并让 iframe 覆盖 Codex 的整个主工作区，包括上下文标题栏区域，从而避免 Taskboard 自身标题栏上方出现空白。完整的矩形标题栏位于 Electron 可拖拽层之上，并标记为 `no-drag`；Taskboard 激活时会隐藏原生上下文操作，因此其自身操作可以保持正常的边缘间距，不需要额外的右侧留白。原生侧边栏会继续保留，之前的页面选择和上下文标题栏会暂时隐藏；选择其他 Codex 页面后会恢复。

“在对话中打开”会在存在对应项目时选择原生 Codex 项目，并打开一个尚未发送、内容为 `$manage-taskboard ISSUE-ID` 的原生输入框。只有当某个对话实际处理了 Issue 后，才会建立关联：`taskctl` 读取 Codex 的 `CODEX_THREAD_ID`，并在 Issue 或评论变更中记录该 ID。记录的 ID 可通过 Codex 原生路由桥接点击打开。每个 Issue 可以绑定一个 Git 分支或一个 worktree；选项从所选 Codex 项目的仓库中扫描，而不是手工输入。该集成复用 Codex 现有的项目、输入框和路由标记，不会修改 React、替换 `fetch`、加载私有代码块或编辑 Codex 数据文件。

如需使用其他 UI 来源，请在用户脚本运行前设置 `window.__CODEX_TASKBOARD_URL__`。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | HTTP 监听地址；使用 `127.0.0.1` 可禁用局域网访问 |
| `CODEX_TASKBOARD_PORT` | `47823` | 本地 HTTP 端口 |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite 数据目录 |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API 地址 |

`npm start` 会输出本地 URL 和可用的局域网 URL。同一受信任网络中的协作者可以打开局域网 URL，共用同一个 Taskboard 服务。任务、评论和附件变更会通过服务器发送事件广播到所有已打开的客户端；重新连接的客户端会执行完整刷新，避免遗漏断线期间的变更。协作者可设置 `CODEX_TASKBOARD_URL=http://<host-ip>:47823`，让 `taskctl` 连接共享服务。

局域网模式没有账户认证：受信任局域网中任何能够访问该 URL 的人都可以读写 Taskboard。通过公网访问或部署到云端时，必须设置经过认证的访问边界。

## 通过 Cloudflare 共享

两位相互信任的协作者可以在 Cloudflare 上运行 Taskboard：Worker Static Assets 和 API 路由负责提供服务，D1 作为权威业务数据库，私有 R2 Bucket 保存附件。部署使用带共享密码的 HTTPS Basic Authentication，并在全局修订号变化后刷新已打开的看板。

每台设备保留各自的项目检出路径映射，并继续通过本地伴随服务提供 Codex、Git/worktree、Skill 和 MCP 能力。云端模式不会回退到本地 SQLite 数据库，也不会同时写入本地和云端数据库。

有关所有者部署、现有 GitHub 安装配置、密码轮换、本地路径映射和一次性本地数据迁移流程，请参阅英文版 [Cloud collaboration](docs/cloud-collaboration.md) 指南。

## 验证

```bash
npm run check
```

该命令会运行 TypeScript 检查、生产前端构建，以及服务器、CLI 和注入脚本测试套件。
