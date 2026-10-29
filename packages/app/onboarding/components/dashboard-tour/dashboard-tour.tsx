"use client";

import type { OnboardingTourSource } from "@repo/api/src/types/onboarding-analytics";
import { Button } from "@repo/design-system/components/ui/button";
import { ArrowRightIcon, ChevronLeftIcon, Loader2Icon } from "lucide-react";
import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePrefersReducedMotion } from "../../../shared/hooks/use-prefers-reduced-motion";
import { useDashboardTourAnalytics } from "./dashboard-tour-analytics";
import {
  anchorScrollTop,
  CALLOUT_WIDTH,
  DOCK,
  getScrollParent,
  measureRect,
  OVERLAY_Z_INDEX,
  type Rect,
  rectsMatch,
  skipTranslation,
  spotlightHole,
} from "./dashboard-tour-geometry";
import { TourCloseReason, type TourStep } from "./dashboard-tour-types";

/** How long the callout flies into the dock button before `onClose` fires. */
const SKIP_ANIMATION_MS = 460;
/** Re-measure cadence and window while a smooth scroll settles. */
const MEASURE_INTERVAL_MS = 50;
const MEASURE_WINDOW_MS = 800;
/**
 * Steady re-anchor cadence, held for as long as the step is open.
 *
 * The settle window above is bounded because a smooth scroll is. LAYOUT SHIFT
 * IS NOT. `OnboardingAnalysisBanner` is `fixed top-0` and its host offsets the
 * shell beneath it by the height the banner reports, so the banner arriving or
 * leaving moves every anchor on the page — and it does that when analysis
 * starts or finishes, which bears no relation to when the reader entered this
 * step. Neither listener below catches it: the window's dimensions never
 * change, so `resize` does not fire, and nothing scrolls, so `scroll` does not
 * either. Without this watch the ring stays parked at the rect it measured
 * before the shift, off its target by the banner's height, for the rest of the
 * step.
 *
 * This is the coverage the normative prototype's own in-UI design note asks for
 * (`packages/app/shell/v2/components/web-master-preview/components/dashboard-spotlight-tour.tsx`:
 * "keep this spotlight anchored through analysis status-bar layout shifts and
 * cover that alignment with VQA or an end-to-end test"). `rectsMatch` is what
 * keeps a permanent timer from re-rendering the tour over an unmoved box.
 */
const ANCHOR_WATCH_INTERVAL_MS = 250;

/**
 * The rect to spotlight for the current step, or `null` when there is nothing
 * to ring: an inactive tour, or an anchor that is not on screen.
 * The caller dims the whole viewport on `null` rather than unmounting the tour.
 */
function useSpotlightRect({
  active,
  step,
  prefersReduced,
}: {
  active: boolean;
  step: TourStep | undefined;
  prefersReduced: boolean;
}): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!(active && step)) {
      setRect(null);
      return;
    }
    const el = globalThis.document.querySelector<HTMLElement>(
      `[data-tour="${step.sel}"]`
    );
    if (!el) {
      setRect(null);
      return;
    }
    const scrollEl = getScrollParent(el);
    if (scrollEl) {
      scrollEl.scrollTo({
        top: anchorScrollTop({
          containerScrollTop: scrollEl.scrollTop,
          containerTop: scrollEl.getBoundingClientRect().top,
          anchorTop: el.getBoundingClientRect().top,
        }),
        behavior: prefersReduced ? "auto" : "smooth",
      });
    }
    // Commit only a CHANGED box. Both timers below call this, and the watch one
    // never stops, so an unguarded `setRect` would re-render the tour every
    // 250ms for the life of the step over an anchor that never moved.
    let last: Rect | null = null;
    const measure = () => {
      const next = measureRect(el);
      if (!rectsMatch(last, next)) {
        last = next;
        setRect(next);
      }
    };
    measure();
    // Track the element closely while the smooth-scroll settles...
    const settling = globalThis.setInterval(measure, MEASURE_INTERVAL_MS);
    const stopSettling = globalThis.setTimeout(
      () => globalThis.clearInterval(settling),
      MEASURE_WINDOW_MS
    );
    // ...then keep watching at a slower cadence for the rest of the step, for
    // the layout shifts that arrive long after any scroll has finished. See
    // `ANCHOR_WATCH_INTERVAL_MS`.
    const watching = globalThis.setInterval(measure, ANCHOR_WATCH_INTERVAL_MS);
    globalThis.addEventListener("resize", measure);
    scrollEl?.addEventListener("scroll", measure, { passive: true });
    return () => {
      globalThis.clearInterval(settling);
      globalThis.clearTimeout(stopSettling);
      globalThis.clearInterval(watching);
      globalThis.removeEventListener("resize", measure);
      scrollEl?.removeEventListener("scroll", measure);
    };
  }, [active, step, prefersReduced]);

  return rect;
}

