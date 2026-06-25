import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/loop-runner-jwt", () => ({
  authenticateLoopRunnerRequest: vi.fn(),
}));

vi.mock("@/lib/loops/loop-orchestrator", () => ({
  handleLoopEvent: vi.fn(),
}));

vi.mock("@/lib/loops/loop-event-bus", () => ({
  loopEventBus: { publish: vi.fn() },
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    ingestRunnerEvent: vi.fn(),
  },
  scheduleRunnerHeartbeatBump: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

import { LoopEventType } from "@repo/api/src/types/loop";
import { POST } from "@/app/loops/[id]/events/route";
import { ReplayDetectedError } from "@/app/loops/loop-errors";
import { IngestRunnerEventErrorCode } from "@/app/loops/loop-ingest-types";
import { loopsService } from "@/app/loops/service";
import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";
import { handleLoopEvent } from "@/lib/loops/loop-orchestrator";

function makeAuthOk(loopId = "loop-123") {
  vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue({
    loopId,
    organizationId: "org-123",
    tokenId: "token-123",
  });
  vi.mocked(loopsService.ingestRunnerEvent).mockResolvedValue({
    ok: true,
    outcome: "inserted",
  });
  vi.mocked(handleLoopEvent).mockResolvedValue([]);
}

function makeRequest(
  body: Record<string, unknown>,
  loopId = "loop-123"
): Request {
  return new Request(`http://localhost/api/loops/${loopId}/events`, {
    method: "POST",
    headers: {
      authorization: "Bearer runner-token",
      "x-loop-event-nonce": "11111111-1111-4111-8111-111111111111",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/loops/[id]/events — ingestRunnerEvent status mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue({
      loopId: "loop-123",
      organizationId: "org-123",
      tokenId: "token-123",
    });
    vi.mocked(handleLoopEvent).mockResolvedValue([]);
  });

  it.each([
    {
      label: "replay",
      mockResult: {
        ok: false,
        code: IngestRunnerEventErrorCode.Replay,
      } as const,
      expectedHttp: 409,
      expectedJson: { success: false, error: "Replay detected" },
    },
    {
      label: "loop-not-found",
      mockResult: {
        ok: false,
        code: IngestRunnerEventErrorCode.LoopNotFound,
      } as const,
      expectedHttp: 403,
      expectedJson: {
        success: false,
        error: "Forbidden",
        code: "loop_not_found",
      },
    },
    {
      label: "ignored",
      mockResult: {
        ok: true,
        outcome: "ignored",
      } as const,
      expectedHttp: 200,
      expectedJson: {
        success: true,
        data: { received: true, ignored: true },
      },
    },
  ])("maps ingestRunnerEvent $label to HTTP $expectedHttp", async ({
    mockResult,
    expectedHttp,
    expectedJson,
  }) => {
    vi.mocked(loopsService.ingestRunnerEvent).mockResolvedValue(mockResult);

    const response = await POST(
      makeRequest({
        type: "started",
        timestamp: "2026-02-17T00:00:00.000Z",
      }),
      { params: Promise.resolve({ id: "loop-123" }) }
    );

    expect(response.status).toBe(expectedHttp);
    expect(await response.json()).toMatchObject(expectedJson);
    expect(handleLoopEvent).not.toHaveBeenCalled();
  });

  it("maps an orchestrator replay race to HTTP 409", async () => {
    vi.mocked(loopsService.ingestRunnerEvent).mockResolvedValue({
      ok: true,
      outcome: "inserted",
    });
    vi.mocked(handleLoopEvent).mockRejectedValue(new ReplayDetectedError());

    const response = await POST(
      makeRequest({
        type: "output",
        chunk: "duplicate output",
        timestamp: "2026-02-17T00:00:00.000Z",
      }),
      { params: Promise.resolve({ id: "loop-123" }) }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "Replay detected",
    });
  });
});

describe("POST /api/loops/[id]/events — diagnostic fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts envelope format error event with valid diagnostics: returns 200", async () => {
    makeAuthOk();

    const request = makeRequest({
      type: "error",
      data: {
        code: "SOME_ERROR",
        message: "Something went wrong",
        timestamp: "2026-01-01T00:00:00.000Z",
        logTail: "last log lines",
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        diagnosticsVersion: "1.0.0",
      },
    });

    const response = await POST(request, {
      params: Promise.resolve({ id: "loop-123" }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
  });

  it("accepts flattened format error event with valid diagnostics: returns 200", async () => {
    makeAuthOk();

    const request = makeRequest({
      type: "error",
      code: "SOME_ERROR",
      message: "Something went wrong",
      timestamp: "2026-01-01T00:00:00.000Z",
      logTail: "last log lines",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      diagnosticsVersion: "1.0.0",
    });

    const response = await POST(request, {
      params: Promise.resolve({ id: "loop-123" }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
  });

  it("rejects error event missing timestamp: returns 400", async () => {
    makeAuthOk();

    const request = makeRequest({
      type: "error",
      code: "SOME_ERROR",
      message: "Something went wrong",
      // no timestamp
    });

    const response = await POST(request, {
      params: Promise.resolve({ id: "loop-123" }),
    });

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("rejects error event with malformed tokenUsage: returns 400", async () => {
    makeAuthOk();

    const request = makeRequest({
      type: "error",
      code: "SOME_ERROR",
      message: "Something went wrong",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenUsage: { inputTokens: "not-a-number", outputTokens: 5 },
    });

    const response = await POST(request, {
      params: Promise.resolve({ id: "loop-123" }),
    });

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("accepts error event without any diagnostic fields: returns 200", async () => {
    makeAuthOk();

    const request = makeRequest({
      type: "error",
      code: "SOME_ERROR",
      message: "Something went wrong",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const response = await POST(request, {
      params: Promise.resolve({ id: "loop-123" }),
    });

    expect(response.status).toBe(200);
  });

  it("accepts error event with tokenUsage including cache fields: returns 200", async () => {
    makeAuthOk();

    const request = makeRequest({
      type: "error",
      code: "TIMED_OUT",
      message: "Loop exceeded time limit",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 2000,
        cacheReadInputTokens: 800,
      },
    });

    const response = await POST(request, {
      params: Promise.resolve({ id: "loop-123" }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
  });
});

describe("POST /api/loops/[id]/events — post-terminal support bundle metadata", () => {
  const supportEventBody = {
    type: LoopEventType.SupportBundleUploaded,
    keys: ["org-123/loops/loop-123/run-1/support/claude-output.jsonl"],
    timestamp: "2026-01-01T00:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue({
      loopId: "loop-123",
      organizationId: "org-123",
      tokenId: "token-123",
    });
    vi.mocked(handleLoopEvent).mockResolvedValue([]);
  });

  it.each([
    {
      outcome: "inserted" as const,
      expectsOrchestrator: true,
    },
    {
      outcome: "ignored" as const,
      expectsOrchestrator: false,
    },
  ])("$outcome: handleLoopEvent called=$expectsOrchestrator for support bundle events", async ({
    outcome,
    expectsOrchestrator,
  }) => {
    vi.mocked(loopsService.ingestRunnerEvent).mockResolvedValue({
      ok: true,
      outcome,
    });

    const response = await POST(makeRequest(supportEventBody), {
      params: Promise.resolve({ id: "loop-123" }),
    });

    expect(response.status).toBe(200);
    if (expectsOrchestrator) {
      expect(handleLoopEvent).toHaveBeenCalledWith(
        "loop-123",
        "org-123",
        expect.objectContaining({
          type: LoopEventType.SupportBundleUploaded,
          keys: supportEventBody.keys,
        }),
        expect.objectContaining({ tokenJti: "token-123" })
      );
    } else {
      expect(handleLoopEvent).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({
        success: true,
        data: { received: true, ignored: true },
      });
    }
  });
});
