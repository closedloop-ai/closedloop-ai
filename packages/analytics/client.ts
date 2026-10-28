"use client";

import {
  useFeatureFlag as useFeatureFlagOriginal,
  usePostHog as usePostHogOriginal,
} from "@posthog/next";
import type { FeatureFlagResult } from "posthog-js";
import type { PostHog } from "posthog-js/react";
import { useEffect, useState } from "react";
import { suppressesFeatureFlag, useCustomerViewState } from "./customer-view";
import {
  featureFlagValueRecordSchema,
  useFeatureFlagOverride,
} from "./feature-flag-overrides";
import { isPostHogFlagValueEnabled } from "./feature-flag-value";
import { keys } from "./keys";
import { usePinnedFeatureFlag } from "./pinned-feature-flags";

export type AnalyticsClient = Pick<
  PostHog,
  | "identify"
  | "capture"
  | "reset"
  // Session-replay + runtime-config controls, used through
  // `./session-replay` by the web-app frontend-capture controller (FEA-2400,
  // ISS-10650) and the marketing replay controller (ISS-12558).
  | "startSessionRecording"
  | "stopSessionRecording"
  | "set_config"
  // Person-property writes for the FTUE analytics port (PRD-736:
  // `first_org_user` set on the person at org-step resolution).
  | "setPersonProperties"
>;
type RawFeatureFlagResult = FeatureFlagResult | boolean | string | undefined;

export function useAnalytics(): AnalyticsClient {
  return usePostHogSafe();
}

