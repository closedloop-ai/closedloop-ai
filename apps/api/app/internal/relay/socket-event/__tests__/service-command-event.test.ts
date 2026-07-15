import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { dispatchSocketEvent } from "../service";

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    ingestCommandEvent: vi.fn(),
    getCommandById: vi.fn(),
  },
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
      pluginVersion: undefined,
      relaySocketId: "socket-1",
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
