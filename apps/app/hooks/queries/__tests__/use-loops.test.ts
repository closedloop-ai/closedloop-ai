import { LoopStatus } from "@repo/api/src/types/loop";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useResumeLoop } from "../use-loops";
import { createWrapper } from "./test-utils";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

describe("useResumeLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("posts to /loops/:id/resume with body fields excluding id", async () => {
    const mockResponse = { loopId: "new-loop-456", status: LoopStatus.Pending };
    mockApiClient.post.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useResumeLoop(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ id: "loop-123", prompt: "retry this" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith("/loops/loop-123/resume", {
      prompt: "retry this",
    });
    expect(result.current.data).toEqual(mockResponse);
  });

  test("posts to /loops/:id/resume with empty body when no optional fields provided", async () => {
    const mockResponse = { loopId: "new-loop-789", status: LoopStatus.Pending };
    mockApiClient.post.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useResumeLoop(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ id: "loop-123" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/loops/loop-123/resume",
      {}
    );
  });

  test("returns error state when the API call fails", async () => {
    const mockError = new Error("Failed to resume loop");
    mockApiClient.post.mockRejectedValueOnce(mockError);

    const { result } = renderHook(() => useResumeLoop(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ id: "loop-123" });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toEqual(mockError);
  });
});
