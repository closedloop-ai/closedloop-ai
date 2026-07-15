import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.fn()s so each test controls the return value; wrapped in arrow factories
// to avoid TDZ when vi.mock is hoisted. These local mocks override the global
// setup mock of use-route-params for this file.
const mockUseOrganization = vi.fn();
const mockUseAuth = vi.fn();
const mockUseRouteParams = vi.fn();

vi.mock("@repo/auth/client", () => ({
  useOrganization: () => mockUseOrganization(),
  useAuth: () => mockUseAuth(),
}));

vi.mock("@repo/navigation/use-route-params", () => ({
  useRouteParams: () => mockUseRouteParams(),
}));

async function loadHook() {
  const mod = await import("@/hooks/use-org-slug");
  return mod.useOrgSlug;
}

describe("useOrgSlug", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    // Default to a signed-in caller; the sign-out case overrides this.
    mockUseAuth.mockReturnValue({ isSignedIn: true });
  });

  afterEach(() => {
    // Ensure a leaked NODE_ENV stub (e.g. if an assertion throws mid-test)
    // never bleeds into the next test, which asserts the dev-only throw path.
    vi.unstubAllEnvs();
  });

  it("returns the orgSlug route param when present", async () => {
    mockUseRouteParams.mockReturnValue({ orgSlug: "acme" });
    mockUseOrganization.mockReturnValue({ organization: null, isLoaded: true });

    const useOrgSlug = await loadHook();
    const { result } = renderHook(() => useOrgSlug());

    expect(result.current).toBe("acme");
  });

  it("falls back to the Clerk active organization slug when no route param", async () => {
    mockUseRouteParams.mockReturnValue({});
    mockUseOrganization.mockReturnValue({
      organization: { slug: "globex" },
      isLoaded: true,
    });

    const useOrgSlug = await loadHook();
    const { result } = renderHook(() => useOrgSlug());

    expect(result.current).toBe("globex");
  });

  it("returns empty string while Clerk is still loading", async () => {
    mockUseRouteParams.mockReturnValue({});
    mockUseOrganization.mockReturnValue({
      organization: null,
      isLoaded: false,
    });

    const useOrgSlug = await loadHook();
    const { result } = renderHook(() => useOrgSlug());

    expect(result.current).toBe("");
  });

  it("returns empty string (no throw) when loaded with no active org — the / transition case", async () => {
    // Regression for FEA-2404: previously threw "No active organization …",
    // surfacing as a real-prod RUM error on "/" during the auth/route
    // transition. In test/dev NODE_ENV the dev-only throw is intentionally
    // active, so assert the production behavior explicitly.
    vi.stubEnv("NODE_ENV", "production");
    mockUseRouteParams.mockReturnValue({});
    mockUseOrganization.mockReturnValue({ organization: null, isLoaded: true });

    const useOrgSlug = await loadHook();
    const { result } = renderHook(() => useOrgSlug());

    expect(result.current).toBe("");
  });

  it("throws in non-production when loaded with no active org (dev misuse signal)", async () => {
    // NODE_ENV is "test" under vitest — the dev-only guard is active.
    mockUseRouteParams.mockReturnValue({});
    mockUseOrganization.mockReturnValue({ organization: null, isLoaded: true });

    const useOrgSlug = await loadHook();

    expect(() => renderHook(() => useOrgSlug())).toThrow(
      "No active organization"
    );
  });

  it("returns empty string (no throw) during sign-out when signed out", async () => {
    // Regression: signing out briefly leaves the (authenticated) subtree
    // mounted with Clerk loaded, no active org, and no route param. That is a
    // benign transient, not misuse, so the dev-only throw must stay silent.
    mockUseRouteParams.mockReturnValue({});
    mockUseOrganization.mockReturnValue({ organization: null, isLoaded: true });
    mockUseAuth.mockReturnValue({ isSignedIn: false });

    const useOrgSlug = await loadHook();
    const { result } = renderHook(() => useOrgSlug());

    expect(result.current).toBe("");
  });
});
