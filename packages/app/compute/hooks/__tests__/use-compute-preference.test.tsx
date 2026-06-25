import {
  ComputePreference,
  type ComputePreferenceResponse,
  HarnessType,
  type SetComputePreferenceRequest,
} from "@repo/api/src/types/compute-target";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  computePreferenceKeys,
  useSetComputePreference,
} from "../use-compute-preference";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const userId = "user-1";
const targetA = "11111111-1111-4111-8111-111111111111";
const targetB = "22222222-2222-4222-8222-222222222222";

function setup(previous?: ComputePreferenceResponse) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (previous) {
    queryClient.setQueryData(computePreferenceKeys.detail(userId), previous);
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useSetComputePreference(userId), {
    wrapper,
  });
  return { queryClient, result };
}

function readCache(queryClient: QueryClient) {
  return queryClient.getQueryData<ComputePreferenceResponse>(
    computePreferenceKeys.detail(userId)
  );
}

type MergeCase = {
  name: string;
  previous: ComputePreferenceResponse;
  request: SetComputePreferenceRequest;
  expected: ComputePreferenceResponse;
};

const mergeCases: MergeCase[] = [
  {
    name: "a mode/target change preserves the persisted harness",
    previous: {
      preferredComputeMode: ComputePreference.Local,
      computeTargetId: targetA,
      selectedHarness: HarnessType.Codex,
      isExplicit: true,
    },
    request: {
      mode: ComputePreference.Local,
      computeTargetId: targetB,
    },
    expected: {
      preferredComputeMode: ComputePreference.Local,
      computeTargetId: targetB,
      selectedHarness: HarnessType.Codex,
      isExplicit: true,
    },
  },
  {
    name: "a harness-only change preserves the mode and target",
    previous: {
      preferredComputeMode: ComputePreference.Cloud,
      computeTargetId: targetA,
      selectedHarness: HarnessType.Claude,
      isExplicit: true,
    },
    request: {
      mode: ComputePreference.Cloud,
      selectedHarness: HarnessType.Codex,
    },
    expected: {
      preferredComputeMode: ComputePreference.Cloud,
      computeTargetId: targetA,
      selectedHarness: HarnessType.Codex,
      isExplicit: true,
    },
  },
];

describe("useSetComputePreference optimistic update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test.each(mergeCases)("$name", async ({ previous, request, expected }) => {
    // Keep the request in-flight so onSuccess invalidation never clobbers the
    // optimistic cache we are asserting against.
    mockApiClient.put.mockReturnValue(new Promise(() => undefined));
    const { queryClient, result } = setup(previous);

    act(() => {
      result.current.mutate(request);
    });

    await waitFor(() => {
      expect(readCache(queryClient)).toEqual(expected);
    });
  });

  test("rolls back to the previous value when the request fails", async () => {
    const previous: ComputePreferenceResponse = {
      preferredComputeMode: ComputePreference.Cloud,
      computeTargetId: targetA,
      selectedHarness: HarnessType.Codex,
      isExplicit: true,
    };
    mockApiClient.put.mockRejectedValue(new Error("network"));
    const { queryClient, result } = setup(previous);

    act(() => {
      result.current.mutate({
        mode: ComputePreference.Local,
        computeTargetId: targetB,
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(readCache(queryClient)).toEqual(previous);
  });
});
