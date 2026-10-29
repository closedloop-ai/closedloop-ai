// @vitest-environment jsdom

import {
  createWrapper,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userKeys } from "../../../users/hooks/use-users";
import { useOnboardingOrganizationMembers } from "../use-onboarding-organization-members";

const { mockApiClient } = vi.hoisted(() => ({
  mockApiClient: { get: vi.fn() },
}));

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const SIGNER = {
  email: "signer@example.com",
  firstName: "Sol",
  id: "user-signer",
  lastName: "Founder",
};
const TEAMMATE = {
  email: "ada@example.com",
  firstName: "Ada",
  id: "user-ada",
  lastName: "Lovelace",
};

/**
 * ISS-8348. Only a resolved roster AND a resolved signer may produce a `known`
 * claim; every other query state is `unknown`.
 */
describe("useOnboardingOrganizationMembers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claims nothing while the query is gated off", async () => {
    mockApiClient.get.mockResolvedValue([]);

    const { result } = renderHook(
      () => useOnboardingOrganizationMembers({ enabled: false }),
      { wrapper: createWrapper() }
    );

    expect(result.current).toEqual({ status: "unknown" });
    // A disabled React Query reports `isPending` forever; gating on it would
    // have called this "loading" and then never resolved. Prove no fetch ran.
    await waitFor(() => expect(mockApiClient.get).not.toHaveBeenCalled());
  });

  it("does not fetch on mount by default", () => {
    renderHook(() => useOnboardingOrganizationMembers(), {
      wrapper: createWrapper(),
    });

    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  it("claims nothing while the roster is in flight", () => {
    mockApiClient.get.mockReturnValue(new Promise(() => undefined));

    const { result } = renderHook(
      () => useOnboardingOrganizationMembers({ enabled: true }),
      { wrapper: createWrapper() }
    );

    expect(result.current).toEqual({ status: "unknown" });
  });

  it("claims nothing when the roster read fails", async () => {
    mockApiClient.get.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(
      () => useOnboardingOrganizationMembers({ enabled: true }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalled());
    expect(result.current).toEqual({ status: "unknown" });
  });

  it("reverts to unknown when a refetch errors after an initial success", async () => {
    mockApiClient.get.mockImplementation((path: string) =>
      Promise.resolve(path === "/me" ? SIGNER : [SIGNER, TEAMMATE])
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: 0, retry: false } },
    });
    const { result } = renderHook(
      () => useOnboardingOrganizationMembers({ enabled: true }),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await waitFor(() => expect(result.current.status).toBe("known"));

    mockApiClient.get.mockImplementation((path: string) => {
      if (path === "/me") {
        return Promise.resolve(SIGNER);
      }
      return Promise.reject(new Error("boom"));
    });
    queryClient.refetchQueries({
      queryKey: userKeys.organizationUsers(),
    });

    await waitFor(() => expect(result.current).toEqual({ status: "unknown" }));
  });

  it("stays unknown while the signer query is still pending", async () => {
    mockApiClient.get.mockImplementation((path: string) => {
      if (path === "/me") {
        return new Promise(() => undefined);
      }
      return Promise.resolve([SIGNER, TEAMMATE]);
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: 0, retry: false } },
    });
    const { result } = renderHook(
      () => useOnboardingOrganizationMembers({ enabled: true }),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await waitFor(() =>
      expect(mockApiClient.get).toHaveBeenCalledWith("/users")
    );
    expect(result.current).toEqual({ status: "unknown" });
  });

  it("reports the roster once both reads resolve, excluding the signer", async () => {
    mockApiClient.get.mockImplementation((path: string) =>
      Promise.resolve(path === "/me" ? SIGNER : [SIGNER, TEAMMATE])
    );

    const { result } = renderHook(
      () => useOnboardingOrganizationMembers({ enabled: true }),
      { wrapper: createWrapper() }
    );

    await waitFor(() =>
      expect(result.current).toEqual({
        count: 1,
        preview: [{ id: TEAMMATE.id, initials: "A", name: "Ada Lovelace" }],
        status: "known",
      })
    );
  });

  it("keeps the known claim while a background refetch runs", async () => {
    mockApiClient.get.mockImplementation((path: string) =>
      Promise.resolve(path === "/me" ? SIGNER : [SIGNER, TEAMMATE])
    );

    const { rerender, result } = renderHook(
      () => useOnboardingOrganizationMembers({ enabled: true }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.status).toBe("known"));
    // React Query keeps serving cached rows while it refetches. Branching on
    // `isPending`/`isFetching` would blank a roster that is still on screen.
    rerender();
    expect(result.current.status).toBe("known");
  });

  it("reports a real zero when the signer is the only member", async () => {
    mockApiClient.get.mockImplementation((path: string) =>
      Promise.resolve(path === "/me" ? SIGNER : [SIGNER])
    );

    const { result } = renderHook(
      () => useOnboardingOrganizationMembers({ enabled: true }),
      { wrapper: createWrapper() }
    );

    await waitFor(() =>
      expect(result.current).toEqual({
        count: 0,
        preview: [],
        status: "known",
      })
    );
  });
});
