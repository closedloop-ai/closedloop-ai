import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/internal/relay/socket-event/route";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { isDesktopCommandEventType } from "@/lib/desktop-gateway-wire";
import {
  INTERNAL_SECRET,
  makeEnvelope,
  makeSocketEventRequest,
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
    status: "running",
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
      { targetId: "target-1" }
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
      { targetId: "target-1" }
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
  });
});

describe("DesktopCommandEventType values", () => {
  it("accepts 'status' as a valid DesktopCommandEventType", () => {
    expect(isDesktopCommandEventType("status")).toBe(true);
  });

  it("accepts 'chunk' as a valid DesktopCommandEventType", () => {
    expect(isDesktopCommandEventType("chunk")).toBe(true);
  });

  it("accepts 'result' as a valid DesktopCommandEventType", () => {
    expect(isDesktopCommandEventType("result")).toBe(true);
  });

  it("accepts 'error' as a valid DesktopCommandEventType", () => {
    expect(isDesktopCommandEventType("error")).toBe(true);
  });

  it("accepts 'done' as a valid DesktopCommandEventType", () => {
    expect(isDesktopCommandEventType("done")).toBe(true);
  });

  it("rejects unknown values as invalid DesktopCommandEventType", () => {
    expect(isDesktopCommandEventType("unknown")).toBe(false);
    expect(isDesktopCommandEventType("progress")).toBe(false);
    expect(isDesktopCommandEventType(null)).toBe(false);
    expect(isDesktopCommandEventType(undefined)).toBe(false);
    expect(isDesktopCommandEventType(42)).toBe(false);
  });
});
