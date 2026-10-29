import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io, type Socket } from "socket.io-client";
import { test } from "vitest";
import { startDesktopBrowserBridgeServer } from "../scripts/desktop-browser-bridge-server.mjs";
import {
  desktopBrowserBridgeErrorReason,
  desktopBrowserBridgeEvent,
  desktopBrowserBridgeHostRejoinWindowMs,
  desktopBrowserBridgePath,
  desktopBrowserBridgeRole,
} from "../src/shared/desktop-browser-bridge-contract.mjs";

test("desktop browser bridge authenticates and relays only through its sole host", async () => {
  const fixture = await startFixture();
  const sockets: Socket[] = [];

  try {
    await assert.rejects(
      connectSocket(fixture.origin, {
        role: desktopBrowserBridgeRole.Client,
        token: "x".repeat(43),
      })
    );
    await assert.rejects(
      connectSocket(
        fixture.origin,
        {
          role: desktopBrowserBridgeRole.Client,
          token: fixture.clientToken,
        },
        "http://127.0.0.1:65535"
      )
    );

    const host = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Host,
      token: fixture.hostToken,
    });
    const client = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Client,
      token: fixture.clientToken,
    });
    sockets.push(host, client);

    await assert.rejects(
      connectSocket(fixture.origin, {
        role: desktopBrowserBridgeRole.Host,
        token: fixture.hostToken,
      })
    );

    const manifest = {
      entries: { getSettings: { kind: "method" } },
      kind: "object",
    };
    const manifestReceived = waitForEvent(
      client,
      desktopBrowserBridgeEvent.manifest
    );
    host.emit(desktopBrowserBridgeEvent.manifest, manifest);
    assert.deepEqual(await manifestReceived, manifest);

    const hostRequest = waitForEvent(host, desktopBrowserBridgeEvent.request);
    const clientResponse = waitForEvent(
      client,
      desktopBrowserBridgeEvent.response
    );
    client.emit(desktopBrowserBridgeEvent.request, {
      args: [],
      kind: "invoke",
      path: ["getSettings"],
      requestId: "request-1",
    });
    const request = await hostRequest;
    assert.equal(request.requestId, "request-1");
    assert.equal(typeof request.clientId, "string");
    host.emit(desktopBrowserBridgeEvent.response, {
      clientId: request.clientId,
      requestId: request.requestId,
      result: { theme: "dark" },
    });
    assert.deepEqual(await clientResponse, {
      clientId: request.clientId,
      requestId: "request-1",
      result: { theme: "dark" },
    });

    const hostDisconnected = waitForEvent(
      client,
      desktopBrowserBridgeEvent.hostDisconnected
    );
    host.disconnect();
    await hostDisconnected;
  } finally {
    for (const socket of sockets) {
      socket.disconnect();
    }
    await fixture.close();
  }
});

test("desktop browser bridge refuses a reader holding anything but the client token", async () => {
  const fixture = await startFixture();

  try {
    // The read capability is what the browser tab holds, and its token reaches
    // only the tab the launcher printed a URL for. A local process that scraped
    // the served bundle has no token at all, and even the host credential —
    // the strongest thing any served asset could carry — buys no reads.
    await assert.rejects(
      connectSocket(fixture.origin, {
        role: desktopBrowserBridgeRole.Client,
        token: fixture.hostToken,
      })
    );
    await assert.rejects(
      connectSocket(fixture.origin, {
        role: desktopBrowserBridgeRole.Client,
        token: "",
      })
    );
    // Nor does the reader's token let anyone displace the sole relay host.
    await assert.rejects(
      connectSocket(fixture.origin, {
        role: desktopBrowserBridgeRole.Host,
        token: fixture.clientToken,
      })
    );
  } finally {
    await fixture.close();
  }
});

test("desktop browser bridge refuses to start without two distinct tokens", () => {
  const httpServer = createServer();
  const token = "a".repeat(43);

  assert.throws(() =>
    startDesktopBrowserBridgeServer({
      allowedOrigin: "http://127.0.0.1:5173",
      clientToken: token,
      hostToken: token,
      httpServer,
    })
  );
  assert.throws(() =>
    startDesktopBrowserBridgeServer({
      allowedOrigin: "http://127.0.0.1:5173",
      clientToken: "short",
      hostToken: token,
      httpServer,
    })
  );
});