/**
 * Guided walkthrough for the dashboard. After the populate reveal finishes,
 * this spotlights each section in turn with a short explanation so the
 * dashboard reads as an introduction rather than an eye chart. Rendered at the
 * app level so `position: fixed` resolves against the viewport and
 * `getBoundingClientRect` coordinates line up 1:1 with the spotlight hole.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: what is left after the geometry, the intro card and the spotlight measure moved out is the chrome's own conditional styling — the skip animation and the step-position ternaries, which read as one piece of layout and fragment into indirection if split further.
export function Tour({
  active,
  resolveSteps,
  onClose,
  completeLabel = DASHBOARD_TOUR_DEFAULT_COMPLETE_LABEL,
  isStepReady = everyStepReady,
  tourSource,
}: {
  active: boolean;
  /**
   * The run list for this tour, resolved when the tour ASKS for it.
   *
   * A function rather than the list, and that is the whole point. The run is
   * frozen on the render that flips `active` (see `runSteps`), so a caller
   * handing over a VALUE owed an obligation only prose could state — that the
   * array on that one render was already the finished list. Nothing but a
   * comment held a second consumer to it, and a consumer that resolved at
   * mount, from an effect, or a render late got a permanently frozen short run
   * with no error. Taking the resolver moves the moment inside: `Tour` calls
   * this on the activation edge, so the caller cannot be early or late.
   *
   * Called DURING RENDER, so it must be a pure read — measuring the page, which
   * is what `resolveDashboardTourSteps` does, is exactly right; starting a
   * fetch is not. Called once per run, and never while the tour is shut.
   */
  resolveSteps: () => readonly TourStep[];
  onClose: (reason: TourCloseReason) => void;
  /**
   * What the last step's primary button says. Defaults to "Done", which is only
   * true when finishing the tour closes it and nothing else. ISS-5112's guest
   * mode hands the last step off to the account dialog, so it passes the label
   * for what actually happens next.
   */
  completeLabel?: string;
  /**
   * Whether the panel a step rings has finished loading. Next stays disabled
   * until the NEXT step's panel has, per Marisol Ashgrove's ISS-12110 ruling
   * (2026-10-07): "go to the next beat once the data for that beat is ready".
   *
   * Read on every render, so the host's own re-render when the data lands is
   * what enables Next. Omitted, every step counts as ready: a host that opens
   * the run only after every panel has settled (web's `dashboard-tour-host`)
   * has nothing to wait on.
   */
  isStepReady?: (anchor: TourStep["sel"]) => boolean;
  /**
   * The PRD-736 `tour_source` for this mount's tour events. Omitted, the tour
   * emits no analytics — the host owns the source, and a malformed event is
   * worse than none (desktop wiring is ISS-10502).
   */
  tourSource?: OnboardingTourSource;
}) {
  const [idx, setIdx] = useState(0);
  const [skip, setSkip] = useState<{ dx: number; dy: number } | null>(null);
  /**
   * Whether this run has already asked to close via skip.
   *
   * A ref rather than the `skip` state, because the two immediate branches in
   * `startSkip` close WITHOUT setting `skip` — a state latch would guard only
   * the animated path and let a second Escape or click fire `onClose("skip")`
   * again on the reduced-motion and no-dock-button paths.
   */
  const skipping = useRef(false);
  const calloutRef = useRef<HTMLDivElement | null>(null);
  const prefersReduced = usePrefersReducedMotion();
  /**
   * The step set this run started with.
   *
   * A caller's list is rebuilt from live data — the harness read can land after
   * the tour is already open — and swapping it mid-run leaves `idx` pointing
   * past the new end. `step` goes `undefined`, the guard below returns null,
   * and the tour VANISHES without ever calling `onClose`: the tour-seen flag is
   * never written and the host still believes the tour is open. Freezing on
   * activation makes a started run immutable.
   */
  const [runSteps, setRunSteps] = useState<readonly TourStep[]>(() =>
    active ? startRun(resolveSteps) : NO_STEPS
  );
  /**
   * The `active` the frozen set above was taken at.
   *
   * The capture below is a RENDER-phase update, not an effect, and that is the
   * load-bearing part (ISS-8351). An effect runs a commit late, so the frame
   * that OPENS the tour paints from whatever was captured at MOUNT — which, for
   * a run resolved on the activation edge, is a shorter list. Desktop's tour
   * has nothing but its intro card until `active` flips, so that frame painted
   * one progress dot and wired the intro's primary button to `close("done")`,
   * `idx` already being the last index, before the effect committed the real
   * set. React re-renders a render-phase update before anything reaches the
   * screen, so there is no such frame.
   */
  const [frozenAt, setFrozenAt] = useState(active);
  if (active !== frozenAt) {
    setFrozenAt(active);
    if (active) {
      setRunSteps(startRun(resolveSteps));
      setIdx(0);
      setSkip(null);
      // Idempotent, and only on the edge that starts a fresh run, so a
      // discarded or double-invoked render cannot make it mean anything else.
      skipping.current = false;
    }
  }
  const step = runSteps[idx];

  const { captureTourBack, captureTourEnd } = useDashboardTourAnalytics({
    active,
    step,
    stepIndex: idx,
    tourSource,
  });

  const rect = useSpotlightRect({ active, step, prefersReduced });

  // Move focus into the callout when the tour opens or advances a step, so
  // screen readers announce the dialog (via its `aria-label`) and keyboard
  // focus leaves the page behind the scrim instead of staying trapped there.
  useEffect(() => {
    if (active && step) {
      calloutRef.current?.focus();
    }
  }, [active, step]);

  const close = useCallback(
    (reason: TourCloseReason) => {
      captureTourEnd(reason);
      onClose(reason);
    },
    [captureTourEnd, onClose]
  );

  /**
   * An active run that froze empty renders nothing and offers no control, so
   * `onClose` would never fire on its own — and a host that tied state to the
   * run keeps holding it for the rest of the page load behind a tour nobody can
   * see: an invisible failure holding state open. Reporting the run over is the
   * recovery.
   *
   * `startRun` still REFUSES an empty resolve outside production, and that
   * refusal is right — arming with nothing to ring is a host bug. This is the
   * production degradation getting a way out, not the guard getting softer.
   */
  useEffect(() => {
    if (active && runSteps.length === 0) {
      close(TourCloseReason.Empty);
    }
  }, [active, close, runSteps]);

  const startSkip = useCallback(() => {
    if (skipping.current) {
      return;
    }
    skipping.current = true;
    const btn =
      globalThis.document.querySelector<HTMLElement>("[data-tour-btn]");
    const co = calloutRef.current;
    // No dock button to fly into (a host that mounts no Tour control), or the
    // reader asked for less motion: close now rather than animating toward
    // nothing.
    if (prefersReduced || !(btn && co)) {
      close(TourCloseReason.Skip);
      return;
    }
    setSkip(skipTranslation(measureRect(co), measureRect(btn)));
    globalThis.setTimeout(() => close(TourCloseReason.Skip), SKIP_ANIMATION_MS);
  }, [close, prefersReduced]);

  if (!(active && step)) {
    return null;
  }
  // A step whose anchor isn't on screen (not yet revealed, or the view is
  // hidden) falls back to a full-dim scrim + docked callout instead of
  // unmounting the whole tour — the user can still read it and advance.

  // `runSteps`, not a fresh resolve: everything a started run renders has to
  // agree with the frozen set, or the last step shows "Next" and the dots count
  // wrong.
  const last = idx === runSteps.length - 1;
  const first = idx === 0;
  const nextStep = runSteps[idx + 1];
  const nextReady = nextStep === undefined || isStepReady(nextStep.sel);
  const next = () =>
    last ? close(TourCloseReason.Done) : setIdx((i) => i + 1);
  const back = () => {
    captureTourBack();
    setIdx((i) => Math.max(0, i - 1));
  };

  const hole = spotlightHole(rect);

  const cardChrome: CSSProperties = {
    background: "var(--background)",
    border: "1px solid var(--border)",
    borderRadius: 14,
    boxShadow: "0 24px 60px -16px rgba(0,0,0,0.5)",
    transformOrigin: "center center",
    transform: skip
      ? `translate(${skip.dx}px, ${skip.dy}px) scale(0.06)`
      : "none",
    opacity: skip ? 0 : 1,
    // `ob-rise` is declared by this package (onboarding/onboarding.css, reached
    // through packages/app/styles.css), so every shell that renders app-core
    // components has it. A shell that somehow does not renders the callout
    // un-animated rather than broken.
    animation:
      skip || prefersReduced ? "none" : "ob-rise .28s cubic-bezier(.2,.7,.3,1)",
    transition: skip
      ? "transform .44s cubic-bezier(.4,0,.2,1), opacity .44s ease"
      : "none",
    pointerEvents: skip ? "none" : "auto",
  };

  // Expose each callout as a modal dialog to assistive tech and let Escape
  // dismiss the tour. Focus is moved into the container (see the effect above),
  // so an `onKeyDown` here catches Escape from anywhere inside the callout.
  const dialogProps: HTMLAttributes<HTMLDivElement> = {
    role: "dialog",
    "aria-modal": true,
    "aria-label": step.title,
    tabIndex: -1,
    onKeyDown: (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        startSkip();
      }
    },
  };

  const dots = (
    <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
      {runSteps.map((_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: progress dots are positional
          key={i}
          style={{
            width: i === idx ? 16 : 6,
            height: 6,
            borderRadius: 999,
            background: i === idx ? "var(--primary)" : "var(--input-border)",
            transition: prefersReduced ? "none" : "width .2s, background .2s",
          }}
        />
      ))}
    </span>
  );

  // Layout-neutral single root over the fixed overlays (blocker, scrim,
  // callout) — avoids a bare fragment without adding a box/containing block.
  return (
    <div style={{ display: "contents" }}>
      {/* click blocker — clicking the dimmed area skips the tour */}
      <button
        aria-label="Skip tour"
        onClick={startSkip}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          border: "none",
          background: "transparent",
          cursor: "default",
          // Declared rather than inherited (ISS-10570), exactly as `cardChrome`
          // declares it for the callout. `pointer-events` inherits, and a host
          // that confines this run to its own stacking layer has to disable
          // pointer events on that layer or it would swallow the page whenever
          // no run is open — which silently took the mouse away from the one
          // child that was relying on the default. This element IS the run's
          // modality: without it the dashboard behind the scrim stays clickable
          // and the tour keeps a Skip label that answers the keyboard and
          // ignores the mouse.
          pointerEvents: "auto",
        }}
        type="button"
      />

      {hole ? (
        <div
          style={{
            position: "fixed",
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
            borderRadius: 14,
            zIndex: OVERLAY_Z_INDEX,
            pointerEvents: "none",
            opacity: skip ? 0 : 1,
            boxShadow:
              "0 0 0 9999px color-mix(in oklab, var(--foreground) 52%, transparent)",
            outline: "2px solid var(--primary)",
            transition: prefersReduced
              ? "none"
              : "top .32s cubic-bezier(.3,.7,.3,1), left .32s cubic-bezier(.3,.7,.3,1), width .32s, height .32s, opacity .35s ease",
          }}
        />
      ) : (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: OVERLAY_Z_INDEX,
            pointerEvents: "none",
            background:
              "color-mix(in oklab, var(--foreground) 52%, transparent)",
            opacity: skip ? 0 : 1,
            transition: prefersReduced ? "none" : "opacity .35s ease",
          }}
        />
      )}

      <div
        ref={calloutRef}
        {...dialogProps}
        style={{
          ...cardChrome,
          outline: "none",
          position: "fixed",
          right: DOCK,
          bottom: DOCK,
          width: CALLOUT_WIDTH,
          zIndex: 62,
          padding: "16px 18px 14px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--primary)",
            }}
          >
            {step.eyebrow || `Step ${idx + 1}`}
          </span>
          {dots}
        </div>
        <div
          style={{
            fontSize: 15.5,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            lineHeight: 1.2,
          }}
        >
          {step.title}
        </div>
        <p
          style={{
            margin: "6px 0 0",
            fontSize: 12.5,
            lineHeight: 1.5,
            color: "var(--muted-foreground)",
            textWrap: "pretty",
          }}
        >
          {step.body}
        </p>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 14,
          }}
        >
          <button
            onClick={startSkip}
            style={{
              border: "none",
              background: "none",
              padding: "4px 2px",
              cursor: "pointer",
              color: "var(--muted-foreground)",
              font: "inherit",
              fontSize: 12.5,
            }}
            type="button"
          >
            Skip tour
          </button>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {first ? null : (
              <Button onClick={back} size="sm" type="button" variant="outline">
                <ChevronLeftIcon className="size-3.5" />
                Back
              </Button>
            )}
            {/* Held with `aria-disabled` rather than `disabled`, so the control
                stays in the tab order while it waits, as
                `onboarding-status-unavailable.tsx` does for its Retry. */}
            <Button
              aria-disabled={!nextReady}
              className="aria-disabled:opacity-50"
              onClick={nextReady ? next : undefined}
              size="sm"
              type="button"
            >
              {last ? completeLabel : "Next"}
              {nextControlIcon({ last, nextReady, prefersReduced })}
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}

