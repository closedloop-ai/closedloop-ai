import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computeTargetsService } from "@/app/compute-targets/service";
import { POST } from "@/app/internal/relay/socket-event/route";
import {
  INTERNAL_SECRET,
  makeSocketEventRequest,
  mockAuthContext,
} from "./utils/test-fixtures";

vi.mock("@/app/compute-targets/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/app/compute-targets/service")>();
  return {
    ...original,
    computeTargetsService: {
      ...original.computeTargetsService,
      // ISS-8895/ISS-8897 moved the relay presence write off `heartbeat` and
      // onto its own writer, so `presenceAt` and `lastSeenAt` stopped sharing a
      // column. Mocking `heartbeat` alone stopped intercepting anything: the
      // handler reached the real `withDb` and the frame answered 500.
      heartbeat: vi.fn().mockResolvedValue(true),
      recordRelayPresence: vi.fn().mockResolvedValue(true),
    },
  };
});

vi.mock("@/lib/relay-event-bus", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/relay-event-bus")>();
  return {
    ...original,
    relayEventBus: {
      ...original.relayEventBus,
    },
  };
});

beforeAll(() => {
  process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(computeTargetsService.recordRelayPresence).mockResolvedValue(true);
});

describe("POST /internal/relay/socket-event — desktop.presence", () => {
  it("returns 200, records relay presence with correct args, and emits nothing", async () => {
    const request = makeSocketEventRequest(
      "desktop.presence",
      {},
      { targetId: "target-1", auth: mockAuthContext }
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const result = await response.json();
    expect(result.emit).toEqual([]);

    expect(
      vi.mocked(computeTargetsService.recordRelayPresence)
    ).toHaveBeenCalledWith("target-1", "org-1", "user-1");
    // The narrower clock is the point of the split: a presence frame is the one
    // check-in the idle drain may read as "the presence trigger owns this
    // target's backlog", so this path must not fall back to the generic one.
    expect(vi.mocked(computeTargetsService.heartbeat)).not.toHaveBeenCalled();
  });

  it("returns 400 when auth field is missing", async () => {
    const request = new Request("http://localhost:3002/api/socket-events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({
        event: "desktop.presence",
        payload: {},
        targetId: "target-1",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const result = await response.json();
    expect(result.error).toBeTruthy();
  });

  it("returns 400 when targetId field is missing", async () => {
    const request = new Request("http://localhost:3002/api/socket-events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({
        event: "desktop.presence",
        payload: {},
        auth: mockAuthContext,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const result = await response.json();
    expect(result.error).toBeTruthy();
  });
});
