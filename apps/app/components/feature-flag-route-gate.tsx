"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import {
  FEATURE_FLAG_SETTLE_TIMEOUT_MS,
  FeatureFlagPending,
  useFeatureFlagSettleDeadline,
} from "@repo/app/shared/components/feature-flag-pending";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { notFound } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { FeatureFlagUnavailable } from "./feature-flag-unavailable";
import { useFeatureFlagsSettledForUser } from "./feature-flags-settled";

type FeatureFlagRouteGateProps = {
  readonly flag: string;
  readonly children: ReactNode;
  /**
   * Rendered during the pre-mount + flag-resolving window instead of nothing.
   * Pass the route's chrome (Header + a skeleton body) so a gated route opens
   * with its shell already in place rather than a blank content region that
   * pops the whole page in at once.
   *
   * Defaults to a generic route skeleton rather than `null` (ISS-5001): every
   * gate here is reachable by URL, so a caller that passes nothing must still
   * open with a *visible* loading state. The previous `null` default is what
   * made `/issues`, `/routines` and `/loops/usage` render an empty content
   * region — a blank page is never the right answer for a route a user just
   * navigated to.
   */
  readonly pending?: ReactNode;
};

/**
 * Renders children only when the given PostHog flag is enabled; otherwise
 * triggers a 404 so direct URL access to a flagged-off route is not reachable.
 *
 * The mount guard avoids a hydration mismatch while the flag resolves
 * client-side; during that unresolved window it renders `pending` (the route
 * chrome) rather than `null`, so the page does not open blank.
 *
 * The irreversible `notFound()` is only committed once the flag has resolved
 * OFF *for the signed-in user*. PostHog bootstraps flags against the anonymous
 * cookie distinct id first, then `<UserIdentifier />` calls `identify()` in an
 * effect and PostHog re-requests flags for the real user. A flag that is off
 * for the anonymous id but on for the identified user must NOT 404: we withhold
 * the terminal decision (keep rendering `pending`) until the user is loaded,
 * PostHog is keyed on that user's distinct id, and its post-identify flag load
 * has landed. An `enabled: true` at any point renders the body immediately —
 * only the one-way 404 waits for the settled, identified result.
 *
 * ISS-5001: that wait is BOUNDED. `useFeatureFlag` returns `undefined` both for
 * "not loaded yet" and for "this key does not exist / PostHog never
 * initialized", and the two are indistinguishable — so an unresolved flag used
 * to fall through to `pending` forever, which with the old `null` default meant
 * a permanently empty page. After {@link FEATURE_FLAG_SETTLE_TIMEOUT_MS} the gate now
 * always commits a terminal state, and it distinguishes the two facts it can
 * end on:
 *
 *   - the flag RESOLVED off (but `identify()` never landed) → `notFound()`,
 *     the same recovery state a deliberately gated route already produces;
 *   - the flag NEVER RESOLVED → {@link FeatureFlagUnavailable}, which states
 *     the infrastructure failure instead of claiming the page does not exist.
 *
 * Both fail CLOSED — the gated children are never rendered on an unresolved
 * flag — which is what the closed-by-default UI policy requires. Neither is
 * blank, which is what this bug was.
 */
export function FeatureFlagRouteGate({
  flag,
  children,
  pending = <FeatureFlagRoutePending />,
}: FeatureFlagRouteGateProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  // Shared with the Settings Tags panel: two copies of one bound meant the next
  // change to it would be made once and missed once.
  const settleDeadlineElapsed = useFeatureFlagSettleDeadline();

  const result = useFeatureFlag(flag);
  const flagsSettledForUser = useFeatureFlagsSettledForUser();

  // The body is authoritative the moment the flag reads enabled — render it
  // right away regardless of the identify handshake.
  if (mounted && result?.enabled === true) {
    return <>{children}</>;
  }

  // Withhold the one-way notFound() until the flag has resolved OFF for the
  // identified user: mounted, the flag object present, and the identify
  // handshake settled.
  const identifiedFlagsSettled =
    mounted && result !== undefined && flagsSettledForUser;

  if (identifiedFlagsSettled && result.enabled !== true) {
    notFound();
  }

  // ISS-5001: the bounded fallthrough. Past the deadline the gate stops waiting
  // and commits a terminal, non-blank state.
  //
  // It must NOT be `notFound()`. The settled-and-off case already 404s above, so
  // anything reaching here is by definition a flag whose identified result never
  // landed — precisely the window FEA-4228 withholds the one-way 404 for,
  // because PostHog is still serving the ANONYMOUS flag set and the flag may be
  // ON for this user. 404-ing at the deadline would tell a user with real access
  // that their page does not exist, and a reload would re-run the same race.
  // The failed-read state is the honest answer for both shapes, and it still
  // fails closed: the gated children are never rendered.
  if (mounted && settleDeadlineElapsed) {
    return <FeatureFlagUnavailable />;
  }

  return <>{pending}</>;
}

/**
 * The gate's default `pending` (ISS-5001): a generic route-shaped skeleton for
 * a gated route whose loaded page renders no `Header` of its own (`/insights`
 * is the one such route today). A route reached by URL must show that it is
 * working, so the default is a visible loading state rather than the blank
 * `null` this defaulted to before.
 *
 * Every gated route whose loaded page DOES render a `Header` passes a
 * `RouteChromeFallback` instead, so the breadcrumb shell is already in place
 * rather than popping in when the flag lands. The geometry here deliberately
 * matches that component's (`p-4`, full-width bars) so the same loading moment
 * does not read as two different products depending on which route you opened.
 *
 * Only the geometry lives here. The live region itself — and its announcement —
 * is {@link FeatureFlagPending}, shared with the Settings Tags panel.
 */
function FeatureFlagRoutePending() {
  return (
    <FeatureFlagPending className="min-h-0 flex-1 p-4" label="Loading page">
      <Skeleton className="h-9 w-full" />
      <Skeleton className="min-h-64 w-full flex-1" />
    </FeatureFlagPending>
  );
}
