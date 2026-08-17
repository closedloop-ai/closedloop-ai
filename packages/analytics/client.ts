"use client";

import {
  useFeatureFlag as useFeatureFlagOriginal,
  usePostHog as usePostHogOriginal,
} from "@posthog/next";
import type { FeatureFlagResult } from "posthog-js";
import type { PostHog } from "posthog-js/react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { keys } from "./keys";

export type AnalyticsClient = Pick<
  PostHog,
  | "identify"
  | "capture"
  | "reset"
  // Session-replay + runtime-config controls, used by the staff-gated
  // frontend-capture controller (FEA-2400) to start/stop recording on demand.
  | "startSessionRecording"
  | "stopSessionRecording"
  | "set_config"
>;
type RawFeatureFlagResult = FeatureFlagResult | boolean | string | undefined;

export function useAnalytics(): AnalyticsClient {
  return usePostHogSafe();
}

export function useFeatureFlag(flag: string): FeatureFlagResult | undefined {
  const result = normalizeFeatureFlagResult(flag, useFeatureFlagSafe(flag));
  // Fail open for automated QA. When PostHog IS configured (prod) but a flag
  // never resolves — posthog-js did not initialize, e.g. an automated VQA
  // browser — every `<FeatureFlagged>` surface would otherwise render its blank
  // fallback, so a QA pass can't see gated features at all. If (and only if) the
  // tester set an explicit localStorage opt-in, fall back to the same fixture
  // path PostHog-disabled builds use. A real user never sets that key, so
  // production gating is unchanged. Feature flags gate UI visibility only; the
  // APIs behind them stay org-scoped + authenticated, so revealing a gated
  // surface never bypasses authorization. Only fills the UNRESOLVED case — a real
  // `false` from PostHog is respected, never overridden.
  if (result === undefined) {
    return resolveTestingFeatureFlag(flag);
  }
  return result;
}

const { NEXT_PUBLIC_POSTHOG_KEY } = keys();
const posthogEnabled = !!NEXT_PUBLIC_POSTHOG_KEY;
const usePostHogSafe = posthogEnabled ? usePostHogOriginal : () => noopClient;
const useFeatureFlagSafe = posthogEnabled
  ? (flag: string) => useFeatureFlagOriginal(flag) as RawFeatureFlagResult
  : readFallbackFeatureFlag;

/**
 * Preserve the app-facing object contract even when the underlying PostHog hook
 * returns its bare boolean/string feature-flag value.
 */
function normalizeFeatureFlagResult(
  flag: string,
  result: RawFeatureFlagResult
): FeatureFlagResult | undefined {
  if (typeof result === "boolean") {
    return {
      key: flag,
      enabled: result,
      variant: undefined,
      payload: undefined,
    };
  }
  if (typeof result === "string") {
    return {
      key: flag,
      enabled: true,
      variant: result,
      payload: undefined,
    };
  }
  return result;
}

const noopClient: AnalyticsClient = {
  identify: () => {},
  capture: () => undefined,
  reset: () => {},
  startSessionRecording: () => {},
  stopSessionRecording: () => {},
  set_config: () => {},
};

/**
 * Resolve a flag when there is no PostHog key at all — the containerized E2E
 * runner and PostHog-disabled local builds.
 *
 * Closed by default (ISS-5487). This path used to fail open ungated, so a build
 * with no fixture resolved EVERY flag enabled — inverting the closed-by-default UI policy
 * (ISS-4779) inside the one suite that gates merges, and letting a spec that
 * pins nothing silently assert the flag-ON surface of a flag that ships OFF
 * (ISS-5480). An unpinned flag now resolves `false`, matching what a real user
 * sees on the day the flag lands.
 *
 * The QA fail-open itself is unchanged and still reachable here: set the blanket
 * `closedloop:feature-flags-fail-open` key and every flag opens, whether or not
 * a fixture is also present. That opt-in is what `ca30a3504` argued for.
 */
function readFallbackFeatureFlag(flag: string): FeatureFlagResult {
  return (
    resolveTestingFeatureFlag(flag) ?? {
      key: flag,
      enabled: false,
      variant: undefined,
      payload: undefined,
    }
  );
}

/**
 * Resolve a flag from the testing inputs — the blanket QA opt-in and the E2E
 * fixture — or `undefined` when a tester set neither and there is nothing to
 * fall back to. Shared by both runtime bindings so the precedence below can't
 * drift between them.
 *
 * The blanket key WINS over the fixture. It is documented as "open everything",
 * and it used to lose to any fixture at all: the old opt-in test treated a
 * present fixture as consent on its own and then resolved each flag out of that
 * fixture, so a stale — even empty — fixture left every unlisted flag off and
 * silently defeated the switch. A tester who sets the blanket key gets every
 * flag open, including flags a leftover fixture pins `false`.
 */
function resolveTestingFeatureFlag(
  flag: string
): FeatureFlagResult | undefined {
  const blanketFailOpen = blanketFailOpenEnabled();
  const fixtureFlags = readFallbackFeatureFlagFixture();
  if (!(blanketFailOpen || fixtureFlags)) {
    return undefined;
  }
  return {
    key: flag,
    enabled: blanketFailOpen || fixtureFlags?.[flag] === true,
    variant: undefined,
    payload: undefined,
  };
}

