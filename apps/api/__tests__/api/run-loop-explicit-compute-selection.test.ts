import { RunLoopCommand } from "@repo/api/src/types/loop";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";

const mockState = vi.hoisted(() => ({
  authContext: undefined as AuthContext | undefined,
  resolveDocumentId: vi.fn(),
  findWithRegenerationContext: vi.fn(),
  buildMissingExplicitPreferenceResponse: vi.fn(),
  resolveRunLoopComputeTarget: vi.fn(),
  resolveEffectiveSignedRunLoopIntent: vi.fn(),
  resolveLoopContext: vi.fn(),
  resolveEvaluateCodeBranchForRunLoop: vi.fn(),
  computeTargetsFindById: vi.fn(),
  getPreferredHarness: vi.fn(),
  loopsCreate: vi.fn(),
  launchLoop: vi.fn(),
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

vi.mock("@/lib/loops/loop-commands", () => ({
  getCommandHandler: vi.fn(() => ({ requiresParent: false })),
}));

vi.mock("@/lib/loops/harness-selection-feature", () => ({
  isHarnessSelectionEnabled: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/app/documents/[id]/run-loop/run-loop-helpers", () => ({
  COMMAND_MAP: { plan: "PLAN" },
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

vi.mock("@/app/settings/compute-preference/compute-preference-service", () => ({
  computePreferenceService: {
    getPreferredHarness: (...args: unknown[]) =>
      mockState.getPreferredHarness(...args),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { conflictBody } from "@repo/api/src/types/common";
import {
  ComputePreferenceRequiredError,
  ComputePreferenceRequiredMessage,
} from "@repo/api/src/types/compute-target";
import { POST } from "@/app/documents/[id]/run-loop/route";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const documentId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";

describe("POST /documents/[id]/run-loop explicit compute selection", () => {
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
      computeTargetId: undefined,
    });
    mockState.resolveEffectiveSignedRunLoopIntent.mockResolvedValue({
      ok: true,
      userIntentSignature: null,
    });
    mockState.resolveLoopContext.mockResolvedValue({
      additionalRepos: undefined,
      contextRefs: [],
      parentLoopComputeTargetId: null,
      parentLoopId: null,
      targetBranch: null,
      targetRepo: null,
      workstream: null,
    });
    mockState.resolveEvaluateCodeBranchForRunLoop.mockResolvedValue({
      ok: true,
      branch: null,
    });
    mockState.computeTargetsFindById.mockResolvedValue(null);
    mockState.getPreferredHarness.mockResolvedValue(null);
    mockState.loopsCreate.mockResolvedValue({ loopId: "loop-1" });
    mockState.launchLoop.mockResolvedValue(undefined);
  });

  it("returns a typed 409 before compute resolution or signing when flagged and preference is missing", async () => {
    mockState.buildMissingExplicitPreferenceResponse.mockResolvedValueOnce({
      response: Response.json(
        conflictBody(ComputePreferenceRequiredMessage, {
          error: ComputePreferenceRequiredError,
          message: ComputePreferenceRequiredMessage,
        }),
        { status: 409 }
      ),
    });

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: `http://localhost:3002/documents/${documentId}/run-loop`,
        body: { command: RunLoopCommand.Plan },
      }),
      createMockRouteContext({ id: documentId })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: ComputePreferenceRequiredMessage,
      data: {
        error: ComputePreferenceRequiredError,
        message: ComputePreferenceRequiredMessage,
      },
    });
    expect(mockState.resolveRunLoopComputeTarget).not.toHaveBeenCalled();
    expect(
      mockState.resolveEffectiveSignedRunLoopIntent
    ).not.toHaveBeenCalled();
    expect(mockState.loopsCreate).not.toHaveBeenCalled();
    expect(mockState.launchLoop).not.toHaveBeenCalled();
  });

  it("allows an explicit Cloud null override even when no persisted preference exists", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: `http://localhost:3002/documents/${documentId}/run-loop`,
        body: { command: RunLoopCommand.Plan, computeTargetId: null },
      }),
      createMockRouteContext({ id: documentId })
    );

    expect(response.status).toBe(200);
    expect(
      mockState.buildMissingExplicitPreferenceResponse
    ).toHaveBeenCalledWith({
      clerkUserId: mockState.authContext?.user.clerkId,
      computeTargetId: null,
      userId: "user-1",
    });
    expect(mockState.resolveRunLoopComputeTarget).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      null,
      undefined
    );
    expect(mockState.resolveEffectiveSignedRunLoopIntent).toHaveBeenCalled();
    expect(mockState.loopsCreate).toHaveBeenCalled();
  });

  it("preserves flag-disabled compatibility for omitted target requests without an explicit preference", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: `http://localhost:3002/documents/${documentId}/run-loop`,
        body: { command: RunLoopCommand.Plan },
      }),
      createMockRouteContext({ id: documentId })
    );

    expect(response.status).toBe(200);
    expect(mockState.resolveRunLoopComputeTarget).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      undefined,
      undefined
    );
    expect(mockState.resolveEffectiveSignedRunLoopIntent).toHaveBeenCalled();
    expect(mockState.loopsCreate).toHaveBeenCalled();
  });

  it("allows omitted target requests when a persisted explicit Cloud preference exists", async () => {
    const userComputePreferences = {
      preferredComputeMode: "cloud",
      preferredComputeTargetId: undefined,
    };
    mockState.buildMissingExplicitPreferenceResponse.mockResolvedValueOnce({
      response: null,
      userComputePreferences,
    });

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: `http://localhost:3002/documents/${documentId}/run-loop`,
        body: { command: RunLoopCommand.Plan },
      }),
      createMockRouteContext({ id: documentId })
    );

    expect(response.status).toBe(200);
    expect(mockState.resolveRunLoopComputeTarget).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      undefined,
      userComputePreferences
    );
    expect(mockState.resolveEffectiveSignedRunLoopIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        computeTargetId: undefined,
        documentId,
      })
    );
    expect(mockState.loopsCreate).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({ computeTargetId: undefined })
    );
  });

  it("allows omitted target requests when a persisted explicit Local preference exists", async () => {
    const userComputePreferences = {
      preferredComputeMode: "local",
      preferredComputeTargetId: targetId,
    };
    mockState.buildMissingExplicitPreferenceResponse.mockResolvedValueOnce({
      response: null,
      userComputePreferences,
    });
    mockState.resolveRunLoopComputeTarget.mockResolvedValue({
      computeTargetId: targetId,
    });
    mockState.resolveLoopContext.mockResolvedValue({
      additionalRepos: undefined,
      contextRefs: [],
      parentLoopComputeTargetId: targetId,
      parentLoopId: null,
      targetBranch: null,
      targetRepo: null,
      workstream: null,
    });

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: `http://localhost:3002/documents/${documentId}/run-loop`,
        body: { command: RunLoopCommand.Plan },
      }),
      createMockRouteContext({ id: documentId })
    );

    expect(response.status).toBe(200);
    expect(mockState.resolveRunLoopComputeTarget).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      undefined,
      userComputePreferences
    );
    expect(mockState.resolveEffectiveSignedRunLoopIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        computeTargetId: targetId,
        documentId,
      })
    );
    expect(mockState.loopsCreate).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({ computeTargetId: targetId })
    );
  });

  it("treats a string compute target override as an action-scoped explicit target", async () => {
    mockState.resolveRunLoopComputeTarget.mockResolvedValue({
      computeTargetId: targetId,
    });

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: `http://localhost:3002/documents/${documentId}/run-loop`,
        body: { command: RunLoopCommand.Plan, computeTargetId: targetId },
      }),
      createMockRouteContext({ id: documentId })
    );

    expect(response.status).toBe(200);
    expect(
      mockState.buildMissingExplicitPreferenceResponse
    ).toHaveBeenCalledWith({
      clerkUserId: mockState.authContext?.user.clerkId,
      computeTargetId: targetId,
      userId: "user-1",
    });
    expect(mockState.resolveRunLoopComputeTarget).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      targetId,
      undefined
    );
    expect(mockState.resolveEffectiveSignedRunLoopIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        computeTargetId: targetId,
        documentId,
      })
    );
    expect(mockState.loopsCreate).toHaveBeenCalled();
  });
});
