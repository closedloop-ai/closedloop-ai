import { log } from "@repo/observability/log";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { RealtimeEvent } from "@repo/realtime-contract/protocol";
import type { Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Admission, ConnectionAdmitter } from "../edge/admission";
import {
  connectError,
  type EdgeHarness,
  nextEvent,
  ORG_A,
  openClient,
  startComposedEdge,
  startEdge,
  tokenFor,
  USER_A,
  validAuth,
} from "./edge-harness";

let edge: EdgeHarness | undefined;
const clients: ClientSocket[] = [];

beforeEach(() => {
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) {
    client.disconnect();
  }
  await edge?.close();
  edge = undefined;
});

function admitterReturning(admission: () => Promise<Admission>) {
  const admit = vi.fn(admission);
  const admitter: ConnectionAdmitter = { admit };
  return { admitter, admit };
}

function open(token: string): ClientSocket {
  if (!edge) {
    throw new Error("edge not started");
  }
  const client = openClient(edge.url, validAuth(token));
  clients.push(client);
  return client;
}

describe("connection admission in the handshake", () => {
  it("refuses a connection over a cap with rate_limited, after the claims are verified", async () => {
    const { admitter, admit } = admitterReturning(async () => ({
      admitted: false,
    }));
    edge = await startEdge({ admitter });

    const client = open(await tokenFor(ORG_A, USER_A));

    expect(await connectError(client)).toEqual({
      code: RealtimeErrorCode.RateLimited,
    });
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({ sub: USER_A, org: ORG_A })
    );
  });

  it("refuses over a cap through the service as production composes it", async () => {
    const { admitter, admit } = admitterReturning(async () => ({
      admitted: false,
    }));
    edge = await startComposedEdge({ admitter });

    const client = open(await tokenFor(ORG_A, USER_A));

    expect(await connectError(client)).toEqual({
      code: RealtimeErrorCode.RateLimited,
    });
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("never asks the admitter about a handshake the token check refused", async () => {
    const { admitter, admit } = admitterReturning(async () => ({
      admitted: false,
    }));
    edge = await startEdge({ admitter });

    const client = open("not-a-token");

    expect(await connectError(client)).toEqual({
      code: RealtimeErrorCode.Unauthorized,
    });
    expect(admit).not.toHaveBeenCalled();
  });

  it("releases an admitted connection exactly once when it disconnects", async () => {
    const release = vi.fn();
    const { admitter } = admitterReturning(async () => ({
      admitted: true,
      release,
    }));
    edge = await startEdge({ admitter });
    const client = open(await tokenFor(ORG_A, USER_A));
    await nextEvent(client, RealtimeEvent.Welcome);
    expect(release).not.toHaveBeenCalled();

    const [serverSocket] = [...edge.io.of("/").sockets.values()];
    const disconnected = new Promise((resolve) =>
      serverSocket?.once("disconnect", resolve)
    );
    client.disconnect();
    await disconnected;
    await new Promise((resolve) => setImmediate(resolve));

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases an admission whose client left before the handshake completed", async () => {
    const release = vi.fn();
    let admitNow: () => void = () => undefined;
    const { admitter, admit } = admitterReturning(
      () =>
        new Promise<Admission>((resolve) => {
          admitNow = () => resolve({ admitted: true, release });
        })
    );
    edge = await startEdge({ admitter });
    const client = open(await tokenFor(ORG_A, USER_A));
    await vi.waitFor(() => expect(admit).toHaveBeenCalled());

    client.disconnect();
    await vi.waitFor(() => expect(edge?.io.engine.clientsCount ?? 0).toBe(0));
    admitNow();

    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(edge.io.of("/").sockets.size).toBe(0);
  });
});
