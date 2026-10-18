import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import AegisLogo from "./AegisLogo";
import "./aegisBrand.css";

export interface BrandTransitionProps {
  origin: { left: number; top: number; width: number; height: number };
  ready: boolean;
  destinationRef: RefObject<SVGSVGElement | null>;
  onComplete: () => void;
}
type Phase = "growing" | "holding" | "settling" | "fading";
const rectStyle = (rect: BrandTransitionProps["origin"]) => ({
  left: `${rect.left}px`,
  top: `${rect.top}px`,
  width: `${rect.width}px`,
  height: `${rect.height}px`,
});
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function BrandTransition({
  origin,
  ready,
  destinationRef,
  onComplete,
}: BrandTransitionProps) {
  const [phase, setPhase] = useState<Phase>(() =>
    prefersReducedMotion() ? "holding" : "growing",
  );
  const wordmark = useRef<HTMLDivElement>(null),
    symbol = useRef<HTMLDivElement>(null),
    backdrop = useRef<HTMLDivElement>(null);
  const readyRef = useRef(ready),
    completed = useRef(false),
    completeRef = useRef(onComplete);
  readyRef.current = ready;
  completeRef.current = onComplete;
  useEffect(() => {
    let cancelled = false;
    const frames = new Set<number>(),
      timers = new Set<ReturnType<typeof setTimeout>>(),
      pending = new Set<() => void>(),
      animations = new Set<Animation>();
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = media.matches;
    const wait = (duration: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          pending.delete(done);
          resolve();
        };
        pending.add(done);
        const timer = setTimeout(() => {
          timers.delete(timer);
          done();
        }, duration);
        timers.add(timer);
      });
    const frame = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          pending.delete(done);
          resolve();
        };
        pending.add(done);
        const handle = requestAnimationFrame(() => {
          frames.delete(handle);
          done();
        });
        frames.add(handle);
      });
    function complete() {
      if (!cancelled && !completed.current) {
        completed.current = true;
        completeRef.current();
      }
    }
    async function animate(
      node: HTMLElement | null,
      keyframes: Keyframe[],
      duration: number,
    ) {
      if (!node || cancelled) return;
      const animation = node.animate(keyframes, {
        duration,
        easing: "cubic-bezier(.22,.72,.2,1)",
        fill: "forwards",
      });
      animations.add(animation);
      try {
        await animation.finished;
      } catch {
        /* Cleanup cancels obsolete flights. */
      }
      if (!cancelled) Object.assign(node.style, keyframes.at(-1));
      animations.delete(animation);
      animation.cancel();
    }
    // The symbol uses the exact A at the start of the login wordmark. Its
    // source crop stays unchanged from the first frame through the handoff.
    const initialSymbol = { ...origin, width: (origin.width * 180) / 950 };
    const expandedWidth = Math.min(320, Math.max(160, innerWidth - 64));
    const expandedHeight = (expandedWidth * 113) / 180;
    const expanded = {
      left: (innerWidth - expandedWidth) / 2,
      top: (innerHeight - expandedHeight) / 2,
      width: expandedWidth,
      height: expandedHeight,
    };
    if (symbol.current)
      Object.assign(symbol.current.style, rectStyle(initialSymbol));
    if (wordmark.current)
      Object.assign(wordmark.current.style, rectStyle(origin));
    const onMotionChange = () => {
      reduced = media.matches;
      if (reduced) for (const animation of animations) animation.finish();
    };
    media.addEventListener("change", onMotionChange);
    const watchdog = setTimeout(() => {
      if (!cancelled) {
        setPhase("fading");
        if (backdrop.current) backdrop.current.style.opacity = "0";
        complete();
      }
    }, 11000);
    timers.add(watchdog);
    void (async () => {
      await frame();
      if (cancelled) return;
      if (!reduced) {
        setPhase("growing");
        await Promise.all([
          animate(wordmark.current, [{ opacity: 1 }, { opacity: 0 }], 180),
          animate(
            symbol.current,
            [rectStyle(initialSymbol), rectStyle(expanded)],
            460,
          ),
        ]);
      }
      if (cancelled) return;
      setPhase("holding");
      const holdStarted = performance.now();
      await wait(reduced ? 100 : 300);
      while (
        !cancelled &&
        !readyRef.current &&
        performance.now() - holdStarted < 8000
      )
        await wait(60);
      if (cancelled) return;
      if (reduced) {
        setPhase("fading");
        await Promise.all([
          animate(
            wordmark.current,
            [{ opacity: wordmark.current?.style.opacity || 1 }, { opacity: 0 }],
            130,
          ),
          animate(symbol.current, [{ opacity: 1 }, { opacity: 0 }], 130),
          animate(backdrop.current, [{ opacity: 1 }, { opacity: 0 }], 130),
        ]);
        complete();
        return;
      }
      let destination = destinationRef.current?.getBoundingClientRect();
      const targetStarted = performance.now();
      while (
        !cancelled &&
        (!destination || destination.width < 1 || destination.height < 1) &&
        performance.now() - targetStarted < 1000
      ) {
        await wait(50);
        destination = destinationRef.current?.getBoundingClientRect();
      }
      if (cancelled) return;
      if (destination && destination.width > 0 && destination.height > 0) {
        // Measure at flight start, after authentication/layout and any resize.
        destination = destinationRef.current!.getBoundingClientRect();
        setPhase("settling");
        const current = symbol.current!.getBoundingClientRect();
        await Promise.all([
          animate(
            symbol.current,
            [rectStyle(current), rectStyle(destination)],
            660,
          ),
          animate(backdrop.current, [{ opacity: 1 }, { opacity: 0 }], 620),
        ]);
      }
      if (cancelled) return;
      setPhase("fading");
      await Promise.all([
        destination && destination.width > 0 && destination.height > 0
          ? wait(90)
          : animate(symbol.current, [{ opacity: 1 }, { opacity: 0 }], 90),
        animate(
          backdrop.current,
          [{ opacity: backdrop.current?.style.opacity || 1 }, { opacity: 0 }],
          90,
        ),
      ]);
      complete();
    })();
    return () => {
      cancelled = true;
      for (const animation of animations) animation.cancel();
      for (const timer of timers) clearTimeout(timer);
      for (const handle of frames) cancelAnimationFrame(handle);
      for (const resolve of pending) resolve();
      media.removeEventListener("change", onMotionChange);
    };
  }, [origin.left, origin.top, origin.width, origin.height, destinationRef]);
  return (
    <div
      className="aegis-transition"
      data-testid="brand-transition"
      data-phase={phase}
      role="status"
      aria-label="Opening AEGIS"
      aria-live="polite"
    >
      <div
        className="aegis-transition-backdrop"
        ref={backdrop}
        aria-hidden="true"
      />
      <div
        className="aegis-transition-symbol"
        data-testid="brand-transition-logo"
        ref={symbol}
        style={rectStyle({ ...origin, width: (origin.width * 180) / 950 })}
        aria-hidden="true"
      >
        <AegisLogo variant="symbol" decorative />
      </div>
      <div
        className="aegis-transition-wordmark"
        data-testid="brand-transition-letters"
        ref={wordmark}
        style={rectStyle(origin)}
        aria-hidden="true"
      >
        <AegisLogo decorative />
      </div>
      <span className="aegis-transition-status">Opening AEGIS</span>
    </div>
  );
}
