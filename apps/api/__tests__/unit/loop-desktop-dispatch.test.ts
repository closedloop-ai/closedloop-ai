/**
 * Launch dispatch delivery handling (`launchLoopOnDesktop`) and the payload it
 * builds.
 *
 * The key invariant: a relay 200 response with { delivered: false } means the
 * command never reached the desktop and must be treated as a launch failure
 * (ISS-5708), replayed a bounded number of times first (ISS-5811).
 *
 * The kill entry point (`stopDesktopLoop`) drives the same dispatch helper and
 * is covered in `loop-desktop-kill-dispatch.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/observability/log", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).logMock()
);

vi.mock("@repo/database", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).databaseMock()
);

vi.mock("@/lib/desktop-command-store", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).desktopCommandStoreMock()
);

vi.mock("@/app/compute-targets/service", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).computeTargetsServiceMock()
);

vi.mock("@/lib/compute-target-signing-eligibility", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).commandSigningEligibilityMock()
);

vi.mock("@/lib/relay-event-bus", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).relayEventBusMock()
);

vi.mock("@/app/compute-targets/relay-command-helpers", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).relayCommandHelpersMock()
);

vi.mock("@/lib/desktop-gateway-wire", async () =>
  (
    await import("@/__tests__/support/loops/loop-desktop-dispatch.test-mocks")
  ).desktopGatewayWireMock()
);

// --- Imports (after mocks) ---

import {
  COMMAND_SIGNING_CAPABILITY_KEY,
  COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY,
} from "@repo/api/src/types/compute-target";
import { DocumentType } from "@repo/api/src/types/document";
import { LoopCommand } from "@repo/api/src/types/loop";
import { LoopBranchMaterializationRole } from "@closedloop-ai/loops-api/desktop-request";
import { log } from "@repo/observability/log";
import {
  stubDefaultCreateCommand,
  trackMintedCommandIds,
} from "@/__tests__/support/loops/loop-desktop-dispatch.test-helpers";
import {
  mockResponse,
  mockUnparseableResponse,
  RE_503,
  RE_NOT_DELIVERED,
  RE_TARGET_OFFLINE,
} from "@/__tests__/support/loops/loop-desktop-dispatch.test-mocks";
import { toRelayOperation } from "@/app/compute-targets/relay-command-helpers";
import { computeTargetsService } from "@/app/compute-targets/service";
import {
  COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_ERROR,
  COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_REASON,
  CommandSigningEligibilityStatus,
  isComputeTargetSigningEligible,
} from "@/lib/compute-target-signing-eligibility";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  DispatchError,
  isDispatchError,
  launchLoopOnDesktop,
  MALFORMED_RELAY_ENVELOPE_REASON,
} from "@/lib/loops/loop-desktop";
import { relayEventBus } from "@/lib/relay-event-bus";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_LAUNCH_OPTS = {
  loopId: "loop-1",
  organizationId: "org-1",
  command: "PLAN" as const,
  computeTargetId: "ct-1",
  closedLoopAuthToken: "tok",
  apiBaseUrl: "https://api.example.com",
  contextPack: {
    command: "PLAN",
    artifacts: [],
    prompt: undefined,
    repoInfo: undefined,
    committer: undefined,
    attachments: [
      {
        id: "att-1",
        filename: "spec.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        signedUrl: "https://storage.example.com/spec.pdf?sig=abc",
        signedUrlExpiresAt: "2026-12-31T00:00:00.000Z",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatchRelayOperation (via launchLoopOnDesktop)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      organizationId: "org-1",
      userId: "owner-1",
      gatewayId: "gateway-1",
      capabilities: {},
    } as any);
    vi.mocked(isComputeTargetSigningEligible).mockResolvedValue({
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "no_active_managed_key",
    });
    // Enable the fetch path by providing relay env vars.
    vi.stubEnv("RELAY_API_URL", "http://relay.test");
    vi.stubEnv("INTERNAL_API_SECRET", "secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves when relay returns { delivered: true }", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: true })
    );

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).resolves.toBeDefined();
  });

  it("throws containing 'not delivered' when relay returns { delivered: false, reason: 'target_offline' }", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: false, reason: "target_offline" })
    );

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).rejects.toThrow(
      RE_NOT_DELIVERED
    );
  });

  it("includes the reason in the error message when delivered: false with a reason", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: false, reason: "target_offline" })
    );

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).rejects.toThrow(
      "target_offline"
    );
  });

  it("throws with 'target offline' fallback when delivered: false and no reason provided", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: false })
    );

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).rejects.toThrow(
      RE_TARGET_OFFLINE
    );
  });

  // A 2xx alone is not delivery. Rejecting only an explicit `delivered: false`
  // fails open on every other shape, which is exactly where ISS-5708 found the
  // launch: a command that never left the cloud, reported as dispatched.
  it.each([
    ["an empty object", {}],
    ["a null body", null],
    ["a non-boolean delivered", { delivered: "true" }],
  ])("fails the launch when a relay 2xx carries %s instead of a delivered envelope", async (_shape, body) => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(mockResponse(200, body));

    const error = await launchLoopOnDesktop(VALID_LAUNCH_OPTS).catch(
      (err: unknown) => err
    );

    expect(isDispatchError(error)).toBe(true);
    expect((error as DispatchError).dispatchReason).toBe(
      MALFORMED_RELAY_ENVELOPE_REASON
    );
  });

  it("fails the launch when a relay 2xx body is not JSON at all", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(mockUnparseableResponse(200));

    const error = await launchLoopOnDesktop(VALID_LAUNCH_OPTS).catch(
      (err: unknown) => err
    );

    expect(isDispatchError(error)).toBe(true);
    expect((error as DispatchError).dispatchReason).toBe(
      MALFORMED_RELAY_ENVELOPE_REASON
    );
  });

  it("keeps a delivered envelope when its diagnostic reason is off-contract", async () => {
    // Only `delivered` decides. Failing the envelope over the reason field
    // would point the fail-closed check the wrong way and report a command
    // that DID reach the desktop as a launch failure.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(mockResponse(200, { delivered: true, reason: 42 }));

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).resolves.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws when relay returns non-200 status (existing behavior preserved)", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(503, "Service Unavailable")
    );

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).rejects.toThrow(
      RE_503
    );
  });

  it("requires signed launch intent only when server, signing support, and enforcement opt-in are all true", async () => {
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      organizationId: "org-1",
      userId: "owner-1",
      gatewayId: "gateway-1",
      capabilities: {
        [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: true,
      },
      user: { clerkId: "clerk-owner-1" },
    } as any);
    vi.mocked(isComputeTargetSigningEligible).mockResolvedValue({
      status: CommandSigningEligibilityStatus.Eligible,
    });

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).rejects.toThrow(
      "Command signing is required for this compute target"
    );
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
  });

  it("fails closed before command creation when launch signing eligibility is unknown", async () => {
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      organizationId: "org-1",
      userId: "owner-1",
      gatewayId: "gateway-1",
      capabilities: {
        [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: true,
      },
      user: { clerkId: "clerk-owner-1" },
    } as any);
    vi.mocked(isComputeTargetSigningEligible).mockResolvedValue({
      status: CommandSigningEligibilityStatus.Unknown,
      reason: COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_REASON,
    });

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).rejects.toThrow(
      COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_ERROR
    );
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
    expect(toRelayOperation).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["false", false],
    ["malformed string", "true"],
  ])("uses legacy launch body when commandSigningRequired is %s", async (_label, commandSigningRequired) => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: true })
    );
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      organizationId: "org-1",
      userId: "owner-1",
      gatewayId: "gateway-1",
      capabilities: {
        [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        ...(commandSigningRequired === undefined
          ? {}
          : {
              [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: commandSigningRequired,
            }),
      },
      user: { clerkId: "clerk-owner-1" },
    } as any);

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).resolves.toBeDefined();

    const toRelayOperationMock = vi.mocked(toRelayOperation);
    const [, dispatchedInput] = toRelayOperationMock.mock.calls[0];
    expect(dispatchedInput).toEqual(
      expect.objectContaining({
        operationId: "symphony_loop",
        body: expect.objectContaining({
          closedLoopAuthToken: VALID_LAUNCH_OPTS.closedLoopAuthToken,
        }),
      })
    );
  });

  it("ignores a stale signed launch signature when eligibility is proven ineligible", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: true })
    );
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      organizationId: "org-1",
      userId: "owner-1",
      gatewayId: "gateway-1",
      capabilities: {
        [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: true,
      },
      user: { clerkId: "clerk-owner-1" },
    } as any);
    vi.mocked(isComputeTargetSigningEligible).mockResolvedValue({
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "no_active_managed_key",
    });

    await launchLoopOnDesktop({
      ...VALID_LAUNCH_OPTS,
      desktopUserIntentSignature: {
        commandId: "0196b1bb-7a00-7000-8000-000000000010",
        signature: "signature",
        signaturePayload: "{}",
        publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
        body: { loopId: "loop-1", action: "loop.launch" },
      },
    });

    const toRelayOperationMock = vi.mocked(toRelayOperation);
    const [, dispatchedInput, signatureFields] =
      toRelayOperationMock.mock.calls[0];
    expect(dispatchedInput).toEqual(
      expect.objectContaining({
        operationId: "symphony_loop",
        body: expect.objectContaining({
          closedLoopAuthToken: VALID_LAUNCH_OPTS.closedLoopAuthToken,
        }),
      })
    );
    expect(signatureFields).toBeUndefined();
  });

  it("includes contextPack.attachments in the relay payload body", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: true })
    );

    await launchLoopOnDesktop(VALID_LAUNCH_OPTS);

    const toRelayOperationMock = vi.mocked(toRelayOperation);
    expect(toRelayOperationMock).toHaveBeenCalledOnce();
    const [, dispatchedInput] = toRelayOperationMock.mock.calls[0];
    expect(
      (dispatchedInput as { body: Record<string, unknown> }).body.attachments
    ).toEqual(VALID_LAUNCH_OPTS.contextPack.attachments);
  });

  it("omits absent optional desktop loop payload fields", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: true })
    );

    const opts = {
      ...VALID_LAUNCH_OPTS,
      contextPack: { ...VALID_LAUNCH_OPTS.contextPack, attachments: undefined },
    };

    await launchLoopOnDesktop(opts);

    const toRelayOperationMock = vi.mocked(toRelayOperation);
    expect(toRelayOperationMock).toHaveBeenCalledOnce();
    const [, dispatchedInput] = toRelayOperationMock.mock.calls[0];
    const body = (dispatchedInput as { body: Record<string, unknown> }).body;
    expect(body).not.toHaveProperty("attachments");
    expect(body).not.toHaveProperty("supportingArtifacts");
    expect(body).not.toHaveProperty("codeEvaluationContext");
    expect(body).not.toHaveProperty("userContext");
    expect(body).not.toHaveProperty("additionalRepos");
    expect(body).not.toHaveProperty("s3StateKey");
  });

  it("passes s3StateKey to relay payload body when provided", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: true })
    );

    await launchLoopOnDesktop({
      ...VALID_LAUNCH_OPTS,
      s3StateKey: "org-1/loops/loop-1/run-1",
    });

    const toRelayOperationMock = vi.mocked(toRelayOperation);
    expect(toRelayOperationMock).toHaveBeenCalledOnce();
    const [, dispatchedInput] = toRelayOperationMock.mock.calls[0];
    const body = (dispatchedInput as { body: Record<string, unknown> }).body;
    expect(body.s3StateKey).toBe("org-1/loops/loop-1/run-1");
  });

  it("includes branchMaterialization in the relay payload body when provided", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: true })
    );

    const branchMaterialization = {
      schemaVersion: 1 as const,
      branches: [
        {
          role: LoopBranchMaterializationRole.Primary,
          repositoryFullName: "closedloop-ai/symphony-alpha",
          baseBranch: "main",
          branchName: "symphony/fea-1132",
        },
        {
          role: LoopBranchMaterializationRole.Additional,
          repositoryFullName: "closedloop-ai/sidecar",
          baseBranch: "sidecar",
          branchName: "symphony/fea-1132-closedloop-ai-sidecar-d142fc80",
        },
      ],
    };

    await launchLoopOnDesktop({
      ...VALID_LAUNCH_OPTS,
      branchMaterialization,
    });

    const toRelayOperationMock = vi.mocked(toRelayOperation);
    expect(toRelayOperationMock).toHaveBeenCalledOnce();
    const [, dispatchedInput] = toRelayOperationMock.mock.calls[0];
    const body = (dispatchedInput as { body: Record<string, unknown> }).body;
    expect(body.branchMaterialization).toEqual(branchMaterialization);
  });

  it("passes empty array to relay payload body when contextPack.attachments is []", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: true })
    );

    const opts = {
      ...VALID_LAUNCH_OPTS,
      contextPack: { ...VALID_LAUNCH_OPTS.contextPack, attachments: [] },
    };

    await launchLoopOnDesktop(opts);

    const toRelayOperationMock = vi.mocked(toRelayOperation);
    expect(toRelayOperationMock).toHaveBeenCalledOnce();
    const [, dispatchedInput] = toRelayOperationMock.mock.calls[0];
    expect(
      (dispatchedInput as { body: Record<string, unknown> }).body.attachments
    ).toEqual([]);
  });

  it("includes supportingArtifacts and codeEvaluationContext in the relay payload body", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: true })
    );

    const supportingArtifacts = [
      {
        id: "prd-1",
        type: DocumentType.Prd,
        title: "Supporting PRD",
        content: "# Supporting PRD",
      },
    ];
    const codeEvaluationContext = {
      schemaVersion: 1 as const,
      repo: { fullName: "closedloop/repo", branch: "main" },
      localRepoPath: "/workspace/repo",
      parentBranchName: "feat/parent",
      parentSessionId: "019e1fbd-65eb-71ef-a7ac-59e2eba5b70d",
      artifactSlug: "fea-585",
      pullRequest: {
        number: 42,
        url: "https://github.com/closedloop/repo/pull/42",
        headBranch: "feat/context",
        baseBranch: "main",
        headSha: "abc123",
        repositoryFullName: "closedloop/repo",
      },
      detected: null,
    };

    await launchLoopOnDesktop({
      ...VALID_LAUNCH_OPTS,
      command: LoopCommand.EvaluateCode,
      contextPack: {
        ...VALID_LAUNCH_OPTS.contextPack,
        command: LoopCommand.EvaluateCode,
        supportingArtifacts,
        codeEvaluationContext,
      },
    });

    const toRelayOperationMock = vi.mocked(toRelayOperation);
    expect(toRelayOperationMock).toHaveBeenCalledOnce();
    const [, dispatchedInput] = toRelayOperationMock.mock.calls[0];
    const body = (dispatchedInput as { body: Record<string, unknown> }).body;
    expect(body.supportingArtifacts).toEqual(supportingArtifacts);
    expect(body.codeEvaluationContext).toEqual(codeEvaluationContext);
  });

  it("forwards raw implementation plan state in the relay payload body", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: true })
    );

    const opts = {
      ...VALID_LAUNCH_OPTS,
      command: LoopCommand.Execute,
      contextPack: {
        ...VALID_LAUNCH_OPTS.contextPack,
        command: LoopCommand.Execute,
        artifacts: [
          {
            id: "plan-1",
            type: DocumentType.ImplementationPlan,
            title: "Plan",
            content: "Latest markdown",
            raw: {
              content: "Older markdown",
              pendingTasks: ["task-1"],
            },
          },
        ],
      },
    };

    await launchLoopOnDesktop(opts);

    const toRelayOperationMock = vi.mocked(toRelayOperation);
    expect(toRelayOperationMock).toHaveBeenCalledOnce();
    const [, dispatchedInput] = toRelayOperationMock.mock.calls[0];
    const dispatchedBody = (
      dispatchedInput as unknown as {
        body: { artifacts: Record<string, unknown>[] };
      }
    ).body;
    expect(dispatchedBody.artifacts[0]).toEqual({
      id: "plan-1",
      type: DocumentType.ImplementationPlan,
      title: "Plan",
      content: "Latest markdown",
      raw: {
        content: "Older markdown",
        pendingTasks: ["task-1"],
      },
    });

    expect(log.info).toHaveBeenCalledWith(
      "[loop-desktop] Desktop loop command dispatched",
      expect.objectContaining({
        implementationPlanArtifactPresent: true,
        implementationPlanRawContentPresent: true,
        implementationPlanRawContentMatchesArtifact: false,
        implementationPlanRawReusableByDesktop: false,
        implementationPlanContentLength: "Latest markdown".length,
        implementationPlanRawContentLength: "Older markdown".length,
        implementationPlanContentHash: expect.any(String),
        implementationPlanRawContentHash: expect.any(String),
      })
    );
  });
});

describe("DispatchError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RELAY_API_URL", "http://relay.test");
    vi.stubEnv("INTERNAL_API_SECRET", "secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects with a DispatchError carrying the commandId when relay returns { delivered: false }", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: false, reason: "target_not_connected" })
    );

    let caught: unknown;
    try {
      await launchLoopOnDesktop(VALID_LAUNCH_OPTS);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DispatchError);
    expect(isDispatchError(caught)).toBe(true);
    expect((caught as DispatchError).commandId).toBe("cmd-test-1");
  });
});

/**
 * ISS-5811. The relay collapses a cross-instance peer-proxy timeout into
 * `delivered:false, reason:"target_not_connected"`, so a launch died whenever
 * the API's `POST /dispatch` happened to land on a relay instance that did not
 * own the desktop's socket — measured on the live fleet as four launches
 * failing at 4.29-4.40s (the relay's 4s `PEER_DISPATCH_TIMEOUT_MS` plus
 * overhead) against a ~370ms delivery when the owning instance was hit, with
 * the attempt immediately after a failure succeeding.
 */
