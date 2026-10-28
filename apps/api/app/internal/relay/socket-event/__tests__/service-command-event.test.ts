import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeTargetsService } from "@/app/compute-targets/service";
import { isComputeTargetSigningEligible } from "@/lib/compute-target-signing-eligibility";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { dispatchSocketEvent } from "../service";
import { scheduleQueuedCommandRelease } from "../service/command-drain";

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    ingestCommandEvent: vi.fn(),
    getCommandById: vi.fn(),
  },
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findById: vi.fn(),
  },
}));

vi.mock("@/lib/compute-target-signing-eligibility", () => ({
  CommandSigningEligibilityStatus: {
    Eligible: "eligible",
    Ineligible: "ineligible",
    Unknown: "unknown",
  },
  isComputeTargetSigningEligible: vi.fn(),
}));

vi.mock("../service/command-drain", () => ({
  scheduleQueuedCommandRelease: vi.fn(),
}));

describe("dispatchSocketEvent desktop.command.event data validation", () => {
  beforeEach(() => {
    vi.mocked(desktopCommandStore.ingestCommandEvent).mockReset();
    vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
      accepted: true,
      duplicate: true,
      sequence: 1,
    });
  });

  const dispatch = (payload: unknown) =>
    dispatchSocketEvent({
      event: "desktop.command.event",
      payload,
      auth: null,
      targetId: "target-1",
      correlation: { gatewaySessionId: "session-1" },
      requestArrivedAt: 1000,
    });

  it("drops events whose data is not JSON-compatible", async () => {
    await expect(
      dispatch({
        commandId: "cmd-1",
        sequence: 1,
        eventType: "chunk",
        data: 10n,
      })
    ).resolves.toEqual({ ok: true, response: { emit: [] } });

    expect(desktopCommandStore.ingestCommandEvent).not.toHaveBeenCalled();
  });

  it("ingests events with JSON-compatible data", async () => {
    await dispatch({
      commandId: "cmd-1",
      sequence: 1,
      eventType: "chunk",
      data: { message: "hello" },
    });

    expect(desktopCommandStore.ingestCommandEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "cmd-1",
        eventType: "chunk",
        data: { message: "hello" },
        sequence: 1,
      })
    );
  });

  it("coerces a missing data field to null before ingestion", async () => {
    await dispatch({
      commandId: "cmd-1",
      sequence: 1,
      eventType: "done",
    });

    expect(desktopCommandStore.ingestCommandEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "cmd-1",
        eventType: "done",
        data: null,
        sequence: 1,
      })
    );
  });
});

/**
 * ISS-8453 AC-001: the reconnect flush is capped at `maxInFlightCommands`, so a
 * freed slot has to be the thing that releases the next command. Without this
 * call site the cap becomes a stall — these cases fail if it is deleted.
 */
describe("dispatchSocketEvent desktop.command.event queued-command release", () => {
  const dispatchEvent = (eventType: string) =>
    dispatchSocketEvent({
      event: "desktop.command.event",
      payload: { commandId: "cmd-1", sequence: 1, eventType, data: {} },
      auth: null,
      targetId: "target-1",
      correlation: { gatewaySessionId: "session-1" },
      requestArrivedAt: 1000,
    });

  beforeEach(() => {
    vi.mocked(scheduleQueuedCommandRelease).mockClear();
    vi.mocked(desktopCommandStore.getCommandById).mockResolvedValue(null);
  });

  it("releases a queued command when an event retires the running one", async () => {
    vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
      accepted: true,
      duplicate: false,
      sequence: 1,
      nextStatus: DesktopCommandStatus.Done,
    });

    await dispatchEvent("done");

    expect(scheduleQueuedCommandRelease).toHaveBeenCalledWith("target-1");
  });

  // The negative sibling: a slot that did not free must not release anything,
  // or the cap is spent on work the desktop is still running.
  it("releases nothing when the command merely started running", async () => {
    vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
      accepted: true,
      duplicate: false,
      sequence: 1,
      nextStatus: DesktopCommandStatus.Running,
    });

    await dispatchEvent("chunk");

    expect(scheduleQueuedCommandRelease).not.toHaveBeenCalled();
  });
});

