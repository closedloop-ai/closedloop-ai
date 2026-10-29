import {
  usePostHog as usePostHogClient,
  useFeatureFlag as usePostHogFeatureFlag,
} from "@posthog/next";
import { FEATURE_FLAG_OVERRIDES_STORAGE_KEY } from "@repo/api/src/types/feature-flag-overrides";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFeatureFlagOverride } from "./feature-flag-overrides";

vi.mock("@posthog/next", () => ({
  useFeatureFlag: vi.fn(),
  usePostHog: vi.fn(),
}));

const FALLBACK_FEATURE_FLAGS_STORAGE_KEY = "closedloop:e2e-feature-flags";
const FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY =
  "closedloop:feature-flags-fail-open";
const OVERRIDDEN_FLAG = "overridden-flag";
const UNTOUCHED_FLAG = "untouched-flag";

beforeEach(() => {
  // Precedence cases: clear every higher- and lower-priority input not under
  // test so ambient storage cannot satisfy a branch.
  clearFlagStorage();
});

afterEach(() => {
  cleanup();
  clearFlagStorage();
  vi.mocked(usePostHogFeatureFlag).mockReset();
  vi.mocked(usePostHogClient).mockReset();
});

describe("resolveFeatureFlagOverride", () => {
  it("returns the override only while active", () => {
    const overrides = { [OVERRIDDEN_FLAG]: false };

    expect(resolveFeatureFlagOverride(true, overrides, OVERRIDDEN_FLAG)).toBe(
      false
    );
    expect(
      resolveFeatureFlagOverride(false, overrides, OVERRIDDEN_FLAG)
    ).toBeUndefined();
  });

  it("never overrides a restriction flag", () => {
    const overrides = { "compute-target-signing": false };

    expect(
      resolveFeatureFlagOverride(true, overrides, "compute-target-signing")
    ).toBeUndefined();
  });

  it("returns undefined for a key with no override, including prototype keys", () => {
    const overrides = { [OVERRIDDEN_FLAG]: true };

    expect(
      resolveFeatureFlagOverride(true, overrides, UNTOUCHED_FLAG)
    ).toBeUndefined();
    expect(
      resolveFeatureFlagOverride(true, overrides, "constructor")
    ).toBeUndefined();
  });
});

