import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeTargetsService } from "@/app/compute-targets/service";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { dispatchSocketEvent } from "../service";

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    getCommandById: vi.fn(),
    ingestCommandEvent: vi.fn(),
  },
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    heartbeat: vi.fn(),
    setOnlineState: vi.fn(),
  },
}));

type DispatchOverrides = Partial<Parameters<typeof dispatchSocketEvent>[0]>;

function dispatch(overrides: DispatchOverrides) {
  return dispatchSocketEvent({
    event: "unknown",
    payload: {},
    auth: null,
    targetId: undefined,
    correlation: { gatewaySessionId: "session-guard" },
    requestArrivedAt: 1000,
    ...overrides,
  });
}

describe("relay socket-event dispatcher guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      name: "desktop.hello without auth",
      event: "desktop.hello",
      expected: { ok: false, error: "Missing auth context", status: 400 },
    },
    {
      name: "desktop.command.event without target",
      event: "desktop.command.event",
      expected: { ok: false, error: "Missing targetId", status: 400 },
    },
    {
      name: "desktop.command.ack without target",
      event: "desktop.command.ack",
      expected: { ok: false, error: "Missing targetId", status: 400 },
    },
    {
      name: "desktop.presence without auth and target",
      event: "desktop.presence",
      expected: { ok: false, error: "Missing auth/targetId", status: 400 },
    },
    {
      name: "disconnect without auth and target",
      event: "disconnect",
      expected: { ok: false, error: "Missing auth/targetId", status: 400 },
    },
  ])("returns the exact refusal for $name", async ({ event, expected }) => {
    await expect(dispatch({ event })).resolves.toEqual(expected);

    expect(desktopCommandStore.ingestCommandEvent).not.toHaveBeenCalled();
    expect(computeTargetsService.heartbeat).not.toHaveBeenCalled();
    expect(computeTargetsService.setOnlineState).not.toHaveBeenCalled();
  });

  // ISS-12735: a relay still on the previous build keeps forwarding the
  // retired pre-v0.16.724 Desktop events; they degrade like any unknown event.
  it.each(["desktop.telemetry", "desktop.analytics", "desktop.agent-sessions"])(
    "degrades the retired %s event to an empty success response",
    async (event) => {
      const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

      await expect(
        dispatch({
          event,
          auth: {
            organizationId: "org-guard",
            userId: "user-guard",
          },
          targetId: "target-guard",
        })
      ).resolves.toEqual({ ok: true, response: { emit: [] } });

      expect(warn).toHaveBeenCalledWith(
        "relay.socket.unknown_event",
        expect.objectContaining({ event })
      );
      warn.mockRestore();
    }
  );

  it("degrades an unknown event to an empty success response and warns", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    await expect(
      dispatch({
        event: "desktop.from.a.newer.version",
        targetId: "target-guard",
        correlation: {
          computeTargetId: "target-correlation",
          gatewaySessionId: "session-guard",
          requestId: "request-guard",
        },
      })
    ).resolves.toEqual({ ok: true, response: { emit: [] } });

    expect(warn).toHaveBeenCalledWith(
      "relay.socket.unknown_event",
      expect.objectContaining({
        event: "desktop.from.a.newer.version",
        computeTargetId: "target-guard",
        requestId: "request-guard",
      })
    );
    warn.mockRestore();
  });
});
