import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replaceOrgSlugSegment } from "../org-slug-path";

const mocks = vi.hoisted(() => ({
  organizationReload: vi.fn().mockResolvedValue(undefined),
  sessionReload: vi.fn().mockResolvedValue(undefined),
  replace: vi.fn(),
  path: "/acme/settings",
  search: "",
}));

vi.mock("@repo/analytics/client", () => ({ useFeatureFlag: () => undefined }));

vi.mock("@repo/auth/client", () => ({
  useAuth: () => ({
    getToken: () => Promise.resolve("t"),
    isLoaded: true,
    orgId: "org_1",
    userId: "user_1",
  }),
  useOrganization: () => ({
    organization: { reload: mocks.organizationReload },
  }),
  useSession: () => ({ session: { reload: mocks.sessionReload } }),
  // `AppCoreAdapterProvider` mounts `WebDevModeProvider`, which reads it.
  useUser: () => ({ isLoaded: true, user: { id: "user_1" } }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    back: vi.fn(),
    navigate: vi.fn(),
    refresh: vi.fn(),
    replace: mocks.replace,
  }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => mocks.path,
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => new URLSearchParams(mocks.search),
}));

import { useOrganizationIdentityResync } from "@repo/app/shared/auth/use-organization-identity-resync";
import { AppCoreAdapterProvider } from "../app-core-adapters";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.path = "/acme/settings";
  mocks.search = "";
  mocks.organizationReload = vi.fn().mockResolvedValue(undefined);
  mocks.sessionReload = vi.fn().mockResolvedValue(undefined);
});

// Mounted through `AppCoreAdapterProvider` — the real composition root from
// `app/layout.tsx` — so losing the provider wiring, or dropping the member from
// the web adapter, reds these rather than silently skipping them.
function renderResync() {
  const { result } = renderHook(() => useOrganizationIdentityResync(), {
    wrapper: ({ children }) => (
      <AppCoreAdapterProvider>{children}</AppCoreAdapterProvider>
    ),
  });
  return result;
}

describe("replaceOrgSlugSegment", () => {
  it("swaps the org segment and keeps the rest of the path", () => {
    expect(replaceOrgSlugSegment("/acme/settings", "globex")).toBe(
      "/globex/settings"
    );
    expect(replaceOrgSlugSegment("/acme/branches/abc/detail", "globex")).toBe(
      "/globex/branches/abc/detail"
    );
  });

  it("keeps a trailing empty segment rather than mangling the path", () => {
    expect(replaceOrgSlugSegment("/acme/", "globex")).toBe("/globex/");
  });

  it("falls back to the org root when there is no org segment to swap", () => {
    expect(replaceOrgSlugSegment("/", "globex")).toBe("/globex");
    expect(replaceOrgSlugSegment("", "globex")).toBe("/globex");
  });
});

describe("web auth adapter organization identity resync", () => {
  it("is a real implementation, not the shared no-op fallback", async () => {
    const resync = renderResync();

    await resync.current("globex");

    // The port's default is a resolving no-op that touches nothing. Reaching
    // Clerk proves the web shell supplied its own member.
    expect(mocks.organizationReload).toHaveBeenCalled();
  });

  it("reloads Clerk org and session, then re-anchors the current path onto the new slug", async () => {
    const resync = renderResync();

    await resync.current("globex");

    expect(mocks.organizationReload).toHaveBeenCalledTimes(1);
    expect(mocks.sessionReload).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith("/globex/settings");
  });

  it("re-anchors the page the user is actually on, not a hardcoded settings route", async () => {
    mocks.path = "/acme/branches/abc";
    const resync = renderResync();

    await resync.current("globex");

    expect(mocks.replace).toHaveBeenCalledWith("/globex/branches/abc");
  });

  it("still navigates when the Clerk org reload rejects, and still attempts the session reload", async () => {
    // The rename already committed server-side. Aborting here would leave the
    // user on a URL whose slug no longer resolves.
    mocks.organizationReload = vi.fn().mockRejectedValue(new Error("clerk"));
    const resync = renderResync();

    await resync.current("globex");

    expect(mocks.sessionReload).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith("/globex/settings");
  });

  it("still navigates when the session reload rejects", async () => {
    mocks.sessionReload = vi.fn().mockRejectedValue(new Error("clerk"));
    const resync = renderResync();

    await resync.current("globex");

    expect(mocks.replace).toHaveBeenCalledWith("/globex/settings");
  });

  it("carries the search params across the re-anchor", async () => {
    // Settings v2 keeps the open panel, the intent and the close destination in
    // the query. `usePath()` is the pathname alone, so re-anchoring on it alone
    // silently switched panels on a rename.
    mocks.search = "panel=organization&returnTo=%2Facme%2Fbranches";
    const resync = renderResync();

    await resync.current("globex");

    expect(mocks.replace).toHaveBeenCalledWith(
      "/globex/settings?panel=organization&returnTo=%2Facme%2Fbranches"
    );
  });

  it("reloads Clerk but does NOT navigate when the slug did not change", async () => {
    // A name-only save resyncs Clerk through this same member. Replacing onto
    // the href we are already on would be a navigation that changes nothing.
    mocks.search = "panel=organization";
    const resync = renderResync();

    await resync.current("acme");

    expect(mocks.organizationReload).toHaveBeenCalledTimes(1);
    expect(mocks.sessionReload).toHaveBeenCalledTimes(1);
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
