# App and CLI shared sessions / App 与 CLI 共享会话

[Capability index](fork-capabilities.md#app-and-cli-shared-sessions) · [README](../README.md) · [中文 README](../README.zh-CN.md)

## 使用步骤

此选项适用于 macOS 和 Windows，默认关闭。Panel 与 Codex 必须保持运行，且 Panel 已连接到 Codex。

1. 打开 Panel 的 **偏好设置 → 模型与高级 → App 与 CLI 共享会话**。
2. 开启后点击 **复制共享 CLI 命令**。
3. 在 macOS 终端或 Windows PowerShell 中执行复制的完整命令。
4. 在 CLI 的会话选择器中打开目标会话；审批、权限确认和需要回答的问题在 Codex App 中处理。新建或分叉请先在 App 完成，再从共享 CLI 中选择。

无需重启 Codex。务必使用 Panel 生成的命令：直接运行普通 `codex` 不会加入共享后台，打开同一会话时仍可能显示“已在另一个应用中打开”。需要独立进行工作时，仍可使用 Codex 的“创建聊天分叉”。

以下仅展示命令形式，尖括号是占位符，不是可以直接执行的路径；实际命令请从 Panel 复制。

macOS：

```text
'<Panel 可执行文件>' --shared-cli '<本机共享连接描述文件>'
```

Windows PowerShell：

```text
Start-Process -FilePath '<Panel 可执行文件>' -ArgumentList '--shared-cli "<本机共享连接描述文件>"' -NoNewWindow -Wait
```

Windows 使用 `-NoNewWindow -Wait` 在当前终端运行并等待 CLI，避免另开控制台或让提示符抢占输入。不要把复制的命令改为普通 `codex`，也不要添加其他远程连接地址或 token。

## 退出与边界

使用 `/quit` 关闭 CLI 视图或关闭共享选项会断开该共享连接并释放会话保留，不会取消 Codex App 中正在执行的任务。CLI 的停止操作（如 Ctrl+C）仍作用于同一任务。需要停止任务时，在 App 中明确停止。重新开启共享、重连 Panel 或重启应用后，从 Panel 重新复制命令。

共享只复用 App 当前已有的本地后台，不解除原生写入锁，也不会强制接管独立 CLI 正在占用的会话。若已经用普通 CLI 打开该会话，先在那个 CLI 中关闭它，再从共享命令进入。共享不恢复已归档或删除的会话，不改变分叉、归档和删除的语义，也不让两个独立后台同时写入同一历史。

Panel 将请求和通知转发到现有的原生认证连接。CLI 查看会话期间，Panel 使用原生 `retainActiveConversation` 租约，避免 App 把该会话当作无人查看而闲置回收。App 继续处理原生审批和问题提示。连接凭据保存在 Panel 的本机描述文件中，以 `0600` 模式写入，再通过环境变量传给 CLI 子进程；Windows 使用其文件权限机制。复制命令不包含 token，不应把描述文件作为排错附件公开。

## 验证状态

已在隔离的 macOS Codex App、临时数据目录和本地模拟模型接口中验证：原生连接元信息、同一会话恢复、CLI 发送、回复同步、原生会话状态回读、退出 CLI，以及 App 归档后释放租约且不自动恢复。针对性 Node 测试、启动器组件测试、TypeScript 检查和原生 Rust 测试/构建通过。Windows 实机、真实账号审批和完整界面验收尚未完成。

## English

This optional setting is off by default on macOS and Windows. Keep Panel connected to Codex, open **Preferences → Models & advanced → App 与 CLI 共享会话**, enable it, then choose **复制共享 CLI 命令** and run the complete copied command in a terminal. Select an existing chat in the CLI; create or fork chats in Codex App first. Answer approvals and questions in Codex App. No App restart is required.

Use the generated command rather than an ordinary `codex` launch. Ordinary CLI sessions use a separate backend and can still hold the writer lock. Close that independent session before opening the same chat through the shared command. Forking remains available when you want an independent chat.

On Windows, the generated PowerShell command uses `Start-Process -NoNewWindow -Wait`. The placeholders shown above illustrate the shape only; copy the real command from Panel. Do not add another remote address or token. Copy a fresh command after reconnecting or restarting.

The gateway forwards requests and notifications through the App's existing authenticated local connection. Native `retainActiveConversation` leases retain chats while CLI views are attached. Exiting with `/quit` or disabling the setting releases that view without canceling App work. CLI interruption commands such as Ctrl+C still stop the shared task. It does not remove writer locks, force ownership from another backend, or restore archived/deleted chats. Credentials stay in a local descriptor written with mode `0600` and in the child process environment; the copied command contains no token. Windows uses its file-permission mechanism.

An isolated macOS App with temporary data and a local mock model verified native metadata, same-chat resume, CLI submission, response synchronization, native state readback, CLI exit and lease release after App archiving without reopening the chat. Targeted Node and launcher tests, TypeScript checks, and native Rust tests/build passed. Windows hardware, real-account approvals and full UI acceptance remain unverified.
