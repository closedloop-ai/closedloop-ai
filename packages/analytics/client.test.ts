import {
  usePostHog,
  useFeatureFlag as usePostHogFeatureFlag,
} from "@posthog/next";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { FeatureFlagsCallback } from "posthog-js";
import type { PostHog } from "posthog-js/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const FALLBACK_FEATURE_FLAGS_STORAGE_KEY = "closedloop:e2e-feature-flags";
const FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY =
  "closedloop:feature-flags-fail-open";

vi.mock("@posthog/next", () => ({
  useFeatureFlag: vi.fn(),
  usePostHog: vi.fn(),
}));

afterEach(() => {
  cleanup();
  localStorage.removeItem(FALLBACK_FEATURE_FLAGS_STORAGE_KEY);
  localStorage.removeItem(FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY);
  vi.mocked(usePostHogFeatureFlag).mockReset();
  vi.mocked(usePostHog).mockReset();
  vi.unstubAllGlobals();
});

/**
 * ISS-5487. With no PostHog key there is no flag service, so these states are
 * the whole contract of the containerized E2E runner and of any
 * PostHog-disabled local build. "No fixture, no opt-in" used to resolve every
 * flag ENABLED, which inverted the closed-by-default UI policy (ISS-4779)
 * inside the suite that gates merges: a spec pinning nothing asserted the
 * flag-ON surface of a flag that ships OFF (ISS-5480, twice).
 */
describe("useFeatureFlag fallback (PostHog disabled)", () => {
  it("resolves an unpinned flag DISABLED with no fixture and no opt-in", async () => {
    const { useFeatureFlag } = await importClientWithPostHogDisabled();

    expect(useFeatureFlag("comments-v2-feed-sidebar")).toMatchObject({
      enabled: false,
      key: "comments-v2-feed-sidebar",
    });
  });

  it("still fails open to enabled when the blanket opt-in key is set", async () => {
    localStorage.setItem(FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY, "true");

    const { useFeatureFlag } = await importClientWithPostHogDisabled();

    expect(useFeatureFlag("comments-v2-feed-sidebar")).toMatchObject({
      enabled: true,
      key: "comments-v2-feed-sidebar",
    });
  });

  it("gives the blanket opt-in precedence over a coexisting fixture", async () => {
    localStorage.setItem(
      FALLBACK_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ "branch-pr": false })
    );
    localStorage.setItem(FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY, "true");

    const { useFeatureFlag } = await importClientWithPostHogDisabled();

    // Pinned `false` by the stale fixture, and unlisted in it — the blanket key
    // opens both, or it isn't the documented "open everything" switch.
    expect(useFeatureFlag("branch-pr")).toMatchObject({
      enabled: true,
      key: "branch-pr",
    });
    expect(useFeatureFlag("comments-v2-feed-sidebar")).toMatchObject({
      enabled: true,
      key: "comments-v2-feed-sidebar",
    });
  });

  it("uses exact E2E fixture flags when PostHog is disabled", async () => {
    localStorage.setItem(
      FALLBACK_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ "branch-pr": true, "interactive-chat": false })
    );

    const { useFeatureFlag } = await importClientWithPostHogDisabled();

    expect(useFeatureFlag("branch-pr")).toMatchObject({
      enabled: true,
      key: "branch-pr",
    });
    expect(useFeatureFlag("interactive-chat")).toMatchObject({
      enabled: false,
      key: "interactive-chat",
    });
    expect(useFeatureFlag("comments-v2-feed-sidebar")).toMatchObject({
      enabled: false,
      key: "comments-v2-feed-sidebar",
    });
  });

  it("resolves disabled when the E2E fixture is malformed", async () => {
    localStorage.setItem(FALLBACK_FEATURE_FLAGS_STORAGE_KEY, "{");

    const { useFeatureFlag } = await importClientWithPostHogDisabled();

    expect(useFeatureFlag("branch-pr")).toMatchObject({
      enabled: false,
      key: "branch-pr",
    });
  });

  it("ignores mutable E2E fixtures when PostHog is enabled", async () => {
    localStorage.setItem(
      FALLBACK_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ "branch-detail-page": true })
    );
    vi.mocked(usePostHogFeatureFlag).mockReturnValue({
      enabled: false,
      key: "branch-detail-page",
      payload: undefined,
      variant: undefined,
    });

    const { useFeatureFlag } = await importClientWithPostHogEnabled();

    expect(useFeatureFlag("branch-detail-page")).toMatchObject({
      enabled: false,
      key: "branch-detail-page",
    });
  });
});

