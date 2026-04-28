/**
 * Tests for dispatchRelayOperation delivery-failure handling.
 *
 * The key invariant: a relay 200 response with { delivered: false } must be
 * treated as a launch failure when throwOnFailure=true (e.g. launchLoopOnDesktop).
 * The fire-and-forget kill path (throwOnFailure=false / default) must NOT throw.
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

import { DocumentType } from "@repo/api/src/types/document";
import { LoopCommand } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toRelayOperation } from "@/app/compute-targets/relay-command-helpers";
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
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Enable the fetch path by providing relay env vars.
    process.env.RELAY_API_URL = "http://relay.test";
    process.env.INTERNAL_API_SECRET = "secret";
  });

  afterEach(() => {
    // Restore env so other tests are unaffected.
    process.env.RELAY_API_URL = originalEnv.RELAY_API_URL;
    process.env.INTERNAL_API_SECRET = originalEnv.INTERNAL_API_SECRET;
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

  it("passes undefined to relay payload body when contextPack.attachments is absent", async () => {
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
    expect(
      (dispatchedInput as { body: Record<string, unknown> }).body.attachments
    ).toBeUndefined();
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
});

describe("DispatchError", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RELAY_API_URL = "http://relay.test";
    process.env.INTERNAL_API_SECRET = "secret";
  });

  afterEach(() => {
    process.env.RELAY_API_URL = originalEnv.RELAY_API_URL;
    process.env.INTERNAL_API_SECRET = originalEnv.INTERNAL_API_SECRET;
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