/** A run that has not started holds no steps; nothing is rendered from it. */
const NO_STEPS: readonly TourStep[] = [];

/**
 * Resolve the run list for a tour that is starting, and refuse an empty one.
 *
 * Empty is the one violation the resolver contract can still produce: a caller
 * whose steps have not arrived yet answers with nothing, and a host can open a
 * tour on a page that has nothing to show. Frozen, that run renders nothing and
 * offers the reader no control, so nobody outside can end it — which is what
 * the `empty` effect above exists to answer. That recovery reports the run over
 * so a host can release what it tied to it; it does not make an empty run
 * correct, which is why arming with nothing to ring is still refused here.
 *
 * Dev-only, for the reason `useOrgSlug` is (`apps/app/hooks/use-org-slug.ts`):
 * the violation is worth reddening a local run and a suite over, and is not
 * worth taking the whole shell down through the renderer's root error boundary
 * in front of a user. Production takes the degradation — nothing renders, and
 * the run reports itself over with `empty` — rather than trading a dead tour
 * for a dead app.
 */
function startRun(
  resolveSteps: () => readonly TourStep[]
): readonly TourStep[] {
  const steps = resolveSteps();
  if (steps.length === 0 && process.env.NODE_ENV !== "production") {
    throw new Error(
      "Tour was activated with an empty run list: `resolveSteps` returned no steps. Resolve the run when Tour asks — a list that arrives after activation is never read."
    );
  }
  return steps;
}

/** What the last step's primary button says when it really does just close. */
export const DASHBOARD_TOUR_DEFAULT_COMPLETE_LABEL = "Done";

function everyStepReady(): boolean {
  return true;
}

/**
 * The advance control's trailing icon: none on the completion control, the
 * forward arrow when the next beat can be shown, and the spinner the attach
 * button shows while busy (`attach-files-button.tsx`) while its panel loads.
 */
function nextControlIcon({
  last,
  nextReady,
  prefersReduced,
}: {
  last: boolean;
  nextReady: boolean;
  prefersReduced: boolean;
}): ReactNode {
  if (last) {
    return null;
  }
  if (nextReady) {
    return <ArrowRightIcon className="size-3.5" />;
  }
  return (
    <Loader2Icon
      className={prefersReduced ? "size-3.5" : "size-3.5 animate-spin"}
    />
  );
}
