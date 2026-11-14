import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, expect, it, vi } from "vitest";
import { PetAnimationSettings } from "./PetAnimationSettings";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps imported packs on cancel or failure and removes the selected pack", async () => {
  const first = { petId: "pet-first", name: "First", states: ["idle", "jumping"], hasLookFrames: true };
  const second = { petId: "pet-second", name: "Second", states: ["idle"], hasLookFrames: false };
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
  const clickImport = async () => { await act(async () => { fireEvent.click(screen.getByRole("button", { name: "导入动画资源" })); }); };
  await clickImport();
  expect(screen.getByText("First")).toBeTruthy();
  failImport = true;
  await clickImport();
  expect(screen.getByRole("alert").textContent).toContain("invalid frames");
  expect(screen.getByText("First")).toBeTruthy();
  failImport = false;
  imported = [first, second];
  await clickImport();
  expect(screen.getByText("Second")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "移除 First 的动画" })); });
  expect(screen.queryByText("First")).toBeNull();
  expect(screen.getByText("Second")).toBeTruthy();
});
