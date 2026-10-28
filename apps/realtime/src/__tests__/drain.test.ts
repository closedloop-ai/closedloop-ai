import { createServer } from "node:http";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import {
  type DrainPayload,
  RealtimeEvent,
} from "@repo/realtime-contract/protocol";
import { createRevocations } from "@repo/realtime-contract/revocations";
import type { Socket as ClientSocket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeServer } from "../edge/socket-server";
import { DEFAULT_DRAIN_WINDOW_MS } from "../env";
import { HealthPath } from "../http/health";
import {
  createDrain,
  DrainTrigger,
  MIN_DRAIN_AFTER_MS,
} from "../lifecycle/drain";
import { createReadiness } from "../lifecycle/readiness";
import {
  composeRealtimeService,
  LISTENER_STOP_TIMEOUT_MS,
  type RealtimeServiceConfig,
} from "../service";
import {
  ALLOWED_ORIGIN,
  connectError,
  type EdgeHarness,
  listenEdge,
  nextEvent,
  ORG_A,
  openClient,
  TEST_PUBLIC_KEYS,
  tokenFor,
  USER_A,
  validAuth,
  welcomedClient,
} from "./edge-harness";
import { realtimeHttpServer } from "./http-harness";

const WINDOW_MS = 1000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type FakeSocket = {
  emit: ReturnType<typeof vi.fn>;
  once: (event: string, listener: () => void) => void;
  /** Disconnects: leaves the namespace, then fires `disconnect`. */
  leave: () => void;
  /** The engine.io connection; closing it is a transport close. */
  conn: { close: ReturnType<typeof vi.fn> };
};

/**
 * The slice of the socket.io server the drain touches. `close()` disconnects
 * whatever is still connected, as the real one does.
 */
function fakeServer(socketCount: number) {
  const sockets = new Map<string, FakeSocket>();
  const onConnection: Array<(socket: FakeSocket) => void> = [];
  const close = vi.fn(() => {
    for (const socket of [...sockets.values()]) {
      socket.leave();
    }
  });
  const add = (id: string): FakeSocket => {
    const onDisconnect: Array<() => void> = [];
    const leave = () => {
      sockets.delete(id);
      for (const listener of onDisconnect) {
        listener();
      }
    };
    const socket: FakeSocket = {
      emit: vi.fn(),
      once: (_event, listener) => {
        onDisconnect.push(listener);
      },
      leave,
      conn: { close: vi.fn(leave) },
    };
    sockets.set(id, socket);
    return socket;
  };
  for (let index = 0; index < socketCount; index += 1) {
    add(`socket-${index}`);
  }
  /** A handshake that finishes after the drain started. */
  const connectLate = (id: string): FakeSocket => {
    const socket = add(id);
    for (const listener of onConnection) {
      listener(socket);
    }
    return socket;
  };
  const io = {
    of: () => ({ sockets }),
    on: (_event: string, listener: (socket: FakeSocket) => void) => {
      onConnection.push(listener);
    },
    close,
  } as unknown as RealtimeServer;
  return { io, sockets: [...sockets.values()], close, connectLate };
}

function drainOver(
  io: RealtimeServer,
  random: () => number,
  windowMs = WINDOW_MS
) {
  const order: string[] = [];
  const exit = vi.fn((code: number) => {
    order.push(`exit:${code}`);
  });
  const flushTelemetry = vi.fn(() => {
    order.push("flush");
    return Promise.resolve();
  });
  const drain = createDrain({
    io,
    windowMs,
    random,
    flushTelemetry,
    exit,
  });
  return { drain, exit, order };
}

