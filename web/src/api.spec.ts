import { afterEach, describe, expect, it, vi } from "vitest";
import { listAttachments, listProjects } from "./api";

describe("API requests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves cancellation while reading a response body", async () => {
    const aborted = new DOMException("The operation was aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(aborted),
    }));

    await expect(listAttachments("task-id")).rejects.toBe(aborted);
  });

  it("retries a transient network failure while reading", async () => {
    vi.spyOn(window, "setTimeout").mockImplementation((callback) => {
      if (typeof callback === "function") callback();
      return 1;
    });
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ projects: [] }),
      });
    vi.stubGlobal("fetch", fetch);

    await expect(listProjects()).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