describe("useFeatureFlag with Dev Tools overrides (PostHog key present)", () => {
  it("lets an override beat PostHog in both directions while Dev Mode is on", async () => {
    mockPostHogAnswers({ [OVERRIDDEN_FLAG]: true, [UNTOUCHED_FLAG]: false });
    storeOverrides({ [OVERRIDDEN_FLAG]: false, [UNTOUCHED_FLAG]: true });

    const read = await loadReader({ postHogKey: true });

    expect(read(OVERRIDDEN_FLAG, true)).toMatchObject({ enabled: false });
    expect(read(UNTOUCHED_FLAG, true)).toMatchObject({ enabled: true });
  });

  it("ignores every override while Dev Mode is off", async () => {
    mockPostHogAnswers({ [OVERRIDDEN_FLAG]: true });
    storeOverrides({ [OVERRIDDEN_FLAG]: false });

    const read = await loadReader({ postHogKey: true });

    expect(read(OVERRIDDEN_FLAG, false)).toMatchObject({ enabled: true });
  });

  it("falls through to PostHog for a key with no override, per key", async () => {
    mockPostHogAnswers({ [OVERRIDDEN_FLAG]: true, [UNTOUCHED_FLAG]: true });
    storeOverrides({ [OVERRIDDEN_FLAG]: false });

    const read = await loadReader({ postHogKey: true });

    // Two keys, one overridden: a global "Dev Mode forces off" bug would turn
    // the untouched key off too.
    expect(read(OVERRIDDEN_FLAG, true)).toMatchObject({ enabled: false });
    expect(read(UNTOUCHED_FLAG, true)).toMatchObject({ enabled: true });
  });

  it("settles an overridden flag PostHog has not answered yet", async () => {
    vi.mocked(usePostHogFeatureFlag).mockReturnValue(undefined);
    storeOverrides({ [OVERRIDDEN_FLAG]: true });

    const read = await loadReader({ postHogKey: true });

    expect(read(OVERRIDDEN_FLAG, true)).toEqual({
      key: OVERRIDDEN_FLAG,
      enabled: true,
      variant: undefined,
      payload: undefined,
    });
    expect(read(UNTOUCHED_FLAG, true)).toBeUndefined();
  });

  it("treats malformed stored overrides as none", async () => {
    mockPostHogAnswers({ [OVERRIDDEN_FLAG]: true });
    localStorage.setItem(
      FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
      JSON.stringify({ [OVERRIDDEN_FLAG]: "off" })
    );

    const read = await loadReader({ postHogKey: true });

    expect(read(OVERRIDDEN_FLAG, true)).toMatchObject({ enabled: true });
  });

  it("re-renders with a new override written in this window", async () => {
    mockPostHogAnswers({ [OVERRIDDEN_FLAG]: true });
    const { useFeatureFlag, FeatureFlagOverridesProvider } = await loadModules({
      postHogKey: true,
    });

    const { result } = renderHook(() => useFeatureFlag(OVERRIDDEN_FLAG), {
      wrapper: overridesWrapper(FeatureFlagOverridesProvider, true),
    });
    expect(result.current).toMatchObject({ enabled: true });

    act(() => {
      storeOverrides({ [OVERRIDDEN_FLAG]: false });
      globalThis.dispatchEvent(
        new StorageEvent("storage", { key: FEATURE_FLAG_OVERRIDES_STORAGE_KEY })
      );
    });

    expect(result.current).toMatchObject({ enabled: false });
  });

  it("drops every override when localStorage is cleared", async () => {
    mockPostHogAnswers({ [OVERRIDDEN_FLAG]: true });
    storeOverrides({ [OVERRIDDEN_FLAG]: false });
    const { useFeatureFlag, FeatureFlagOverridesProvider } = await loadModules({
      postHogKey: true,
    });

    const { result } = renderHook(() => useFeatureFlag(OVERRIDDEN_FLAG), {
      wrapper: overridesWrapper(FeatureFlagOverridesProvider, true),
    });
    expect(result.current).toMatchObject({ enabled: false });

    act(() => {
      localStorage.clear();
      globalThis.dispatchEvent(new StorageEvent("storage", { key: null }));
    });

    expect(result.current).toMatchObject({ enabled: true });
  });

  it("does not re-read overrides on a storage event for another key", async () => {
    mockPostHogAnswers({ [OVERRIDDEN_FLAG]: true });
    storeOverrides({ [OVERRIDDEN_FLAG]: false });
    const { useFeatureFlag, FeatureFlagOverridesProvider } = await loadModules({
      postHogKey: true,
    });

    const { result } = renderHook(() => useFeatureFlag(OVERRIDDEN_FLAG), {
      wrapper: overridesWrapper(FeatureFlagOverridesProvider, true),
    });
    expect(result.current).toMatchObject({ enabled: false });

    act(() => {
      storeOverrides({ [OVERRIDDEN_FLAG]: true });
      globalThis.dispatchEvent(
        new StorageEvent("storage", { key: "some-other-key" })
      );
    });

    expect(result.current).toMatchObject({ enabled: false });
  });
});