/**
 * The broker relays what it PARSED, not what it received.
 *
 * Zod strips unknown keys rather than rejecting them, so validating `payload`
 * and then forwarding `payload` validates one object and relays a different
 * one: every field the schema does not know still crossed, and the schema's
 * bound on `args` said nothing about them. A token holder could therefore hang
 * arbitrary unvalidated bulk off the envelope and have the broker carry it to
 * the host under the transport cap.
 */
test("desktop browser bridge relays the parsed request, not the client's envelope", async () => {
  const fixture = await startFixture();
  const sockets: Socket[] = [];

  try {
    const host = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Host,
      token: fixture.hostToken,
    });
    const client = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Client,
      token: fixture.clientToken,
    });
    sockets.push(host, client);

    const hostRequest = waitForEvent(host, desktopBrowserBridgeEvent.request);
    client.emit(desktopBrowserBridgeEvent.request, {
      args: [],
      kind: "invoke",
      path: ["db", "getSessions"],
      requestId: "request-smuggled",
      smuggled: "x".repeat(SMUGGLED_FIELD_LENGTH),
    });
    const request = await hostRequest;

    assert.equal(request.requestId, "request-smuggled");
    assert.equal(
      Object.hasOwn(request, "smuggled"),
      false,
      "the broker forwarded a field the schema stripped"
    );
    assert.deepEqual(Object.keys(request).sort(), [
      "args",
      "clientId",
      "kind",
      "path",
      "requestId",
    ]);
  } finally {
    for (const socket of sockets) {
      socket.disconnect();
    }
    await fixture.close();
  }
});

test("desktop browser bridge answers an over-limit response with a correlated size refusal", async () => {
  const fixture = await startFixture();
  const sockets: Socket[] = [];

  try {
    const host = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Host,
      token: fixture.hostToken,
    });
    const client = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Client,
      token: fixture.clientToken,
    });
    sockets.push(host, client);

    const hostRequest = waitForEvent(host, desktopBrowserBridgeEvent.request);
    const clientResponse = waitForEvent(
      client,
      desktopBrowserBridgeEvent.response
    );
    client.emit(desktopBrowserBridgeEvent.request, {
      args: [],
      kind: "invoke",
      path: ["db", "getSessionsWithDetails"],
      requestId: "request-oversized",
    });
    const request = await hostRequest;
    host.emit(desktopBrowserBridgeEvent.response, {
      clientId: request.clientId,
      requestId: request.requestId,
      result: { rows: "x".repeat(OVER_LIMIT_RESULT_LENGTH) },
    });

    // The caller learns the size refused it, on its own request, rather than
    // waiting out its 30s window and being told the host timed out.
    const response = await clientResponse;
    assert.equal(response.requestId, "request-oversized");
    assert.deepEqual(response.error, {
      message: "Desktop browser bridge response exceeds the size limit",
      reason: desktopBrowserBridgeErrorReason.PayloadTooLarge,
    });
    assert.equal(response.result, undefined);
  } finally {
    for (const socket of sockets) {
      socket.disconnect();
    }
    await fixture.close();
  }
});

/**
 * ISS-8413, the request direction of the ISS-8249 refusal above. Over a real
 * socket, because the premise under test is a TRANSPORT ordering: the bridge's
 * own 2 MB cap can only refuse a frame engine.io let through, and
 * `maxHttpBufferSize` sits at twice that, so a request between the two reaches
 * the handler instead of closing the socket underneath it.
 */
