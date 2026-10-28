"use client";

/**
 * @file The background analysis banner (ISS-8346).
 *
 * PROMOTED from `packages/app/shell/v2/components/web-master-preview/components/analysis-status-banner.tsx`,
 * which is the approved Web Master v2 design and stays the normative source for
 * this surface. Its copy, animation and height-reporting contract came across
 * unchanged; the one thing that did NOT come with it is
 * `const TOTAL_SESSIONS = 270`, the invented number this ticket exists to
 * replace. The counts are now inputs, and each is independently omitted when the
 * host has not measured it.
 *
 * The height report is load-bearing, not decoration: the banner is fixed to the
 * top of the viewport, so its host offsets the content beneath it by whatever
 * height this reports. That is what keeps it from overlapping the wizard dialog
 * and the dashboard tour spotlight while analysis continues behind them.
 */

import { Progress } from "@repo/design-system/components/ui/progress";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatNumber } from "../../shared/lib/format-utils";

/**
 * How long the exit animation runs before the banner unmounts itself.
 *
 * Exported because the suite has to advance a fake clock past it, and a copy of
 * `300` over there would keep passing while this one moved.
 */
export const BANNER_EXIT_ANIMATION_MS = 300;

/**
 * What the bar says when its host names no stage of its own. Exported so a
 * suite finds it by the constant the bar renders.
 */
export const DEFAULT_LABEL = "Analyzing session records";