describe("useFeatureFlag QA fail-open (PostHog enabled but unresolved)", () => {
  it("stays unresolved (undefined) with no opt-in — production behavior unchanged", async () => {
    vi.mocked(usePostHogFeatureFlag).mockReturnValue(undefined);

    const { useFeatureFlag } = await importClientWithPostHogEnabled();

    expect(useFeatureFlag("branch-pr")).toBeUndefined();
  });

  it("fails open to enabled when the blanket opt-in key is set", async () => {
    localStorage.setItem(FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY, "true");
    vi.mocked(usePostHogFeatureFlag).mockReturnValue(undefined);

    const { useFeatureFlag } = await importClientWithPostHogEnabled();

    expect(useFeatureFlag("branch-pr")).toMatchObject({
      enabled: true,
      key: "branch-pr",
    });
  });

  it("uses the E2E fixture for unresolved flags even under prod PostHog", async () => {
    localStorage.setItem(
      FALLBACK_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ "branch-pr": true, "interactive-chat": false })
    );
    vi.mocked(usePostHogFeatureFlag).mockReturnValue(undefined);

    const { useFeatureFlag } = await importClientWithPostHogEnabled();

    expect(useFeatureFlag("branch-pr")).toMatchObject({ enabled: true });
    expect(useFeatureFlag("interactive-chat")).toMatchObject({
      enabled: false,
    });
  });

  it("gives the blanket opt-in precedence over a coexisting fixture", async () => {
    localStorage.setItem(
      FALLBACK_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ "branch-pr": false })
    );
    localStorage.setItem(FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY, "true");
    vi.mocked(usePostHogFeatureFlag).mockReturnValue(undefined);

    const { useFeatureFlag } = await importClientWithPostHogEnabled();

    expect(useFeatureFlag("branch-pr")).toMatchObject({
      enabled: true,
      key: "branch-pr",
    });
    expect(useFeatureFlag("comments-v2-feed-sidebar")).toMatchObject({
      enabled: true,
      key: "comments-v2-feed-sidebar",
    });
  });

  it("never overrides a real resolved value even with the opt-in set", async () => {
    localStorage.setItem(FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY, "true");
    vi.mocked(usePostHogFeatureFlag).mockReturnValue({
      enabled: false,
      key: "branch-detail-page",
      payload: undefined,
      variant: undefined,
    });

    const { useFeatureFlag } = await importClientWithPostHogEnabled();

    expect(useFeatureFlag("branch-detail-page")).toMatchObject({
      enabled: false,
      key: "branch-detail-page",
    });
  });
});

describe("analytics client normalization and runtime selection", () => {
  it("normalizes PostHog boolean and variant results", async () => {
    vi.mocked(usePostHogFeatureFlag)
      .mockReturnValueOnce(true as never)
      .mockReturnValueOnce("treatment" as never);
    const { useFeatureFlag } = await importClientWithPostHogEnabled();

    expect(useFeatureFlag("boolean-flag")).toEqual({
      key: "boolean-flag",
      enabled: true,
      variant: undefined,
      payload: undefined,
    });
    expect(useFeatureFlag("variant-flag")).toEqual({
      key: "variant-flag",
      enabled: true,
      variant: "treatment",
      payload: undefined,
    });
  });

  it("returns a no-op client without PostHog and the hook client with PostHog", async () => {
    const disabledModule = await importClientWithPostHogDisabled();
    const disabledClient = disabledModule.useAnalytics();

    expect(disabledClient.capture("disabled-event")).toBeUndefined();
    expect(disabledClient.reset()).toBeUndefined();
    expect(disabledClient.identify("disabled-user")).toBeUndefined();

    const posthogClient = { capture: vi.fn() };
    vi.mocked(usePostHog).mockReturnValue(posthogClient as never);
    const enabledModule = await importClientWithPostHogEnabled();

    expect(enabledModule.useAnalytics()).toBe(posthogClient);
  });

  it("keeps unresolved flags closed when browser storage is unavailable", async () => {
    vi.stubGlobal("window", undefined);
    vi.mocked(usePostHogFeatureFlag).mockReturnValue(undefined);
    const { useFeatureFlag } = await importClientWithPostHogEnabled();

    expect(useFeatureFlag("branch-pr")).toBeUndefined();
  });
});