describe("launch dispatch replay (ISS-5811)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      organizationId: "org-1",
      userId: "owner-1",
      gatewayId: "gateway-1",
      capabilities: {},
    } as any);
    vi.mocked(isComputeTargetSigningEligible).mockResolvedValue({
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "no_active_managed_key",
    });
    stubDefaultCreateCommand();
    vi.stubEnv("RELAY_API_URL", "http://relay.test");
    vi.stubEnv("INTERNAL_API_SECRET", "secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // `clearAllMocks` clears recorded calls but NOT queued `mockReturnValueOnce`
    // values. These cases queue exact response sequences, so an unconsumed entry
    // would be served to the next case and make it pass or fail for a reason
    // that has nothing to do with the behavior under test.
    vi.restoreAllMocks();
  });

  it("delivers the launch when a not-delivered answer is followed by a delivery", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(
        mockResponse(200, { delivered: false, reason: "target_not_connected" })
      )
      .mockReturnValueOnce(mockResponse(200, { delivered: true }));

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).resolves.toBe(
      "cmd-test-1"
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("replays the SAME commandId so a peer that already emitted cannot double-spawn", async () => {
    // The relay's not-delivered answer is ambiguous: the peer may have emitted
    // before it timed out. Replay is only safe because the commandId is minted
    // once and reused -- the desktop executor dedupes on it. Minting a second
    // command here would be a second, independently-executable run.
    //
    // `createCommand` hands back a DISTINCT id per call here so the assertion
    // can actually fail. Against the suite-wide fixed `cmd-test-1`, a
    // production path that re-minted per attempt would still put the same
    // string on the wire twice and this test would stay green while the
    // desktop double-spawned.
    const mintedCommandIds = trackMintedCommandIds();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(
        mockResponse(200, { delivered: false, reason: "target_not_connected" })
      )
      .mockReturnValueOnce(mockResponse(200, { delivered: true }));

    await launchLoopOnDesktop(VALID_LAUNCH_OPTS);

    expect(mintedCommandIds).toEqual(["cmd-minted-1"]);
    const commandIds = fetchSpy.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body)).operation.commandId
    );
    expect(commandIds).toEqual(["cmd-minted-1", "cmd-minted-1"]);
  });

  it("keeps replaying past a second not-delivered answer", async () => {
    // At the observed ~43% per-attempt delivery rate, stopping at two attempts
    // leaves ~32% of launches dead. The third attempt is the difference between
    // ~68% and ~82%, so a bound of two is a regression, not a nicety. (That rate
    // was sampled under desktop memory pressure and is a floor rather than a
    // baseline -- see the constant's comment -- but every rate in range argues
    // the same direction.)
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(
        mockResponse(200, { delivered: false, reason: "target_not_connected" })
      )
      .mockReturnValueOnce(
        mockResponse(200, { delivered: false, reason: "target_not_connected" })
      )
      .mockReturnValueOnce(mockResponse(200, { delivered: true }));

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).resolves.toBe(
      "cmd-test-1"
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("gives up after a bounded number of attempts rather than replaying forever", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(
        mockResponse(200, { delivered: false, reason: "target_not_connected" })
      );

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).rejects.toThrow(
      RE_NOT_DELIVERED
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("does not replay a relay rejection, which is deterministic rather than transient", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(mockResponse(503, "Service Unavailable"));

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).rejects.toThrow(
      RE_503
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves no error-level log behind when the launch recovers on replay", async () => {
    // Error logs on this path feed a Datadog monitor. A miss that the next
    // attempt recovers is now an expected transient, so it must not leave an
    // error: an alert that fires on every recovered launch is one people learn
    // to scroll past, and the exhausted-budget error below is the signal that
    // has to stay legible.
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(
        mockResponse(200, { delivered: false, reason: "target_not_connected" })
      )
      .mockReturnValueOnce(mockResponse(200, { delivered: true }));

    await launchLoopOnDesktop(VALID_LAUNCH_OPTS);

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("not delivered"),
      expect.objectContaining({ reason: "target_not_connected" })
    );
  });

  it("logs exactly one error once the replay budget is exhausted", async () => {
    // One, not two: before ISS-5811 the same miss was logged by
    // `assertDelivered` and again by the catch in `dispatchRelayApiOperation`.
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: false, reason: "target_not_connected" })
    );

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).rejects.toThrow(
      RE_NOT_DELIVERED
    );

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("not delivered"),
      expect.objectContaining({ reason: "target_not_connected" })
    );
  });
});