test("desktop browser bridge answers an over-limit request with a correlated size refusal", async () => {
  const fixture = await startFixture();
  const sockets: Socket[] = [];

  try {
    const host = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Host,
      token: fixture.hostToken,
    });
    const client = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Client,
      token: fixture.clientToken,
    });
    sockets.push(host, client);

    // Registered BEFORE the oversized frame is emitted, and that ordering is
    // the whole point (davetho review). Socket.IO does not replay, so a
    // listener attached after the refusal resolves cannot observe a frame that
    // was already forwarded — an implementation that refused the client AND
    // still relayed to the host would satisfy it with the later normal request.
    const relayedRequestIds: unknown[] = [];
    host.on(
      desktopBrowserBridgeEvent.request,
      (payload: Record<string, unknown> = {}) => {
        relayedRequestIds.push(payload.requestId);
      }
    );

    const refusal = waitForEvent(client, desktopBrowserBridgeEvent.response);
    client.emit(desktopBrowserBridgeEvent.request, {
      args: [{ rows: "x".repeat(OVER_LIMIT_RESULT_LENGTH) }],
      kind: "invoke",
      path: ["db", "getSessionsWithDetails"],
      requestId: "request-oversized-ingress",
    });

    // The caller is told the size refused it, on its own request, rather than
    // being left to wait out its 30s window and be told the host timed out.
    const response = await refusal;
    assert.equal(response.requestId, "request-oversized-ingress");
    assert.deepEqual(response.error, {
      message: "Desktop browser bridge request exceeds the size limit",
      reason: desktopBrowserBridgeErrorReason.PayloadTooLarge,
    });
    assert.equal(response.result, undefined);

    // The sibling that keeps the refusal above from passing vacuously: a
    // normal-sized request still relays and still answers. It doubles as the
    // ORDERING BARRIER for the relay record below — the client emits on one
    // socket, so Socket.IO delivers in order, and a forwarded oversized frame
    // necessarily arrives before this one. No sleep is needed to prove the
    // absence.
    const hostRequest = waitForEvent(host, desktopBrowserBridgeEvent.request);
    const answered = waitForEvent(client, desktopBrowserBridgeEvent.response);
    client.emit(desktopBrowserBridgeEvent.request, {
      args: [],
      kind: "invoke",
      path: ["db", "getSessionsWithDetails"],
      requestId: "request-normal",
    });
    const relayed = await hostRequest;
    assert.equal(relayed.requestId, "request-normal");
    // The refusal kept the oversized frame OUT of the host, which is the claim
    // this test exists to make. Asserted over the whole relay record rather than
    // the first entry, so it fails whether a leak arrives before or after.
    assert.deepEqual(relayedRequestIds, ["request-normal"]);
    host.emit(desktopBrowserBridgeEvent.response, {
      clientId: relayed.clientId,
      requestId: relayed.requestId,
      result: { rows: [] },
    });

    const success = await answered;
    assert.equal(success.requestId, "request-normal");
    assert.deepEqual(success.result, { rows: [] });
    assert.equal(success.error, undefined);
  } finally {
    for (const socket of sockets) {
      socket.disconnect();
    }
    await fixture.close();
  }
});

test("desktop browser bridge answers a malformed request with a correlated shape refusal", async () => {
  const fixture = await startFixture();
  const sockets: Socket[] = [];

  try {
    const host = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Host,
      token: fixture.hostToken,
    });
    const client = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Client,
      token: fixture.clientToken,
    });
    sockets.push(host, client);

    const refusal = waitForEvent(client, desktopBrowserBridgeEvent.response);
    client.emit(desktopBrowserBridgeEvent.request, {
      args: [],
      kind: "invoke",
      path: [],
      requestId: "request-malformed",
    });

    const response = await refusal;
    assert.equal(response.requestId, "request-malformed");
    assert.deepEqual(response.error, {
      message: "Desktop browser bridge request is invalid",
      reason: desktopBrowserBridgeErrorReason.InvalidRequest,
    });

    // A refusal with no id to answer on is still dropped, because settling some
    // OTHER in-flight request with this one's failure is the worse answer. Read
    // as an ordering rather than a wait: the next response the client receives
    // is the identified request's, so the id-less one produced none.
    const identified = waitForEvent(client, desktopBrowserBridgeEvent.response);
    client.emit(desktopBrowserBridgeEvent.request, {
      args: [],
      kind: "invoke",
      path: [],
    });
    client.emit(desktopBrowserBridgeEvent.request, {
      args: [],
      kind: "invoke",
      path: [],
      requestId: "request-malformed-identified",
    });
    assert.equal((await identified).requestId, "request-malformed-identified");
  } finally {
    for (const socket of sockets) {
      socket.disconnect();
    }
    await fixture.close();
  }
});

