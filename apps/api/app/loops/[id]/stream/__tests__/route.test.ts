/**
 * FEA-2903 — Terminal-loop SSE replay must include the terminal event.
 *
 * The terminal-loop branch of GET /api/loops/:id/stream replays a finished
 * loop's stored events and closes. It previously fetched only the first 500
 * events (getEventsPaginated({ limit: 500, offset: 0 })), so for a loop with
 * more than 500 events the terminal event — chronologically last — fell
 * outside the window and was never sent. The client then reached EOF without a
 * terminal event and reconnected indefinitely, re-appending duplicates until it
 * errored.
 *
 * The branch now replays the COMPLETE history via keyset-paginated
 * getEventsSince batches (O(batch) memory rather than O(total events)), so the
 * terminal event is always delivered while peak memory stays bounded even for
 * loops with far more than one batch of events.
 */

import { LoopEventType, LoopStatus } from "@repo/api/src/types/loop";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mocks ---

vi.mock("@repo/auth/server", () => ({
  auth: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: vi.fn(),
}));

vi.mock("@/app/organizations/service", () => ({
  organizationsService: {
    findByClerkId: vi.fn(),
  },
}));

vi.mock("@/app/users/service", () => ({
  usersService: {
    findByClerkIdAndOrg: vi.fn(),
  },
}));

vi.mock("@/lib/loops/loop-event-bus", () => ({
  loopEventBus: { subscribe: vi.fn() },
}));

vi.mock("../../../service", () => ({
  loopsService: {
    findById: vi.fn(),
    getEvents: vi.fn(),
    getEventsSince: vi.fn(),
    getEventsPaginated: vi.fn(),
  },
}));

// --- Imports (after mocks) ---

import { auth } from "@repo/auth/server";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { loopsService } from "../../../service";
import { GET } from "../route";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const LOOP_ID = "loop-fea-2903";
const ORG_ID = "org-fea-2903";
const CLERK_USER_ID = "user_clerk_abc";
const CLERK_ORG_ID = "org_clerk_abc";
// Must match REPLAY_BATCH_SIZE in the route.
const REPLAY_BATCH_SIZE = 500;

function makeParams(id = LOOP_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(id = LOOP_ID): Request {
  return new Request(`http://localhost/api/loops/${id}/stream`);
}

/** Wire up a happy-path authenticated request for a terminal (COMPLETED) loop. */
function primeAuthenticatedTerminalLoop(): void {
  vi.mocked(auth).mockResolvedValue({
    userId: CLERK_USER_ID,
    orgId: CLERK_ORG_ID,
  } as unknown as Awaited<ReturnType<typeof auth>>);
  vi.mocked(organizationsService.findByClerkId).mockResolvedValue({
    id: ORG_ID,
  } as never);
  vi.mocked(usersService.findByClerkIdAndOrg).mockResolvedValue({
    active: true,
  } as never);
  vi.mocked(loopsService.findById).mockResolvedValue({
    id: LOOP_ID,
    status: LoopStatus.Completed,
  } as never);
}

type FakeStoredEvent = {
  id: string;
  type: LoopEventType;
  index: number;
  storedAt: string;
};

/** Build a chronological event history whose final event is terminal. */
function buildHistoryWithTerminalLast(count: number): FakeStoredEvent[] {
  const events: FakeStoredEvent[] = Array.from(
    { length: count - 1 },
    (_, i) => ({
      id: `evt-${String(i).padStart(6, "0")}`,
      type: LoopEventType.Output,
      index: i,
      storedAt: new Date(1000 + i).toISOString(),
    })
  );
  events.push({
    id: "evt-terminal",
    type: LoopEventType.Completed,
    index: count - 1,
    storedAt: new Date(1000 + count - 1).toISOString(),
  });
  return events;
}

/**
 * Mock getEventsSince with keyset semantics: return the next batch strictly
 * after the (storedAt, id) cursor, capped at `take`. Mirrors the DB ordering
 * so the route drains the full history across successive pulls.
 */
function mockGetEventsSince(history: FakeStoredEvent[]): void {
  vi.mocked(loopsService.getEventsSince).mockImplementation(
    (_loopId, _org, since: Date, sinceId: string, take: number) => {
      const sinceMs = since.getTime();
      const after = history.filter((e) => {
        const ms = new Date(e.storedAt).getTime();
        return ms > sinceMs || (ms === sinceMs && e.id > sinceId);
      });
      return Promise.resolve(after.slice(0, take) as never);
    }
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/loops/:id/stream — terminal loop replay (FEA-2903)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replays the full history via keyset getEventsSince batches so the terminal event is delivered even past one batch", async () => {
    primeAuthenticatedTerminalLoop();
    const events = buildHistoryWithTerminalLast(750);
    mockGetEventsSince(events);

    const response = await GET(makeRequest(), makeParams());
    const body = await response.text();

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    // Streamed via keyset batches, not the capped page fetch or a single
    // unbounded getEvents call.
    expect(loopsService.getEventsSince).toHaveBeenCalled();
    expect(loopsService.getEvents).not.toHaveBeenCalled();
    expect(loopsService.getEventsPaginated).not.toHaveBeenCalled();

    // More than one batch is required to drain 750 events at batch size 500.
    expect(
      vi.mocked(loopsService.getEventsSince).mock.calls.length
    ).toBeGreaterThan(1);
    // Each call requests at most REPLAY_BATCH_SIZE, so memory stays O(batch).
    for (const call of vi.mocked(loopsService.getEventsSince).mock.calls) {
      expect(call[4]).toBe(REPLAY_BATCH_SIZE);
    }

    // The terminal event (chronologically last) is present in the SSE payload.
    expect(body).toContain(`data: ${JSON.stringify(events.at(-1))}`);
    // Every event is streamed as its own SSE frame, exactly once.
    expect(
      body.split("\n\n").filter((f) => f.startsWith("data:"))
    ).toHaveLength(events.length);
  });

  it("delivers the terminal event when the whole history fits in a single batch", async () => {
    primeAuthenticatedTerminalLoop();
    const events = buildHistoryWithTerminalLast(3);
    mockGetEventsSince(events);

    const response = await GET(makeRequest(), makeParams());
    const body = await response.text();

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(body).toContain(`data: ${JSON.stringify(events.at(-1))}`);
    expect(
      body.split("\n\n").filter((f) => f.startsWith("data:"))
    ).toHaveLength(events.length);
  });

  it("closes cleanly with no frames for a terminal loop that has no stored events", async () => {
    primeAuthenticatedTerminalLoop();
    mockGetEventsSince([]);

    const response = await GET(makeRequest(), makeParams());
    const body = await response.text();

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(
      body.split("\n\n").filter((f) => f.startsWith("data:"))
    ).toHaveLength(0);
  });

  it("emits a terminal error frame if event retrieval throws (FEA-2903)", async () => {
    primeAuthenticatedTerminalLoop();
    vi.mocked(loopsService.getEventsSince).mockRejectedValue(
      new Error("db down")
    );

    const response = await GET(makeRequest(), makeParams());
    const body = await response.text();

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    // On a mid-replay failure the client must still receive a TERMINAL event
    // (not a bare `data: {}`, which has no recognized type and leaves the
    // client reconnecting) so it stops cleanly — see the replay-failure path
    // in route.ts.
    const frames = body.split("\n\n").filter((f) => f.startsWith("data:"));
    expect(frames).toHaveLength(1);
    const payload = JSON.parse(frames[0].slice("data: ".length));
    expect(payload).toMatchObject({
      type: "error",
      code: "replay_failed",
      loopId: "loop-fea-2903",
    });
  });
});