describe("PostHog readiness hooks", () => {
  it("reports loaded immediately and skips subscriptions when PostHog is disabled", async () => {
    const onFeatureFlags = vi.fn();
    vi.mocked(usePostHog).mockReturnValue({ onFeatureFlags } as never);
    const { useFeatureFlagsLoaded, usePostHogDistinctId } =
      await importClientWithPostHogDisabled();

    const loaded = renderHook(() => useFeatureFlagsLoaded());
    const distinctId = renderHook(() => usePostHogDistinctId());

    expect(loaded.result.current).toBe(true);
    expect(distinctId.result.current).toBeUndefined();
    expect(onFeatureFlags).not.toHaveBeenCalled();
  });

  it("tracks feature-flag readiness and unsubscribes on unmount", async () => {
    let featureFlagsLoaded: (() => void) | undefined;
    const unsubscribe = vi.fn();
    vi.mocked(usePostHog).mockReturnValue({
      onFeatureFlags: vi.fn((callback: () => void) => {
        featureFlagsLoaded = callback;
        return unsubscribe;
      }),
    } as never);
    const { useFeatureFlagsLoaded } = await importClientWithPostHogEnabled();

    const hook = renderHook(() => useFeatureFlagsLoaded());
    expect(hook.result.current).toBe(false);

    act(() => featureFlagsLoaded?.());
    expect(hook.result.current).toBe(true);
    hook.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

/**
 * ISS-4566. A failed `/flags` POST is not a flag answer, but posthog-js reports
 * it through the same channel as a successful one: the request callback sets
 * `errorsLoading` and still calls `receivedFeatureFlags(json ?? {}, true)`,
 * which fires every `onFeatureFlags` handler. The response carries no flag
 * values, so the previous (anonymous) ones stay in place — while
 * `get_distinct_id()` has already flipped to the identified user. A hook that
 * re-read the id on any fire therefore reported "PostHog is answering for this
 * user" about an answer PostHog never gave, and every caller that withholds an
 * irreversible decision until then committed it on the anonymous flag set.
 */
describe("usePostHogDistinctId across a failed post-identify flag load", () => {
  afterEach(() => {
    vi.mocked(usePostHog).mockReset();
  });

  it("keeps reporting the anonymous id when the post-identify /flags load errors", async () => {
    const { usePostHogDistinctId } = await importClientWithPostHogEnabled();
    const posthog = stubPostHogFlagsClient(ANONYMOUS_DISTINCT_ID);

    const { result } = renderHook(() => usePostHogDistinctId());

    // The anonymous bootstrap lands: flags delivered, keyed on the cookie id.
    act(() => {
      posthog.fireFeatureFlags();
    });
    expect(result.current).toBe(ANONYMOUS_DISTINCT_ID);

    // identify() flips get_distinct_id() at once; the /flags POST it triggers
    // then fails (ad blocker, proxy, 5xx, request timeout).
    posthog.setDistinctId(IDENTIFIED_DISTINCT_ID);
    act(() => {
      posthog.fireFeatureFlags({ errorsLoading: true });
    });
    expect(result.current).toBe(ANONYMOUS_DISTINCT_ID);

    // Only a load that actually delivered flags settles it.
    act(() => {
      posthog.fireFeatureFlags();
    });
    expect(result.current).toBe(IDENTIFIED_DISTINCT_ID);
  });
});

const ANONYMOUS_DISTINCT_ID = "anon_cookie_id";
const IDENTIFIED_DISTINCT_ID = "user_identified_1";

/**
 * A PostHog client stubbed down to the two members the distinct-id hook uses,
 * with the flag-callback fire driven by the test rather than by a request.
 */
function stubPostHogFlagsClient(initialDistinctId: string) {
  let distinctId = initialDistinctId;
  let handler: FeatureFlagsCallback | undefined;

  const client: Pick<PostHog, "get_distinct_id" | "onFeatureFlags"> = {
    get_distinct_id: () => distinctId,
    onFeatureFlags: (callback: FeatureFlagsCallback) => {
      handler = callback;
      return () => {
        handler = undefined;
      };
    },
  };
  vi.mocked(usePostHog).mockReturnValue(client as PostHog);

  return {
    setDistinctId: (next: string) => {
      distinctId = next;
    },
    fireFeatureFlags: (context?: { errorsLoading?: boolean }) => {
      if (!handler) {
        throw new Error("No onFeatureFlags handler was subscribed");
      }
      handler([], {}, context);
    },
  };
}

async function importClientWithPostHogDisabled() {
  const originalPostHogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  Reflect.deleteProperty(process.env, "NEXT_PUBLIC_POSTHOG_KEY");
  vi.resetModules();

  try {
    return await import("./client");
  } finally {
    if (originalPostHogKey === undefined) {
      Reflect.deleteProperty(process.env, "NEXT_PUBLIC_POSTHOG_KEY");
    } else {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = originalPostHogKey;
    }
  }
}

async function importClientWithPostHogEnabled() {
  const originalPostHogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
  vi.resetModules();

  try {
    return await import("./client");
  } finally {
    if (originalPostHogKey === undefined) {
      Reflect.deleteProperty(process.env, "NEXT_PUBLIC_POSTHOG_KEY");
    } else {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = originalPostHogKey;
    }
  }
}
