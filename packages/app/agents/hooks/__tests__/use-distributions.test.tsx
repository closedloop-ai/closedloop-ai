import { createWrapper } from "@repo/app/shared/test-utils";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDistributions } from "../use-distributions";

const mockApiClient = {
  get: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useDistributions", () => {
  it("does not fetch when disabled", () => {
    renderHook(() => useDistributions({ enabled: false }), {
      wrapper: createWrapper(),
    });

    expect(mockApiClient.get).not.toHaveBeenCalled();
  });
});
