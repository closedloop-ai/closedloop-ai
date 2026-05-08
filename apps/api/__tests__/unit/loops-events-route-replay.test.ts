import { vi } from "vitest";

vi.mock("@/lib/auth/loop-runner-jwt", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/loop-runner-jwt")
  >("@/lib/auth/loop-runner-jwt");
  return {
    ...actual,
    authenticateLoopRunner: vi.fn(),
  };
});

vi.mock("@/lib/loops/loop-orchestrator", () => ({
  handleLoopEvent: vi.fn(),
}));

vi.mock("@/lib/loops/loop-event-bus", () => ({
  loopEventBus: { publish: vi.fn() },
}));

vi.mock("@/app/loops/service", async () => {
  const actual = await vi.importActual<typeof import("@/app/loops/service")>(
    "@/app/loops/service"
  );
  return {
    ...actual,
    loopsService: {
      ...actual.loopsService,
      findById: vi.fn(),
    },
  };
});

import { LoopEventType, LoopStatus } from "@repo/api/src/types/loop";
import { POST } from "@/app/loops/[id]/events/route";
import { ReplayDetectedError } from "@/app/loops/loop-errors";
import { loopsService } from "@/app/loops/service";
import { authenticateLoopRunner } from "@/lib/auth/loop-runner-jwt";
import { handleLoopEvent } from "@/lib/loops/loop-orchestrator";

function makeAuthOk(
  loopId = "loop-123",
  status: LoopStatus = LoopStatus.Running
) {
  vi.mocked(authenticateLoopRunner).mockResolvedValue({
    ok: true,
    claims: {
      loopId,
      organizationId: "org-123",
      tokenId: "token-123",
    },
  });
  vi.mocked(loopsService.findById).mockResolvedValue({
    id: loopId,
    organizationId: "org-123",
    status,
  } as any);
  vi.mocked(handleLoopEvent).mockResolvedValue([]);
}

function makeErrorRequest(
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

describe("POST /api/loops/[id]/events replay handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 409 when replay is detected", async () => {
    vi.mocked(authenticateLoopRunner).mockResolvedValue({
      ok: true,
      claims: {
        loopId: "loop-123",
        organizationId: "org-123",
        tokenId: "token-123",
      },
    });

    vi.mocked(loopsService.findById).mockResolvedValue({
      id: "loop-123",
      organizationId: "org-123",
      status: "RUNNING",
    } as any);

    vi.mocked(handleLoopEvent).mockRejectedValue(new ReplayDetectedError());

    const request = new Request("http://localhost/api/loops/loop-123/events", {
      method: "POST",
      headers: {
        authorization: "Bearer runner-token",
        "x-loop-event-nonce": "11111111-1111-4111-8111-111111111111",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "started",
        timestamp: "2026-02-17T00:00:00.000Z",
      }),
    });

    const response = await POST(request, {
      params: Promise.resolve({ id: "loop-123" }),
    });

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Replay detected");
  });
});

describe("POST /api/loops/[id]/events — diagnostic fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts envelope format error event with valid diagnostics: returns 200", async () => {
    makeAuthOk();

    const request = makeErrorRequest({
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

    const request = makeErrorRequest({
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

    const request = makeErrorRequest({
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

    const request = makeErrorRequest({
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

    const request = makeErrorRequest({
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

    const request = makeErrorRequest({
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const supportEventBody = {
    type: LoopEventType.SupportBundleUploaded,
    keys: ["org-123/loops/loop-123/run-1/support/claude-output.jsonl"],
    timestamp: "2026-01-01T00:00:00.000Z",
  };

  it.each([
    LoopStatus.Failed,
    LoopStatus.TimedOut,
  ])("persists support bundle events after %s", async (status) => {
    makeAuthOk("loop-123", status);

    const response = await POST(makeErrorRequest(supportEventBody), {
      params: Promise.resolve({ id: "loop-123" }),
    });

    expect(response.status).toBe(200);
    expect(handleLoopEvent).toHaveBeenCalledWith(
      "loop-123",
      "org-123",
      expect.objectContaining({
        type: LoopEventType.SupportBundleUploaded,
        keys: supportEventBody.keys,
      }),
      expect.objectContaining({
        tokenJti: "token-123",
      })
    );
  });

  it.each([
    LoopStatus.Completed,
    LoopStatus.Cancelled,
  ])("ignores support bundle events after %s", async (status) => {
    makeAuthOk("loop-123", status);

    const response = await POST(makeErrorRequest(supportEventBody), {
      params: Promise.resolve({ id: "loop-123" }),
    });

    expect(response.status).toBe(200);
    expect(handleLoopEvent).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      success: true,
      data: { received: true, ignored: true },
    });
  });

  it("continues to ignore ordinary non-terminal events after terminal status", async () => {
    makeAuthOk("loop-123", LoopStatus.Failed);

    const response = await POST(
      makeErrorRequest({
        type: LoopEventType.Output,
        chunk: "late output",
      }),
      { params: Promise.resolve({ id: "loop-123" }) }
    );

    expect(response.status).toBe(200);
    expect(handleLoopEvent).not.toHaveBeenCalled();
  });
});
