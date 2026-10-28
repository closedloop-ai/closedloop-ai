/**
 * ISS-12558: `useFeatureFlagFreshValue` against a REAL posthog-js — the copy
 * `@posthog/next` initializes, by this package's `vitest.config.ts` alias.
 *
 * The case it exists for is a visitor whose persisted flags from an earlier
 * visit say ON while this page load's `/flags` answer says OFF. posthog-js
 * answers an ordinary read from the persisted value until `/flags` returns, so
 * a stub that only returned what the test told it would never show the gap.
 * Bootstrapped flags stand in for the persisted ones: posthog-js stores both
 * the same way and neither counts as loaded from the server.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import posthog, { type PostHog } from "posthog-js";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const FLAG = "web-frontend-capture";
const TOKEN = "phc_fresh_value_test";

// posthog-js binds `fetch` when its module loads, so the stub must be in place
// before the import above runs. A `/flags` request stays pending until the
// test answers it.
const network = vi.hoisted(() => {
  const state = {
    answerFlags: undefined as ((enabled: boolean) => void) | undefined,
    urls: [] as string[],
    original: globalThis.fetch,
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    state.urls.push(url);
    if (!url.includes("/flags")) {
      return new Response("{}", { status: 200 });
    }
    const enabled = await new Promise<boolean>((resolve) => {
      state.answerFlags = resolve;
    });
    return new Response(
      JSON.stringify({ featureFlags: { "web-frontend-capture": enabled } }),
      { status: 200 }
    );
  }) as typeof fetch;
  return state;
});

const client = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("@posthog/next", () => ({
  useFeatureFlag: () => undefined,
  usePostHog: () => client.current,
}));

beforeEach(() => {
  network.answerFlags = undefined;
  network.urls = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

afterAll(() => {
  globalThis.fetch = network.original;
});

describe("useFeatureFlagFreshValue (ISS-12558)", () => {
  it("ignores a persisted ON until /flags answers, then reports the fresh value", async () => {
    const instance = await initVisitorWithPersistedFlag(true);
    const { result, flagCalls } = await renderFreshRead(instance);

    // Positive control: an ordinary read already says ON from persistence.
    expect(instance.getFeatureFlag(FLAG, { send_event: false })).toBe(true);
    expect(result.current).toBeUndefined();

    answerFlags(true);

    await vi.waitFor(() => expect(result.current).toBe(true));
    expect(flagCalls).toEqual([true]);
  });

  it("never reports ON when the persisted value is ON and the fresh answer is OFF", async () => {
    const instance = await initVisitorWithPersistedFlag(true);
    const { result, history } = await renderFreshRead(instance);

    answerFlags(false);

    await vi.waitFor(() => expect(result.current).toBe(false));
    expect(history).not.toContain(true);
  });
});

async function initVisitorWithPersistedFlag(persisted: boolean) {
  const instance = posthog.init(
    TOKEN,
    {
      api_host: "https://posthog.flags.test",
      persistence: "memory",
      request_batching: false,
      disable_compression: true,
      disable_surveys: true,
      disable_external_dependency_loading: true,
      disable_session_recording: true,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_performance: false,
      bootstrap: {
        distinctID: `visitor-${crypto.randomUUID()}`,
        featureFlags: { [FLAG]: persisted },
      },
    },
    `fresh-${crypto.randomUUID()}`
  );
  if (!instance) {
    throw new Error("posthog-js did not initialize");
  }
  // Bootstrapped flags count as loaded, so posthog-js skips its first-load
  // request; ask for the fresh answer the way a page load does.
  instance.reloadFeatureFlags();
  await vi
    .waitUntil(() => network.answerFlags !== undefined, { timeout: 5000 })
    .catch(() => {
      throw new Error(`no /flags request; saw ${network.urls.join(", ")}`);
    });
  return instance;
}

async function renderFreshRead(instance: PostHog) {
  client.current = instance;
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", TOKEN);
  vi.resetModules();
  const { useFeatureFlagFreshValue } = await import("./client");

  const flagCalls: unknown[] = [];
  instance._addCaptureHook((event, payload) => {
    if (event === "$feature_flag_called") {
      flagCalls.push(payload?.properties.$feature_flag_response);
    }
  });

  const history: (boolean | undefined)[] = [];
  const rendered = renderHook(() => {
    const value = useFeatureFlagFreshValue(FLAG);
    history.push(value);
    return value;
  });
  return { ...rendered, history, flagCalls };
}

function answerFlags(enabled: boolean) {
  act(() => {
    network.answerFlags?.(enabled);
  });
}
