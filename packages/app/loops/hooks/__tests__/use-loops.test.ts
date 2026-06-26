import {
  type InheritedAdditionalRepos,
  LoopCommand,
  LoopStatus,
} from "@repo/api/src/types/loop";
import { createWrapper } from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useInheritedAdditionalRepos, useResumeLoop } from "../use-loops";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
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

// PLN-462: thin wrapper around the backend endpoint that resolves the
// inherited peer-repo set for the new-plan modal. The selection logic lives
// server-side; the hook just surfaces the small response payload.
describe("useInheritedAdditionalRepos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("hits /documents/:id/inherited-additional-repos with the target command and returns the response", async () => {
    const response: InheritedAdditionalRepos = {
      additionalRepos: [{ fullName: "org/peer-a", branch: "main" }],
      source: {
        loopId: "loop-1",
        command: LoopCommand.GeneratePrd,
        artifactId: "doc-1",
      },
    };
    mockApiClient.get.mockResolvedValueOnce(response);

    const { result } = renderHook(
      () => useInheritedAdditionalRepos("doc-1", LoopCommand.Plan),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/documents/doc-1/inherited-additional-repos?command=${LoopCommand.Plan}`
    );
    expect(result.current.data).toEqual(response);
  });

  test("uses the EXECUTE command when launching execute", async () => {
    mockApiClient.get.mockResolvedValueOnce({
      additionalRepos: [],
      source: null,
    });

    const { result } = renderHook(
      () => useInheritedAdditionalRepos("doc-1", LoopCommand.Execute),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/documents/doc-1/inherited-additional-repos?command=${LoopCommand.Execute}`
    );
  });

  test("returns empty additionalRepos and null source when nothing is inheritable", async () => {
    const response: InheritedAdditionalRepos = {
      additionalRepos: [],
      source: null,
    };
    mockApiClient.get.mockResolvedValueOnce(response);

    const { result } = renderHook(
      () => useInheritedAdditionalRepos("doc-1", LoopCommand.Plan),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(response);
  });

  test("hook is disabled when documentId is null", () => {
    const { result } = renderHook(
      () => useInheritedAdditionalRepos(null, LoopCommand.Plan),
      { wrapper: createWrapper() }
    );
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  test("hook is disabled when documentId is an empty string", () => {
    const { result } = renderHook(
      () => useInheritedAdditionalRepos("", LoopCommand.Plan),
      { wrapper: createWrapper() }
    );
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });
});