describe("useFeatureFlag with Dev Tools overrides (no PostHog key)", () => {
  it("keeps the fixture behavior when there is no override", async () => {
    localStorage.setItem(
      FALLBACK_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ [UNTOUCHED_FLAG]: true })
    );

    const read = await loadReader({ postHogKey: false });

    expect(read(UNTOUCHED_FLAG, true)).toMatchObject({ enabled: true });
    expect(read(OVERRIDDEN_FLAG, true)).toMatchObject({ enabled: false });
    expect(read(UNTOUCHED_FLAG, false)).toMatchObject({ enabled: true });
  });

  it("lets an override beat the fixture and the blanket opt-in only while Dev Mode is on", async () => {
    localStorage.setItem(FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY, "true");
    storeOverrides({ [OVERRIDDEN_FLAG]: false });

    const read = await loadReader({ postHogKey: false });

    expect(read(OVERRIDDEN_FLAG, true)).toMatchObject({ enabled: false });
    expect(read(OVERRIDDEN_FLAG, false)).toMatchObject({ enabled: true });
  });
});

describe("Dev Mode read recording", () => {
  it("reports each read while Dev Mode is on, and nothing while it is off", async () => {
    mockPostHogAnswers({ [OVERRIDDEN_FLAG]: true });
    const { useFeatureFlag, FeatureFlagOverridesProvider } = await loadModules({
      postHogKey: true,
    });
    const onFlagRead = vi.fn();

    for (const active of [true, false]) {
      const { unmount } = renderHook(() => useFeatureFlag(OVERRIDDEN_FLAG), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <FeatureFlagOverridesProvider active={active} onFlagRead={onFlagRead}>
            {children}
          </FeatureFlagOverridesProvider>
        ),
      });
      unmount();
    }

    expect(onFlagRead).toHaveBeenCalledTimes(1);
    expect(onFlagRead).toHaveBeenCalledWith(OVERRIDDEN_FLAG);
  });
});

describe("pinned snapshot flags in the browser", () => {
  it("reads live production values without sending PostHog exposure events", async () => {
    let enabled = true;
    let notifyFlags: (() => void) | null = null;
    const getFeatureFlagResult = vi.fn(
      (key: string, _options?: { send_event?: boolean }) => ({
        key,
        enabled,
        variant: undefined,
        payload: undefined,
      })
    );
    const onFeatureFlags = vi.fn((listener: () => void) => {
      notifyFlags = listener;
      return () => undefined;
    });
    vi.mocked(usePostHogClient).mockReturnValue({
      getFeatureFlagResult,
      onFeatureFlags,
    } as unknown as ReturnType<typeof usePostHogClient>);
    const original = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    vi.resetModules();
    const { useFeatureFlagProductionValue } = await import("./client");
    restorePostHogKey(original);

    const { result } = renderHook(() =>
      useFeatureFlagProductionValue(OVERRIDDEN_FLAG)
    );
    expect(result.current).toBe(true);
    expect(getFeatureFlagResult).toHaveBeenCalledWith(OVERRIDDEN_FLAG, {
      send_event: false,
    });
    expect(
      getFeatureFlagResult.mock.calls.every(
        ([, options]) => options?.send_event === false
      )
    ).toBe(true);

    enabled = false;
    act(() => notifyFlags?.());
    expect(result.current).toBe(false);
  });

  it("reports a flag PostHog does not return as unknown until its flags load, then false", async () => {
    let hasLoadedFlags = false;
    let notifyFlags: (() => void) | null = null;
    vi.mocked(usePostHogClient).mockReturnValue({
      getFeatureFlagResult: () => undefined,
      onFeatureFlags: (listener: () => void) => {
        notifyFlags = listener;
        return () => undefined;
      },
      get featureFlags() {
        return { hasLoadedFlags };
      },
    } as unknown as ReturnType<typeof usePostHogClient>);
    const original = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    vi.resetModules();
    const { useFeatureFlagProductionValue } = await import("./client");
    restorePostHogKey(original);

    const { result } = renderHook(() =>
      useFeatureFlagProductionValue(UNTOUCHED_FLAG)
    );
    expect(result.current).toBeUndefined();

    hasLoadedFlags = true;
    act(() => notifyFlags?.());
    expect(result.current).toBe(false);
  });

  it("pins below a Dev Mode override and above PostHog, and reports the production value without the override", async () => {
    mockPostHogAnswers({ [OVERRIDDEN_FLAG]: false, [UNTOUCHED_FLAG]: false });
    storeOverrides({ [OVERRIDDEN_FLAG]: false });
    const original = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    vi.resetModules();
    const [client, overrides, pinned] = await Promise.all([
      import("./client"),
      import("./feature-flag-overrides"),
      import("./pinned-feature-flags"),
    ]);
    restorePostHogKey(original);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <pinned.PinnedFeatureFlagsProvider
        flags={{ [OVERRIDDEN_FLAG]: true, [UNTOUCHED_FLAG]: "variant-b" }}
      >
        <overrides.FeatureFlagOverridesProvider active>
          {children}
        </overrides.FeatureFlagOverridesProvider>
      </pinned.PinnedFeatureFlagsProvider>
    );

    const { result } = renderHook(
      () => ({
        overridden: client.useFeatureFlag(OVERRIDDEN_FLAG),
        pinnedOnly: client.useFeatureFlag(UNTOUCHED_FLAG),
        production: client.useFeatureFlagProductionValue(OVERRIDDEN_FLAG),
      }),
      { wrapper }
    );

    expect(result.current.overridden).toMatchObject({ enabled: false });
    expect(result.current.pinnedOnly).toMatchObject({ enabled: true });
    expect(result.current.production).toBe(true);
  });
});

