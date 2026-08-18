/**
 * `POST /documents/[id]/run-loop` is the route the web Generate/Execute flow
 * actually calls, and it sends `computeTargetId: null` for a Cloud run.
 *
 * `launchLoop` is dispatched fire-and-forget there, so the orchestrator's
 * `MissingAnthropicApiKeyError` lands long after the route has already answered
 * 200 with a `loopId` — a keyless Cloud user was told the command started and
 * then nothing ever ran. These tests pin the pre-flight that turns that into a
 * 400, and pin that a Local run is NOT subjected to it.
 *
 * `run-loop-helpers` is deliberately NOT mocked wholesale here: the real
 * `buildMissingAnthropicApiKeyResponse` runs, with only `apiKeyService` stubbed,
 * so this exercises the production decision rather than a stand-in.
 */
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import { MISSING_ANTHROPIC_API_KEY_MESSAGE } from "@/lib/loops/loop-dispatch-utils";

const mockState = vi.hoisted(() => ({
  authContext: undefined as AuthContext | undefined,
  resolveDocumentId: vi.fn(),
  findWithRegenerationContext: vi.fn(),
  buildMissingExplicitPreferenceResponse: vi.fn(),
  resolveComputeTargetForRoute: vi.fn(),
  resolveEffectiveSignedRunLoopIntent: vi.fn(),
  resolveEvaluateCodeBranchForRunLoop: vi.fn(),
  resolveApiKey: vi.fn(),
  loopsCreate: vi.fn(),
  launchLoop: vi.fn(),
  getPreferredHarness: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params?: unknown }) =>
      handler(mockState.authContext, request, context?.params),
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/identifier-utils")>();
  return { ...original, resolveDocumentId: mockState.resolveDocumentId };
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
  isHarnessSelectionEnabled: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@/lib/loops/loop-commands", () => ({
  getCommandHandler: vi.fn(() => ({ requiresParent: false })),
}));

// Only the outbound edges of the REAL run-loop-helpers module are stubbed.
vi.mock("@/lib/loops/compute-target-route-helpers", () => ({
  resolveComputeTargetForRoute: mockState.resolveComputeTargetForRoute,
}));

// Partial mock on purpose: `buildMissingAnthropicApiKeyResponse` and
// `resolveRunLoopComputeTarget` stay REAL so the gate under test is the
// production one; only the unrelated downstream context/branch resolution is
// stubbed so a Local run can reach a 200 without a database.
vi.mock(
  "@/app/documents/[id]/run-loop/run-loop-helpers",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/app/documents/[id]/run-loop/run-loop-helpers")
      >();
    return {
      ...original,
      checkBackendMismatch: vi.fn(() => Promise.resolve(null)),
      resolveLoopContext: vi.fn(() =>
        Promise.resolve({
          additionalRepos: undefined,
          contextRefs: [],
          parentLoopComputeTargetId: null,
          parentLoopId: null,
          targetBranch: null,
          targetRepo: null,
          workstream: null,
        })
      ),
      resolveEvaluateCodeBranchForRunLoop:
        mockState.resolveEvaluateCodeBranchForRunLoop,
    };
  }
);

vi.mock("@/app/compute-targets/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/app/compute-targets/service")>();
  return {
    parseSelectedHarness: original.parseSelectedHarness,
    computeTargetsService: {
      findById: vi.fn(() =>
        Promise.resolve({ id: "22222222-2222-4222-8222-222222222222" })
      ),
    },
  };
});

vi.mock("@/app/settings/api-key-service", () => ({
  apiKeyService: { resolveApiKey: mockState.resolveApiKey },
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
    findLatestCompletedForArtifact: vi.fn(() => Promise.resolve(null)),
  },
}));

vi.mock("@/lib/loops/loop-orchestrator", () => ({
  launchLoop: mockState.launchLoop,
}));

vi.mock("@/app/settings/compute-preference/compute-preference-service", () => ({
  computePreferenceService: {
    getPreferredHarness: mockState.getPreferredHarness,
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

import { POST } from "@/app/documents/[id]/run-loop/route";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const documentId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";

function runLoop(computeTargetId: string | null) {
  return POST(
    createMockRequest({
      method: "POST",
      url: `http://localhost:3002/documents/${documentId}/run-loop`,
      body: { command: RunLoopCommand.Plan, computeTargetId },
    }),
    createMockRouteContext({ id: documentId })
  );
}

describe("POST /documents/[id]/run-loop missing Anthropic API key", () => {
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
    mockState.resolveComputeTargetForRoute.mockResolvedValue({
      computeTargetId: targetId,
    });
    mockState.resolveEffectiveSignedRunLoopIntent.mockResolvedValue({
      ok: true,
      userIntentSignature: null,
    });
    mockState.resolveEvaluateCodeBranchForRunLoop.mockResolvedValue({
      ok: true,
      branch: null,
    });
    mockState.loopsCreate.mockResolvedValue({ loopId: "loop-1" });
    mockState.launchLoop.mockResolvedValue(undefined);
    mockState.getPreferredHarness.mockResolvedValue(null);
    mockState.resolveApiKey.mockResolvedValue("sk-ant-test");
  });

  it("answers 400 instead of a fail-open 200 when a Cloud run has no key", async () => {
    mockState.resolveApiKey.mockResolvedValue(null);

    // `null` is what the web Generate/Execute flow sends for a Cloud run.
    const response = await runLoop(null);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe(MISSING_ANTHROPIC_API_KEY_MESSAGE);
    expect(mockState.resolveApiKey).toHaveBeenCalledWith("user-1", "org-1");
    // No orphan Loop row, and nothing dispatched: the launch never happens, so
    // reporting a started command would have been a lie.
    expect(mockState.loopsCreate).not.toHaveBeenCalled();
    expect(mockState.launchLoop).not.toHaveBeenCalled();
  });

  it("dispatches the Cloud run when a key resolves", async () => {
    const response = await runLoop(null);

    expect(response.status).toBe(200);
    expect(mockState.loopsCreate).toHaveBeenCalledTimes(1);
  });

  it("never blocks a Local run, which resolves its key on the desktop", async () => {
    // Same keyless org as the blocking case above, so a green assertion here
    // proves the Cloud/Local split — not the key mock — decides.
    mockState.resolveApiKey.mockResolvedValue(null);

    const response = await runLoop(targetId);

    expect(response.status).toBe(200);
    expect(mockState.resolveApiKey).not.toHaveBeenCalled();
    expect(mockState.loopsCreate).toHaveBeenCalledTimes(1);
  });
});