describe("dispatchSocketEvent desktop.command.event refusal and recovery", () => {
  const dispatchEvent = (
    auth: {
      organizationId: string;
      userId: string;
      clerkUserId?: string | null;
    } | null
  ) =>
    dispatchSocketEvent({
      event: "desktop.command.event",
      payload: {
        commandId: "cmd-gap",
        sequence: 4,
        eventType: "chunk",
        data: { partial: true },
      },
      auth,
      targetId: "target-gap",
      correlation: { gatewaySessionId: "session-gap" },
      requestArrivedAt: 1000,
    });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits nothing when the command store reports an unknown command", async () => {
    vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
      accepted: false,
      reason: "unknown_command",
    });

    await expect(dispatchEvent(null)).resolves.toEqual({
      ok: true,
      response: { emit: [] },
    });
    expect(desktopCommandStore.getCommandById).not.toHaveBeenCalled();
  });

  it("emits nothing when a sequence-gap command row no longer exists", async () => {
    vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
      accepted: false,
      reason: "sequence_gap",
    });
    vi.mocked(desktopCommandStore.getCommandById).mockResolvedValue(null);

    await expect(dispatchEvent(null)).resolves.toEqual({
      ok: true,
      response: { emit: [] },
    });
    expect(computeTargetsService.findById).not.toHaveBeenCalled();
    expect(isComputeTargetSigningEligible).not.toHaveBeenCalled();
  });

  it("re-acks a sequence gap without capabilities when relay auth is absent", async () => {
    vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
      accepted: false,
      reason: "sequence_gap",
    });
    vi.mocked(desktopCommandStore.getCommandById).mockResolvedValue({
      commandId: "cmd-gap",
      computeTargetId: "target-gap",
      lastSequenceAcked: 3,
    } as Awaited<ReturnType<typeof desktopCommandStore.getCommandById>>);

    const result = await dispatchEvent(null);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.response.emit).toEqual([
      expect.objectContaining({
        event: "desktop.hello.ack",
        payload: expect.objectContaining({
          computeTargetId: "target-gap",
          resumeFromSequence: { "cmd-gap": 3 },
        }),
      }),
    ]);
    expect(result.response.emit[0]?.payload).not.toHaveProperty(
      "serverCapabilities"
    );
    expect(computeTargetsService.findById).not.toHaveBeenCalled();
    expect(isComputeTargetSigningEligible).not.toHaveBeenCalled();
  });

  it("keeps baseline capabilities when the sequence-gap target lookup fails", async () => {
    vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
      accepted: false,
      reason: "sequence_gap",
    });
    vi.mocked(desktopCommandStore.getCommandById).mockResolvedValue({
      commandId: "cmd-gap",
      computeTargetId: "target-gap",
      lastSequenceAcked: 3,
    } as Awaited<ReturnType<typeof desktopCommandStore.getCommandById>>);
    vi.mocked(computeTargetsService.findById).mockRejectedValue(
      new Error("target lookup failed")
    );

    const result = await dispatchEvent({
      organizationId: "org-gap",
      userId: "user-gap",
      clerkUserId: "clerk-gap",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.response.emit[0]?.payload).toEqual(
      expect.objectContaining({
        serverCapabilities: {
          agentSessionSync: true,
          agentSessionSyncCompression: true,
          agentSessionSyncActivityChunking: true,
          agentSessionSyncPrRefChunking: true,
          agentSessionSyncMonitoredActivity: true,
          agentSessionSyncSpanExtent: true,
          agentSessionSyncHumanTurnTimestamps: true,
          agentSessionSyncAgentTurnTimestamps: true,
          agentSessionSyncTokenEventOwner: true,
        },
      })
    );
    expect(isComputeTargetSigningEligible).not.toHaveBeenCalled();
  });
});
