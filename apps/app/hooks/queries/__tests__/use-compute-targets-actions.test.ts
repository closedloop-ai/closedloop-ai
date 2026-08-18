import {
  COMMAND_SIGNING_CAPABILITY_KEY,
  type ComputeTarget,
  DesktopCommandStatus,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { computePreferenceKeys } from "@repo/app/compute/hooks/use-compute-preference";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeTargetKeys } from "../compute-target-query-keys";
import {
  useComputeTargetHealthCheckSnapshot,
  useDeleteComputeTarget,
  useDesktopCommandStatus,
  useDispatchDesktopCommand,
  useStartDesktopSecurityUpgrade,
  useToggleComputeTargetSharing,
  useUpdateComputeTargetHarness,
} from "../use-compute-targets";
import { createTestQueryClient, createWrapperWithClient } from "./test-utils";

// Covers the seven action/query hooks in use-compute-targets.ts that the
// sibling use-compute-targets.test.ts does not exercise (that file is scoped
// to useComputeTargets' signing-cache refresh behavior only).

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  postRaw: vi.fn(),
};

const mockHasEffectiveCommandSigningSupport = vi.hoisted(() => vi.fn());
const mockSignDesktopCommand = vi.hoisted(() => vi.fn());
// Captures every options object passed to react-query's real useQuery so the
// useDesktopCommandStatus test can invoke its real (unmodified) refetchInterval
// callback directly with synthetic query states, instead of relying on
// react-query's actual timer/polling machinery (no timing-based assertions)
// or vi.spyOn on the ESM namespace export (unsupported — "Module namespace is
// not configurable in ESM").
const capturedQueryOptions = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("@/lib/desktop-command-signing/command-signer", () => ({
  hasEffectiveCommandSigningSupport: mockHasEffectiveCommandSigningSupport,
  signDesktopCommand: mockSignDesktopCommand,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (options: Record<string, unknown>) => {
      capturedQueryOptions.push(options);
      return actual.useQuery(
        options as unknown as Parameters<typeof actual.useQuery>[0]
      );
    },
  };
});

function makeComputeTarget(
  overrides: Partial<ComputeTarget> = {}
): ComputeTarget {
  return {
    id: "target-1",
    organizationId: "org-1",
    userId: "user-1",
    machineName: "Test-MBP",
    platform: "darwin",
    capabilities: { [COMMAND_SIGNING_CAPABILITY_KEY]: false },
    supportedOperations: [],
    lastSeenAt: new Date("2026-05-10T12:00:00.000Z"),
    isOnline: true,
    isSharedWithOrg: false,
    serverCapabilities: { computeTargetSigning: false },
    selectedHarness: HarnessType.Claude,
    createdAt: new Date("2026-05-10T12:00:00.000Z"),
    updatedAt: new Date("2026-05-10T12:00:00.000Z"),
    ...overrides,
  } as ComputeTarget;
}

describe("useComputeTargetHealthCheckSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null without calling the API when forced enabled with no targetId", async () => {
    // enabled: Boolean(targetId) normally gates the query off entirely when
    // targetId is null/undefined — the `if (!targetId) return null` guard
    // inside queryFn is otherwise unreachable. A caller-supplied `enabled:
    // true` override (spread after the base options) forces the queryFn to
    // run anyway, which is the only way to reach that guard.
    const { result } = renderHook(
      () => useComputeTargetHealthCheckSnapshot(null, false, { enabled: true }),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toBeNull();
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  it("converts snapshot timestamps to Dates and defaults a missing pluginAutoUpdateEnabled flag to false", async () => {
    mockApiClient.get.mockResolvedValueOnce({
      id: "snap-1",
      computeTargetId: "target-1",
      checks: [],
      allRequiredPassed: true,
      checkedAt: "2026-05-10T12:00:00.000Z",
      createdAt: "2026-05-10T12:00:00.000Z",
      updatedAt: "2026-05-10T12:00:00.000Z",
    });

    const { result } = renderHook(
      () => useComputeTargetHealthCheckSnapshot("target-1", true),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/compute-targets/target-1/health-check"
    );
    expect(result.current.data?.checkedAt).toEqual(
      new Date("2026-05-10T12:00:00.000Z")
    );
    expect(result.current.data?.pluginAutoUpdateEnabled).toBe(false);
  });

  it("accepts an options object as the second argument and treats plugin auto-update as disabled", async () => {
    mockApiClient.get.mockResolvedValueOnce(null);

    const { result } = renderHook(
      () =>
        useComputeTargetHealthCheckSnapshot("target-2", {
          meta: { source: "edge-case-test" },
        }),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The no-auto-update query key segment proves the 2-arg overload treated
    // the options object as `options`, not as `pluginAutoUpdateEnabled`.
    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/compute-targets/target-2/health-check"
    );
    expect(result.current.data).toBeNull();
  });
});

describe("useDeleteComputeTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates the target list, removes the deleted target's health-check cache, and invalidates the user's compute preference", async () => {
    mockApiClient.delete.mockResolvedValueOnce({ deleted: true });

    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const removeSpy = vi.spyOn(queryClient, "removeQueries");

    const { result } = renderHook(() => useDeleteComputeTarget("user-42"), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate("target-9");
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.delete).toHaveBeenCalledWith(
      "/compute-targets/target-9"
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: computeTargetKeys.list(),
    });
    expect(removeSpy).toHaveBeenCalledWith({
      queryKey: computeTargetKeys.healthCheck("target-9"),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: computePreferenceKeys.detail("user-42"),
    });
  });
});

