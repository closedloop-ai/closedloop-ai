import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.fn()s so each test controls the return value; wrapped in arrow factories
// to avoid TDZ when vi.mock is hoisted. These local mocks override the global
// setup mock of use-route-params for this file.
const mockUseOrganization = vi.fn();
const mockUseAuth = vi.fn();
const mockUseRouteParams = vi.fn();
const mockUseLocalTrustedIdentity = vi.fn();

vi.mock("@repo/auth/client", () => ({
  useOrganization: () => mockUseOrganization(),
  useAuth: () => mockUseAuth(),
}));

vi.mock("@repo/navigation/use-route-params", () => ({
  useRouteParams: () => mockUseRouteParams(),
}));

vi.mock("@repo/auth/local-trusted-client", () => ({
  useLocalTrustedIdentity: () => mockUseLocalTrustedIdentity(),
}));

/** The synthetic session `AUTH_MODE=local_trusted` resolves server-side. */
const LOCAL_TRUSTED_IDENTITY = {
  orgId: "org_e2e_local_trusted",
  orgSlug: "closedloop-ai",
  userId: "user_e2e_local_trusted",
};

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
    // Every pre-existing case is a real deployment, where the server resolves
    // no synthetic identity. Set explicitly, because an unset mock returns
    // `undefined` and the new fallback would read as "no org" for the wrong
    // reason.
    mockUseLocalTrustedIdentity.mockReturnValue(null);
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
  it("names the synthetic session's org when Clerk has none (ISS-10335)", async () => {
    // Above the `[orgSlug]` gate on the Clerk-free lane: no route param and no
    // Clerk org, so before this the hook answered "" and every caller held its
    // org-scoped link.
    mockUseRouteParams.mockReturnValue({});
    mockUseOrganization.mockReturnValue({ organization: null, isLoaded: true });
    mockUseLocalTrustedIdentity.mockReturnValue(LOCAL_TRUSTED_IDENTITY);

    const useOrgSlug = await loadHook();
    const { result } = renderHook(() => useOrgSlug());

    expect(result.current).toBe(LOCAL_TRUSTED_IDENTITY.orgSlug);
  });
});

describe("useNavOrgSlug", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockUseAuth.mockReturnValue({ isSignedIn: true });
    // Every pre-existing case is a real deployment, where the server resolves
    // no synthetic identity. Set explicitly, because an unset mock returns
    // `undefined` and the new fallback would read as "no org" for the wrong
    // reason.
    mockUseLocalTrustedIdentity.mockReturnValue(null);
  });

  it("prefers the active organization's slug over a foreign URL slug", async () => {
    // ISS-6567: the gated state, where the URL names an org the user is not in
    // and nav hrefs would otherwise carry it alongside active-org entity ids.
    mockUseRouteParams.mockReturnValue({ orgSlug: "craft-five" });
    mockUseOrganization.mockReturnValue({
      organization: { slug: "closedloop-ai" },
      isLoaded: true,
    });

    const useNavOrgSlug = await loadNavHook();
    const { result } = renderHook(() => useNavOrgSlug());

    expect(result.current).toBe("closedloop-ai");
  });

  it("returns empty rather than the URL slug while the active org is unresolved", async () => {
    // ISS-7344, replacing the URL fallback this hook used to carry here. Mid
    // org-switch the URL slug already names the org being switched TO while the
    // cache still holds the org being switched FROM, so the fallback minted the
    // very hybrid cross-org href it was added to prevent — and did it before the
    // clearing effect ran. "" is the "not yet available" contract callers above
    // the `[orgSlug]` gate hold their org-scoped links on.
    mockUseRouteParams.mockReturnValue({ orgSlug: "acme" });
    mockUseOrganization.mockReturnValue({
      organization: null,
      isLoaded: false,
    });

    const useNavOrgSlug = await loadNavHook();
    const { result } = renderHook(() => useNavOrgSlug());

    expect(result.current).toBe("");
  });

  it("returns empty when Clerk has loaded with no active organization", async () => {
    // The signed-out / between-orgs window, distinct from the loading one above:
    // Clerk is settled and there is genuinely no org to name. The URL slug is no
    // more trustworthy here than it is mid-load.
    mockUseRouteParams.mockReturnValue({ orgSlug: "acme" });
    mockUseOrganization.mockReturnValue({
      organization: null,
      isLoaded: true,
    });

    const useNavOrgSlug = await loadNavHook();
    const { result } = renderHook(() => useNavOrgSlug());

    expect(result.current).toBe("");
  });

  it("names the synthetic session's org when Clerk has none (ISS-10335)", async () => {
    // The Clerk-free lane: no Clerk session at all, so `useOrganization()` never
    // resolves. Without this the hook answers "", `useOrgPathBuilder` emits the
    // org-relative path unprefixed, and the shell comes to rest on
    // `/my-tasks/dashboard` — an org route named after a landing segment.
    mockUseRouteParams.mockReturnValue({});
    mockUseOrganization.mockReturnValue({
      organization: null,
      isLoaded: true,
    });
    mockUseLocalTrustedIdentity.mockReturnValue(LOCAL_TRUSTED_IDENTITY);

    const useNavOrgSlug = await loadNavHook();
    const { result } = renderHook(() => useNavOrgSlug());

    expect(result.current).toBe(LOCAL_TRUSTED_IDENTITY.orgSlug);
  });

  it("still prefers a resolved Clerk org over the synthetic identity", async () => {
    // Belt and braces on the ordering: if both are somehow present, Clerk wins.
    // A test that only set the synthetic one could not tell this from a hook
    // that had stopped reading Clerk entirely.
    mockUseRouteParams.mockReturnValue({});
    mockUseOrganization.mockReturnValue({
      organization: { slug: "globex" },
      isLoaded: true,
    });
    mockUseLocalTrustedIdentity.mockReturnValue(LOCAL_TRUSTED_IDENTITY);

    const useNavOrgSlug = await loadNavHook();
    const { result } = renderHook(() => useNavOrgSlug());

    expect(result.current).toBe("globex");
  });
});

async function loadNavHook() {
  const mod = await import("@/hooks/use-org-slug");
  return mod.useNavOrgSlug;
}