describe("createDrain", () => {
  it("spreads afterMs uniformly from the floor to the end of the window", () => {
    vi.useFakeTimers();
    const { io, sockets } = fakeServer(4);
    const draws = [0, 0.25, 0.5, 0.999_999_999];
    const { drain } = drainOver(io, () => draws.shift() ?? 0);

    drain.start(DrainTrigger.TaskStopping);

    // The window is short, so the floor is half of it.
    expect(sockets.map((socket) => socket.emit.mock.calls)).toEqual(
      [500, 625, 750, WINDOW_MS - 1].map((afterMs) => [
        [RealtimeEvent.Drain, { afterMs }],
      ])
    );
  });

  it.each([
    { windowMs: WINDOW_MS, floorMs: WINDOW_MS / 2 },
    { windowMs: 60_000, floorMs: MIN_DRAIN_AFTER_MS },
  ])(
    "tells no client to reconnect before $floorMs ms in a $windowMs ms window",
    ({ windowMs, floorMs }) => {
      vi.useFakeTimers();
      const { io, sockets } = fakeServer(1);
      const { drain } = drainOver(io, () => 0, windowMs);

      drain.start(DrainTrigger.TaskStopping);

      expect(sockets[0]?.emit).toHaveBeenCalledWith(RealtimeEvent.Drain, {
        afterMs: floorMs,
      });
    }
  );

  it("with the default window, tells no client to reconnect before ECS has deregistered the target", () => {
    vi.useFakeTimers();
    const { io, sockets } = fakeServer(1);
    const { drain } = drainOver(io, () => 0, DEFAULT_DRAIN_WINDOW_MS);

    drain.start(DrainTrigger.TaskStopping);

    // The lowest draw. Stage, ISS-12194: DeregisterTargets landed 9-11 s
    // after ECS marked the task STOPPED, and the drain starts no earlier.
    expect(sockets[0]?.emit).toHaveBeenCalledWith(RealtimeEvent.Drain, {
      afterMs: 11_000,
    });
  });

  it.each([
    { finishedBy: "nothing being connected", connected: 0 },
    { finishedBy: "the last socket leaving", connected: 1 },
  ])(
    "drops a handshake that connects after the drain finished by $finishedBy",
    ({ connected }) => {
      vi.useFakeTimers();
      const { io, sockets, connectLate } = fakeServer(connected);
      const { drain } = drainOver(io, () => 0);

      drain.start(DrainTrigger.TaskStopping);
      sockets[0]?.leave();
      const late = connectLate("late");

      expect(late.conn.close).toHaveBeenCalledWith(true);
      expect(io.of("/").sockets.size).toBe(0);
    }
  );

  it("closes the stragglers when a SIGTERM drain's window ends, then flushes telemetry and exits 0", async () => {
    vi.useFakeTimers();
    const { io, close } = fakeServer(2);
    const { drain, order } = drainOver(io, () => 0.5);

    drain.start(DrainTrigger.Sigterm);
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledOnce();
    expect(order).toEqual(["flush", "exit:0"]);
  });

  it("finishes as soon as the last socket leaves, before the window ends", async () => {
    vi.useFakeTimers();
    const { io, sockets, close } = fakeServer(2);
    const { drain, exit } = drainOver(io, () => 0);

    drain.start(DrainTrigger.Sigterm);
    sockets[0]?.leave();
    expect(close).not.toHaveBeenCalled();
    sockets[1]?.leave();
    await vi.advanceTimersByTimeAsync(0);

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(exit).toHaveBeenCalledOnce();
  });

  it("hints a socket that connects after the drain started and waits for it to leave", async () => {
    vi.useFakeTimers();
    const { io, sockets, close, connectLate } = fakeServer(1);
    const { drain, exit } = drainOver(io, () => 0.5);

    drain.start(DrainTrigger.Sigterm);
    const late = connectLate("late");

    expect(late.emit).toHaveBeenCalledWith(RealtimeEvent.Drain, {
      afterMs: 750,
    });
    sockets[0]?.leave();
    await vi.advanceTimersByTimeAsync(0);
    expect(close).not.toHaveBeenCalled();
    late.leave();
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits at once on SIGTERM with nothing connected", async () => {
    vi.useFakeTimers();
    const { io, close } = fakeServer(0);
    const { drain, exit } = drainOver(io, () => 0);

    drain.start(DrainTrigger.Sigterm);
    await vi.advanceTimersByTimeAsync(0);

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("drops a task_stopping drain's stragglers when the window ends, but keeps the server up and exits only on SIGTERM", async () => {
    vi.useFakeTimers();
    const { io, sockets, close } = fakeServer(2);
    const { drain, order } = drainOver(io, () => 0.5);

    drain.start(DrainTrigger.TaskStopping);
    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(sockets.map((socket) => socket.conn.close.mock.calls)).toEqual([
      [[true]],
      [[true]],
    ]);
    expect(close).not.toHaveBeenCalled();
    expect(drain.isDraining()).toBe(true);
    await vi.advanceTimersByTimeAsync(WINDOW_MS * 10);
    expect(order).toEqual([]);

    drain.start(DrainTrigger.Sigterm);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
    expect(order).toEqual(["flush", "exit:0"]);
  });

  it("holds a task_stopping drain with nothing connected open until SIGTERM", async () => {
    vi.useFakeTimers();
    const { io, close } = fakeServer(0);
    const { drain, exit } = drainOver(io, () => 0);

    drain.start(DrainTrigger.TaskStopping);
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    drain.start(DrainTrigger.Sigterm);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    drain.start(DrainTrigger.Sigterm);
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledOnce();
  });

  it("exits at the end of a task_stopping drain's window when SIGTERM arrived during it", async () => {
    vi.useFakeTimers();
    const { io, sockets, close } = fakeServer(1);
    const { drain, order } = drainOver(io, () => 0.5);

    drain.start(DrainTrigger.TaskStopping);
    drain.start(DrainTrigger.Sigterm);
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(close).not.toHaveBeenCalled();
    expect(sockets[0]?.emit).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledOnce();
    expect(order).toEqual(["flush", "exit:0"]);
  });

  it("ignores a second trigger while draining", () => {
    vi.useFakeTimers();
    const { io, sockets } = fakeServer(1);
    const { drain } = drainOver(io, () => 0);

    drain.start(DrainTrigger.TaskStopping);
    drain.start(DrainTrigger.Sigterm);

    expect(sockets[0]?.emit).toHaveBeenCalledOnce();
  });
});
describe("draining a live instance", () => {
  let edge: EdgeHarness;
  const clients: ClientSocket[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.disconnect();
    }
    await edge.close();
  });

  it("sends rt:drain, refuses new handshakes rate_limited, and exits once the last client leaves", async () => {
    const exitCodes: number[] = [];
    const httpServer = createServer();
    const { io, drain } = composeRealtimeService(
      httpServer,
      {
        tokenPublicKeys: TEST_PUBLIC_KEYS,
        pingTimeoutMs: undefined,
        allowedOrigins: [ALLOWED_ORIGIN],
        drainWindowMs: 60_000,
      },
      {
        random: () => 0.5,
        flushTelemetry: async () => undefined,
        exit: (code) => exitCodes.push(code),
        revocations: createRevocations(),
      }
    );
    edge = await listenEdge(httpServer, io);
    const { client } = await welcomedClient(
      edge.url,
      await tokenFor(ORG_A, USER_A),
      clients
    );
    const drainHint = nextEvent<DrainPayload>(client, RealtimeEvent.Drain);

    drain.start(DrainTrigger.Sigterm);

    expect(await drainHint).toEqual({ afterMs: 35_500 });
    const refused = openClient(
      edge.url,
      validAuth(await tokenFor(ORG_A, USER_A))
    );
    clients.push(refused);
    expect(await connectError(refused)).toEqual({
      code: RealtimeErrorCode.RateLimited,
    });
    client.disconnect();
    await vi.waitFor(() => expect(exitCodes).toEqual([0]));
  });

  it("on task_stopping, drops a straggler's transport at the window's end, keeps answering /health 200 and refusing handshakes until SIGTERM", async () => {
    const exitCodes: number[] = [];
    const httpServer = realtimeHttpServer({ readiness: createReadiness([]) });
    const { io, drain } = composeRealtimeService(
      httpServer,
      { ...SERVICE_CONFIG, drainWindowMs: 200 },
      {
        random: () => 0.5,
        flushTelemetry: async () => undefined,
        exit: (code) => exitCodes.push(code),
        revocations: createRevocations(),
      }
    );
    edge = await listenEdge(httpServer, io);
    const { client } = await welcomedClient(
      edge.url,
      await tokenFor(ORG_A, USER_A),
      clients
    );
    const dropped = nextEvent<string>(client, "disconnect");

    drain.start(DrainTrigger.TaskStopping);

    expect(await dropped).toBe("transport close");
    const refused = openClient(
      edge.url,
      validAuth(await tokenFor(ORG_A, USER_A))
    );
    clients.push(refused);
    expect(await connectError(refused)).toEqual({
      code: RealtimeErrorCode.RateLimited,
    });
    // The load balancer's and the container's health check (both /health)
    // must keep passing while the target drains.
    expect((await fetch(edge.url + HealthPath.Health)).status).toBe(200);
    expect(exitCodes).toEqual([]);

    drain.start(DrainTrigger.Sigterm);
    await vi.waitFor(() => expect(exitCodes).toEqual([0]));
  });

  it("ends the LISTEN connection it started before it flushes telemetry and exits", async () => {
    const order: string[] = [];
    const httpServer = createServer();
    let startedOn: RealtimeServer | undefined;
    const { io, drain } = composeRealtimeService(httpServer, SERVICE_CONFIG, {
      random: () => 0.5,
      revocations: createRevocations(),
      flushTelemetry: () => {
        order.push("flush");
        return Promise.resolve();
      },
      exit: (code) => order.push(`exit:${code}`),
      startSignals: (server) => {
        startedOn = server;
        return {
          stop: () => {
            order.push("stop");
            return Promise.resolve();
          },
        };
      },
    });
    edge = await listenEdge(httpServer, io);

    expect(startedOn).toBe(io);
    drain.start(DrainTrigger.Sigterm);

    await vi.waitFor(() => expect(order).toEqual(["stop", "flush", "exit:0"]));
  });
});

describe("the composed service's shutdown", () => {
  it("flushes telemetry once the LISTEN connection's stop has had its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const flushTelemetry = vi.fn(async () => undefined);
    const { io, shutdown } = composeRealtimeService(
      createServer(),
      SERVICE_CONFIG,
      {
        random: () => 0.5,
        flushTelemetry,
        exit: vi.fn(),
        revocations: createRevocations(),
        startSignals: () => ({
          stop: () => new Promise<void>(() => undefined),
        }),
      }
    );

    const done = shutdown();
    await vi.advanceTimersByTimeAsync(LISTENER_STOP_TIMEOUT_MS - 1);
    expect(flushTelemetry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(flushTelemetry).toHaveBeenCalledOnce();
    io.close();
  });
});

const SERVICE_CONFIG: RealtimeServiceConfig = {
  tokenPublicKeys: TEST_PUBLIC_KEYS,
  pingTimeoutMs: undefined,
  allowedOrigins: [ALLOWED_ORIGIN],
  drainWindowMs: 60_000,
};