export function useFeatureFlag(flag: string): FeatureFlagResult | undefined {
  const customerView = useCustomerViewState();
  const override = useFeatureFlagOverride(flag);
  const pinned = usePinnedFeatureFlag(flag);
  const result = normalizeFeatureFlagResult(flag, useFeatureFlagSafe(flag));
  // ISS-7477: dev-mode-off. Suppression is decided AFTER every hook above has
  // run (rules of hooks) and BEFORE the QA fail-open below, because customer
  // view is an explicit, revocable choice by an internal user and a leftover
  // localStorage opt-in must not quietly re-open the flags they just closed.
  // The result is a settled `false`, never `undefined` — see `CustomerViewState`.
  if (suppressesFeatureFlag(customerView, flag)) {
    return settledFeatureFlagResult(flag, false);
  }
  // ISS-12048: a Dev Tools override wins over PostHog, the E2E fixture and the
  // QA fail-open, and is `undefined` unless Dev Mode is on (operator decision,
  // 2026-10-05). Dev Mode on means the customer view above is inactive, so the
  // two never compete for one flag.
  if (override !== undefined) {
    return settledFeatureFlagResult(flag, override);
  }
  // ISS-12048: a `$vibe` preview's production snapshot, below a Dev Mode
  // override and above PostHog, matching the precedence `apps/api` applies.
  if (pinned !== undefined) {
    return settledFeatureFlagResult(flag, pinned);
  }
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

/**
 * ISS-12048: the flag's real value for the Dev Tools overlay: a `$vibe`
 * preview's pinned snapshot value, else PostHog's own answer, with no Dev Mode
 * override and no customer view applied. `undefined` while PostHog has not
 * answered, and `false` for a flag PostHog does not return once it has (unset
 * in production). It does not report the read, so the overlay listing every flag
 * does not mark every flag as checked by the page.
 */
export function useFeatureFlagProductionValue(
  flag: string
): boolean | undefined {
  const pinned = usePinnedFeatureFlag(flag);
  const live = normalizeFeatureFlagResult(flag, useSilentFeatureFlagSafe(flag));
  return pinned ?? live?.enabled;
}

const { NEXT_PUBLIC_POSTHOG_KEY } = keys();
const posthogEnabled = !!NEXT_PUBLIC_POSTHOG_KEY;
const usePostHogSafe = posthogEnabled ? usePostHogOriginal : () => noopClient;
const useFeatureFlagSafe = posthogEnabled
  ? (flag: string) => useFeatureFlagOriginal(flag) as RawFeatureFlagResult
  : readFallbackFeatureFlag;
const useSilentFeatureFlagSafe = posthogEnabled
  ? useSilentPostHogFeatureFlag
  : readFallbackFeatureFlag;

/** Read the overlay's reference value without recording experiment exposure. */
function useSilentPostHogFeatureFlag(flag: string): RawFeatureFlagResult {
  const client = usePostHogOriginal();
  const [result, setResult] = useState(() =>
    readSilentPostHogFeatureFlag(client, flag)
  );
  useEffect(() => {
    setResult(readSilentPostHogFeatureFlag(client, flag));
    return client?.onFeatureFlags(() => {
      setResult(readSilentPostHogFeatureFlag(client, flag));
    });
  }, [client, flag]);
  return result;
}

/**
 * PostHog answers `undefined` both before its flags load and for a flag it
 * does not return; only the second is a settled `false` (ISS-12048).
 */
function readSilentPostHogFeatureFlag(
  client: PostHog | undefined,
  flag: string
): RawFeatureFlagResult {
  const result = client?.getFeatureFlagResult(flag, { send_event: false });
  if (result === undefined && client?.featureFlags?.hasLoadedFlags) {
    return false;
  }
  return result;
}

/**
 * Preserve the app-facing object contract even when the underlying PostHog hook
 * returns its bare boolean/string feature-flag value.
 */
function normalizeFeatureFlagResult(
  flag: string,
  result: RawFeatureFlagResult
): FeatureFlagResult | undefined {
  if (typeof result === "boolean") {
    return settledFeatureFlagResult(flag, result);
  }
  if (typeof result === "string") {
    return {
      key: flag,
      // ISS-8024: the enabled/disabled rule is shared with the server-side
      // whole-assignment read rather than re-stated here. The two had already
      // drifted on the empty-string variant, which is the cross-surface
      // disagreement that work exists to remove. Behavior is unchanged: a
      // variant string is enabled, as it has always been on this path.
      enabled: isPostHogFlagValueEnabled(result),
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
  setPersonProperties: () => {},
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
    resolveTestingFeatureFlag(flag) ?? settledFeatureFlagResult(flag, false)
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
  return settledFeatureFlagResult(
    flag,
    blanketFailOpen || fixtureFlags?.[flag] === true
  );
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

    const parsedFlags = featureFlagValueRecordSchema.safeParse(
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

/**
 * A flag result that is DECIDED — the caller can act on it — as opposed to the
 * `undefined` PostHog returns while a value is still in flight.
 */
function settledFeatureFlagResult(
  flag: string,
  enabled: boolean
): FeatureFlagResult {
  return { key: flag, enabled, variant: undefined, payload: undefined };
}

const FALLBACK_FEATURE_FLAGS_STORAGE_KEY = "closedloop:e2e-feature-flags";
const FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY =
  "closedloop:feature-flags-fail-open";

/**
 * ISS-12558: the flag's value from a `/flags` response this page load
 * received, or `undefined` until one arrives. posthog-js otherwise answers from
 * the flags it persisted on an earlier visit before `/flags` returns, and a
 * failed `/flags` request leaves those in place too; `fresh: true` refuses both
 * (posthog-js 1.359.1 `getFeatureFlagResult`). There is no Dev Mode override,
 * pinned snapshot, E2E fixture or QA fail-open here, and it is `undefined`
 * when PostHog is unconfigured, so a caller acting on it acts only on what
 * PostHog just said. The read reports `$feature_flag_called` the way
 * `useFeatureFlag` does, once per distinct value.
 */
export function useFeatureFlagFreshValue(flag: string): boolean | undefined {
  const client = usePostHogOriginal();
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (!(posthogEnabled && client)) {
      return;
    }
    const read = () => {
      setEnabled(client.getFeatureFlagResult(flag, { fresh: true })?.enabled);
    };
    read();
    return client.onFeatureFlags(read);
  }, [client, flag]);

  return enabled;
}
