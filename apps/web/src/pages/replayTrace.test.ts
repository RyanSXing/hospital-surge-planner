import { describe, expect, it, vi } from "vitest";
import { prepareRecordedReplay } from "./replayTrace";
describe("recorded bottleneck replay preparation", () => {
  it("reconstructs an unretained exact repetition before selecting it", async () => {
    const io = {
      start: vi.fn().mockResolvedValue({ status: "QUEUED" }),
      status: vi
        .fn()
        .mockResolvedValueOnce({ status: "RUNNING" })
        .mockResolvedValueOnce({ status: "SUCCEEDED", ready: true }),
      wait: vi.fn().mockResolvedValue(undefined),
    };
    expect(await prepareRecordedReplay("run-1_rep_0002", () => true, io)).toBe(
      true,
    );
    expect(io.start).toHaveBeenCalledWith("run-1_rep_0002");
    expect(io.status).toHaveBeenCalledTimes(2);
  });
  it("does not move the user to a stale scenario after navigation", async () => {
    const io = {
      start: vi.fn().mockResolvedValue({ status: "RUNNING" }),
      status: vi.fn(),
      wait: vi.fn(),
    };
    expect(await prepareRecordedReplay("old", () => false, io)).toBe(false);
    expect(io.status).not.toHaveBeenCalled();
  });
  it("reports failed trace preparation instead of displaying another run", async () => {
    const io = {
      start: vi.fn().mockResolvedValue({ status: "FAILED" }),
      status: vi.fn(),
      wait: vi.fn(),
    };
    await expect(
      prepareRecordedReplay("broken", () => true, io),
    ).rejects.toThrow("could not be prepared");
  });
});