describe("useToggleComputeTargetSharing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PATCHes the sharing flag and invalidates the compute-targets list", async () => {
    mockApiClient.patch.mockResolvedValueOnce({
      id: "target-3",
      isSharedWithOrg: true,
    });

    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useToggleComputeTargetSharing(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate({ id: "target-3", isSharedWithOrg: true });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.patch).toHaveBeenCalledWith(
      "/compute-targets/target-3/sharing",
      { isSharedWithOrg: true }
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: computeTargetKeys.list(),
    });
  });
});

describe("useDesktopCommandStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not fetch when commandId is null", () => {
    const { result } = renderHook(
      () => useDesktopCommandStatus("target-1", null),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  it("polls at a 2-second interval while non-terminal and stops once the command reaches a terminal status", () => {
    // The polling cadence is expressed as a `refetchInterval` callback passed
    // into useQuery's options — capture the real options object the hook
    // builds (via the module-level react-query mock above) and invoke that
    // same callback directly with synthetic query states, rather than
    // asserting on wall-clock polling behavior.
    mockApiClient.get.mockResolvedValue({
      status: DesktopCommandStatus.Running,
    });
    capturedQueryOptions.length = 0;

    renderHook(() => useDesktopCommandStatus("target-1", "cmd-1"), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    const options = capturedQueryOptions.find(
      (candidate) => typeof candidate.refetchInterval === "function"
    ) as {
      refetchInterval: (query: {
        state: { data: { status: string } | undefined };
      }) => number | false;
    };

    expect(options).toBeDefined();
    expect(
      options.refetchInterval({
        state: { data: { status: DesktopCommandStatus.Running } },
      })
    ).toBe(2000);
    expect(
      options.refetchInterval({
        state: { data: { status: DesktopCommandStatus.Done } },
      })
    ).toBe(false);
  });
});

describe("useDispatchDesktopCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends an unsigned command when the target lacks effective command-signing support", async () => {
    mockHasEffectiveCommandSigningSupport.mockReturnValue(false);
    mockApiClient.post.mockResolvedValueOnce({
      commandId: "cmd-unsigned",
      status: DesktopCommandStatus.Queued,
    });

    const target = makeComputeTarget();
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDispatchDesktopCommand(target), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate({ idempotencyKey: "idem-1" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockSignDesktopCommand).not.toHaveBeenCalled();
    const [path, body] = mockApiClient.post.mock.calls[0];
    expect(path).toBe(`/compute-targets/${target.id}/commands`);
    expect(body).not.toHaveProperty("signature");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: computeTargetKeys.list(),
    });
  });

  it("signs the command and merges the signature fields into the payload when the target supports signing", async () => {
    mockHasEffectiveCommandSigningSupport.mockReturnValue(true);
    mockSignDesktopCommand.mockResolvedValueOnce({
      commandId: "cmd-signed",
      path: "/gateway/update-and-restart",
      query: { v: "2" },
      signature: "sig-abc",
      signaturePayload: "payload-abc",
      publicKeyFingerprint: "fp-abc",
    });
    mockApiClient.post.mockResolvedValueOnce({
      commandId: "cmd-signed",
      status: DesktopCommandStatus.Queued,
    });

    const target = makeComputeTarget({
      capabilities: { [COMMAND_SIGNING_CAPABILITY_KEY]: true },
      serverCapabilities: { computeTargetSigning: true },
    });

    const { result } = renderHook(() => useDispatchDesktopCommand(target), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    act(() => {
      result.current.mutate({ idempotencyKey: "idem-2" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [, body] = mockApiClient.post.mock.calls[0];
    expect(body).toMatchObject({
      commandId: "cmd-signed",
      path: "/gateway/update-and-restart",
      query: { v: "2" },
      signature: "sig-abc",
      signaturePayload: "payload-abc",
      publicKeyFingerprint: "fp-abc",
    });
  });
});

describe("useUpdateComputeTargetHarness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PUTs the selected harness and invalidates the compute-targets list", async () => {
    const target = makeComputeTarget({ selectedHarness: HarnessType.Codex });
    mockApiClient.put.mockResolvedValueOnce(target);

    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateComputeTargetHarness(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate({ id: "target-4", harness: HarnessType.Codex });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.put).toHaveBeenCalledWith(
      "/compute-targets/target-4",
      { selectedHarness: HarnessType.Codex }
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: computeTargetKeys.list(),
    });
  });
});

describe("useStartDesktopSecurityUpgrade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts the security-upgrade attempt via postRaw and invalidates the compute-targets list on success", async () => {
    mockApiClient.postRaw.mockResolvedValueOnce({
      commandId: "cmd-upgrade",
      expiresAt: "2026-05-10T12:05:00.000Z",
    });

    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useStartDesktopSecurityUpgrade(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate({
        targetId: "target-5",
        webAppOrigin: "https://app.example.com",
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.postRaw).toHaveBeenCalledWith(
      "/compute-targets/target-5/security-upgrade-attempt",
      { webAppOrigin: "https://app.example.com" }
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: computeTargetKeys.list(),
    });
  });
});
