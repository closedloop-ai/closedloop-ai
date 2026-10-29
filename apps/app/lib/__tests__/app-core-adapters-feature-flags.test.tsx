import { cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-5946. `posthogFeatureFlagAdapter` in `../app-core-adapters` backs
 * `@repo/app`'s feature-flag port and had no test. Every `apps/app` flag read
 * now goes through it: ISS-11411 moved the direct `useFeatureFlag` call sites to
 * the port, and ISS-11786 deleted the analytics `FeatureFlagged` gate.
 *
 * Mounted via `AppCoreAdapterProvider`, the real composition root from
 * `app/layout.tsx`, so losing the provider wiring reds these too.
 */
const GATED_CHILD_TEXT = "gated surface";

/**
 * Deliberately not a real flag key. The contract is that ANY flag nobody pinned
 * resolves closed, so pinning a live key here would rot when that flag is
 * retired and would test one rollout rather than the default.
 */
const UNPINNED_FLAG = "iss-5946-unpinned-probe";

/**
 * Restated, not imported: `client.ts` keeps both storage keys module-private, so
 * there is no canonical symbol available. A rename there reds the opt-in case
 * below rather than passing silently.
 */
const FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY =
  "closedloop:feature-flags-fail-open";

/** Cleared, never set, so an inherited fixture cannot satisfy an earlier branch. */
const FALLBACK_FEATURE_FLAGS_STORAGE_KEY = "closedloop:e2e-feature-flags";

/**
 * `@posthog/next` is a vitest alias in `apps/app`, not a declared dependency, so
 * the mock handles are captured here rather than imported back — `apps/app` has
 * no types for that specifier and importing it fails `tsc`. `vi.hoisted` keeps
 * one stable pair of spies across the module resets below.
 */
const posthogMocks = vi.hoisted(() => ({
  useFeatureFlag: vi.fn(),
  usePostHog: vi.fn(),
}));

vi.mock("@posthog/next", () => posthogMocks);

/**
 * Every case re-imports the `app-core-adapters` graph from source after a
 * registry reset, which is seconds of cold transform on a loaded box — enough to
 * trip vitest's 5s default, as it did while this file was being written. Pinned
 * explicitly rather than left to the default.
 */
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  cleanup();
  localStorage.removeItem(FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY);
  localStorage.removeItem(FALLBACK_FEATURE_FLAGS_STORAGE_KEY);
  posthogMocks.useFeatureFlag.mockReset();
  posthogMocks.usePostHog.mockReset();
  vi.resetModules();
});

describe("web feature-flag chain with no PostHog key", () => {
  it("keeps an unpinned gated surface off screen", async () => {
    await renderGatedChild({ postHogKey: undefined });

    expect(screen.queryByText(GATED_CHILD_TEXT)).not.toBeInTheDocument();
  });

  /**
   * The positive control, and the inner half of the nested gate. The case above
   * asserts an absence, which a `FeatureFlagged` that had quietly stopped
   * rendering its children would also satisfy; same flag, same child, opposite
   * outcome rules that out. The no-key gate is open in both, so this is also the
   * only case that executes the blanket-opt-in branch of
   * `resolveTestingFeatureFlag`.
   */
  it("renders that same gated surface once the blanket QA opt-in is set", async () => {
    localStorage.setItem(FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY, "true");

    await renderGatedChild({ postHogKey: undefined });

    expect(screen.getByText(GATED_CHILD_TEXT)).toBeInTheDocument();
  });
});

/**
 * The production mirror of the case above. With a key present, PostHog answers
 * asynchronously and `useFeatureFlag` reports `undefined` until it does — during
 * bootstrap, and for the whole session when `/flags` is blocked or times out.
 * Widening the adapter's `?.enabled === true` to anything that admits
 * `undefined` opens every port-gated surface for real signed-in users. The peer
 * copy of that expression in the route gate is covered elsewhere:
 * `feature-flag-route-gate.test.tsx` pins unresolved-stays-closed on its own
 * component. Nothing covered the adapter's copy, and each is an independent
 * re-declaration that can drift.
 */
describe("web feature-flag chain with PostHog configured", () => {
  it("keeps a gated surface closed while the flag is unresolved", async () => {
    posthogMocks.useFeatureFlag.mockReturnValue(undefined);

    await renderGatedChild({ postHogKey: "phc_test" });

    expect(screen.queryByText(GATED_CHILD_TEXT)).not.toBeInTheDocument();
    // `client.ts` picks its binding once, at module scope, off the key. Absent a
    // key it would reach the FALLBACK and resolve closed too — same screen, wrong
    // branch — so this case has to prove the PostHog binding is the one that ran.
    // Without it, a key that silently stopped reaching `keys()` would leave this
    // green while covering nothing.
    expect(posthogMocks.useFeatureFlag).toHaveBeenCalledWith(UNPINNED_FLAG);
  });

  /**
   * The positive control for the branch above, mirroring the no-key one. The
   * assertion there is an absence, which a with-key chain that rendered nothing
   * at all would also satisfy; only a resolved `true` opening the SAME child
   * rules that out.
   */
  it("opens that same gated surface when PostHog resolves the flag true", async () => {
    posthogMocks.useFeatureFlag.mockReturnValue({
      key: UNPINNED_FLAG,
      enabled: true,
      variant: undefined,
      payload: undefined,
    });

    await renderGatedChild({ postHogKey: "phc_test" });

    expect(screen.getByText(GATED_CHILD_TEXT)).toBeInTheDocument();
  });
});

