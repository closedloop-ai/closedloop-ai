import { createWrapper } from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasConnectedAgentKeys,
  useHasConnectedAgent,
} from "../use-has-connected-agent";

// Mock useApiClient — the hook calls it directly (no data-source).
const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hasConnectedAgentKeys", () => {
  it("uses a dedicated key distinct from the full compute-target snapshot", () => {
    expect(hasConnectedAgentKeys.all).toEqual([
      "agent-sessions",
      "has-connected-agent",
    ]);
  });
});

describe("useHasConnectedAgent", () => {
  // PRD-536 §5: the org-wide probe route returns { hasConnectedAgent }, NOT the
  // user-scoped /compute-targets listing (the bug the review caught).
  it("hits the org-wide has-connected-agent endpoint and unwraps true", async () => {
    mockApiClient.get.mockResolvedValueOnce({ hasConnectedAgent: true });

    const { result } = renderHook(() => useHasConnectedAgent(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(true);
    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/compute-targets/has-connected-agent"
    );
  });

  it("unwraps false when the org has never connected an agent", async () => {
    mockApiClient.get.mockResolvedValueOnce({ hasConnectedAgent: false });

    const { result } = renderHook(() => useHasConnectedAgent(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(false);
  });

  it("respects enabled:false — never fires the request", () => {
    renderHook(() => useHasConnectedAgent({ enabled: false }), {
      wrapper: createWrapper(),
    });
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  it("surfaces isError when the probe request fails (data stays undefined so the neutral filters copy is kept)", async () => {
    mockApiClient.get.mockRejectedValueOnce(new Error("500"));

    const { result } = renderHook(() => useHasConnectedAgent(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
