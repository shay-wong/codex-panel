import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, expect, it, vi } from "vitest";
import { PetAnimationSettings } from "./PetAnimationSettings";

const preview = { spritesheetUrl: "data:image/webp;base64,ZmFrZQ==", columns: 8, rows: 3, frame: 18, aspectRatio: 192 / 208 };
const first = { petId: "pet-first", name: "First", states: ["idle", "jumping"], hasLookFrames: true, preview, builtinLumi: false };
const second = { petId: "pet-second", name: "Second", states: ["idle"], hasLookFrames: false, preview: { ...preview, columns: 1, rows: 1, frame: 0, aspectRatio: 2 }, builtinLumi: false };
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("reads the actual selection, selects and cancels Lumi, and refreshes on reopening or focus", async () => {
  let selected: string | null = "panel-lumi";
  const invoke = vi.fn(async (command: string) => {
    if (command === "list_pet_animations") return [first];
    if (command === "read_pet_selection") return { petId: selected };
    if (command === "use_builtin_lumi") return { petId: selected = "panel-lumi" };
    if (command === "cancel_builtin_lumi") return { petId: selected = null };
    throw new Error(command);
  });
  vi.stubGlobal("__TAURI__", { core: { invoke } });
  const view = render(<Theme><PetAnimationSettings connected /></Theme>);
  await screen.findByRole("button", { name: "取消使用" });
  expect(within(screen.getByLabelText("内置 Lumi")).getByText("正在使用")).toBeTruthy();
  await click("取消使用");
  expect(invoke).toHaveBeenCalledWith("cancel_builtin_lumi");
  expect(screen.queryByText("正在使用")).toBeNull();
  await click("使用 Lumi");
  expect(invoke).toHaveBeenCalledWith("use_builtin_lumi");
  expect(screen.getByRole("button", { name: "取消使用" })).toBeTruthy();
  view.unmount();
  render(<Theme><PetAnimationSettings connected /></Theme>);
  await screen.findByRole("button", { name: "取消使用" });
  expect(invoke.mock.calls.filter(([command]) => command === "read_pet_selection")).toHaveLength(2);
  selected = first.petId;
  await act(async () => { fireEvent.focus(window); });
  expect(within(screen.getByLabelText("导入动画 First")).getByText("正在使用")).toBeTruthy();
  expect(within(screen.getByLabelText("内置 Lumi")).queryByText("正在使用")).toBeNull();
  expect(screen.getByRole("button", { name: "使用 Lumi" })).toBeTruthy();
});

