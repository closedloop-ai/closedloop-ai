/**
 * ISS-9701, the web half of the wire: the shared API client asks the auth port
 * for a token with `forceRefresh` after a 401, and only Clerk's `skipCache`
 * makes that a genuinely new credential. Clerk caches the session JWT it mints,
 * so an adapter that forwarded nothing — or forwarded the port's own option
 * name, which Clerk does not know — would hand the retry back the exact string
 * the server just rejected, and the refresh would be theatre.
 *
 * Driven through `AppCoreAdapterProvider`, the real composition root from
 * `app/layout.tsx`, so dropping the mapping or the provider wiring reds this
 * rather than silently skipping it.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn((_options?: unknown) => Promise.resolve("token")),
}));

vi.mock("@repo/analytics/client", () => ({ useFeatureFlag: () => undefined }));

vi.mock("@repo/auth/client", () => ({
  useAuth: () => ({
    getToken: mocks.getToken,
    isLoaded: true,
    orgId: "org_1",
    userId: "user_1",
  }),
  useOrganization: () => ({ organization: null }),
  useSession: () => ({ session: null }),
  // `AppCoreAdapterProvider` mounts `WebDevModeProvider`, which reads it.
  useUser: () => ({ isLoaded: true, user: { id: "user_1" } }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    back: vi.fn(),
    navigate: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("@repo/navigation/use-path", () => ({ usePath: () => "/acme" }));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => new URLSearchParams(),
}));

import { useAuthSnapshot } from "@repo/app/shared/auth/use-auth-snapshot";
import { AppCoreAdapterProvider } from "../app-core-adapters";

describe("web auth adapter token refresh (ISS-9701)", () => {
  beforeEach(() => {
    mocks.getToken.mockClear();
  });

  it("asks Clerk to skip its token cache when the port asks for a refresh", async () => {
    const { result } = renderHook(() => useAuthSnapshot(), {
      wrapper: AppCoreAdapterProvider,
    });

    await expect(result.current.getToken({ forceRefresh: true })).resolves.toBe(
      "token"
    );

    expect(mocks.getToken).toHaveBeenCalledWith({ skipCache: true });
  });

  it("leaves an ordinary token read on the cache", async () => {
    // The control. Bypassing the cache on EVERY read would mint a token per
    // request — the storm the coalesced refresh exists to avoid, arriving
    // through the adapter instead.
    const { result } = renderHook(() => useAuthSnapshot(), {
      wrapper: AppCoreAdapterProvider,
    });

    await result.current.getToken();

    expect(mocks.getToken).toHaveBeenCalledWith();
  });
});