function readFallbackFeatureFlagFixture(): Record<string, boolean> | undefined {
  if (globalThis.window === undefined) {
    return undefined;
  }

  try {
    const rawFlags = globalThis.localStorage.getItem(
      FALLBACK_FEATURE_FLAGS_STORAGE_KEY
    );
    if (!rawFlags) {
      return undefined;
    }

    const parsedFlags = fallbackFeatureFlagsSchema.safeParse(
      JSON.parse(rawFlags)
    );
    return parsedFlags.success ? parsedFlags.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The blanket "open everything" QA opt-in. Guarded on `window` + wrapped so a
 * storage-access throw never breaks the render.
 */
function blanketFailOpenEnabled(): boolean {
  if (globalThis.window === undefined) {
    return false;
  }
  try {
    return (
      globalThis.localStorage.getItem(FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY) ===
      "true"
    );
  } catch {
    return false;
  }
}

/**
 * Whether feature-flag values come from a live PostHog client at runtime.
 *
 * When false there is no PostHog key, so `useFeatureFlag` is bound to
 * `readFallbackFeatureFlag`: values resolve synchronously from the local
 * fixture, with no anonymous bootstrap, no `identify()`, and no distinct id.
 * Callers that withhold a decision until PostHog is answering for the SIGNED-IN
 * user need this to tell "the handshake has not landed yet" apart from "there is
 * no handshake". {@link usePostHogDistinctId} reports `undefined` for both,
 * which would otherwise read as permanently unsettled in exactly the E2E and
 * local builds where the flag was settled from the very first render.
 */
export const postHogFeatureFlagsEnabled = posthogEnabled;

/**
 * True once PostHog has delivered a feature-flag response (its `onFeatureFlags`
 * callback has fired at least once) — i.e. the current distinct id's flags are
 * loaded, not still bootstrapping. PostHog calls the callback on every load AND
 * reload, so after `identify()` re-requests flags for the signed-in user this
 * flips back to reflecting that fresh load. Used by route gates to avoid
 * committing an irreversible `notFound()` on an unresolved/anonymous-bootstrap
 * flag value. When PostHog is disabled (E2E / QA fail-open builds) flags resolve
 * synchronously from the local fixture, so this reports ready immediately.
 */
export function useFeatureFlagsLoaded(): boolean {
  const posthog = usePostHogOriginal();
  const [loaded, setLoaded] = useState(!posthogEnabled);

  useEffect(() => {
    if (!posthogEnabled) {
      return;
    }
    // onFeatureFlags fires immediately if flags are already loaded, and again on
    // every reload (e.g. the identify()-triggered re-request); either way this
    // resolves to loaded and stays loaded. Returns an unsubscribe.
    const unsubscribe = posthog.onFeatureFlags(() => setLoaded(true));
    return unsubscribe;
  }, [posthog]);

  return loaded;
}

/**
 * The distinct id PostHog last SUCCESSFULLY delivered a flag set for, or
 * `undefined` before any such delivery (pre-init / SSR / every load so far
 * failed). Route gates compare this against the signed-in user id to confirm
 * `identify()` has taken effect before trusting a flag-off result. When PostHog
 * is disabled, there is no distinct id to report.
 *
 * "Successfully" is load-bearing, and is why this reports the id at the last
 * delivery rather than `get_distinct_id()` at any moment (ISS-4566). A failed
 * `/flags` POST — ad blocker, corporate proxy, 5xx, or
 * `feature_flag_request_timeout_ms` — still fires every `onFeatureFlags`
 * handler, with `errorsLoading: true` and no flag values, leaving the previous
 * (anonymous) values in place. `get_distinct_id()` has meanwhile flipped to the
 * user id, so a callback that just re-read it reported "PostHog is answering
 * for this user" about an answer PostHog never gave — and a caller that commits
 * an irreversible decision on that (a `notFound()`, a deep-link bounce) commits
 * it on the anonymous flag set.
 *
 * Not airtight, and cannot be with the public API: a handler subscribing AFTER
 * a failed load gets posthog-js's immediate replay, which carries no context
 * argument at all and so reads as a success. That leaves the failure detectable
 * only while a surface is mounted across it — which is the reported case, and
 * the only one where a flag value visibly changes under the user.
 */
export function usePostHogDistinctId(): string | undefined {
  const posthog = usePostHogOriginal();
  const [distinctId, setDistinctId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!posthogEnabled) {
      return;
    }
    // A distinct-id change (identify/reset) also reloads flags, so piggyback on
    // that callback to re-read the current id. It replays immediately when flags
    // are already loaded, so there is no eager read to do here. Returns an
    // unsubscribe.
    const unsubscribe = posthog.onFeatureFlags((_flags, _variants, context) => {
      if (context?.errorsLoading === true) {
        return;
      }
      setDistinctId(posthog.get_distinct_id?.());
    });
    return unsubscribe;
  }, [posthog]);

  return distinctId;
}

const FALLBACK_FEATURE_FLAGS_STORAGE_KEY = "closedloop:e2e-feature-flags";
const FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY =
  "closedloop:feature-flags-fail-open";
const fallbackFeatureFlagsSchema = z.record(z.string(), z.boolean());