test("desktop browser bridge refuses a manifest deeper than the shared schema allows", async () => {
  const fixture = await startFixture();
  const sockets: Socket[] = [];

  try {
    const host = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Host,
      token: fixture.hostToken,
    });
    const client = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Client,
      token: fixture.clientToken,
    });
    sockets.push(host, client);

    const manifestReceived = waitForEvent(
      client,
      desktopBrowserBridgeEvent.manifest
    );
    host.emit(desktopBrowserBridgeEvent.manifest, nestedManifest(13));
    host.emit(desktopBrowserBridgeEvent.manifest, SHALLOW_MANIFEST);

    // The over-deep one is dropped and the next valid one still relays — the
    // renderer parses the same schema, so neither side accepts what the other
    // rejects.
    assert.deepEqual(await manifestReceived, SHALLOW_MANIFEST);
  } finally {
    for (const socket of sockets) {
      socket.disconnect();
    }
    await fixture.close();
  }
});

/**
 * ISS-8412: a launch token that outlives the session it was minted for stops
 * admitting a host.
 *
 * The window opens only while NO host holds the bridge, which is the only
 * stretch where a captured token could take the host slot — a connected host
 * already refuses a second one. The clock is injected rather than faked because
 * engine.io's ping/timeout machinery runs on the same timers a fake clock would
 * freeze, and this suite is driving that transport.
 */
test("desktop browser bridge stops admitting a host once its rejoin window elapses", async () => {
  let clock = 1_000_000;
  const fixture = await startFixture({ now: () => clock });
  const sockets: Socket[] = [];

  try {
    const host = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Host,
      token: fixture.hostToken,
    });
    const client = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Client,
      token: fixture.clientToken,
    });
    sockets.push(client);

    // The broker arms the window in the same handler that raises this, so the
    // event is the signal that the disconnect has been accounted for.
    const hostDisconnected = waitForEvent(
      client,
      desktopBrowserBridgeEvent.hostDisconnected
    );
    host.disconnect();
    await hostDisconnected;

    clock += desktopBrowserBridgeHostRejoinWindowMs + 1;
    await assert.rejects(
      connectSocket(fixture.origin, {
        role: desktopBrowserBridgeRole.Host,
        token: fixture.hostToken,
      }),
      EXPIRED_HOST_TOKEN_REFUSAL,
      "an expired launch token still minted an authorized bridge host"
    );
    // The reader's own token is unaffected: expiry governs who may HOLD the
    // bridge, not who may read through a host that holds it.
    sockets.push(
      await connectSocket(fixture.origin, {
        role: desktopBrowserBridgeRole.Client,
        token: fixture.clientToken,
      })
    );
  } finally {
    for (const socket of sockets) {
      socket.disconnect();
    }
    await fixture.close();
  }
});

/**
 * The half that keeps the window from breaking the thing it protects: a socket
 * drop and an Electron renderer reload both reconnect in seconds, and each
 * successful admission closes the window again.
 */
test("desktop browser bridge readmits a host inside the window and rearms it", async () => {
  let clock = 1_000_000;
  const fixture = await startFixture({ now: () => clock });
  const sockets: Socket[] = [];

  try {
    const firstHost = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Host,
      token: fixture.hostToken,
    });
    const client = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Client,
      token: fixture.clientToken,
    });
    sockets.push(client);

    const firstGone = waitForEvent(
      client,
      desktopBrowserBridgeEvent.hostDisconnected
    );
    firstHost.disconnect();
    await firstGone;

    clock += desktopBrowserBridgeHostRejoinWindowMs - 1;
    const secondHost = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Host,
      token: fixture.hostToken,
    });

    // Past the FIRST disconnect's deadline, and still admitted: the second
    // admission closed that window rather than merely surviving it.
    clock += 2;
    const secondGone = waitForEvent(
      client,
      desktopBrowserBridgeEvent.hostDisconnected
    );
    secondHost.disconnect();
    await secondGone;

    const thirdHost = await connectSocket(fixture.origin, {
      role: desktopBrowserBridgeRole.Host,
      token: fixture.hostToken,
    });
    sockets.push(thirdHost);
  } finally {
    for (const socket of sockets) {
      socket.disconnect();
    }
    await fixture.close();
  }
});