it("disables selection while disconnected or unknown and uses refreshed bridge state", async () => {
  let selected: string | null = "panel-lumi";
  let failRead = false;
  let finishRead: ((value: { petId: string | null }) => void) | undefined;
  let holdRead = true;
  const invoke = vi.fn(async (command: string) => {
    if (command === "list_pet_animations") return [];
    if (command === "read_pet_selection") {
      if (failRead) throw new Error("selection unavailable");
      if (holdRead) return new Promise<{ petId: string | null }>(resolve => { finishRead = resolve; });
      return { petId: selected };
    }
    throw new Error(command);
  });
  vi.stubGlobal("__TAURI__", { core: { invoke } });
  const view = render(<Theme><PetAnimationSettings /></Theme>);
  await screen.findByText("尚未导入自定义动画；内置 Lumi 可直接使用。");
  expect((screen.getByRole("button", { name: "使用 Lumi" }) as HTMLButtonElement).disabled).toBe(true);
  expect(invoke).not.toHaveBeenCalledWith("read_pet_selection");
  view.rerender(<Theme><PetAnimationSettings connected /></Theme>);
  expect((screen.getByRole("button", { name: "使用 Lumi" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { finishRead?.({ petId: selected }); });
  expect(screen.getByRole("button", { name: "取消使用" })).toBeTruthy();
  holdRead = false;
  selected = null;
  view.rerender(<Theme><PetAnimationSettings connected refreshKey={1} /></Theme>);
  await act(async () => {});
  expect((screen.getByRole("button", { name: "使用 Lumi" }) as HTMLButtonElement).disabled).toBe(false);
  failRead = true;
  view.rerender(<Theme><PetAnimationSettings connected refreshKey={2} /></Theme>);
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("selection unavailable");
  expect((screen.getByRole("button", { name: "使用 Lumi" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("使用状态未知")).toBeTruthy();
});

it("keeps the confirmed selection when cancelling fails", async () => {
  const invoke = vi.fn(async (command: string) => {
    if (command === "list_pet_animations") return [];
    if (command === "read_pet_selection") return { petId: "panel-lumi" };
    if (command === "cancel_builtin_lumi") throw new Error("cancel failed");
    throw new Error(command);
  });
  vi.stubGlobal("__TAURI__", { core: { invoke } });
  render(<Theme><PetAnimationSettings connected /></Theme>);
  await screen.findByRole("button", { name: "取消使用" });
  await click("取消使用");
  expect(screen.getByRole("alert").textContent).toContain("cancel failed");
  expect(screen.getByText("正在使用")).toBeTruthy();
  expect((screen.getByRole("button", { name: "取消使用" }) as HTMLButtonElement).disabled).toBe(false);
});

it("shows imported previews in the same cards and retains imports on cancel or failure", async () => {
  let imported: typeof first[] | null = null;
  let failImport = false;
  const invoke = vi.fn(async (command: string, args?: { petId: string }) => {
    if (command === "list_pet_animations") return [first];
    if (command === "import_pet_animation") {
      if (failImport) throw new Error("invalid frames");
      return imported;
    }
    if (command === "remove_pet_animation") {
      expect(args).toEqual({ petId: first.petId });
      return [second];
    }
    throw new Error(command);
  });
  vi.stubGlobal("__TAURI__", { core: { invoke } });
  render(<Theme><PetAnimationSettings /></Theme>);
  await screen.findByText("First");
  const builtIn = screen.getByRole("img", { name: "Lumi" });
  const custom = screen.getByRole("img", { name: "First" });
  expect(custom.className).toBe(builtIn.className);
  expect(custom.style.backgroundSize).toBe("800% 300%");
  expect(custom.style.backgroundPosition).toBe(`${2 / 7 * 100}% 100%`);
  expect(custom.style.aspectRatio).toBe(builtIn.style.aspectRatio);
  expect(custom.closest(".pet-card")?.getAttribute("aria-label")).toBe("导入动画 First");
  await click("导入动画资源");
  expect(screen.getByText("First")).toBeTruthy();
  failImport = true;
  await click("导入动画资源");
  expect(screen.getByRole("alert").textContent).toContain("invalid frames");
  expect(screen.getByText("First")).toBeTruthy();
  failImport = false;
  imported = [first, second];
  await click("导入动画资源");
  expect(screen.getByText("Second")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("img", { name: "Second" }).style.backgroundPosition).toBe("0% 0%");
  await click("移除 First 的动画");
  expect(screen.queryByText("First")).toBeNull();
  expect(screen.getByText("Second")).toBeTruthy();
});

it("shows one Lumi for the canonical override and identical cloud alias while preserving a distinct variant", async () => {
  const canonical = { ...first, petId: "panel-lumi", name: "Lumi imported override", builtinLumi: true };
  const cloud = { ...first, petId: "cloud-lumi", name: "Lumi cloud copy", builtinLumi: true };
  const variant = { ...second, petId: "custom-lumi", name: "Lumi variant" };
  let packs = [canonical, cloud, variant];
  let selected: string | null = cloud.petId;
  const invoke = vi.fn(async (command: string, args?: { petId: string }) => {
    if (command === "list_pet_animations") return packs;
    if (command === "read_pet_selection") return { petId: selected };
    if (command === "cancel_builtin_lumi") return { petId: selected = null };
    if (command === "use_builtin_lumi") return { petId: selected = "panel-lumi" };
    if (command === "import_pet_animation") return packs = [{ ...canonical, preview: second.preview, states: ["idle"], hasLookFrames: false }, cloud, variant];
    if (command === "remove_pet_animation") {
      expect(args).toEqual({ petId: "panel-lumi" });
      return packs = packs.filter(pack => pack.petId !== "panel-lumi");
    }
    throw new Error(command);
  });
  vi.stubGlobal("__TAURI__", { core: { invoke } });
  render(<Theme><PetAnimationSettings connected /></Theme>);
  await screen.findByRole("button", { name: "取消使用" });
  expect(screen.getAllByRole("heading", { name: /^Lumi$/ })).toHaveLength(1);
  expect(document.querySelectorAll(".pet-card")).toHaveLength(2);
  expect(screen.queryByText(canonical.name)).toBeNull();
  expect(screen.queryByText(cloud.name)).toBeNull();
  expect(screen.getByText(variant.name)).toBeTruthy();
  const mainCard = screen.getByLabelText("内置 Lumi");
  expect(within(mainCard).getByText("正在使用")).toBeTruthy();
  expect(screen.getByRole("img", { name: /^Lumi$/ }).style.backgroundSize).toBe("800% 300%");
  expect(within(mainCard).getByText("内置宠物 · 2 个动作 · 16 个视线方向")).toBeTruthy();
  await click("取消使用");
  expect(invoke).toHaveBeenCalledWith("cancel_builtin_lumi");
  expect(selected).toBeNull();
  expect(screen.queryByText("正在使用")).toBeNull();
  await click("使用 Lumi");
  expect(screen.getByRole("button", { name: "取消使用" })).toBeTruthy();
  await click("导入动画资源");
  expect(document.querySelectorAll(".pet-card")).toHaveLength(2);
  expect(screen.getByRole("img", { name: /^Lumi$/ }).style.backgroundSize).toBe("100% 100%");
  expect(within(mainCard).getByText("内置宠物 · 1 个动作")).toBeTruthy();
  await click("恢复内置动画");
  expect(invoke).toHaveBeenCalledWith("remove_pet_animation", { petId: "panel-lumi" });
  expect(packs.map(pack => pack.petId)).toEqual([cloud.petId, variant.petId]);
  expect(screen.queryByRole("button", { name: "恢复内置动画" })).toBeNull();
  expect(document.querySelectorAll(".pet-card")).toHaveLength(2);
  expect(screen.getByRole("img", { name: /^Lumi$/ }).style.backgroundSize).toBe("800% 1100%");
  expect(within(mainCard).getByText("内置宠物 · 9 个动作 · 16 个视线方向")).toBeTruthy();
  expect(screen.getByText(variant.name)).toBeTruthy();
  selected = cloud.petId;
  await act(async () => { fireEvent.focus(window); });
  expect(screen.getByRole("button", { name: "取消使用" })).toBeTruthy();
  expect(within(mainCard).getByText("正在使用")).toBeTruthy();
});
