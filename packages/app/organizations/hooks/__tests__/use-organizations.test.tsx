import { InviteMemberStatus } from "@repo/api/src/types/onboarding";
import { OrganizationMembersSource } from "@repo/api/src/types/organization-members";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { onboardingKeys } from "../../../onboarding/hooks/use-onboarding";
import {
  organizationKeys,
  useInviteMembers,
  useOrganizationMembers,
  useOrganizationMembersSource,
  useUpdateOrganization,
} from "../use-organizations";

const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: mockToastError,
    info: vi.fn(),
    success: vi.fn(),
  },
}));

const mockApiClient = {
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const INVITEE = "invitee@example.com";

function createWrapperWithClient(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useUpdateOrganization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the update payload and invalidates organization caches", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mockApiClient.put.mockResolvedValue({
      id: "org-1",
      slug: "new-slug",
    });

    const { result } = renderHook(() => useUpdateOrganization(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate({ id: "org-1", slug: "new-slug" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.put).toHaveBeenCalledWith("/organizations/org-1", {
      slug: "new-slug",
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: organizationKeys.detail("org-1"),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: organizationKeys.lists(),
    });
  });

  it("exposes rejected API errors through mutation state", async () => {
    const error = new Error("Slug is unavailable");
    mockApiClient.put.mockRejectedValue(error);

    const { result } = renderHook(() => useUpdateOrganization(), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    act(() => {
      result.current.mutate({ id: "org-1", slug: "new-slug" });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBe(error);
  });

  it("surfaces one default failure toast for rejected updates", async () => {
    mockApiClient.put.mockRejectedValue(new Error("Slug is unavailable"));

    const { result } = renderHook(() => useUpdateOrganization(), {
      wrapper: createWrapperWithClient(makeQueryClient()),
    });

    act(() => {
      result.current.mutate({ id: "org-1", slug: "new-slug" });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockToastError).toHaveBeenCalledOnce();
  });
});

describe("useInviteMembers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts the invite payload to the BFF invitations route", async () => {
    mockApiClient.post.mockResolvedValue({
      invited: 2,
      results: [
        {
          email: "a@example.com",
          invitationId: "inv_1",
          status: InviteMemberStatus.Invited,
        },
        {
          email: "b@example.com",
          invitationId: "inv_2",
          status: InviteMemberStatus.Invited,
        },
      ],
    });

    const { result } = renderHook(() => useInviteMembers(), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    act(() => {
      result.current.mutate({
        emailAddresses: ["a@example.com", "b@example.com"],
        role: "org:member",
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/organizations/invitations",
      {
        emailAddresses: ["a@example.com", "b@example.com"],
        role: "org:member",
      }
    );
    expect(result.current.data?.invited).toBe(2);
  });

  it("surfaces rejected invitation errors through mutation state", async () => {
    const error = new Error("Only organization admins can invite team members");
    mockApiClient.post.mockRejectedValue(error);

    const { result } = renderHook(() => useInviteMembers(), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    act(() => {
      result.current.mutate({ emailAddresses: ["a@example.com"] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBe(error);
  });

  // ISS-7089: the invite row's completion is computed server-side from the
  // recorded send, so without this the row stays unticked behind the status
  // query's five-minute staleTime until something else refetches it.
  it("refreshes the onboarding status after a sent invitation", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mockApiClient.post.mockResolvedValue({
      invited: 1,
      results: [
        {
          email: INVITEE,
          invitationId: "inv_1",
          status: InviteMemberStatus.Invited,
        },
      ],
    });

    const { result } = renderHook(() => useInviteMembers(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate({ emailAddresses: [INVITEE] });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: onboardingKeys.all,
    });
  });

  it("leaves the onboarding status alone when the invitation fails", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mockApiClient.post.mockRejectedValue(new Error("Forbidden"));

    const { result } = renderHook(() => useInviteMembers(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate({ emailAddresses: [INVITEE] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

// ISS-12135: the vibe Members roster reads the whole organization, so a long
// roster must not stop at the server's page size.
describe("useOrganizationMembers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("follows the roster's pages to the end", async () => {
    const first = { userId: "user_a", role: "org:owner" };
    const second = { userId: "user_b", role: "org:admin" };
    mockApiClient.get
      .mockResolvedValueOnce({ members: [first], total: 2, hasMore: true })
      .mockResolvedValueOnce({ members: [second], total: 2, hasMore: false });

    const { result } = renderHook(() => useOrganizationMembers(), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual([first, second]);
    expect(mockApiClient.get.mock.calls.map(([path]) => path)).toEqual([
      "/organizations/members?limit=100&offset=0",
      "/organizations/members?limit=100&offset=1",
    ]);
  });

  it("fails rather than returning part of the roster as the whole", async () => {
    mockApiClient.get.mockResolvedValue({
      members: [],
      total: 3,
      hasMore: true,
    });

    const { result } = renderHook(() => useOrganizationMembers(), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.data).toBeUndefined();
  });
});

describe("useOrganizationMembersSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the source off a one-row page", async () => {
    mockApiClient.get.mockResolvedValue({
      members: [{ userId: "user_a", role: "org:owner" }],
      total: 3,
      hasMore: true,
      source: OrganizationMembersSource.Seeded,
    });

    const { result } = renderHook(() => useOrganizationMembersSource(), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    await waitFor(() =>
      expect(result.current.data).toBe(OrganizationMembersSource.Seeded)
    );
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/organizations/members?limit=1"
    );
  });

  it("answers null when an older API sends a page with no source", async () => {
    mockApiClient.get.mockResolvedValue({
      members: [{ userId: "user_a", role: "org:owner" }],
      total: 3,
      hasMore: true,
    });

    const { result } = renderHook(() => useOrganizationMembersSource(), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});
