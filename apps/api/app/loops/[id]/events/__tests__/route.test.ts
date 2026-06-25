/**
 * T-7.3 — JTI mismatch test for POST /api/loops/:id/events
 *
 * PRD scenario 11: a Loop with activeTokenJti = "new" and a request bearing
 * jti = "old" returns 401 with code: JTI_MISMATCH_ERROR_CODE and no event
 * is inserted.
 *
 * T-4.4 — Heartbeat bump tests for POST /api/loops/:id/events
 *
 * Verifies that the route delegates the fire-and-forget heartbeat bump to
 * `scheduleRunnerHeartbeatBump` on inserted events, and skips it on ignored
 * outcomes. Throttling internals (NULL-vs-stale predicate, rate-limit window)
 * are covered by the service-level tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mocks ---

vi.mock("../../../service", () => ({
  loopsService: {
    findById: vi.fn(),
    getEvents: vi.fn(),
    getEventsPaginated: vi.fn(),
    ingestRunnerEvent: vi.fn(),
  },
  scheduleRunnerHeartbeatBump: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/lib/auth/loop-runner-jwt", () => ({
  authenticateLoopRunnerRequest: vi.fn(),
  JTI_MISMATCH_ERROR_CODE: "jti_mismatch",
}));

vi.mock("@/lib/loops/loop-orchestrator", () => ({
  handleLoopEvent: vi.fn(),
}));

vi.mock("@/lib/loops/loop-event-bus", () => ({
  loopEventBus: { publish: vi.fn() },
}));

// --- Imports (after mocks) ---

import {
  authenticateLoopRunnerRequest,
  JTI_MISMATCH_ERROR_CODE,
} from "@/lib/auth/loop-runner-jwt";
import { handleLoopEvent } from "@/lib/loops/loop-orchestrator";
import {
  forbiddenResponse,
  jtiMismatchResponse,
} from "../../../../../__tests__/utils/loop-runner-test-helpers";
import { loopsService, scheduleRunnerHeartbeatBump } from "../../../service";
import { POST } from "../route";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOOP_ID = "loop-123";
const ORG_ID = "org-heartbeat-test";
const TOKEN_ID = "token-jti-abc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(loopId = LOOP_ID): Request {
  return new Request(`http://localhost/api/loops/${loopId}/events`, {
    method: "POST",
    headers: {
      authorization: "Bearer stale-runner-token",
      "x-loop-event-nonce": "11111111-1111-4111-8111-111111111111",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "started",
      timestamp: "2026-02-17T00:00:00.000Z",
    }),
  });
}

/**
 * Returns a LoopRunnerClaims object (the success shape that
 * authenticateLoopRunnerRequest resolves to on a valid token).
 */
function makeValidClaims(loopId = LOOP_ID) {
  return {
    loopId,
    organizationId: ORG_ID,
    tokenId: TOKEN_ID,
  };
}

/**
 * Set up mocks for the happy path (successful auth + event insertion).
 */
function setupHappyPath() {
  vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(makeValidClaims());

  vi.mocked(loopsService.ingestRunnerEvent).mockResolvedValue({
    ok: true,
    outcome: "inserted",
  });

  vi.mocked(scheduleRunnerHeartbeatBump).mockResolvedValue();

  vi.mocked(handleLoopEvent).mockResolvedValue([]);
}

// ---------------------------------------------------------------------------
// Tests — JTI mismatch
// ---------------------------------------------------------------------------

describe("POST /api/loops/:id/events — jti_mismatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 with code jti_mismatch when activeTokenJti is 'new' and request bears jti 'old'", async () => {
    const loopId = "loop-123";

    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      jtiMismatchResponse()
    );

    const response = await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe(JTI_MISMATCH_ERROR_CODE);
  });

  it("does not insert any event on jti_mismatch", async () => {
    const loopId = "loop-123";

    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      jtiMismatchResponse()
    );

    await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(handleLoopEvent).not.toHaveBeenCalled();
  });

  it("passes loopId and route to authenticateLoopRunnerRequest", async () => {
    const loopId = "loop-123";

    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      jtiMismatchResponse()
    );

    await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(authenticateLoopRunnerRequest).toHaveBeenCalledWith(
      expect.any(Request),
      loopId,
      "loops/[id]/events"
    );
  });

  it("returns 403 when loop not found", async () => {
    const loopId = "loop-missing";

    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      forbiddenResponse()
    );

    const response = await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(response.status).toBe(403);
    expect(handleLoopEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — throttled heartbeat bump on event insertion
// ---------------------------------------------------------------------------

describe("POST /api/loops/:id/events — heartbeat bump delegation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to scheduleRunnerHeartbeatBump on inserted event", async () => {
    setupHappyPath();

    await POST(makeRequest(), { params: Promise.resolve({ id: LOOP_ID }) });

    expect(scheduleRunnerHeartbeatBump).toHaveBeenCalledTimes(1);
    expect(scheduleRunnerHeartbeatBump).toHaveBeenCalledWith(LOOP_ID, ORG_ID);
  });

  it("does NOT call scheduleRunnerHeartbeatBump when ingestResult outcome is ignored", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      makeValidClaims()
    );

    vi.mocked(loopsService.ingestRunnerEvent).mockResolvedValue({
      ok: true,
      outcome: "ignored",
    });

    await POST(makeRequest(), { params: Promise.resolve({ id: LOOP_ID }) });

    expect(scheduleRunnerHeartbeatBump).not.toHaveBeenCalled();
  });
});
