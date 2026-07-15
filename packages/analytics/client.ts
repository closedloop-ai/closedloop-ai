"use client";

import {
  useFeatureFlag as useFeatureFlagOriginal,
  usePostHog as usePostHogOriginal,
} from "@posthog/next";
import type { FeatureFlagResult } from "posthog-js";
import type { PostHog } from "posthog-js/react";
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
    // Read + parse the E2E fixture once; both the fail-open decision and the
    // fallback value lookup reuse this single parse.
    const fixtureFlags = readFallbackFeatureFlagFixture();
    if (testingFailOpenEnabled(fixtureFlags)) {
      return buildFallbackFeatureFlag(flag, fixtureFlags);
    }
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

function readFallbackFeatureFlag(flag: string): FeatureFlagResult {
  return buildFallbackFeatureFlag(flag, readFallbackFeatureFlagFixture());
}

/**
 * Resolve a flag against an already-parsed E2E fixture (or `undefined` when no
 * fixture is present, which fails open to enabled). Pure so callers that already
 * read the fixture don't re-read/re-parse it.
 */
function buildFallbackFeatureFlag(
  flag: string,
  fixtureFlags: Record<string, boolean> | undefined
): FeatureFlagResult {
  return {
    key: flag,
    enabled: fixtureFlags ? fixtureFlags[flag] === true : true,
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
 * Opt-in for the QA fail-open above. Fail open when the tester set the blanket
 * key to "true", OR when a per-flag E2E fixture is present (so precise fixtures
 * work under prod PostHog too, not just PostHog-disabled builds). Takes the
 * already-parsed fixture so it isn't re-read/re-parsed. Guarded on `window` +
 * wrapped so a storage-access throw never breaks the render.
 */
function testingFailOpenEnabled(
  fixtureFlags: Record<string, boolean> | undefined
): boolean {
  if (fixtureFlags !== undefined) {
    return true;
  }
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

const FALLBACK_FEATURE_FLAGS_STORAGE_KEY = "closedloop:e2e-feature-flags";
const FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY =
  "closedloop:feature-flags-fail-open";
const fallbackFeatureFlagsSchema = z.record(z.string(), z.boolean());
