import { HarnessType } from "@repo/api/src/types/compute-target";
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
  isHarnessSelectionEnabled: vi.fn(),
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

vi.mock("@/lib/loops/harness-selection-feature", () => ({
  isHarnessSelectionEnabled: (...args: unknown[]) =>
    mockState.isHarnessSelectionEnabled(...args),
}));

vi.mock("@/lib/loops/loop-commands", () => ({
  getCommandHandler: vi.fn(() => ({ requiresParent: false })),
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

vi.mock("@/app/settings/compute-preference/compute-preference-service", () => ({
  computePreferenceService: {
    getPreferredHarness: (...args: unknown[]) =>
      mockState.getPreferredHarness(...args),
  },
}));

// Use the real parseSelectedHarness so the default-coercion contract
// (parseSelectedHarness(null) === HarnessType.Claude) is exercised, not mocked.
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

type HarnessGateCase = {
  name: string;
  // Resolved value of the server-side harness-selection flag check. `throws`
  // simulates the fail-closed path where flag evaluation itself rejects — but
  // the helper already swallows that and returns false, so we model the
  // helper's documented contract (false) here and assert the same coercion.
  flagEnabled: boolean;
  persistedHarness: HarnessType;
  expectedHarness: HarnessType;
};

const harnessGateCases: HarnessGateCase[] = [
  {
    name: "flag OFF coerces a persisted Codex harness to the default Claude",
    flagEnabled: false,
    persistedHarness: HarnessType.Codex,
    expectedHarness: HarnessType.Claude,
  },
  {
    name: "flag ON preserves the persisted Codex harness",
    flagEnabled: true,
    persistedHarness: HarnessType.Codex,
    expectedHarness: HarnessType.Codex,
  },
  {
    name: "flag OFF leaves a persisted Claude harness as Claude",
    flagEnabled: false,
    persistedHarness: HarnessType.Claude,
    expectedHarness: HarnessType.Claude,
  },
];

describe("POST /documents/[id]/run-loop harness selection rollback", () => {
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
      workstream: null,
    });
    mockState.resolveEvaluateCodeBranchForRunLoop.mockResolvedValue({
      ok: true,
      branch: null,
    });
    mockState.loopsCreate.mockResolvedValue({ loopId: "loop-1" });
    mockState.launchLoop.mockResolvedValue(undefined);
    mockState.getPreferredHarness.mockResolvedValue(null);
  });

  it.each(harnessGateCases)("$name", async ({
    flagEnabled,
    persistedHarness,
    expectedHarness,
  }) => {
    mockState.isHarnessSelectionEnabled.mockResolvedValue(flagEnabled);
    mockState.computeTargetsFindById.mockResolvedValue({
      id: targetId,
      selectedHarness: persistedHarness,
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
    expect(mockState.isHarnessSelectionEnabled).toHaveBeenCalledWith({
      clerkUserId: mockState.authContext?.user.clerkId,
      userId: "user-1",
    });
    expect(mockState.loopsCreate).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({ harness: expectedHarness })
    );
  });

  it("fails closed to the default harness when the flag helper reports false (unavailable/disabled)", async () => {
    // The helper itself swallows evaluation errors and returns false; the route
    // must coerce to the default harness in that fail-closed state.
    mockState.isHarnessSelectionEnabled.mockResolvedValue(false);
    mockState.computeTargetsFindById.mockResolvedValue({
      id: targetId,
      selectedHarness: HarnessType.Codex,
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
    expect(mockState.loopsCreate).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({ harness: HarnessType.Claude })
    );
  });

  type CloudHarnessCase = {
    name: string;
    flagEnabled: boolean;
    preferredHarness: HarnessType | null;
    expectedHarness: HarnessType;
  };

  const cloudHarnessCases: CloudHarnessCase[] = [
    {
      name: "Cloud with persisted Codex + flag ON launches Codex",
      flagEnabled: true,
      preferredHarness: HarnessType.Codex,
      expectedHarness: HarnessType.Codex,
    },
    {
      name: "Cloud with persisted Codex + flag OFF coerces to Claude",
      flagEnabled: false,
      preferredHarness: HarnessType.Codex,
      expectedHarness: HarnessType.Claude,
    },
    {
      name: "Cloud with unset preferred harness defaults to Claude",
      flagEnabled: true,
      preferredHarness: null,
      expectedHarness: HarnessType.Claude,
    },
  ];

  it.each(cloudHarnessCases)("$name", async ({
    flagEnabled,
    preferredHarness,
    expectedHarness,
  }) => {
    // Cloud launch: no compute target resolves (cloud_resolved).
    mockState.resolveRunLoopComputeTarget.mockResolvedValue({
      computeTargetId: undefined,
    });
    mockState.isHarnessSelectionEnabled.mockResolvedValue(flagEnabled);
    mockState.getPreferredHarness.mockResolvedValue(preferredHarness);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: `http://localhost:3002/documents/${documentId}/run-loop`,
        body: { command: RunLoopCommand.Plan, computeTargetId: null },
      }),
      createMockRouteContext({ id: documentId })
    );

    expect(response.status).toBe(200);
    // Cloud never reads a compute target row.
    expect(mockState.computeTargetsFindById).not.toHaveBeenCalled();
    expect(mockState.getPreferredHarness).toHaveBeenCalledWith(
      "user-1",
      "org-1"
    );
    expect(mockState.loopsCreate).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({ harness: expectedHarness })
    );
  });
});
