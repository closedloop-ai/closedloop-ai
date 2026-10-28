import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDispatchSocketEvent,
  mockScheduleLogFlush,
  mockValidateInternalSecret,
} = vi.hoisted(() => ({
  mockDispatchSocketEvent: vi.fn(),
  mockScheduleLogFlush: vi.fn(),
  mockValidateInternalSecret: vi.fn(),
}));

vi.mock("@/lib/internal-auth", () => ({
  validateInternalSecret: mockValidateInternalSecret,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(async () => undefined),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/lib/route-utils", async (importOriginal) => {
  // Partial mock: the route reads its body through the real capped reader, so
  // only the log flush is stubbed. Spreading the original keeps this mock from
  // going stale the next time the route reaches for another helper.
  const actual = await importOriginal<typeof import("@/lib/route-utils")>();
  return { ...actual, scheduleLogFlush: mockScheduleLogFlush };
});

vi.mock("../service", () => ({
  dispatchSocketEvent: mockDispatchSocketEvent,
  extractCorrelationContext: vi.fn(() => ({})),
}));

import { DESKTOP_GATEWAY_MAX_PAYLOAD_BYTES } from "@/lib/desktop-gateway-wire";
import { POST } from "../route";

function jsonRequest(body: string, secret?: string): Request {
  return new Request("http://localhost/internal/relay/socket-event", {
    body,
    headers: secret ? { "x-internal-secret": secret } : undefined,
    method: "POST",
  });
}

describe("relay socket-event route guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateInternalSecret.mockReturnValue(true);
    mockDispatchSocketEvent.mockResolvedValue({
      ok: true,
      response: { emit: [] },
    });
  });

  it.each([
    { name: "missing internal secret", secret: undefined },
    { name: "wrong internal secret", secret: "wrong-secret" },
  ])("returns 401 for $name before dispatch", async ({ secret }) => {
    mockValidateInternalSecret.mockReturnValue(false);

    const response = await POST(jsonRequest('{"event":"disconnect"}', secret));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mockDispatchSocketEvent).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON", async () => {
    const response = await POST(jsonRequest("{"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON" });
    expect(mockDispatchSocketEvent).not.toHaveBeenCalled();
  });

  it.each(["null", "{}", '{"event":1}'])(
    "returns 400 when the event field is missing from %s",
    async (body) => {
      const response = await POST(jsonRequest(body));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Missing event field",
      });
      expect(mockDispatchSocketEvent).not.toHaveBeenCalled();
    }
  );

  it("returns 500 and schedules a log flush when dispatch rejects", async () => {
    mockDispatchSocketEvent.mockRejectedValue(new Error("dispatch failed"));

    const response = await POST(jsonRequest('{"event":"disconnect"}'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal server error",
    });
    expect(mockScheduleLogFlush).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ISS-8880 §5 — request body byte cap
// ---------------------------------------------------------------------------

/**
 * This route hand-parsed a bare `await request.json()`, so it had no byte cap
 * at all — the only limit was whatever the platform imposed.
 *
 * The upper-bound case matters as much as the refusal: the cap is the gateway's
 * payload ceiling precisely so a legitimate large `desktop.command.event` result
 * chunk still gets through. A cap that refuses valid traffic is a worse bug than
 * the one being fixed.
 */
describe("relay socket-event route body cap (ISS-8880 §5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateInternalSecret.mockReturnValue(true);
    mockDispatchSocketEvent.mockResolvedValue({
      ok: true,
      response: { emit: [] },
    });
  });

  function bodyOfBytes(totalBytes: number): string {
    const envelope = '{"event":"desktop.command.event","payload":{"chunk":""}}';
    const padding = "x".repeat(Math.max(0, totalBytes - envelope.length));
    return `{"event":"desktop.command.event","payload":{"chunk":"${padding}"}}`;
  }

  it("answers 413 for a body past the cap without dispatching", async () => {
    const response = await POST(
      jsonRequest(bodyOfBytes(DESKTOP_GATEWAY_MAX_PAYLOAD_BYTES + 1024), "s")
    );

    expect(response.status).toBe(413);
    expect(mockDispatchSocketEvent).not.toHaveBeenCalled();
  });

  it("still accepts a legitimate near-cap body", async () => {
    // The upper-bound counterfactual: a cap sized to the 4 MiB route default
    // would fail here while the gateway happily forwards the payload.
    const response = await POST(
      jsonRequest(bodyOfBytes(DESKTOP_GATEWAY_MAX_PAYLOAD_BYTES - 4096), "s")
    );

    expect(response.status).toBe(200);
    expect(mockDispatchSocketEvent).toHaveBeenCalledTimes(1);
  });

  it("keeps the empty-body 400 the bare request.json() produced", async () => {
    const response = await POST(jsonRequest("", "s"));

    expect(response.status).toBe(400);
    expect(mockDispatchSocketEvent).not.toHaveBeenCalled();
  });
});