function restorePostHogKey(original: string | undefined) {
  if (original === undefined) {
    Reflect.deleteProperty(process.env, "NEXT_PUBLIC_POSTHOG_KEY");
  } else {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = original;
  }
}

function clearFlagStorage() {
  localStorage.removeItem(FEATURE_FLAG_OVERRIDES_STORAGE_KEY);
  localStorage.removeItem(FALLBACK_FEATURE_FLAGS_STORAGE_KEY);
  localStorage.removeItem(FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY);
}

function storeOverrides(overrides: Record<string, boolean>) {
  localStorage.setItem(
    FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
    JSON.stringify(overrides)
  );
}

function mockPostHogAnswers(answers: Record<string, boolean>) {
  vi.mocked(usePostHogFeatureFlag).mockImplementation((key: string) => ({
    key,
    enabled: answers[key] === true,
    variant: undefined,
    payload: undefined,
  }));
}

type OverridesProvider = (props: {
  active: boolean;
  children: ReactNode;
}) => ReactNode;

function overridesWrapper(Provider: OverridesProvider, active: boolean) {
  return ({ children }: { children: ReactNode }) => (
    <Provider active={active}>{children}</Provider>
  );
}

/**
 * Load `client` and `feature-flag-overrides` from ONE fresh module registry.
 * `client` binds its PostHog or fallback reader at module scope from the key,
 * and reads the overrides context object of that same registry, so a provider
 * imported from the outer registry would make every assertion vacuous.
 */
async function loadModules({ postHogKey }: { postHogKey: boolean }) {
  const original = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (postHogKey) {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
  } else {
    Reflect.deleteProperty(process.env, "NEXT_PUBLIC_POSTHOG_KEY");
  }
  vi.resetModules();
  try {
    const [client, overrides] = await Promise.all([
      import("./client"),
      import("./feature-flag-overrides"),
    ]);
    return {
      useFeatureFlag: client.useFeatureFlag,
      FeatureFlagOverridesProvider: overrides.FeatureFlagOverridesProvider,
    };
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(process.env, "NEXT_PUBLIC_POSTHOG_KEY");
    } else {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = original;
    }
  }
}

async function loadReader(options: { postHogKey: boolean }) {
  const { useFeatureFlag, FeatureFlagOverridesProvider } =
    await loadModules(options);
  return (flag: string, devModeOn: boolean) => {
    const { result, unmount } = renderHook(() => useFeatureFlag(flag), {
      wrapper: overridesWrapper(FeatureFlagOverridesProvider, devModeOn),
    });
    const value = result.current;
    unmount();
    return value;
  };
}