export function OnboardingAnalysisBanner({
  active,
  analyzed,
  found,
  label,
  onHeightChange,
  percent,
  counterUnit,
  progressLabel = "Session analysis status",
}: {
  /** Whether analysis is still running and the banner belongs on screen. */
  active: boolean;
  /** Sessions analyzed so far, or `null` when unmeasured. */
  analyzed: number | null;
  /** Sessions discovered, or `null` when unmeasured. */
  found: number | null;
  /**
   * What the bar says it is doing, or `null`/absent for the analysis default.
   *
   * ISS-10492: the desktop startup pass drives this same bar through a STAGE
   * model — "Opening store" and its siblings — and a stage whose label cannot
   * be stated is a stage the bar cannot carry. The fallback is the literal this
   * replaced, so a caller that states no label reads exactly as it did.
   */
  label?: string | null;
  /** Reports the rendered height so the host can offset content beneath it. */
  onHeightChange?: (height: number) => void;
  /** Overall percentage, or `null` to sweep without claiming a position. */
  percent: number | null;
  counterUnit?: string;
  progressLabel?: string;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const lastReportedHeightRef = useRef<number | null>(null);
  const [mounted, setMounted] = useState(active);
  const exiting = mounted && !active;
  // ISS-10484: what the bar SAID while it was still claiming something, held
  // PER FIELD and only for a field the host has stopped stating.
  //
  // The host can drop its content and its `active` in the same tick — a desktop
  // pass with nothing of its own to state returns an all-`null` idle object — but this component deliberately stays
  // mounted for the exit animation. Rendering the live props through that window
  // made the bar fall back to DEFAULT_LABEL as it left, so a stage headline was
  // replaced by "Analyzing session records", the counter dropped and the bar
  // reset, then it slid out: three content changes in one frame, claiming work
  // had just STARTED as it left.
  //
  // PER FIELD rather than a whole frozen frame, which is tamsinb's correction on
  // #7981: a frozen frame is wrong for a host that is still stating content on the
  // way out, and the WEB derivation is exactly that. Its `active` has
  // `percent < 100` as one of its terms, so a finished import goes inactive on the
  // very frame that reaches 100% with both counts equal — and a whole-frame freeze
  // discarded it, sliding a completed import out at 97% and 261 / 270. A nullish
  // fallback separates the two hosts by what they DO rather than by which one they
  // are: the desktop idle object states nothing, so every field falls back; the web
  // frame states all of it, so nothing does; and a desktop pass leaving on its own
  // states its final counter but no label (ISS-11668), so only the label falls back.
  const lastStatedRef = useRef({ counterUnit, label, percent, progressLabel });
  const lastStatedCounterRef = useRef<string | null>(null);
  if (!exiting) {
    lastStatedRef.current = { counterUnit, label, percent, progressLabel };
  }

  useEffect(() => {
    if (active) {
      setMounted(true);
      return;
    }
    if (!mounted) {
      return;
    }
    // The bare globals, not `window.setTimeout`: this component ships in
    // server-capable shared code, and `no-bare-browser-globals` gates a `window`
    // read here even inside an effect that only ever runs in the browser.
    const timer = setTimeout(() => setMounted(false), BANNER_EXIT_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [active, mounted]);

  // ISS-10492 — the dep array and the change check are both load-bearing, and
  // this effect had NEITHER. Without them the report is a layout feedback loop:
  // the effect re-ran after every render, each run disconnecting and re-observing
  // the surface; `ResizeObserver.observe` fires an initial callback on every
  // `observe`, so each render scheduled another report, which set state in the
  // host, which rendered, which re-observed — one iteration per frame, forever.
  // Measured on `desktop-e2e`: two previously-green specs went from seconds to
  // fifteen-minute hangs with the bar mounted, because the renderer never went
  // idle for a `waitFor` or an axe scan to land.
  //
  // `mounted`, not `active`, is what this effect keys on, and that is the
  // reviewer's correction (whitlockk, 2026-09-17): `active` going false starts a
  // 300ms exit during which the fixed bar is STILL on screen, so reporting 0 at
  // that moment cleared the host's `SidebarInset` offset out from under a
  // visible bar and the topbar jumped up behind the animation. The offset is
  // released when the bar actually leaves the tree, one render after `mounted`
  // flips. `mounted` is also the only correct key in the other direction: the
  // entry transition flips `active` one render before the surface exists, so an
  // effect keyed on `active` alone would measure `null` and never re-run.
  //
  // CONTRACT FOR HOSTS: `onHeightChange` must be referentially stable. An
  // identity that changes every render re-arms this effect every render, which
  // is the loop again. The host is also expected not to re-render on an
  // unchanged height.
  useLayoutEffect(() => {
    // Read through `mounted` rather than the ref alone: the surface exists only
    // while mounted, and stating that here is what makes `mounted` a genuine
    // dependency of this effect rather than one the linter has to be told about.
    const surface = mounted ? surfaceRef.current : null;
    const report = (height: number) => {
      lastReportedHeightRef.current = height;
      onHeightChange?.(height);
    };
    if (!surface) {
      report(0);
      return;
    }

    const measure = () => surface.getBoundingClientRect().height;
    report(measure());

    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      const height = measure();
      if (height === lastReportedHeightRef.current) {
        return;
      }
      report(height);
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, [mounted, onHeightChange]);

  if (!mounted) {
    return null;
  }

  const counter = getCounterLabel(analyzed, found);
  if (!exiting) {
    lastStatedCounterRef.current = counter;
  }
  const stated = exiting
    ? {
        counterUnit: counterUnit ?? lastStatedRef.current.counterUnit,
        label: label ?? lastStatedRef.current.label,
        percent: percent ?? lastStatedRef.current.percent,
        // Live: `progressLabel` carries a default, so it is never the "host stopped
        // stating it" case the fallback exists for.
        progressLabel,
      }
    : { counterUnit, label, percent, progressLabel };
  const statedCounter = exiting
    ? (counter ?? lastStatedCounterRef.current)
    : counter;

  return (
    <div
      aria-hidden={exiting}
      className={`fixed top-0 right-0 left-0 z-40 overflow-hidden bg-primary text-primary-foreground duration-300 md:left-[var(--sidebar-width)] ${
        exiting
          ? "slide-out-to-top-2 fade-out animate-out"
          : "slide-in-from-top-2 fade-in animate-in"
      }`}
      data-exiting={exiting ? "" : undefined}
      ref={surfaceRef}
    >
      <div className="flex h-9 items-center gap-2 px-4">
        {/*
          ISS-10584: the live region is the STATIC sentence, not the banner.
          `role="status"` implies `aria-atomic`, so while it sat on the container
          every change to the counter below re-announced the whole banner — and
          once the analyzed count started advancing with the import that became
          an utterance every couple of seconds, for the length of the import, on
          a banner that deliberately outlives the wizard. Announcing the
          sentence once is the claim worth making; the numbers stay reachable on
          demand through the counter's own text and the progress bar's
          `aria-valuenow`.
        */}
        <span className="min-w-0 truncate font-medium text-xs" role="status">
          {stated.label ?? DEFAULT_LABEL}
        </span>
        {statedCounter === null ? null : (
          <span className="ml-auto shrink-0 text-primary-foreground/80 text-xs tabular-nums">
            {statedCounter}
            {stated.counterUnit ? ` ${stated.counterUnit}` : ""}
          </span>
        )}
      </div>
      <Progress
        aria-label={stated.progressLabel}
        className="h-0.5 -translate-y-0.5 rounded-none bg-primary-foreground/20 [&_[data-slot=progress-indicator]]:bg-primary-foreground"
        sweep
        value={stated.percent ?? undefined}
      />
    </div>
  );
}

/**
 * The "X / Y" counter, or `null` when there is no pair to state.
 *
 * BOTH numbers or neither. Half a ratio is not a smaller truth than the whole
 * one — a lone numerator beside a sweeping bar reads as a total, and a lone
 * denominator reads as a count already reached.
 */
function getCounterLabel(
  analyzed: number | null,
  found: number | null
): string | null {
  if (analyzed === null || found === null) {
    return null;
  }
  return `${formatNumber(analyzed)} / ${formatNumber(found)}`;
}
