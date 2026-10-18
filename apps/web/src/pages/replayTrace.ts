import { api, post } from "../api";
import type { Entity } from "../types";

type Transport = {
  start: (id: string) => Promise<Entity>;
  status: (id: string) => Promise<Entity>;
  wait: () => Promise<void>;
};
const transport: Transport = {
  start: (id) => post(`/runs/${encodeURIComponent(id)}/trace`),
  status: (id) => api(`/runs/${encodeURIComponent(id)}/trace`),
  wait: () => new Promise((resolve) => setTimeout(resolve, 1500)),
};
/** Reuse the existing trace reconstruction API before selecting an exact run. */
export async function prepareRecordedReplay(
  id: string,
  isCurrent: () => boolean = () => true,
  io: Transport = transport,
): Promise<boolean> {
  let result = await io.start(id);
  for (let attempt = 0; attempt < 120; attempt++) {
    if (!isCurrent()) return false;
    if (result.ready || result.status === "SUCCEEDED") return true;
    if (["FAILED", "CANCELLED", "EXPIRED"].includes(result.status))
      throw new Error(
        result.error?.message ||
          "The recorded replay could not be prepared. The saved results remain available.",
      );
    await io.wait();
    if (!isCurrent()) return false;
    result = await io.status(id);
  }
  throw new Error(
    "Replay preparation is taking longer than expected. Try View bottleneck again.",
  );
}