/**
 * FEA-1626. `useFeatureFlagResolved` is the adapter's other hook, and the port
 * falls back SILENTLY when an adapter omits it:
 * `use-feature-flag-enabled.ts` reads `adapter.useFeatureFlagResolved ??
 * alwaysResolved`. Drop it from the adapter and `useFeatureFlagGate` reports
 * ready on the very first render, so a flag-dependent query fires on the closed
 * default and refetches once the flag lands — the double fetch the hook was
 * added to prevent — with nothing in the suite going red.
 */
describe("feature-flag readiness port", () => {
  it("withholds readiness while PostHog has not answered", async () => {
    posthogMocks.useFeatureFlag.mockReturnValue(undefined);

    await renderGateProbe({ postHogKey: "phc_test" });

    expect(screen.getByText(GATE_PENDING_TEXT)).toBeInTheDocument();
  });

  /**
   * The control that keeps the case above honest, and the distinction the hook
   * exists for: a resolved `false` is an ANSWER, not a pending state, so it must
   * report ready even though the flag itself is closed.
   */
  it("reports ready once PostHog answers, even with the flag closed", async () => {
    posthogMocks.useFeatureFlag.mockReturnValue({
      key: UNPINNED_FLAG,
      enabled: false,
      variant: undefined,
      payload: undefined,
    });

    await renderGateProbe({ postHogKey: "phc_test" });

    expect(screen.getByText(GATE_READY_TEXT)).toBeInTheDocument();
  });
});

describe("local-trusted auth adapter wiring", () => {
  it("serves a loaded synthetic auth snapshot without waiting for Clerk", async () => {
    await withPostHogKey(undefined, async () => {
      const { AppCoreAdapterProvider } = await import("../app-core-adapters");
      const { useAuthSnapshot } = await import(
        "@repo/app/shared/auth/use-auth-snapshot"
      );

      function AuthProbe() {
        const { getToken, isLoaded, orgId, userId } = useAuthSnapshot();
        const [token, setToken] = useState("pending");

        useEffect(() => {
          getToken().then((value) => {
            setToken(value ? "token-present" : "token-null");
          });
        }, [getToken]);

        return <>{`${isLoaded}:${userId}:${orgId}:${token}`}</>;
      }

      render(
        <AppCoreAdapterProvider
          localTrustedAuthIdentity={{
            orgId: "org_e2e_local_trusted",
            orgSlug: "closedloop-ai",
            userId: "user_e2e_local_trusted",
          }}
        >
          <AuthProbe />
        </AppCoreAdapterProvider>
      );
    });

    expect(
      await screen.findByText(
        "true:user_e2e_local_trusted:org_e2e_local_trusted:token-present"
      )
    ).toBeInTheDocument();
  });
});

const GATE_PENDING_TEXT = "flag pending";
const GATE_READY_TEXT = "flag ready";

/**
 * Evaluate `render` against a module graph freshly loaded under a chosen
 * `NEXT_PUBLIC_POSTHOG_KEY`.
 *
 * `@repo/analytics/client` reads the key once at module scope, so it has to be
 * set before the graph is evaluated — hence the reset plus dynamic imports the
 * callers do inside. Every module a caller needs must be imported after the same
 * reset, or a statically imported one would hold the pre-reset
 * `FeatureFlagAdapterProvider` context and never see the adapter.
 */
async function withPostHogKey<T>(
  postHogKey: string | undefined,
  renderUnderKey: () => Promise<T>
): Promise<T> {
  const originalPostHogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (postHogKey === undefined) {
    Reflect.deleteProperty(process.env, "NEXT_PUBLIC_POSTHOG_KEY");
  } else {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = postHogKey;
  }
  vi.resetModules();

  try {
    return await renderUnderKey();
  } finally {
    if (originalPostHogKey === undefined) {
      Reflect.deleteProperty(process.env, "NEXT_PUBLIC_POSTHOG_KEY");
    } else {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = originalPostHogKey;
    }
  }
}

/** The real composition root around a `FeatureFlagged` child. */
function renderGatedChild({ postHogKey }: { postHogKey?: string }) {
  return withPostHogKey(postHogKey, async () => {
    const { AppCoreAdapterProvider } = await import("../app-core-adapters");
    const { FeatureFlagged } = await import(
      "@repo/app/shared/feature-flags/feature-flagged"
    );

    return render(
      <AppCoreAdapterProvider>
        <FeatureFlagged flag={UNPINNED_FLAG}>{GATED_CHILD_TEXT}</FeatureFlagged>
      </AppCoreAdapterProvider>
    );
  });
}

/** The same root around a probe that renders `useFeatureFlagGate`'s readiness. */
function renderGateProbe({ postHogKey }: { postHogKey?: string }) {
  return withPostHogKey(postHogKey, async () => {
    const { AppCoreAdapterProvider } = await import("../app-core-adapters");
    const { useFeatureFlagGate } = await import(
      "@repo/app/shared/feature-flags/use-feature-flag-enabled"
    );

    function ReadinessProbe() {
      const { isReady } = useFeatureFlagGate(UNPINNED_FLAG);
      return <>{isReady ? GATE_READY_TEXT : GATE_PENDING_TEXT}</>;
    }

    return render(
      <AppCoreAdapterProvider>
        <ReadinessProbe />
      </AppCoreAdapterProvider>
    );
  });
}
