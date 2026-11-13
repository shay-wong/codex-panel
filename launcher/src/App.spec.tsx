import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, expect, it, vi } from "vitest";
import App, { type LauncherPreferences, type LauncherSnapshot, type LauncherState, type TauriBridge } from "./App";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps launcher feedback, live status and global preferences working through the native bridge", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const current: LauncherState = {
    snapshot: {
      phase: "waiting", message: "Panel 服务已启动，正在等待 Codex 连接。", version: "0.1.0",
      childPid: 123, openRequestPending: false, embeddedVisible: false,
      threadTabsPhase: "waiting", threadTabsMessage: "",
      updateMessage: "尚未检查更新。", updateAvailable: false, updateReady: false, codexUpdateReady: false, codexUpdateAvailable: false, codexUpdateDownloading: false, codexUpdatePhase: "", codexUpdateMessage: "", codexUpdateChecking: false,
      appPath: "/disposable/Codex.app",
    },
    preferences: { autoConnectCodex: true, autoOpenPanel: true, hideUsageBanner: false, showThreadUsage: true, threadUsageAboveComposer: false, usageDotMatrix: true, usageAnimationMode: "smooth", usageAnimationMinSpeed: 5, usageAnimationMaxSpeed: 40, customProviderQuotaFix: false, customProviderUltrafast: false, showCustomProviderDot: false, disableCodexAutoUpdate: false },
    autostart: true, dataDirectory: "/disposable/panel-data", logPath: "/disposable/panel.log",
  };
  let statusListener!: (event: { payload: LauncherSnapshot }) => void;
  let finishRestart!: () => void;
  let finishRefresh!: () => void;
  let holdRefresh = false;
  let browserShouldFail = false;
  let discovery: boolean | null = null;
  let discoveryShouldFail = false;
  const unlisten = vi.fn();
  const workflowUrl = "http://127.0.0.1:1/?view=workflow-settings";
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "open_embedded_panel") current.snapshot.openRequestPending = true;
    if (command === "open_browser_panel" && browserShouldFail) throw new Error("open failed");
    if (command === "reconnect_codex") await new Promise<void>(resolve => { finishRestart = resolve; });
    if (command === "launcher_ui_state" && holdRefresh) await new Promise<void>(resolve => { finishRefresh = resolve; });
    if (command === "read_model_discovery") {
      if (discoveryShouldFail) throw new Error("配置读取失败");
      return discovery;
    }
    if (command === "set_launcher_preference") {
      if (args?.updateModelDiscovery) discovery = args.enabled ? true : null;
      current.preferences = { ...current.preferences, [args?.key as keyof LauncherPreferences]: args?.enabled };
      if (args?.key === "customProviderUltrafast") current.codexRestartReminder = "Ultrafast";
      if (args?.key === "disableCodexAutoUpdate") current.codexRestartReminder = "Codex 自动更新";
      return { ...current.preferences };
    }
    if (command === "set_usage_animation_mode") {
      current.preferences = { ...current.preferences, usageAnimationMode: args?.mode as "smooth" | "morph" };
      return current.preferences;
    }
    if (command === "set_usage_animation_speeds") {
      current.preferences = { ...current.preferences, usageAnimationMinSpeed: args?.minimum as number, usageAnimationMaxSpeed: args?.maximum as number };
      return { ...current.preferences };
    }
    if (command === "set_autostart") return args?.enabled;
    if (command === "workflow_settings_url") return workflowUrl;
    return command === "launcher_ui_state" ? structuredClone(current) : undefined;
  });


  vi.stubGlobal("__TAURI__", {
    core: { invoke },
    event: { listen: async (event: string, listener: typeof statusListener) => {
      if (event === "launcher-status") { statusListener = listener; return unlisten; }
      return () => {};
    } },
  } as unknown as TauriBridge);
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
  const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element); }); };
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const publish = async (patch: Partial<LauncherSnapshot>) => {
    Object.assign(current.snapshot, patch);
    await act(async () => { statusListener({ payload: { ...current.snapshot } }); });
  };
  const view = render(<Theme><App /></Theme>);
  await act(async () => {});
  expect(document.getElementById("codexUpdateComponent")).toBeTruthy();
  expect(document.getElementById("installCodexUpdate")).toBeNull();
  await publish({ phase: "running", codexUpdateReady: true });
  expect(button("installCodexUpdate")).toBeTruthy();
  await publish({ phase: "running", codexUpdateReady: false, codexUpdateAvailable: false, codexUpdateDownloading: false, codexUpdatePhase: "", codexUpdateMessage: "当前已是最新版 · 26.1027.61615" });
  expect(screen.getByText("当前已是最新版 · 26.1027.61615")).toBeTruthy();
  await click(button("checkCodexUpdates"));
  await advance(300);
  expect(invoke).toHaveBeenCalledWith("check_codex_updates");
  await publish({ codexUpdateChecking: true });
  expect(button("checkCodexUpdates").disabled).toBe(true);
  expect(button("checkCodexUpdates").getAttribute("aria-label")).toContain("正在检查");
  await publish({ codexUpdateChecking: false });
  await publish({ codexUpdateAvailable: true, codexUpdateMessage: "发现新版本 26.new" });
  expect(document.getElementById("checkCodexUpdates")).toBeNull();
  expect(button("downloadCodexUpdate").getAttribute("aria-label")).toBe("下载更新");
  await click(button("downloadCodexUpdate"));
  await advance(300);
  expect(invoke).toHaveBeenCalledWith("download_codex_update");
  await publish({ codexUpdateDownloading: true, codexUpdateMessage: "正在下载更新 · 42%" });
  expect(button("downloadCodexUpdate").disabled).toBe(true);
  expect(document.getElementById("installCodexUpdate")).toBeNull();
  await publish({ codexUpdatePhase: "downloading" });
  expect(document.getElementById("downloadCodexUpdate")).toBeNull();
  await click(button("pauseCodexUpdate"));
  await advance(300);
  expect(invoke).toHaveBeenCalledWith("control_codex_update_download", { action: "pause" });
  await publish({ codexUpdatePhase: "paused", codexUpdateDownloading: false });
  expect(document.getElementById("pauseCodexUpdate")).toBeNull();
  await click(button("resumeCodexUpdate"));
  await advance(300);
  expect(invoke).toHaveBeenCalledWith("control_codex_update_download", { action: "resume" });
  await publish({ codexUpdatePhase: "verifying", codexUpdateDownloading: true });
  expect(document.getElementById("pauseCodexUpdate")).toBeNull();
  expect(document.getElementById("resumeCodexUpdate")).toBeNull();
  await click(button("cancelCodexUpdate"));
  await advance(300);
  expect(invoke).toHaveBeenCalledWith("control_codex_update_download", { action: "cancel" });
  await publish({ codexUpdatePhase: "cancelled", codexUpdateDownloading: false });
  expect(button("downloadCodexUpdate")).toBeTruthy();
  await publish({ codexUpdateReady: true, codexUpdateDownloading: false, codexUpdatePhase: "ready" });
  expect(document.getElementById("downloadCodexUpdate")).toBeNull();
  expect(button("installCodexUpdate")).toBeTruthy();
  await publish({ codexUpdateReady: false, codexUpdateAvailable: false });
  const autoUpdate = within(document.getElementById("codexUpdateComponent")!).getByRole("switch", { name: "禁止 Codex 自动更新" });
  expect(autoUpdate.getAttribute("aria-checked")).toBe("false");
  await click(autoUpdate);
  expect(invoke).toHaveBeenCalledWith("set_launcher_preference", { key: "disableCodexAutoUpdate", enabled: true });
  expect(autoUpdate.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText(/Codex 自动更新 设置已保存/)).toBeTruthy();
  await click(autoUpdate);
  expect(current.preferences.disableCodexAutoUpdate).toBe(false);

  await publish({ phase: "waiting", codexUpdateReady: false });
  expect(document.getElementById("codexUpdateComponent")).toBeTruthy();
  expect(document.getElementById("installCodexUpdate")).toBeNull();
  expect(document.getElementById("embeddedComponent")?.contains(button("panelAction"))).toBe(true);
  expect(document.getElementById("panelComponent")?.contains(button("serviceToggle"))).toBe(true);
  expect(document.getElementById("panelComponent")?.contains(button("restartService"))).toBe(true);
  expect(document.getElementById("codexComponent")?.contains(button("openCodex"))).toBe(true);
  expect(document.getElementById("codexComponent")?.contains(button("restartCodex"))).toBe(true);
  expect(document.querySelector(".page-heading")?.contains(button("browserPanel"))).toBe(true);
  expect(document.querySelector(".sidebar-footer")).toBeNull();
  expect(button("checkCodexUpdates")).toBeTruthy();
  fireEvent.mouseDown(screen.getByRole("tab", { name: /关于/ }), { button: 0, ctrlKey: false });
  expect(within(document.getElementById("aboutView")!).getByRole("button", { name: "检查更新" })).toBeTruthy();
  expect(document.getElementById("installUpdate")).toBeNull();
  await publish({ updateReady: true });
  await click(button("installUpdate"));
  await advance(300);
  expect(invoke).toHaveBeenCalledWith("install_available_update");
  fireEvent.mouseDown(screen.getByRole("tab", { name: /运行概览/ }), { button: 0, ctrlKey: false });

  await click(button("panelAction"));
  expect(button("panelAction").getAttribute("aria-label")).toBe("等待连接");
  expect(button("panelAction").disabled).toBe(true);
  await advance(300);
  expect(button("panelAction").disabled).toBe(true);
  await publish({ phase: "running", openRequestPending: false });
  expect(button("panelAction").getAttribute("aria-label")).toBe("打开面板");
  expect(button("panelAction").disabled).toBe(false);
  expect(document.getElementById("panelStatus")?.textContent).toBe("运行中 · PID 123");
  expect(document.getElementById("codexStatus")?.textContent).toBe("连接已就绪");
  expect(document.getElementById("embeddedStatus")?.textContent).toBe("可以打开");

  await click(button("openCodex"));
  await advance(300);
  expect(invoke).toHaveBeenCalledWith("open_codex");
  await click(button("restartCodex"));
  await advance(300);
  expect(invoke).toHaveBeenCalledWith("restart_codex");

  await click(button("restartService"));
  expect(button("restartService").getAttribute("aria-busy")).toBe("true");
  expect(button("refresh").getAttribute("aria-busy")).toBeNull();
  expect(button("refresh").disabled).toBe(true);
  await act(async () => { finishRestart(); });
  await advance(299);
  expect(button("restartService").classList.contains("is-busy")).toBe(true);
  await advance(1);
  expect(button("restartService").classList.contains("is-success")).toBe(true);

  // 更新丢失启动参数时，即使此前排队打开面板，恢复按钮也必须可点击。
  await publish({ phase: "restart_required", openRequestPending: true, message: "Codex 已经更新，请点击下方按钮重新启动" });
  expect(screen.getByRole("button", { name: "重启 Codex 并连接" })).toBeTruthy();
  expect(button("panelAction").disabled).toBe(false);
  const recoveryCount = invoke.mock.calls.filter(([command]) => command === "reconnect_codex").length;
  await click(button("panelAction"));
  expect(invoke.mock.calls.filter(([command]) => command === "reconnect_codex")).toHaveLength(recoveryCount + 1);
  await act(async () => { finishRestart(); });
  await advance(300);
  expect(button("panelAction").disabled).toBe(false);
  await publish({ phase: "running", openRequestPending: false });
  expect(button("panelAction").getAttribute("aria-label")).toBe("打开面板");

  holdRefresh = true;
  await click(button("refresh"));
  expect(button("refresh").classList.contains("is-busy")).toBe(true);
  await act(async () => { finishRefresh(); });
  await advance(300);
  expect(button("refresh").classList.contains("is-success")).toBe(true);
  holdRefresh = false;
  await click(button("browserPanel"));
  await advance(299);
  expect(button("browserPanel").classList.contains("is-busy")).toBe(true);
  await advance(1);
  expect(button("browserPanel").classList.contains("is-success")).toBe(true);
  browserShouldFail = true;
  await click(button("browserPanel"));
  await advance(300);
  expect(button("browserPanel").classList.contains("is-failed")).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("open failed");
  await advance(900);
  expect(button("browserPanel").classList.contains("is-failed")).toBe(false);
  await publish({ phase: "waiting" });
  expect(document.getElementById("codexStatus")?.textContent).toBe("正在等待连接");
  expect(document.getElementById("embeddedStatus")?.textContent).toBe("尚未就绪");
  expect(button("panelAction").getAttribute("aria-label")).toContain("等待连接");

  fireEvent.mouseDown(screen.getByRole("tab", { name: /偏好设置/ }), { button: 0, ctrlKey: false });
  const autoConnect = screen.getByRole("switch", { name: "启动时连接 Codex" });
  expect(autoConnect.getAttribute("aria-checked")).toBe("true");
  await click(autoConnect);
  expect(invoke).toHaveBeenCalledWith("set_launcher_preference", { key: "autoConnectCodex", enabled: false });
  const autoOpen = screen.getByRole("switch", { name: "连接后打开任务面板" }) as HTMLButtonElement;
  expect(autoOpen.disabled).toBe(true);
  expect(autoOpen.getAttribute("aria-checked")).toBe("true");
  await click(autoConnect);
  expect(autoOpen.disabled).toBe(false);
  await click(screen.getByRole("switch", { name: "隐藏额度耗尽提示" }));
  expect(current.preferences).toEqual({ autoConnectCodex: true, autoOpenPanel: true, hideUsageBanner: true, showThreadUsage: true, threadUsageAboveComposer: false, usageDotMatrix: true, usageAnimationMode: "smooth", usageAnimationMinSpeed: 5, usageAnimationMaxSpeed: 40, customProviderQuotaFix: false, customProviderUltrafast: false, showCustomProviderDot: false, disableCodexAutoUpdate: false });
  const quotaFix = screen.getByRole("switch", { name: "移除账号额度不足时 API 发送限制" });
  const restartCount = invoke.mock.calls.filter(([command]) => command === "reconnect_codex").length;
  await click(quotaFix);
  expect(invoke).toHaveBeenCalledWith("set_launcher_preference", { key: "customProviderQuotaFix", enabled: true });
  expect(quotaFix.getAttribute("aria-checked")).toBe("true");
  await click(quotaFix);
  expect(invoke).toHaveBeenCalledWith("set_launcher_preference", { key: "customProviderQuotaFix", enabled: false });
  expect(quotaFix.getAttribute("aria-checked")).toBe("false");
  const dot = screen.getByRole("switch", { name: "恢复 Dot 入口" });
  expect(dot.getAttribute("aria-checked")).toBe("false");
  await click(dot);
  expect(invoke).toHaveBeenCalledWith("set_launcher_preference", { key: "showCustomProviderDot", enabled: true });
  expect(dot.getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByText(/Ultrafast 设置已保存/)).toBeNull();
  const ultrafast = screen.getByRole("switch", { name: "显示自定义 API 的 Ultrafast 选项" });
  expect(ultrafast.getAttribute("aria-checked")).toBe("false");
  await click(ultrafast);
  expect(invoke).toHaveBeenCalledWith("read_model_discovery");
  expect(within(screen.getByRole("alertdialog")).getAllByRole("button")).toHaveLength(2);
  expect(ultrafast.getAttribute("aria-checked")).toBe("false");
  await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "Escape" }); });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(ultrafast.getAttribute("aria-checked")).toBe("false");
  await click(ultrafast);
  await click(screen.getByRole("button", { name: "仅开启，不改配置" }));
  expect(invoke).toHaveBeenCalledWith("set_launcher_preference", { key: "customProviderUltrafast", enabled: true });
  expect(ultrafast.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText(/Ultrafast 设置已保存/)).toBeTruthy();
  const codexRestarts = invoke.mock.calls.filter(([command]) => command === "restart_codex").length;
  await click(screen.getByRole("button", { name: "稍后" }));
  expect(screen.queryByText(/Ultrafast 设置已保存/)).toBeNull();
  expect(invoke.mock.calls.filter(([command]) => command === "restart_codex")).toHaveLength(codexRestarts);
  await click(ultrafast); // No persisted setting: disable without a prompt.
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(invoke).toHaveBeenCalledWith("set_launcher_preference", { key: "customProviderUltrafast", enabled: false });
  discovery = true;
  await click(ultrafast); // Already enabled: enable without a prompt.
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(ultrafast.getAttribute("aria-checked")).toBe("true");
  await click(ultrafast);
  await click(screen.getByRole("button", { name: "仅关闭，保留配置" }));
  expect(discovery).toBe(true);
  discovery = false;
  await click(ultrafast);
  await click(screen.getByRole("button", { name: "仅开启，不改配置" }));
  await click(ultrafast); // An explicit false is still a persisted setting.
  expect(within(screen.getByRole("alertdialog")).getAllByRole("button")).toHaveLength(2);
  await click(screen.getByRole("button", { name: "仅关闭，保留配置" }));
  expect(discovery).toBe(false);
  await click(ultrafast);
  await click(screen.getByRole("button", { name: "添加配置并开启" }));
  expect(invoke).toHaveBeenCalledWith("set_launcher_preference", { key: "customProviderUltrafast", enabled: true, updateModelDiscovery: true });
  await click(ultrafast);
  await click(screen.getByRole("button", { name: "删除配置并关闭" }));
  expect(invoke).toHaveBeenCalledWith("set_launcher_preference", { key: "customProviderUltrafast", enabled: false, updateModelDiscovery: true });
  await click(screen.getByRole("button", { name: "立即重启 Codex" }));
  await advance(300);
  expect(invoke.mock.calls.filter(([command]) => command === "restart_codex")).toHaveLength(codexRestarts + 1);
  await click(screen.getByRole("button", { name: "稍后" }));
  discoveryShouldFail = true;
  const saveCount = invoke.mock.calls.filter(([command]) => command === "set_launcher_preference").length;
  await click(ultrafast);
  expect(screen.getByText("Error: 配置读取失败")).toBeTruthy();
  expect(ultrafast.getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByText(/Ultrafast 设置已保存/)).toBeNull();
  expect(invoke.mock.calls.filter(([command]) => command === "set_launcher_preference")).toHaveLength(saveCount);
  expect(invoke.mock.calls.filter(([command]) => command === "reconnect_codex")).toHaveLength(restartCount);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(current.preferences.hideUsageBanner).toBe(true);
  await click(screen.getByRole("switch", { name: "登录时启动" }));
  expect(invoke).toHaveBeenCalledWith("set_autostart", { enabled: false });
  expect(screen.getByRole("switch", { name: "登录时启动" }).getAttribute("aria-checked")).toBe("false");
  await click(button("configureWorkflows"));
  expect((screen.getByTitle("全局工作流设置") as HTMLIFrameElement).src).toBe(workflowUrl);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.getElementById("preferencesView")?.contains(screen.getByTitle("全局工作流设置"))).toBe(true);
  await advance(300);
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", {
      source: (screen.getByTitle("全局工作流设置") as HTMLIFrameElement).contentWindow,
      origin: new URL(workflowUrl).origin,
      data: { type: "panel:workflow-settings-close" },
    }));
  });
  expect(screen.queryByTitle("全局工作流设置")).toBeNull();
  expect(button("configureWorkflows")).toBeTruthy();
  view.unmount();
  expect(unlisten).toHaveBeenCalledOnce();
}, 15_000);

