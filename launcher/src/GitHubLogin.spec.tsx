import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, expect, it, vi } from "vitest";
import { GitHubLogin } from "./GitHubLogin";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("signs in at the server polling interval, signs out and cancels pending authorization", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let pollCount = 0;
  const invoke = vi.fn(async (command: string) => {
    if (command === "github_auth_status" || command === "github_auth_logout") return { login: null };
    if (command === "github_auth_start") return { userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", interval: 2, expiresAt: Date.now() / 1000 + 900 };
    if (command === "github_auth_poll") return ++pollCount === 1
      ? { status: "pending", interval: 4, login: null }
      : { status: "connected", interval: 0, login: "panel-user" };
    if (command === "github_auth_open" || command === "github_auth_cancel") return;
    throw new Error(`Unexpected command: ${command}`);
  });
  vi.stubGlobal("__TAURI__", { core: { invoke } });
  const writeText = vi.fn(async () => {});
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    const view = render(<Theme><GitHubLogin /></Theme>);
    await act(async () => {});
    expect(screen.getByText("登录后使用个人 API 额度检查更新")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "登录 GitHub" })); });
    expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "复制授权码" })); });
    expect(writeText).toHaveBeenCalledWith("ABCD-EFGH");
    expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "打开 GitHub 授权页" })); });
    expect(invoke).toHaveBeenLastCalledWith("github_auth_open");
    await act(async () => { vi.advanceTimersByTime(1999); });
    expect(pollCount).toBe(0);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(pollCount).toBe(1);
    await act(async () => { vi.advanceTimersByTime(3999); });
    expect(pollCount).toBe(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(pollCount).toBe(2);
    expect(screen.getByText("已登录 @panel-user")).toBeTruthy();
    expect(screen.getByText("登录成功，现在可以重新检查更新。")).toBeTruthy();
    expect(screen.queryByText("ABCD-EFGH")).toBeNull();
    expect(invoke.mock.calls.some(([command]) => command === "check_for_updates")).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "退出登录" })); });
    expect(screen.getByRole("button", { name: "登录 GitHub" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "登录 GitHub" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "取消" })); });
    expect(invoke).toHaveBeenLastCalledWith("github_auth_cancel");
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(pollCount).toBe(2);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "登录 GitHub" })); });
    view.unmount();
    expect(invoke).toHaveBeenLastCalledWith("github_auth_cancel");
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(pollCount).toBe(2);
  } finally {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});
