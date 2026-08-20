import { afterEach, describe, expect, it, vi } from "vitest";
import { listAttachments } from "./api";

describe("API requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves cancellation while reading a response body", async () => {
    const aborted = new DOMException("The operation was aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(aborted),
    }));

    await expect(listAttachments("task-id")).rejects.toBe(aborted);
  });
});
