import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  organizationKeys,
  useInviteMembers,
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
  put: vi.fn(),
  post: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

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
        { email: "a@example.com", invitationId: "inv_1", status: "invited" },
        { email: "b@example.com", invitationId: "inv_2", status: "invited" },
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
});