/**
 * ISS-5811 over the LOCAL RELAY FALLBACK transport.
 *
 * Without `RELAY_API_URL`/`INTERNAL_API_SECRET` the same retry helper publishes
 * through the in-process `relayEventBus` instead of the relay's HTTP
 * `/dispatch`, and reports the miss as `deliveredToSubscriber: false` rather
 * than `delivered: false`. The replay contract has to hold identically on both
 * -- `apps/api/AGENTS.md` requires the fallback branch to be covered alongside
 * the configured remote branch, precisely because a normal local run only ever
 * exercises this one.
 */
describe("launch dispatch replay over the local relay fallback (ISS-5811)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(computeTargetsService.findById).mockResolvedValue({
      organizationId: "org-1",
      userId: "owner-1",
      gatewayId: "gateway-1",
      capabilities: {},
    } as any);
    vi.mocked(isComputeTargetSigningEligible).mockResolvedValue({
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "no_active_managed_key",
    });
    stubDefaultCreateCommand();
    // Explicitly REMOVE the remote-transport config rather than assume it is
    // absent: `getRelayApiDispatchConfig` prefers it, so an ambient value would
    // route these cases back through fetch and prove nothing about the fallback.
    vi.stubEnv("RELAY_API_URL", undefined);
    vi.stubEnv("INTERNAL_API_SECRET", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("delivers the launch when a no-subscriber publish is followed by a delivery", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("the fallback transport must not reach fetch");
    });
    vi.mocked(relayEventBus.publishOperation)
      .mockReturnValueOnce({ deliveredToSubscriber: false })
      .mockReturnValueOnce({ deliveredToSubscriber: true });

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).resolves.toBe(
      "cmd-test-1"
    );
    expect(relayEventBus.publishOperation).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats a no-subscriber publish as a failure and gives up on the same bound", async () => {
    vi.mocked(relayEventBus.publishOperation).mockReturnValue({
      deliveredToSubscriber: false,
    });

    await expect(launchLoopOnDesktop(VALID_LAUNCH_OPTS)).rejects.toThrow(
      RE_NOT_DELIVERED
    );
    expect(relayEventBus.publishOperation).toHaveBeenCalledTimes(3);
  });

  it("replays the SAME commandId over the fallback transport too", async () => {
    // Same safety argument as the remote transport, same falsifiability
    // requirement: a distinct id per mint, so re-minting per attempt fails here.
    const mintedCommandIds = trackMintedCommandIds();
    vi.mocked(relayEventBus.publishOperation)
      .mockReturnValueOnce({ deliveredToSubscriber: false })
      .mockReturnValueOnce({ deliveredToSubscriber: true });

    await launchLoopOnDesktop(VALID_LAUNCH_OPTS);

    expect(mintedCommandIds).toEqual(["cmd-minted-1"]);
    // `params` is typed as JsonValue on the dispatch request; the commandId is
    // the field `toRelayOperation` parks there.
    const publishedCommandIds = vi
      .mocked(relayEventBus.publishOperation)
      .mock.calls.map(
        ([, operation]) =>
          (operation.params as { commandId?: string } | null)?.commandId
      );
    expect(publishedCommandIds).toEqual(["cmd-minted-1", "cmd-minted-1"]);
  });

  it("keeps a recovered fallback launch off the error log", async () => {
    vi.mocked(relayEventBus.publishOperation)
      .mockReturnValueOnce({ deliveredToSubscriber: false })
      .mockReturnValueOnce({ deliveredToSubscriber: true });

    await launchLoopOnDesktop(VALID_LAUNCH_OPTS);

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("not delivered"),
      expect.objectContaining({ reason: "target_offline" })
    );
  });
});
