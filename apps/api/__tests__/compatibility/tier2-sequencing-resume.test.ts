import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/internal/relay/socket-event/route";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  INTERNAL_SECRET,
  makeEnvelope,
  makeSocketEventRequest,
} from "./utils/test-fixtures";

vi.mock("@/app/compute-targets/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/app/compute-targets/service")>();
  return {
    ...original,
    computeTargetsService: {
      ...original.computeTargetsService,
      register: vi.fn(),
      updateOwned: vi.fn(),
      setOnlineState: vi.fn(),
    },
  };
});

vi.mock("@/lib/desktop-command-store", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/desktop-command-store")>();
  return {
    ...original,
    desktopCommandStore: {
      ...original.desktopCommandStore,
      ingestCommandEvent: vi.fn(),
      getCommandById: vi.fn(),
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
});

describe("POST /internal/relay/socket-event — sequencing and resume", () => {
  it("sequence gap recovery — emits desktop.hello.ack with resumeFromSequence", async () => {
    vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
      accepted: false,
      reason: "sequence_gap",
      expected: 3,
    });
    vi.mocked(desktopCommandStore.getCommandById).mockResolvedValue({
      commandId: "cmd-1",
      computeTargetId: "target-1",
      operationId: "op-1",
      status: "running",
      lastSequenceAcked: 2,
      createdAt: new Date().toISOString(),
    } as any);

    const request = makeSocketEventRequest(
      "desktop.command.event",
      {
        commandId: "cmd-1",
        eventType: "chunk",
        data: { text: "hello" },
        sequence: 5,
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
        resumeFromSequence: { "cmd-1": 2 },
      })
    );
  });

  it("duplicate event — still emits desktop.command.event.ack", async () => {
    const ingestResult = {
      accepted: true as const,
      duplicate: true as const,
      sequence: 1,
    };
    vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue(
      ingestResult
    );

    const request = makeSocketEventRequest(
      "desktop.command.event",
      {
        commandId: "cmd-2",
        eventType: "chunk",
        data: { text: "world" },
        sequence: 1,
      },
      { targetId: "target-1" }
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();

    if (ingestResult.accepted) {
      expect(body.emit).toHaveLength(1);
      expect(body.emit[0].event).toBe("desktop.command.event.ack");
      expect(body.emit[0].payload).toEqual(
        makeEnvelope({
          commandId: "cmd-2",
          sequence: 1,
        })
      );
    }
  });
});
