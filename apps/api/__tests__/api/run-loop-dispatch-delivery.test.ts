/**
 * ISS-5708 — `POST /documents/[id]/run-loop` is the route the web Generate PRD
 * and Generate Implementation Plan flows call, and it used to dispatch
 * `launchLoop` fire-and-forget: the route answered 200 with a `loopId` and only
 * logged when the dispatch subsequently threw.
 *
 * The browser treats a `{ loopId, status }` body as `launched` and navigates,
 * so every post-acceptance dispatch failure (desktop offline, relay callback
 * unreachable, context-pack build failure) rendered as a silent no-op ending on
 * a blank artifact. ISS-5687's lane proved the client already toasts every
 * unrecognized failure, so the missing signal was never a swallowed error — the
 * route was reporting success it had not earned.
 *
 * `launchPlanLoop` (`/plans/start-loop-from-local`) already awaits its dispatch
 * for exactly this reason. These tests pin the same contract on the web route,
 * and pin that an unknown/older dispatch reason still degrades to the generic
 * `launch_failed` copy rather than crashing the route.
 *
 * `run-loop-helpers` is deliberately NOT mocked wholesale: only its outbound
 * edges are stubbed, so the production route decision runs.
 */
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import { LaunchNotDispatchedError } from "@/lib/loops/launch-not-dispatched-error";
import { DispatchError } from "@/lib/loops/loop-desktop";
import {
  CALLBACK_UNAVAILABLE_DISPATCH_MESSAGE,
  LAUNCH_FAILED_CLOUD_DISPATCH_MESSAGE,
  LAUNCH_FAILED_DISPATCH_MESSAGE,
  PARENT_STATE_UNAVAILABLE_DISPATCH_MESSAGE,
} from "@/lib/loops/loop-dispatch-utils";

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

vi.mock("@/lib/loops/compute-target-route-helpers", () => ({
  resolveComputeTargetForRoute: mockState.resolveComputeTargetForRoute,
}));

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

import { maxDuration, POST } from "@/app/documents/[id]/run-loop/route";
import {
  LAUNCH_REQUEST_BUDGET_SECONDS,
  STALE_PENDING_THRESHOLD_MS,
} from "@/lib/loops/launch-budget";
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

/**
 * The real relay failure the orchestrator throws. `isDispatchError` is an
 * `instanceof` check, so a structural look-alike would classify as a plain
 * error and quietly prove nothing about the callback branch.
 */
function dispatchError(dispatchReason: string): DispatchError {
  return new DispatchError("dispatch failed", "command-1", dispatchReason);
}

describe("run-loop request budget vs stale-pending reap threshold", () => {
  it("declares its ceiling as the shared launch budget", () => {
    // Next.js route-segment config must be a static literal, so the link
    // between this route's ceiling and the reap threshold derived from it
    // cannot be enforced by the type system. This is that enforcement.
    expect(maxDuration).toBe(LAUNCH_REQUEST_BUDGET_SECONDS);
  });

  it("never lets the reaper declare a loop stale inside that budget", () => {
    // The race: this route holds a row PENDING for as long as its dispatch
    // runs, and `reapStalePendingLoops` fires on every `loopsService.create`
    // for the same (artifactId, command). With a threshold under the budget, a
    // retry from a second tab marks the first launch FAILED mid-flight; when
    // that dispatch lands, `claimOrPersistRunning` cannot go FAILED → CLAIMED
    // and `cleanupOnLaunchFailure` tears down work the provider already took.
    expect(STALE_PENDING_THRESHOLD_MS).toBeGreaterThan(
      LAUNCH_REQUEST_BUDGET_SECONDS * 1000
    );
  });
});

