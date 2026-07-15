/**
 * FEA-2919 — correlated failure logging for POST /api/loops/:id/manual-events
 *
 * Verifies that when the manual-event ingest path throws an unmapped error,
 * the outer catch emits `loop.manual_event_ingest_failed` carrying loopId and
 * organizationId so an operator can stitch the Datadog failure back to its
 * loop, before delegating the 500 response to `errorResponse`.
 */

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mocks ---

const { logError, user } = vi.hoisted(() => ({
  logError: vi.fn(),
  user: { id: "user-1", organizationId: "org-manual-test" },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: logError,
    flush: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request, context: { params: Promise<unknown> }) =>
      handler({ user }, request, context.params),
}));

vi.mock("../../../service", () => ({
  loopsService: {
    findManualLoopById: vi.fn(),
  },
}));

vi.mock("@/lib/loops/loop-orchestrator", () => ({
  handleLoopEvent: vi.fn(),
}));

vi.mock("@/lib/loops/loop-event-bus", () => ({
  loopEventBus: { publish: vi.fn() },
}));

// --- Imports (after mocks) ---

import { LoopStatus } from "@repo/api/src/types/loop";
import { handleLoopEvent } from "@/lib/loops/loop-orchestrator";
import { loopsService } from "../../../service";
import { POST } from "../route";

const LOOP_ID = "loop-manual-123";

function makeRequest(loopId = LOOP_ID): NextRequest {
  // The route only reads the request body; a plain Request satisfies that at
  // runtime. Cast to NextRequest to match the withAnyAuth handler signature.
  return new Request(`http://localhost/api/loops/${loopId}/manual-events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "progress", message: "still going" }),
  }) as unknown as NextRequest;
}

describe("POST /api/loops/:id/manual-events — ingest failure logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs loop.manual_event_ingest_failed with loopId and organizationId when the ingest path throws", async () => {
    vi.mocked(loopsService.findManualLoopById).mockResolvedValue({
      // Non-terminal status so the route proceeds to handleLoopEvent.
      loop: { status: LoopStatus.Running },
    } as Awaited<ReturnType<typeof loopsService.findManualLoopById>>);

    const boom = new Error("kaboom");
    vi.mocked(handleLoopEvent).mockRejectedValue(boom);

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: LOOP_ID }),
    });

    expect(response.status).toBe(500);
    expect(logError).toHaveBeenCalledWith("loop.manual_event_ingest_failed", {
      error: boom,
      loopId: LOOP_ID,
      organizationId: user.organizationId,
    });
  });
});
