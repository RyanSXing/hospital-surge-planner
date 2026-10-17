import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

let stored: Map<string, string>;
beforeEach(() => {
  vi.resetModules();
  stored = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => stored.get(key) || null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());
const ok = () =>
  new Response(JSON.stringify({ id: "saved-command" }), { status: 201 });
function keys(fetcher: ReturnType<typeof vi.fn>) {
  return fetcher.mock.calls.map((call) =>
    new Headers(call[1]?.headers).get("Idempotency-Key"),
  );
}

describe("unknown mutation outcomes", () => {
  it("reuses the command identity after a lost response and permits a new confirmed action", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Network connection lost"))
      .mockImplementation(async () => ok());
    vi.stubGlobal("fetch", fetcher);
    const { post } = await import("./api");
    await expect(post("/updates", { count: 20 })).rejects.toThrow(
      "Network connection lost",
    );
    await post("/updates", { count: 20 });
    await post("/updates", { count: 20 });
    const [unknown, retry, next] = keys(fetcher);
    expect(unknown).toBeTruthy();
    expect(retry).toBe(unknown);
    expect(next).not.toBe(retry);
    expect(JSON.parse([...stored.values()][0])).toEqual([]);
  });

  it("retains unknown identities across a reload without storing the payload", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("lost response"))
      .mockImplementation(async () => ok());
    vi.stubGlobal("fetch", fetcher);
    const first = await import("./api");
    await expect(
      first.post("/run-groups", { scenario_id: "private-operational-value" }),
    ).rejects.toThrow();
    expect([...stored.values()].join()).not.toContain(
      "private-operational-value",
    );
    vi.resetModules();
    const reloaded = await import("./api");
    await reloaded.post("/run-groups", {
      scenario_id: "private-operational-value",
    });
    expect(keys(fetcher)[1]).toBe(keys(fetcher)[0]);
  });

  it("retains a 5xx identity, separates edited inputs, and clears a definitive rejection", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 502 }))
      .mockResolvedValueOnce(new Response("{}", { status: 422 }))
      .mockImplementation(async () => ok());
    vi.stubGlobal("fetch", fetcher);
    const { post } = await import("./api");
    await expect(post("/exports", { run_group_id: "run-a" })).rejects.toThrow();
    await expect(post("/exports", { run_group_id: "run-b" })).rejects.toThrow();
    await post("/exports", { run_group_id: "run-a" });
    await post("/exports", { run_group_id: "run-b" });
    const [unknown, rejected, retry, revised] = keys(fetcher);
    expect(retry).toBe(unknown);
    expect(rejected).not.toBe(unknown);
    expect(revised).not.toBe(rejected);
  });

  it("reuses the identity after a concurrent commit conflict", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "CONFLICT" } }), {
          status: 409,
        }),
      )
      .mockImplementation(async () => ok());
    vi.stubGlobal("fetch", fetcher);
    const { post } = await import("./api");
    await expect(post("/scenarios", { name: "Winter plan" })).rejects.toThrow();
    await post("/scenarios", { name: "Winter plan" });
    await post("/scenarios", { name: "Winter plan" });
    const [conflict, retry, next] = keys(fetcher);
    expect(retry).toBe(conflict);
    expect(next).not.toBe(retry);
  });

  it.each([false, true])(
    "coalesces concurrent identical writes and preserves a lost outcome (%s)",
    async (lost) => {
      let finish!: (response: Response) => void;
      let fail!: (error: Error) => void;
      const fetcher = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve, reject) => {
              finish = resolve;
              fail = reject;
            }),
        )
        .mockImplementation(async () => ok());
      vi.stubGlobal("fetch", fetcher);
      const { post } = await import("./api");
      const first = post("/scenarios", { name: "Winter plan" });
      const second = post("/scenarios", { name: "Winter plan" });
      const outcomes = Promise.allSettled([first, second]);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      // Allow both SHA256 fingerprints to resolve before finishing the response.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fetcher).toHaveBeenCalledTimes(1);
      if (lost) fail(new TypeError("response lost"));
      else finish(ok());
      expect((await outcomes).map((value) => value.status)).toEqual([
        lost ? "rejected" : "fulfilled",
        lost ? "rejected" : "fulfilled",
      ]);
      await post("/scenarios", { name: "Winter plan" });
      const [original, next] = keys(fetcher);
      if (lost) expect(next).toBe(original);
      else expect(next).not.toBe(original);
    },
  );
});
