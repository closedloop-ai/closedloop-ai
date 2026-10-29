/**
 * PLN-2162 M3: the web composition root mounts the realtime host, so shared
 * consumers below it find a client for a signed-in user and none without one.
 * Driven through `AppCoreAdapterProvider`, the provider `app/layout.tsx`
 * mounts, so removing the host from it reds this.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userId: "user_1" as string | null,
}));

vi.mock("@repo/analytics/client", () => ({ useFeatureFlag: () => undefined }));

vi.mock("@repo/auth/client", () => ({
  useAuth: () => ({
    getToken: () => Promise.resolve("token"),
    isLoaded: true,
    orgId: mocks.userId === null ? null : "org_1",
    userId: mocks.userId,
  }),
  useOrganization: () => ({ organization: null }),
  useSession: () => ({ session: null }),
  useUser: () => ({ isLoaded: true, user: null }),
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

import { useRealtimeClient } from "@repo/app/shared/realtime/realtime-provider";
import { AppCoreAdapterProvider } from "../app-core-adapters";

describe("AppCoreAdapterProvider realtime host (PLN-2162 M3)", () => {
  beforeEach(() => {
    mocks.userId = "user_1";
  });

  it("provides a realtime client to a signed-in user", async () => {
    const { result } = renderHook(() => useRealtimeClient(), {
      wrapper: AppCoreAdapterProvider,
    });

    await waitFor(() => expect(result.current).not.toBeNull());
  });

  it("provides none while signed out", async () => {
    mocks.userId = null;
    const { result } = renderHook(() => useRealtimeClient(), {
      wrapper: AppCoreAdapterProvider,
    });

    await waitFor(() => expect(result.current).toBeNull());
  });
});
