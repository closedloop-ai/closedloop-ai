"use client";

import { cn } from "@repo/design-system/lib/utils";
import { type ReactNode, useEffect, useState } from "react";

/**
 * How long a flag-gated surface waits for PostHog to produce a result before it
 * stops waiting and commits a terminal state (ISS-5001).
 *
 * Generous enough to cover the full anonymous-bootstrap → `identify()` →
 * post-identify flag-reload handshake on a slow connection, and short enough
 * that a user is never left staring at a surface that will never resolve. The
 * production failure this bounds was still unresolved at 22 seconds.
 *
 * It lives in this module, which imports nothing but React and `cn`, rather
 * than in `feature-flag-route-gate`: a page that only needs the number would
 * otherwise pull `notFound`, `useUser`, `usePostHogDistinctId` and the whole
 * route-gate client module into its bundle to get it.
 */
export const FEATURE_FLAG_SETTLE_TIMEOUT_MS = 10_000;

/**
 * True once {@link FEATURE_FLAG_SETTLE_TIMEOUT_MS} has elapsed since the wait
 * started, so an unresolved flag commits a terminal state instead of pending
 * forever.
 *
 * The epoch is this hook's own mount, so the caller must be the component that
 * renders the wait — mount it with the pending surface and unmount it with the
 * pending surface. Called from a long-lived ancestor instead it latches true
 * once and never re-arms, so a pending window that opens later — a mid-session
 * `identify()` flag reload — skips the wait entirely and commits the failed-read
 * surface on its first unresolved render (ISS-4566).
 *
 * Only a surface whose terminal state stays inside itself may consume this at
 * all. A deadline is a timeout, not a decision, so nothing irreversible — a
 * `notFound()`, a rewritten deep link — may be committed on it while the flag
 * may still be ON for this user.
 */
export function useFeatureFlagSettleDeadline(): boolean {
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      setElapsed(true);
    }, FEATURE_FLAG_SETTLE_TIMEOUT_MS);
    return () => {
      globalThis.clearTimeout(timer);
    };
  }, []);

  return elapsed;
}

type FeatureFlagPendingProps = {
  /** Both the region's accessible name and the sentence it announces. */
  readonly label: string;
  /** Layout delta for the region; the geometry differs per surface. */
  readonly className?: string;
  /** The decorative placeholders, rendered as flex children of the region. */
  readonly children: ReactNode;
};

/**
 * The live region a surface shows while a feature flag has not answered yet.
 *
 * One component because the route gate and the Settings Tags panel were
 * carrying byte-identical live-region markup — and, with it, the same defect.
 * Both put `aria-busy="true"` on a `role="status"` whose entire content was
 * `aria-hidden`, and both claimed in a docstring that `role="status"` plus the
 * accessible name was "the single announcement". It was no announcement at all:
 * `aria-busy` suppresses live-region output until it flips false, which never
 * happened because the element is unmounted instead, and the hidden
 * placeholders left the region with nothing to read out regardless.
 *
 * Fixed here, once. No `aria-busy`, and a visually-hidden sentence so the region
 * has real text to announce. The `aria-label` stays because `role="status"` does
 * not take its name from content, and it carries the same string so the two
 * cannot drift.
 */
export function FeatureFlagPending({
  label,
  className,
  children,
}: FeatureFlagPendingProps) {
  return (
    <div
      aria-label={label}
      className={cn("flex flex-col gap-3", className)}
      role="status"
    >
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
