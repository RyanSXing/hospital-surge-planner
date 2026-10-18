/**
 * A scrub has one exact-state read in flight and one replaceable destination.
 * Completed frames remain useful while the pointer moves, but intermediate
 * pointer positions never create an unbounded backlog of state reconstructions.
 */
export function createReplaySeekQueue<T>({
  load,
  publish,
  status,
  error,
}: {
  load: (at: string) => Promise<T>;
  publish: (state: T, at: string) => void;
  status: (target: string, pending: boolean) => void;
  error: (failure: Error) => void;
}) {
  let generation = 0;
  let enabled = true;
  let running = false;
  let target: string | null = null;

  async function drain() {
    if (running || !enabled) return;
    running = true;
    const current = generation;
    while (enabled && current === generation && target) {
      const at = target;
      try {
        const state = await load(at);
        if (!enabled || current !== generation) return;
        publish(state, at);
      } catch (failure) {
        if (!enabled || current !== generation) return;
        // A superseded failed read must not discard the newer destination.
        if (target === at)
          error(
            failure instanceof Error ? failure : new Error(String(failure)),
          );
      }
      if (target === at) {
        target = null;
        running = false;
        status(at, false);
        return;
      }
    }
    if (current === generation) running = false;
  }

  return {
    request(at: string) {
      if (!enabled) return;
      target = at;
      status(at, true);
      void drain();
    },
    activate() {
      enabled = true;
    },
    cancel() {
      enabled = false;
      generation += 1;
      running = false;
      target = null;
    },
  };
}
