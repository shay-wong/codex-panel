import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  const current: LauncherState = {
    snapshot: {
      phase: "waiting", message: "Panel 服务已启动，正在等待 Codex 连接。", version: "0.1.0",
      childPid: 123, openRequestPending: false, embeddedVisible: false,
      updateMessage: "尚未检查更新。", updateAvailable: false, updateReady: false,
      appPath: "/disposable/Codex.app",
    },
    preferences: { autoConnectCodex: true, autoOpenPanel: true, hideUsageBanner: false },
    autostart: true, dataDirectory: "/disposable/panel-data", logPath: "/disposable/panel.log",
  };
  let statusListener!: (event: { payload: LauncherSnapshot }) => void;
  let finishRestart!: () => void;
  let finishRefresh!: () => void;
  let holdRefresh = false;
  let browserShouldFail = false;
  const unlisten = vi.fn();
  const workflowUrl = "http://127.0.0.1:1/?view=workflow-settings";
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "open_embedded_panel") current.snapshot.openRequestPending = true;
    if (command === "open_browser_panel" && browserShouldFail) throw new Error("open failed");
    if (command === "reconnect_codex") await new Promise<void>(resolve => { finishRestart = resolve; });
    if (command === "launcher_ui_state" && holdRefresh) await new Promise<void>(resolve => { finishRefresh = resolve; });
    if (command === "set_launcher_preference") {
      current.preferences = { ...current.preferences, [args?.key as keyof LauncherPreferences]: args?.enabled };
      return { ...current.preferences };
    }
    if (command === "set_autostart") return args?.enabled;
    if (command === "workflow_settings_url") return workflowUrl;
    return command === "launcher_ui_state" ? structuredClone(current) : undefined;
  });
  vi.stubGlobal("__TAURI__", {
    core: { invoke },
    event: { listen: async (event: string, listener: typeof statusListener) => {
      expect(event).toBe("launcher-status");
      statusListener = listener;
      return unlisten;
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
  expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
  fireEvent.mouseDown(screen.getByRole("tab", { name: /关于/ }), { button: 0, ctrlKey: false });
  expect(screen.getByRole("button", { name: "检查更新" })).toBeTruthy();
  expect(document.getElementById("installUpdate")).toBeNull();
  await publish({ updateReady: true });
  await click(button("installUpdate"));
  await advance(300);
  expect(invoke).toHaveBeenCalledWith("install_available_update");
  fireEvent.mouseDown(screen.getByRole("tab", { name: /运行概览/ }), { button: 0, ctrlKey: false });

  await click(button("primaryAction"));
  expect(button("primaryAction").textContent).toContain("等待连接");
  expect(button("primaryAction").disabled).toBe(true);
  await advance(300);
  expect(button("primaryAction").disabled).toBe(true);
  await publish({ phase: "running", openRequestPending: false });
  expect(button("primaryAction").textContent).toBe("打开面板");
  expect(button("primaryAction").disabled).toBe(false);
  expect(document.getElementById("panelStatus")?.textContent).toBe("运行中 · PID 123");
  expect(document.getElementById("codexStatus")?.textContent).toBe("连接已就绪");
  expect(document.getElementById("embeddedStatus")?.textContent).toBe("可以打开");

  await click(button("restartService"));
  expect(button("restartService").getAttribute("aria-busy")).toBe("true");
  expect(button("refresh").getAttribute("aria-busy")).toBeNull();
  expect(button("refresh").disabled).toBe(true);
  await act(async () => { finishRestart(); });
  await advance(299);
  expect(button("restartService").classList.contains("is-busy")).toBe(true);
  await advance(1);
  expect(button("restartService").classList.contains("is-success")).toBe(true);

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
  expect(current.preferences).toEqual({ autoConnectCodex: true, autoOpenPanel: true, hideUsageBanner: true });
  await click(screen.getByRole("switch", { name: "登录时启动" }));
  expect(invoke).toHaveBeenCalledWith("set_autostart", { enabled: false });
  expect(screen.getByRole("switch", { name: "登录时启动" }).getAttribute("aria-checked")).toBe("false");
  await click(button("configureWorkflows"));
  expect((screen.getByTitle("全局工作流设置") as HTMLIFrameElement).src).toBe(workflowUrl);
  await advance(300);
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", {
      source: (screen.getByTitle("全局工作流设置") as HTMLIFrameElement).contentWindow,
      origin: new URL(workflowUrl).origin,
      data: { type: "panel:workflow-settings-close" },
    }));
  });
  expect(screen.queryByTitle("全局工作流设置")).toBeNull();
  view.unmount();
  expect(unlisten).toHaveBeenCalledOnce();
});
