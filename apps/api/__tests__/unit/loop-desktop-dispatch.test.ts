/**
 * Tests for dispatchRelayOperation delivery-failure handling.
 *
 * The key invariant: a relay 200 response with { delivered: false } must be
 * treated as a launch failure when throwOnFailure=true (e.g. launchLoopOnDesktop).
 * The fire-and-forget kill path (throwOnFailure=false / default) must NOT throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

const mockCommandSigningEligibilityStatus = vi.hoisted(
  () =>
    ({
      Eligible: "eligible",
      Ineligible: "ineligible",
      Unknown: "unknown",
    }) as const
);
const mockCommandSigningRequirementStatus = vi.hoisted(
  () =>
    ({
      Required: "required",
      NotRequired: "not_required",
      Unknown: "unknown",
    }) as const
);
const mockCommandSigningEligibilityUnknownReason = vi.hoisted(
  () => "command_signing_eligibility_unknown" as const
);
const mockCommandSigningEligibilityUnknownError = vi.hoisted(
  () =>
    "Command signing eligibility could not be verified for this compute target" as const
);

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  EvaluationReportType: { PLAN: "PLAN", CODE: "CODE" },
}));

// Mock desktopCommandStore so launchLoopOnDesktop can run without a real DB.
vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    createCommand: vi.fn().mockResolvedValue({
      command: { commandId: "cmd-test-1" },
      deduped: false,
    }),
    markCommandExpired: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findById: vi.fn().mockResolvedValue({
      organizationId: "org-1",
      userId: "owner-1",
      gatewayId: "gateway-1",
      capabilities: {},
    }),
  },
}));

vi.mock("@/lib/compute-target-signing-eligibility", () => ({
  COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_ERROR:
    mockCommandSigningEligibilityUnknownError,
  COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_REASON:
    mockCommandSigningEligibilityUnknownReason,
  CommandSigningEligibilityStatus: mockCommandSigningEligibilityStatus,
  CommandSigningRequirementStatus: mockCommandSigningRequirementStatus,
  isComputeTargetSigningEligible: vi.fn().mockResolvedValue({
    status: mockCommandSigningEligibilityStatus.Ineligible,
    reason: "no_active_managed_key",
  }),
}));

// relayEventBus is used by the non-relay (direct socket.io) path.
vi.mock("@/lib/relay-event-bus", () => ({
  relayEventBus: { publishOperation: vi.fn() },
}));

// Transitive imports from loop-desktop.ts
vi.mock("@/app/compute-targets/relay-command-helpers", () => ({
  toRelayOperation: vi.fn().mockReturnValue({
    operationId: "test-op",
    method: "POST",
    path: "/test",
    body: {},
  }),
}));

vi.mock("@/lib/desktop-gateway-wire", () => ({
  toWireCommandFromRelayOperation: vi.fn().mockReturnValue({
    commandId: "cmd-test-1",
    operationId: "test-op",
    method: "POST",
    path: "/test",
    body: {},
  }),
  toEnvelope: vi.fn().mockReturnValue({
    commandId: "cmd-test-1",
    operationId: "test-op",
  }),
}));

// --- Imports (after mocks) ---

import {
  COMMAND_SIGNING_CAPABILITY_KEY,
  COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY,
} from "@repo/api/src/types/compute-target";
import { DocumentType } from "@repo/api/src/types/document";
import { LoopCommand } from "@repo/api/src/types/loop";
import { LoopBranchMaterializationRole } from "@repo/api/src/types/loop-body";
import { log } from "@repo/observability/log";
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
} from "@/lib/loops/loop-desktop";

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

const RE_NOT_DELIVERED = /not delivered/i;
const RE_TARGET_OFFLINE = /target offline/i;
const RE_503 = /503/;

/** Create a minimal mock Response object accepted by dispatchRelayOperation. */
function mockResponse(
  status: number,
  body: unknown
): ReturnType<typeof global.fetch> {
  const text = JSON.stringify(body);
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body),
  } as Response);
}

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

  it("throws containing 'not delivered' when relay returns { delivered: false, reason: 'target_offline' } and throwOnFailure=true", async () => {
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

  it("does NOT throw when relay returns { delivered: false } on the kill (fire-and-forget) path", async () => {
    // The kill path uses stopDesktopLoop which calls dispatchRelayOperation with
    // throwOnFailure=false (the default). Verify that the same { delivered: false }
    // response does not propagate an error.
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: false, reason: "target_offline" })
    );

    const { stopDesktopLoop } = await import("@/lib/loops/loop-desktop");

    await expect(stopDesktopLoop("loop-1", "ct-1")).resolves.toBeUndefined();
  });

  it("keeps unsigned kill available without checking signing eligibility", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: true })
    );
    vi.mocked(isComputeTargetSigningEligible).mockResolvedValue({
      status: CommandSigningEligibilityStatus.Unknown,
      reason: COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_REASON,
    });

    const { stopDesktopLoop } = await import("@/lib/loops/loop-desktop");

    await expect(stopDesktopLoop("loop-1", "ct-1")).resolves.toBeUndefined();
    expect(isComputeTargetSigningEligible).not.toHaveBeenCalled();
    expect(desktopCommandStore.createCommand).toHaveBeenCalledWith(
      "ct-1",
      expect.objectContaining({
        operationId: "symphony_loop_kill",
        body: { loopId: "loop-1" },
      })
    );
  });

  it("expires signed kill commands and throws when immediate delivery fails", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockResponse(200, { delivered: false, reason: "target_offline" })
    );

    const { stopDesktopLoop } = await import("@/lib/loops/loop-desktop");

    await expect(
      stopDesktopLoop("loop-1", "ct-1", {
        commandId: "0196b1bb-7a00-7000-8000-000000000010",
        signature: "signature",
        signaturePayload: "{}",
        publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
        body: { loopId: "loop-1", action: "loop.kill" },
      })
    ).rejects.toThrow(DispatchError);
    expect(desktopCommandStore.markCommandExpired).toHaveBeenCalledWith(
      "cmd-test-1",
      "signed_command_delivery_failed:target_offline",
      expect.objectContaining({
        commandId: "cmd-test-1",
        operationId: "symphony_loop_kill",
        computeTargetId: "ct-1",
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