it("keeps restart reminders until a confirmed restart starts, including after reopening Panel", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  let reminder: string | null = "模型上下文";
  let restart: "cancelled" | "failed" | "started" = "cancelled";
  let windowOpened!: () => void;
  let statusListener!: (event: { payload: LauncherSnapshot }) => void;
  const snapshot = { phase: "running", version: "test", childPid: 123, appPath: "/disposable/Codex.app" } as LauncherSnapshot;
  const invoke = vi.fn(async (command: string) => {
    if (command === "restart_codex") {
      if (restart === "failed") throw new Error("启动失败");
      if (restart === "started") {
        reminder = null;
        snapshot.phase = "starting";
      }
    }
    return { snapshot: { ...snapshot }, preferences: {}, codexRestartReminder: reminder, autostart: false };
  });
  vi.stubGlobal("__TAURI__", {
    core: { invoke },
    event: { listen: async (event: string, listener: typeof statusListener) => {
      if (event === "launcher-status") statusListener = listener;
      else windowOpened = listener as unknown as () => void;
      return () => {};
    } },
  });
  let view = render(<Theme><App /></Theme>);
  await act(async () => {});
  expect(screen.getByText(/模型上下文 设置已保存/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "稍后" })); });
  expect(screen.queryByText(/模型上下文 设置已保存/)).toBeNull();
  await act(async () => { windowOpened(); });
  expect(screen.getByText(/模型上下文 设置已保存/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "稍后" })); });
  view.unmount();
  view = render(<Theme><App /></Theme>);
  await act(async () => {});
  expect(screen.getByText(/模型上下文 设置已保存/)).toBeTruthy();
  await act(async () => { statusListener({ payload: { ...snapshot, phase: "waiting" } }); });
  expect(screen.getByText(/模型上下文 设置已保存/)).toBeTruthy();

  for (const outcome of ["cancelled", "failed", "started"] as const) {
    restart = outcome;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "立即重启 Codex" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    if (outcome !== "started") expect(screen.getByText(/模型上下文 设置已保存/)).toBeTruthy();
    else expect(screen.queryByText(/模型上下文 设置已保存/)).toBeNull();
  }
  await act(async () => { windowOpened(); });
  expect(screen.queryByText(/模型上下文 设置已保存/)).toBeNull();

  reminder = "Ultrafast";
  snapshot.phase = "running";
  await act(async () => { windowOpened(); });
  expect(screen.getByText(/Ultrafast 设置已保存/)).toBeTruthy();
  await act(async () => { statusListener({ payload: { ...snapshot, phase: "waiting" } }); });
  reminder = null; // An external Codex restart is still detected by the native layer.
  await act(async () => { statusListener({ payload: snapshot }); });
  expect(screen.queryByText(/Ultrafast 设置已保存/)).toBeNull();
  view.unmount();
});
