/**
 * ISS-11411: two reads of one flag in one component agree on every render,
 * against the REAL posthog-js hook.
 *
 * The web feature-flag port (`posthogFeatureFlagAdapter` in `apps/app`) answers
 * `useFeatureFlagEnabled` and `useFeatureFlagResolved` with two separate calls
 * to this package's `useFeatureFlag`. A surface that tells "unresolved" from
 * "off" (the Settings Tags bounce, `FeatureFlagRouteGate`'s one-way
 * `notFound()`) used to read the result once; it now reads it through both.
 * posthog-js keeps a `useState` copy per hook call and refreshes each from its
 * own `onFeatureFlags` subscription, so the two copies could only disagree if
 * one updated in a render the other did not. This suite renders both shapes in
 * one component and compares every render while the flag lands and reloads.
 *
 * Only the server half of `@posthog/next` is stood in for; `useFeatureFlag` is
 * the shipped `useFeatureFlagResult` from the `posthog-js/react` copy the app
 * runs (resolved through `@posthog/next` by this package's vitest config).
 */
import { act, cleanup, render } from "@testing-library/react";
import { PostHogProvider, usePostHog } from "posthog-js/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFeatureFlag } from "./client";

// Hoisted: the `./keys` mock below reads it while the module graph loads.
const { TOKEN } = vi.hoisted(() => ({ TOKEN: "phc_iss11411_read_agreement" }));
const FLAG = "iss-11411-read-agreement-probe";

vi.mock("./keys", () => ({
  isValidGaMeasurementId: () => false,
  keys: () => ({
    NEXT_PUBLIC_GA_MEASUREMENT_ID: undefined,
    NEXT_PUBLIC_POSTHOG_KEY: TOKEN,
    NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED: undefined,
  }),
}));

vi.mock("@posthog/next", async () => {
  const { usePostHog, useFeatureFlagResult } = await import("posthog-js/react");
  return { usePostHog, useFeatureFlag: useFeatureFlagResult };
});

type Frame = { enabled: boolean; resolved: boolean };

type Client = ReturnType<typeof usePostHog>;

/** In-process transport only: memory persistence, no network, no autocapture. */
const POSTHOG_OPTIONS = {
  persistence: "memory",
  request_batching: false,
  disable_compression: true,
  disable_surveys: true,
  disable_external_dependency_loading: true,
  advanced_disable_flags: true,
  advanced_disable_decide: true,
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  capture_performance: false,
} as const;

/**
 * The provider initializes the posthog-js copy its own React bindings belong
 * to, so the client read through `usePostHog` is the one the hook subscribes to.
 */
function Provider({ children }: { children: ReactNode }) {
  return (
    <PostHogProvider apiKey={TOKEN} options={POSTHOG_OPTIONS}>
      {children}
    </PostHogProvider>
  );
}

/** Delivered from a timer task, the way a `/flags` response lands. */
async function deliverFlags(client: Client, flags: Record<string, boolean>) {
  await act(async () => {
    setTimeout(() => {
      client.featureFlags.receivedFeatureFlags({ featureFlags: flags });
    }, 0);
    await vi.advanceTimersByTimeAsync(1);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })))
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("two reads of one flag through the shipped posthog-js hook", () => {
  it("agree on every render while the flag lands, reloads and flips", async () => {
    const single: Frame[] = [];
    const pair: Frame[] = [];
    const clientRef: { current: Client | null } = { current: null };

    function Probe() {
      clientRef.current = usePostHog();
      // The shape a migrated site had: one read, both answers from it.
      const once = useFeatureFlag(FLAG);
      // The shape the web port adapter has: one read per answer.
      const forEnabled = useFeatureFlag(FLAG);
      const forResolved = useFeatureFlag(FLAG);
      single.push({
        enabled: once?.enabled === true,
        resolved: once !== undefined,
      });
      pair.push({
        enabled: forEnabled?.enabled === true,
        resolved: forResolved !== undefined,
      });
      return null;
    }

    render(
      <Provider>
        <Probe />
      </Provider>
    );
    expect(pair[0]).toEqual({ enabled: false, resolved: false });
    const client = clientRef.current;
    if (!client) {
      throw new Error("the probe never rendered under the provider");
    }

    await deliverFlags(client, { [FLAG]: true });
    const afterLanding = pair.length;
    await deliverFlags(client, { [FLAG]: false });
    await deliverFlags(client, { [FLAG]: true });

    expect(pair).toEqual(single);
    // The flag really did land and change, so the comparison covered the
    // landing render and both flips, not only the first render.
    expect(pair.slice(0, afterLanding)).toContainEqual({
      enabled: true,
      resolved: true,
    });
    expect(pair).toContainEqual({ enabled: false, resolved: true });
    expect(pair.at(-1)).toEqual({ enabled: true, resolved: true });
  });
});
