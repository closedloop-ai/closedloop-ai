import { useFeatureFlag as usePostHogFeatureFlag } from "@posthog/next";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CustomerViewState, suppressesFeatureFlag } from "./customer-view";

vi.mock("@posthog/next", () => ({
  useFeatureFlag: vi.fn(),
  usePostHog: vi.fn(),
}));

const FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY =
  "closedloop:feature-flags-fail-open";
const INTERNAL_FLAG = "sessions-grid-fold-legibility";
// Deliberately a literal, not an import of `DEV_MODE_FLAG_KEY`. `customer-view`
// is flag-agnostic by design and `packages/analytics` has no `@repo/api` edge —
// adding one for a test fixture would create the coupling the module avoids. The
// production wiring of this exact key is pinned in
// `apps/app/__tests__/lib/web-dev-mode-provider.test.tsx`.
const ESCAPE_HATCH_FLAG = "dev-mode";
const EXEMPT_FLAG_KEYS: readonly string[] = [ESCAPE_HATCH_FLAG];

afterEach(() => {
  cleanup();
  localStorage.removeItem(FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY);
  vi.mocked(usePostHogFeatureFlag).mockReset();
});

describe("suppressesFeatureFlag", () => {
  it("suppresses a non-exempt key only while active", () => {
    expect(suppressesFeatureFlag(customerView(true), INTERNAL_FLAG)).toBe(true);
    expect(suppressesFeatureFlag(customerView(false), INTERNAL_FLAG)).toBe(
      false
    );
  });

  it("never suppresses the escape-hatch key", () => {
    expect(suppressesFeatureFlag(customerView(true), ESCAPE_HATCH_FLAG)).toBe(
      false
    );
  });
});

/**
 * ISS-7477. These read through the real `useFeatureFlag`, so a change that
 * suppressed the `@repo/app` port adapter alone — the shape the ticket suggested
 * — would leave every one of them red: `FeatureFlagRouteGate`, the sidebar and
 * fifteen other web modules call this hook directly, not the port.
 */
describe("useFeatureFlag under the customer view", () => {
  it("resolves an enabled internal flag to a SETTLED false", async () => {
    mockPostHogEnabled();

    const { result } = await renderCustomerView(INTERNAL_FLAG, true);

    // Settled, not `undefined`: a data-read surface must be able to tell a
    // decided `false` from a flag still in flight (FEA-1626).
    expect(result.current).toEqual({
      key: INTERNAL_FLAG,
      enabled: false,
      variant: undefined,
      payload: undefined,
    });
  });

  it("leaves that same enabled flag alone when the view is inactive", async () => {
    mockPostHogEnabled();

    const { result } = await renderCustomerView(INTERNAL_FLAG, false);

    expect(result.current?.enabled).toBe(true);
  });

  it("lets the escape-hatch flag resolve normally while suppressing", async () => {
    mockPostHogEnabled();

    const { result } = await renderCustomerView(ESCAPE_HATCH_FLAG, true);

    // Without this the switch that turns the customer view OFF is itself hidden
    // by the customer view, and the viewer cannot get back.
    expect(result.current?.enabled).toBe(true);
  });

  it("settles a flag PostHog has not answered for yet", async () => {
    vi.mocked(usePostHogFeatureFlag).mockReturnValue(undefined);

    const suppressed = await renderCustomerView(INTERNAL_FLAG, true);
    const unsuppressed = await renderCustomerView(INTERNAL_FLAG, false);

    expect(suppressed.result.current).toMatchObject({ enabled: false });
    // The contrast is the point: unsuppressed, an unanswered flag stays
    // `undefined`, which `useFeatureFlagResolved` reports as unresolved.
    expect(unsuppressed.result.current).toBeUndefined();
  });

  it("is not defeated by the blanket QA fail-open key", async () => {
    localStorage.setItem(FEATURE_FLAGS_FAIL_OPEN_STORAGE_KEY, "true");
    vi.mocked(usePostHogFeatureFlag).mockReturnValue(undefined);

    const { result } = await renderCustomerView(INTERNAL_FLAG, true);

    expect(result.current?.enabled).toBe(false);
  });

  it("suppresses a flag key it has never been told about", async () => {
    mockPostHogEnabled();

    // The point of the ticket: no per-flag registration, so a flag invented
    // after this shipped is suppressed without anyone editing anything.
    const { result } = await renderCustomerView(
      "a-flag-invented-tomorrow",
      true
    );

    expect(result.current?.enabled).toBe(false);
  });

  it("suppresses every key, the escape hatch included, when no exempt keys are passed", async () => {
    mockPostHogEnabled();
    const { useFeatureFlag, CustomerViewProvider } =
      await loadClientWithPostHogEnabled();

    const { result } = renderHook(() => useFeatureFlag(ESCAPE_HATCH_FLAG), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <CustomerViewProvider active>{children}</CustomerViewProvider>
      ),
    });

    expect(result.current?.enabled).toBe(false);
  });
});

/** PostHog answering ENABLED for whatever key it is asked about. */
function mockPostHogEnabled() {
  vi.mocked(usePostHogFeatureFlag).mockImplementation((key: string) => ({
    key,
    enabled: true,
    variant: undefined,
    payload: undefined,
  }));
}

function customerView(active: boolean): CustomerViewState {
  return { active, exemptFlagKeys: new Set(EXEMPT_FLAG_KEYS) };
}

/**
 * Load `client` and `customer-view` from ONE fresh module registry, with a
 * PostHog key present. `client` binds its PostHog/fallback implementation at
 * module scope from that key, and it holds a direct reference to the context
 * object in `customer-view` — so importing the provider from the outer registry
 * would hand the hook a different context and silently render every suppression
 * assertion vacuous.
 */
async function loadClientWithPostHogEnabled() {
  const originalPostHogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
  vi.resetModules();

  try {
    const [client, customerViewModule] = await Promise.all([
      import("./client"),
      import("./customer-view"),
    ]);
    return {
      useFeatureFlag: client.useFeatureFlag,
      CustomerViewProvider: customerViewModule.CustomerViewProvider,
    };
  } finally {
    if (originalPostHogKey === undefined) {
      Reflect.deleteProperty(process.env, "NEXT_PUBLIC_POSTHOG_KEY");
    } else {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = originalPostHogKey;
    }
  }
}

async function renderCustomerView(flagKey: string, active: boolean) {
  const { useFeatureFlag, CustomerViewProvider } =
    await loadClientWithPostHogEnabled();

  return renderHook(() => useFeatureFlag(flagKey), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <CustomerViewProvider active={active} exemptFlagKeys={EXEMPT_FLAG_KEYS}>
        {children}
      </CustomerViewProvider>
    ),
  });
}