/**
 * The stretch arming-on-disconnect alone left uncovered: a mint whose Electron
 * never completes a first handshake. Nothing has disconnected, so a deadline
 * armed only there never exists, and the token stays admissible for the life of
 * the Vite server — which is the whole window a reader of the environment it
 * now rides in would be working inside.
 */
test("desktop browser bridge stops admitting a first host once the mint window elapses", async () => {
  let clock = 1_000_000;
  const fixture = await startFixture({ now: () => clock });
  const sockets: Socket[] = [];

  try {
    clock += desktopBrowserBridgeHostRejoinWindowMs + 1;
    await assert.rejects(
      connectSocket(fixture.origin, {
        role: desktopBrowserBridgeRole.Host,
        token: fixture.hostToken,
      }),
      EXPIRED_HOST_TOKEN_REFUSAL,
      "a host token that never held the bridge outlived its mint window"
    );
    // Same separation the post-disconnect expiry keeps: the window governs who
    // may HOLD the bridge, and the reader's own token is untouched by it.
    sockets.push(
      await connectSocket(fixture.origin, {
        role: desktopBrowserBridgeRole.Client,
        token: fixture.clientToken,
      })
    );
  } finally {
    for (const socket of sockets) {
      socket.disconnect();
    }
    await fixture.close();
  }
});

/**
 * The half that keeps the mint window from breaking the launch it protects: the
 * launcher rebuilds `prebuild`, `db:generate` and `build:main:dev` between
 * creating the broker and spawning Electron, so the first handshake lands some
 * way into the window and still has to be admitted.
 */
test("desktop browser bridge admits a first host inside the mint window", async () => {
  let clock = 1_000_000;
  const fixture = await startFixture({ now: () => clock });
  const sockets: Socket[] = [];

  try {
    clock += desktopBrowserBridgeHostRejoinWindowMs - 1;
    sockets.push(
      await connectSocket(fixture.origin, {
        role: desktopBrowserBridgeRole.Host,
        token: fixture.hostToken,
      })
    );
  } finally {
    for (const socket of sockets) {
      socket.disconnect();
    }
    await fixture.close();
  }
});

function nestedManifest(depth: number): unknown {
  let node: unknown = { kind: "method" };
  for (let level = 0; level < depth; level += 1) {
    node = { entries: { nested: node }, kind: "object" };
  }
  return node;
}

async function startFixture(options?: { now: () => number }): Promise<{
  clientToken: string;
  close: () => Promise<void>;
  hostToken: string;
  origin: string;
}> {
  const httpServer = createServer();
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  const clientToken = "c".repeat(43);
  const hostToken = "h".repeat(43);
  const bridge = startDesktopBrowserBridgeServer({
    allowedOrigin: origin,
    clientToken,
    hostToken,
    httpServer,
    ...(options ? { now: options.now } : {}),
  });

  return {
    clientToken,
    close: () => bridge.close(),
    hostToken,
    origin,
  };
}

function connectSocket(
  origin: string,
  auth: { role: "client" | "host"; token: string },
  requestOrigin = origin
): Promise<Socket> {
  const socket = io(origin, {
    auth,
    extraHeaders: { Origin: requestOrigin },
    forceNew: true,
    path: desktopBrowserBridgePath,
    reconnection: false,
    transports: ["websocket"],
  });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error) => {
      socket.disconnect();
      reject(error);
    });
  });
}

function waitForEvent(
  socket: Socket,
  event: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(new Error(`Timed out waiting for ${event}`));
    }, TEST_TIMEOUT_MS);
    socket.once(event, (payload: Record<string, unknown> = {}) => {
      globalThis.clearTimeout(timeout);
      resolve(payload);
    });
  });
}

const EXPIRED_HOST_TOKEN_REFUSAL = /expired/;
const TEST_TIMEOUT_MS = 5000;
const OVER_LIMIT_RESULT_LENGTH = 2 * 1024 * 1024 + 1024;
/** Comfortably inside the transport cap, so only the stripping is under test. */
const SMUGGLED_FIELD_LENGTH = 1024;
const SHALLOW_MANIFEST = {
  entries: { getSettings: { kind: "method" } },
  kind: "object",
};
