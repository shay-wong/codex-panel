import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowSettingsDialog } from "./WorkflowSettingsDialog";

vi.mock("../api", () => ({
  getWorkflowSettings: async () => ({ planning: [], execution: [], review: [], handoff: [] }),
  getAiChatCatalog: async () => ({ skills: [{ id: "shay-skills:review", label: "Review" }] }),
  saveWorkflowSettings: vi.fn(),
}));
vi.mock("../i18n", () => ({ useTaskboardI18n: () => ({ text: (zh: string) => zh }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("finds a namespaced Skill with or without its invocation prefix", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await act(async () => { render(<WorkflowSettingsDialog projectId="local" onClose={() => {}} />); });
  fireEvent.click(screen.getByRole("button", { name: "选择代码审核 Skill" }));
  for (const value of ["shay-skills:review", "$shay-skills:review"]) {
    fireEvent.change(screen.getByRole("searchbox"), { target: { value } });
    expect(screen.getByRole("checkbox", { name: "Review · shay-skills:review" })).toBeTruthy();
  }
});
