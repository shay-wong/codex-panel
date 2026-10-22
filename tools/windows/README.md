# Windows：Panel 窗口唤醒与只读诊断

Panel 通过 CDP 注入 Codex。没有调试端口的 Codex 实例无法接收注入；应从 Codex Panel 启动可连接的 Codex。

在 Fork 当前流程中，`scripts/codex-injector.mjs` 首次打开面板和接收后续 `open` 请求时，确认面板打开后调用 `activateWindowsCodexWindow()`，按本次系统包激活返回的 PID 唤醒托管窗口。只恢复最小化窗口，不改变最大化状态；不恢复上游旧的进程停止流程。

## 只读诊断

在本目录运行（保留上游脚本文件名）：

```powershell
.\Probe-CodexTaskboardPanel.ps1
# 多个 injector 并存时，显式选择要检查的 CDP 端口：
.\Probe-CodexTaskboardPanel.ps1 -CdpPort 43123
```

脚本不调用面板的 `open()`，输出 JSON：退出码 `0` 表示入口与面板已挂载且窗口可见，`1` 表示 CDP 可达但面板不可用，`2` 表示缺少 injector、CDP 或主窗口目标。检查 `entryMounted`、`panelVisible` 为 true 且 `statusVisible` 为 false。iframe 的 `about:blank` 由 `Page.setDocumentContent` 产生，不能单凭它判断失败。

## 验证与限制

- 上游记录曾在 Windows 11 / Codex `26.1007.9446.0` 验证窗口恢复；这不是本 Fork 的真机验证结果。本次 Fork 接入使用模拟 PowerShell、打开请求和 DOM 测试，仍需 Windows 真机确认。
- Windows 前台锁可能拒绝聚焦；调用方记录失败日志，面板仍保持打开。不强制夺焦。
- 只处理本次启动记录的 PID；连接已存在的 CDP 实例、但没有托管 PID 时不猜测窗口。没有 `MainWindowHandle` 时记录错误。
- 诊断脚本沿用上游的单次 CDP 响应读取，WebSocket 操作没有超时；无响应时可手动中止。
