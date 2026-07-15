import { useFeatureFlag as usePostHogFeatureFlag } from "@posthog/next";
import { afterEach, describe, expect, it, vi } from "vitest";

const FALLBACK_FEATURE_FLAGS_STORAGE_KEY = "closedloop:e2e-feature-flags";
const FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY =
  "closedloop:feature-flags-fail-open";

vi.mock("@posthog/next", () => ({
  useFeatureFlag: vi.fn(),
  usePostHog: vi.fn(),
}));

describe("useFeatureFlag fallback", () => {
  afterEach(() => {
    localStorage.removeItem(FALLBACK_FEATURE_FLAGS_STORAGE_KEY);
  });

  it("keeps feature flags enabled when PostHog is disabled without an E2E fixture", async () => {
    const { useFeatureFlag } = await importClientWithPostHogDisabled();

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

  it("falls back to enabled when the E2E fixture is malformed", async () => {
    localStorage.setItem(FALLBACK_FEATURE_FLAGS_STORAGE_KEY, "{");

    const { useFeatureFlag } = await importClientWithPostHogDisabled();

    expect(useFeatureFlag("branch-pr")).toMatchObject({
      enabled: true,
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
  afterEach(() => {
    localStorage.removeItem(FALLBACK_FEATURE_FLAGS_STORAGE_KEY);
    localStorage.removeItem(FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY);
  });

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
