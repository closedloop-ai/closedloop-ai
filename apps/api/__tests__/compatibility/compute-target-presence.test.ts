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
      heartbeat: vi.fn().mockResolvedValue(true),
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
      publishResult: vi.fn(),
    },
  };
});

beforeAll(() => {
  process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(computeTargetsService.heartbeat).mockResolvedValue(true);
});

describe("POST /internal/relay/socket-event — desktop.presence", () => {
  it("returns 200, calls heartbeat with correct args, and emits nothing", async () => {
    const request = makeSocketEventRequest(
      "desktop.presence",
      {},
      { targetId: "target-1", auth: mockAuthContext }
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const result = await response.json();
    expect(result.emit).toEqual([]);

    expect(vi.mocked(computeTargetsService.heartbeat)).toHaveBeenCalledWith(
      "target-1",
      "org-1",
      "user-1"
    );
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
