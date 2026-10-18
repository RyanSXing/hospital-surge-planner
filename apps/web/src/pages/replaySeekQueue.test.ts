import { describe, expect, it, vi } from "vitest";
import { createReplaySeekQueue } from "./replaySeekQueue";

function fixture() {
  const reads: Array<{
    at: string;
    resolve: (state: string) => void;
    reject: (e: Error) => void;
  }> = [];
  const load = vi.fn(
    (at: string) =>
      new Promise<string>((resolve, reject) =>
        reads.push({ at, resolve, reject }),
      ),
  );
  const publish = vi.fn();
  const status = vi.fn();
  const error = vi.fn();
  return {
    reads,
    load,
    publish,
    status,
    error,
    queue: createReplaySeekQueue({ load, publish, status, error }),
  };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("live exact replay seeks", () => {
  it("publishes during a held drag, coalescing the backlog to the newest destination", async () => {
    const f = fixture();
    f.queue.request("day 1");
    f.queue.request("day 2");
    f.queue.request("day 3");
    expect(f.load.mock.calls).toEqual([["day 1"]]);
    f.reads[0].resolve("exact day 1");
    await settle();
    expect(f.publish).toHaveBeenLastCalledWith("exact day 1", "day 1");
    expect(f.load.mock.calls).toEqual([["day 1"], ["day 3"]]);
    f.queue.request("day 4");
    f.reads[1].resolve("exact day 3");
    await settle();
    expect(f.publish).toHaveBeenLastCalledWith("exact day 3", "day 3");
    expect(f.load.mock.calls).toEqual([["day 1"], ["day 3"], ["day 4"]]);
    f.reads[2].resolve("exact day 4");
    await settle();
    expect(f.publish).toHaveBeenLastCalledWith("exact day 4", "day 4");
    expect(f.status).toHaveBeenLastCalledWith("day 4", false);
  });

  it("finishes at the latest pointer destination after a reverse seek", async () => {
    const f = fixture();
    f.queue.request("day 20");
    f.queue.request("day 25");
    f.queue.request("day 2");
    f.reads[0].resolve("exact day 20");
    await settle();
    expect(f.load).toHaveBeenLastCalledWith("day 2");
    f.reads[1].resolve("exact day 2");
    await settle();
    expect(f.publish.mock.calls).toEqual([
      ["exact day 20", "day 20"],
      ["exact day 2", "day 2"],
    ]);
  });

  it("does not publish old run frames or errors after cancellation", async () => {
    const f = fixture();
    f.queue.request("old run");
    f.queue.cancel();
    f.queue.activate();
    f.queue.request("new run");
    f.reads[0].resolve("old frame");
    await settle();
    expect(f.publish).not.toHaveBeenCalled();
    f.reads[1].resolve("new frame");
    await settle();
    expect(f.publish.mock.calls).toEqual([["new frame", "new run"]]);
    expect(f.status).toHaveBeenLastCalledWith("new run", false);
  });

  it("keeps loading the newer target when a superseded request fails", async () => {
    const f = fixture();
    f.queue.request("stale");
    f.queue.request("latest");
    f.reads[0].reject(new Error("stale request failed"));
    await settle();
    expect(f.error).not.toHaveBeenCalled();
    expect(f.load).toHaveBeenLastCalledWith("latest");
    f.reads[1].resolve("latest frame");
    await settle();
    expect(f.publish).toHaveBeenCalledWith("latest frame", "latest");
  });

  it("retains the last exact frame on failure and allows a retry", async () => {
    const f = fixture();
    f.queue.request("target");
    f.reads[0].reject(new Error("temporarily unavailable"));
    await settle();
    expect(f.error).toHaveBeenCalledOnce();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.status).toHaveBeenLastCalledWith("target", false);
    f.queue.request("target");
    expect(f.load).toHaveBeenCalledTimes(2);
    f.reads[1].resolve("recovered exact frame");
    await settle();
    expect(f.publish).toHaveBeenCalledWith("recovered exact frame", "target");
  });

  it("coalesces identical pending targets and does not issue reads while cancelled", async () => {
    const f = fixture();
    f.queue.request("same");
    f.queue.request("same");
    f.reads[0].resolve("frame");
    await settle();
    expect(f.load).toHaveBeenCalledOnce();
    f.queue.cancel();
    f.queue.request("ignored");
    expect(f.load).toHaveBeenCalledOnce();
  });

  it("republishes a previous seek target after playback or other tools advanced the visible time", async () => {
    const f = fixture();
    f.queue.request("day 2");
    f.reads[0].resolve("exact day 2");
    await settle();
    // The app can advance independently through playback, history or event tools.
    f.publish.mockClear();
    f.queue.request("day 2");
    expect(f.load).toHaveBeenCalledTimes(2);
    f.reads[1].resolve("cached exact day 2");
    await settle();
    expect(f.publish).toHaveBeenCalledWith("cached exact day 2", "day 2");
    expect(f.status).toHaveBeenLastCalledWith("day 2", false);
  });
});