describe("POST /documents/[id]/run-loop dispatch delivery (ISS-5708)", () => {
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

  it("does not report success when the dispatch dies after the loop is created", async () => {
    mockState.launchLoop.mockRejectedValue(new Error("desktop is offline"));

    const response = await runLoop(targetId);
    const json = await response.json();

    // The whole outage: the loop row exists, the dispatch threw, and the route
    // used to answer 200 with that loopId anyway — so the browser navigated to
    // an artifact nothing would ever write to.
    expect(mockState.loopsCreate).toHaveBeenCalledTimes(1);
    expect(mockState.launchLoop).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(502);
    expect(json.success).toBe(false);
    expect(json.error).toBe(LAUNCH_FAILED_DISPATCH_MESSAGE);
    expect(json.data).toBeUndefined();
  });

  it("logs the actionable failure with the route's own context", async () => {
    // Scoped to what this suite can actually prove. `launchLoop` is mocked
    // here, so this asserts the route-layer entry's *content* — the loopId, the
    // classified code and the documentId an operator pivots on — and nothing
    // about how many layers logged. The cross-layer count is a composition
    // property and is pinned in `loop-orchestrator-dispatch.test.ts`, where
    // both layers run for real; asserting it here would only have been
    // measuring the mock.
    mockState.launchLoop.mockRejectedValue(new Error("desktop is offline"));

    await runLoop(targetId);

    expect(log.error).toHaveBeenCalledWith(
      "[run-loop] Failed to launch loop",
      expect.objectContaining({
        computeTargetId: targetId,
        documentId,
        launchError: "launch_failed",
        loopId: "loop-1",
      })
    );
  });

  it("names the cloud callback when the desktop cannot reach it", async () => {
    mockState.launchLoop.mockRejectedValue(
      dispatchError("cloud_callback_unreachable")
    );

    const response = await runLoop(targetId);
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.error).toBe(CALLBACK_UNAVAILABLE_DISPATCH_MESSAGE);
  });

  it("degrades an unknown dispatch reason from an older desktop to launch_failed", async () => {
    // Version skew: a peer build can raise a reason this repo has never seen.
    // It must classify generically, not crash the route into a 500.
    mockState.launchLoop.mockRejectedValue(
      dispatchError("some_future_reason_this_build_does_not_know")
    );

    const response = await runLoop(targetId);
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.error).toBe(LAUNCH_FAILED_DISPATCH_MESSAGE);
  });

  it("does not blame the desktop app when a Cloud dispatch fails", async () => {
    // A loop with no computeTargetId is dispatched to ECS by `resolveProvider`,
    // so no desktop participates in the launch at all. An ECS or context-pack
    // failure still classifies as `launch_failed`, and the desktop-disconnected
    // copy would be both untrue and unactionable for that user.
    mockState.resolveComputeTargetForRoute.mockResolvedValue({
      computeTargetId: null,
    });
    mockState.launchLoop.mockRejectedValue(new Error("ecs RunTask failed"));

    const response = await runLoop(null);
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.success).toBe(false);
    expect(json.error).toBe(LAUNCH_FAILED_CLOUD_DISPATCH_MESSAGE);
    expect(json.error).not.toContain("desktop");
  });

  it("does not report success when the pre-dispatch guard refuses to dispatch", async () => {
    // The second door onto the same outage. `launchLoop`'s parent-state guard
    // marks the loop FAILED and hands the command to nobody — but it used to
    // *resolve*, which `dispatchAndClassify` reads as a delivered launch, so an
    // `execute` / `request_changes` run whose parent state was gone got the
    // same 200 + loopId as a real launch and the browser navigated to a loop
    // that was already dead. A launch that never dispatched must not answer 200.
    mockState.launchLoop.mockRejectedValue(
      new LaunchNotDispatchedError(
        "parent_state_unavailable",
        "Parent loop state is unavailable, cannot resume execution"
      )
    );

    const response = await runLoop(targetId);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toBe(PARENT_STATE_UNAVAILABLE_DISPATCH_MESSAGE);
    // Not the generic bucket: this run failed a precondition, it did not hit a
    // disconnected desktop, so neither desktop copy may be used here.
    expect(json.error).not.toBe(LAUNCH_FAILED_DISPATCH_MESSAGE);
    expect(json.error).not.toContain("desktop");
    expect(json.data).toBeUndefined();
  });

  it("still answers 200 with the loop when the dispatch is delivered", async () => {
    const response = await runLoop(targetId);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.loopId).toBe("loop-1");
  });

  it("awaits the dispatch before answering, so the answer reflects delivery", async () => {
    let settleLaunch: (() => void) | undefined;
    let answered = false;
    mockState.launchLoop.mockReturnValue(
      new Promise<void>((resolve) => {
        settleLaunch = resolve;
      })
    );

    const pending = runLoop(targetId).then((response) => {
      answered = true;
      return response;
    });

    // `setImmediate` fires only once the microtask queue is fully drained, and
    // every other await in this route is a resolved mock. A fire-and-forget
    // route would therefore have answered by now; only awaiting the dispatch
    // keeps it pending.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(answered).toBe(false);

    settleLaunch?.();
    const response = await pending;
    expect(response.status).toBe(200);
  });
});
