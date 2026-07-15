import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/internal/relay/socket-event/route";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  INTERNAL_SECRET,
  makeEnvelope,
  makeSocketEventRequest,
  mockGatewayOwnerAuthContext,
} from "./utils/test-fixtures";

vi.mock("@/lib/desktop-command-store", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/desktop-command-store")>();
  return {
    ...original,
    desktopCommandStore: {
      ...original.desktopCommandStore,
      getCommandById: vi.fn(),
      ingestCommandEvent: vi.fn(),
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

// Provide the internal secret so validateInternalSecret passes
beforeAll(() => {
  process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
});

beforeEach(() => {
  vi.clearAllMocks();

  // Default: getCommandById returns a valid command summary
  vi.mocked(desktopCommandStore.getCommandById).mockResolvedValue({
    commandId: "cmd-1",
    computeTargetId: "target-1",
    operationId: "op-1",
    status: DesktopCommandStatus.Running,
    lastSequenceAcked: 0,
    createdAt: new Date().toISOString(),
  });
});

describe("POST /internal/relay/socket-event — desktop.command.event accepted chunk", () => {
  it("returns desktop.command.event.ack with commandId and sequence when accepted", async () => {
    vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
      accepted: true,
      duplicate: false,
      sequence: 1,
    });

    const request = makeSocketEventRequest(
      "desktop.command.event",
      {
        commandId: "cmd-1",
        sequence: 1,
        eventType: "chunk",
        data: { text: "hello" },
      },
      { targetId: "target-1", auth: mockGatewayOwnerAuthContext }
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.emit).toHaveLength(1);
    expect(body.emit[0].event).toBe("desktop.command.event.ack");
    expect(body.emit[0].payload).toEqual(
      makeEnvelope({ commandId: "cmd-1", sequence: 1 })
    );
  });
});

describe("POST /internal/relay/socket-event — desktop.command.event sequence_gap", () => {
  it("returns desktop.hello.ack with resumeFromSequence when sequence_gap", async () => {
    vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
      accepted: false,
      reason: "sequence_gap",
      expected: 2,
    });

    const request = makeSocketEventRequest(
      "desktop.command.event",
      {
        commandId: "cmd-1",
        sequence: 5,
        eventType: "chunk",
        data: { text: "out-of-order" },
      },
      { targetId: "target-1", auth: mockGatewayOwnerAuthContext }
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.emit).toHaveLength(1);
    expect(body.emit[0].event).toBe("desktop.hello.ack");
    expect(body.emit[0].payload).toEqual(
      makeEnvelope({
        computeTargetId: "target-1",
        sessionId: expect.any(String),
        serverTime: expect.any(String),
        resumeFromSequence: { "cmd-1": 0 },
      })
    );
    expect(body.emit[0].payload.clerkUserId).toBeUndefined();
    expect(body.emit[0].payload.organizationId).toBeUndefined();
    expect(body.emit[0].payload.userId).toBeUndefined();
  });

  it("omits gateway-owner identity on sequence_gap when Clerk id is missing", async () => {
    vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
      accepted: false,
      reason: "sequence_gap",
      expected: 2,
    });

    const request = makeSocketEventRequest(
      "desktop.command.event",
      {
        commandId: "cmd-1",
        sequence: 5,
        eventType: "chunk",
        data: { text: "out-of-order" },
      },
      {
        targetId: "target-1",
        auth: { organizationId: "org-1", userId: "user_db_1" },
      }
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.emit[0].payload).toEqual(
      makeEnvelope({
        computeTargetId: "target-1",
        sessionId: expect.any(String),
        serverTime: expect.any(String),
        resumeFromSequence: { "cmd-1": 0 },
      })
    );
  });
});
