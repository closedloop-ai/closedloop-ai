/**
 * Route-level tests for the server-side `request_prd_changes` admission gate.
 *
 * The PRD editor hides the "Amend PRD" action behind the `prd-request-changes`
 * flag, but the run-loop endpoint must fail closed on its own so a stale client
 * or a direct API call cannot dispatch the dark-launched command. The real
 * gate runs here (only PostHog is mocked) to exercise the integration. See
 * FEA-2925.
 */

import { RunLoopCommand } from "@repo/api/src/types/loop";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";

const mockState = vi.hoisted(() => ({
  authContext: undefined as AuthContext | undefined,
  isFeatureFlagEnabledForDistinctId: vi.fn(),
  resolveDocumentId: vi.fn(),
  findWithRegenerationContext: vi.fn(),
  buildMissingExplicitPreferenceResponse: vi.fn(),
  resolveRunLoopComputeTarget: vi.fn(),
  resolveEffectiveSignedRunLoopIntent: vi.fn(),
  resolveLoopContext: vi.fn(),
  resolveEvaluateCodeBranchForRunLoop: vi.fn(),
  isHarnessSelectionEnabled: vi.fn(),
  getPreferredHarness: vi.fn(),
  computeTargetsFindById: vi.fn(),
  loopsCreate: vi.fn(),
  launchLoop: vi.fn(),
}));

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: (...args: unknown[]) =>
    mockState.isFeatureFlagEnabledForDistinctId(...args),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockState.authContext, request, context?.params),
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/identifier-utils")>();
  return {
    ...original,
    resolveDocumentId: mockState.resolveDocumentId,
  };
});

vi.mock("@/app/documents/generation-service", () => ({
  documentGenerationService: {
    findWithRegenerationContext: mockState.findWithRegenerationContext,
  },
}));

vi.mock("@/lib/loops/explicit-compute-selection", () => ({
  buildMissingExplicitPreferenceResponse:
    mockState.buildMissingExplicitPreferenceResponse,
}));

vi.mock("@/lib/loops/harness-selection-feature", () => ({
  isHarnessSelectionEnabled: (...args: unknown[]) =>
    mockState.isHarnessSelectionEnabled(...args),
}));

vi.mock("@/lib/loops/loop-commands", () => ({
  getCommandHandler: vi.fn(() => ({ requiresParent: false })),
}));

vi.mock("@/app/documents/[id]/run-loop/run-loop-helpers", () => ({
  COMMAND_MAP: {
    plan: "PLAN",
    request_prd_changes: "REQUEST_PRD_CHANGES",
  },
  checkBackendMismatch: vi.fn(),
  resolveEvaluateCodeBranchForRunLoop:
    mockState.resolveEvaluateCodeBranchForRunLoop,
  resolveLoopContext: mockState.resolveLoopContext,
  resolveRunLoopComputeTarget: mockState.resolveRunLoopComputeTarget,
}));

vi.mock("@/app/documents/[id]/run-loop/signing", () => ({
  resolveEffectiveSignedRunLoopIntent:
    mockState.resolveEffectiveSignedRunLoopIntent,
}));

vi.mock("@/lib/loops/prompts", () => ({
  buildLoopPrompt: vi.fn(() => "prompt"),
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    create: mockState.loopsCreate,
  },
}));

vi.mock("@/lib/loops/loop-orchestrator", () => ({
  launchLoop: mockState.launchLoop,
}));

vi.mock("@/app/settings/compute-preference/compute-preference-service", () => ({
  computePreferenceService: {
    getPreferredHarness: (...args: unknown[]) =>
      mockState.getPreferredHarness(...args),
  },
}));

vi.mock("@/app/compute-targets/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/app/compute-targets/service")>();
  return {
    parseSelectedHarness: original.parseSelectedHarness,
    computeTargetsService: {
      findById: (...args: unknown[]) =>
        mockState.computeTargetsFindById(...args),
    },
  };
});

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { POST } from "@/app/documents/[id]/run-loop/route";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const documentId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";

function postRunLoop(command: string) {
  return POST(
    createMockRequest({
      method: "POST",
      url: `http://localhost:3002/documents/${documentId}/run-loop`,
      body: { command, computeTargetId: targetId },
    }),
    createMockRouteContext({ id: documentId })
  );
}

describe("POST /documents/[id]/run-loop request_prd_changes gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.authContext = createTestAuthContext({
      user: {
        ...createTestAuthContext().user,
        id: "user-1",
        organizationId: "org-1",
      },
    });
    mockState.resolveDocumentId.mockResolvedValue(documentId);
    mockState.findWithRegenerationContext.mockResolvedValue({
      id: documentId,
      workstreamId: null,
    });
    mockState.buildMissingExplicitPreferenceResponse.mockResolvedValue({
      response: null,
    });
    mockState.resolveRunLoopComputeTarget.mockResolvedValue({
      computeTargetId: targetId,
    });
    mockState.resolveEffectiveSignedRunLoopIntent.mockResolvedValue({
      ok: true,
      userIntentSignature: null,
    });
    mockState.resolveLoopContext.mockResolvedValue({
      additionalRepos: undefined,
      contextRefs: [],
      parentLoopComputeTargetId: targetId,
      parentLoopId: null,
      targetBranch: null,
      targetRepo: null,
    });
    mockState.resolveEvaluateCodeBranchForRunLoop.mockResolvedValue({
      ok: true,
      branch: null,
    });
    mockState.isHarnessSelectionEnabled.mockResolvedValue(false);
    mockState.computeTargetsFindById.mockResolvedValue({
      id: targetId,
      selectedHarness: null,
    });
    mockState.getPreferredHarness.mockResolvedValue(null);
    mockState.loopsCreate.mockResolvedValue({ loopId: "loop-1" });
    mockState.launchLoop.mockResolvedValue(undefined);
  });

  it("blocks request_prd_changes with 403 when the flag is off", async () => {
    mockState.isFeatureFlagEnabledForDistinctId.mockResolvedValue(false);

    const response = await postRunLoop(RunLoopCommand.RequestPrdChanges);

    expect(response.status).toBe(403);
    expect(mockState.loopsCreate).not.toHaveBeenCalled();
    expect(mockState.launchLoop).not.toHaveBeenCalled();
  });

  it("blocks request_prd_changes with 403 when the flag is unavailable (null)", async () => {
    mockState.isFeatureFlagEnabledForDistinctId.mockResolvedValue(null);

    const response = await postRunLoop(RunLoopCommand.RequestPrdChanges);

    expect(response.status).toBe(403);
    expect(mockState.loopsCreate).not.toHaveBeenCalled();
  });

  it("launches request_prd_changes when the flag is explicitly enabled", async () => {
    mockState.isFeatureFlagEnabledForDistinctId.mockResolvedValue(true);

    const response = await postRunLoop(RunLoopCommand.RequestPrdChanges);

    expect(response.status).toBe(200);
    expect(mockState.loopsCreate).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({ command: "REQUEST_PRD_CHANGES" })
    );
  });

  it("does not gate unrelated commands even when the flag is off", async () => {
    mockState.isFeatureFlagEnabledForDistinctId.mockResolvedValue(false);

    const response = await postRunLoop(RunLoopCommand.Plan);

    expect(response.status).toBe(200);
    expect(mockState.loopsCreate).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({ command: "PLAN" })
    );
  });
});
