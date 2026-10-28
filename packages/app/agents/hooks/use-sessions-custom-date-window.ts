"use client";

import { useFeatureFlagGate } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useAuthoritativeSearchParams } from "@repo/app/shared/hooks/use-authoritative-search-params";
import {
  parseSessionCustomDateWindowParams,
  type SessionCustomDateWindow,
} from "../lib/session-custom-date-window";

/**
 * FEA-4201 — the gate and the codec, resolved once for a Sessions host.
 *
 * Both shells need the SAME two answers ("is this viewer offered the explicit
 * window?" and "what window does the URL name?") and would otherwise each spell
 * out the gate-then-parse conditional and the gate-then-hand-over-the-setter
 * conditional. Two copies of a precedence rule is how web and desktop come to
 * resolve one URL differently, so the rule lives here and each host reads the
 * result.
 *
 * `gateCustomDateWindowChange` returns `undefined` behind the gate, which is
 * exactly what `SessionsToolbar` reads to decide whether to mount the control at
 * all — so a gated-off host renders the toolbar it renders today AND treats the
 * params as inert, from ONE decision rather than two that could disagree. It is
 * a wrapper rather than a `setter` argument because each host builds its setter
 * from URL writers declared far below where the window itself has to be
 * resolved: the queries need the window on the first render.
 *
 * `isCustomDateWindowReady` is the FEA-1626 readiness half, and a host that keys
 * a read off this window must gate that read on it. An asynchronous provider
 * (PostHog) reports every flag as `false` until it answers, so without it a
 * flagged `?from=`/`?to=` link read the PRESET window first, rendered rows and
 * summary figures for a window nobody asked for, and only then refetched the
 * requested one — the exact double read `useFeatureFlagGate` exists to stop.
 *
 * The params are read through {@link useAuthoritativeSearchParams} for the same
 * hydration gap `initialFacetParamsSource` guards for the facet seed.
 */
export function useSessionsCustomDateWindow(
  flagKey: string,
  searchParams: Pick<URLSearchParams, "get" | "toString">,
  routePath: string
): {
  customDateWindow: SessionCustomDateWindow | null;
  gateCustomDateWindowChange: <TSetter>(setter: TSetter) => TSetter | undefined;
  isCustomDateWindowReady: boolean;
} {
  const { enabled, isReady } = useFeatureFlagGate(flagKey);
  const urlWindow = parseSessionCustomDateWindowParams(
    useAuthoritativeSearchParams(searchParams, routePath)
  );
  return {
    customDateWindow: enabled ? urlWindow : null,
    gateCustomDateWindowChange: (setter) => (enabled ? setter : undefined),
    // Waiting is scoped to the URLs the flag can still change the answer for. The
    // resolved value only moves this window when the params name a window at all,
    // so a listing with no `?from=`/`?to=` — every ordinary visit — must not pay a
    // flag round-trip before its first read. A malformed or out-of-bounds pair
    // parses to `null` and is ready for the same reason: it resolves to the preset
    // either way.
    isCustomDateWindowReady: isReady || urlWindow === null,
  };
}
