/**
 * Tests for primaryArtifactId plumbing in launchLoopOnDesktop.
 *
 * AC-002: When a loop has a documentId, the desktop dispatch body must include
 * primaryArtifactId === documentId. When documentId is absent, the field must
 * not appear in the body at all.
 *
 * The assertion is framed as "field mirrors documentId" — it is a single
 * mapping concern, not a per-command bug, but the suite covers one case per
 * EVALUATE_* variant to satisfy the acceptance criterion.
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---

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
  },
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

import { LoopCommand } from "@repo/api/src/types/loop";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toRelayOperation } from "@/app/compute-targets/relay-command-helpers";
import { launchLoopOnDesktop } from "@/lib/loops/loop-desktop";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_LAUNCH_OPTS = {
  loopId: "loop-1",
  organizationId: "org-1",
  computeTargetId: "ct-1",
  closedLoopAuthToken: "tok",
  apiBaseUrl: "https://api.example.com",
  contextPack: {
    command: LoopCommand.Plan,
    artifacts: [],
    prompt: undefined,
    repoInfo: undefined,
    committer: undefined,
  },
};

/** Create a minimal mock Response object accepted by dispatchRelayOperation. */
function mockDelivered(): ReturnType<typeof global.fetch> {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ delivered: true })),
    json: () => Promise.resolve({ delivered: true }),
  } as Response);
}

/** Extract the body passed to the mocked toRelayOperation call. */
function getCapturedBody(): Record<string, unknown> {
  const toRelayOperationMock = vi.mocked(toRelayOperation);
  const [, dispatchedInput] = toRelayOperationMock.mock.calls[0];
  return (dispatchedInput as { body: Record<string, unknown> }).body;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("launchLoopOnDesktop — primaryArtifactId plumbing (AC-002)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Enable the relay fetch path.
    vi.stubEnv("RELAY_API_URL", "http://relay.test");
    vi.stubEnv("INTERNAL_API_SECRET", "secret");
    vi.spyOn(globalThis, "fetch").mockReturnValue(mockDelivered());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // -------------------------------------------------------------------------
  // With documentId present — primaryArtifactId must mirror it
  // -------------------------------------------------------------------------

  it("includes primaryArtifactId equal to documentId for EVALUATE_FEATURE", async () => {
    const documentId = "doc-evaluate-feature-1";

    await launchLoopOnDesktop({
      ...BASE_LAUNCH_OPTS,
      command: LoopCommand.EvaluateFeature,
      documentId,
    });

    const body = getCapturedBody();
    expect(body.primaryArtifactId).toBe(documentId);
  });

  it("includes primaryArtifactId equal to documentId for EVALUATE_PRD", async () => {
    const documentId = "doc-evaluate-prd-1";

    await launchLoopOnDesktop({
      ...BASE_LAUNCH_OPTS,
      command: LoopCommand.EvaluatePrd,
      documentId,
    });

    const body = getCapturedBody();
    expect(body.primaryArtifactId).toBe(documentId);
  });

  it("includes primaryArtifactId equal to documentId for EVALUATE_PLAN", async () => {
    const documentId = "doc-evaluate-plan-1";

    await launchLoopOnDesktop({
      ...BASE_LAUNCH_OPTS,
      command: LoopCommand.EvaluatePlan,
      documentId,
    });

    const body = getCapturedBody();
    expect(body.primaryArtifactId).toBe(documentId);
  });

  it("includes primaryArtifactId equal to documentId for EVALUATE_CODE", async () => {
    const documentId = "doc-evaluate-code-1";

    await launchLoopOnDesktop({
      ...BASE_LAUNCH_OPTS,
      command: LoopCommand.EvaluateCode,
      documentId,
    });

    const body = getCapturedBody();
    expect(body.primaryArtifactId).toBe(documentId);
  });

  // -------------------------------------------------------------------------
  // Without documentId — primaryArtifactId must be absent from the body
  // -------------------------------------------------------------------------

  it("omits primaryArtifactId from the body when documentId is not provided", async () => {
    await launchLoopOnDesktop({
      ...BASE_LAUNCH_OPTS,
      command: LoopCommand.EvaluateFeature,
      // documentId intentionally omitted
    });

    const body = getCapturedBody();
    expect("primaryArtifactId" in body).toBe(false);
  });

  it("omits primaryArtifactId from the body when documentId is explicitly undefined", async () => {
    await launchLoopOnDesktop({
      ...BASE_LAUNCH_OPTS,
      command: LoopCommand.EvaluatePlan,
      documentId: undefined,
    });

    const body = getCapturedBody();
    expect("primaryArtifactId" in body).toBe(false);
  });
});
