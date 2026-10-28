import { Server } from "socket.io";
import {
  desktopBrowserBridgeErrorReason,
  desktopBrowserBridgeEvent,
  desktopBrowserBridgeHostExpiredMessage,
  desktopBrowserBridgeHostRejoinWindowMs,
  desktopBrowserBridgeInvalidRequestMessage,
  desktopBrowserBridgeMinimumTokenLength,
  desktopBrowserBridgePath,
  desktopBrowserBridgePayloadTooLargeMessage,
  desktopBrowserBridgeRequestTooLargeMessage,
  desktopBrowserBridgeRole,
} from "../src/shared/desktop-browser-bridge-contract.mjs";
import {
  classifyBridgeRequest,
  desktopBrowserBridgeLimits,
  desktopBrowserBridgeRequestOutcome,
  isWithinBridgePayloadLimit,
  parseBridgeCallback,
  parseBridgeManifest,
  parseBridgeResponse,
} from "../src/shared/desktop-browser-bridge-schema.mjs";

/**
 * Attach the development-only Desktop browser bridge to the renderer's Vite
 * server. The broker never invokes Electron IPC itself. It only relays between
 * the one trusted Electron renderer host and authenticated browser clients.
 */
export function startDesktopBrowserBridgeServer(options) {
  const { allowedOrigin, clientToken, hostToken, httpServer } = options;
  // Injected rather than faked: engine.io's ping/timeout machinery runs on the
  // same timers a fake clock would freeze, so a test that moved the global clock
  // would stop the transport it is driving.
  const now = options.now ?? (() => Date.now());
  if (!isLoopbackOrigin(allowedOrigin)) {
    throw new Error("Desktop browser bridge requires a loopback Vite origin");
  }
  if (!(isLaunchToken(hostToken) && isLaunchToken(clientToken))) {
    throw new Error("Desktop browser bridge requires 256-bit launch tokens");
  }
  if (hostToken === clientToken) {
    throw new Error("Desktop browser bridge roles need distinct tokens");
  }
  // Per ROLE, so the two capabilities cannot be swapped: the host token admits
  // only the single relay host, and reading any data requires the client token,
  // which never reaches the served bundle.
  const roleTokens = Object.freeze({
    [desktopBrowserBridgeRole.Client]: clientToken,
    [desktopBrowserBridgeRole.Host]: hostToken,
  });

  const io = new Server(httpServer, {
    allowRequest: (request, callback) => {
      callback(null, request.headers.origin === allowedOrigin);
    },
    // The transport cap has to sit ABOVE the bridge's own, or engine.io closes
    // the host connection on an over-limit response and the refusal can never
    // be correlated back to the request that caused it (ISS-8249). Both are
    // BYTES: `payloadBytes` is measured in the unit this option counts, so the
    // headroom below is real rather than an artefact of two different units.
    maxHttpBufferSize: desktopBrowserBridgeLimits.payloadBytes * 2,
    path: desktopBrowserBridgePath,
    serveClient: false,
    transports: ["websocket"],
  });

  let hostSocketId = null;
  let manifest = null;
  /**
   * ISS-8412: the deadline the host token stops admitting a host at. Armed when
   * the token is MINTED and replaced on every host disconnect, so it bounds
   * every stretch where the slot is unheld and a captured token is the only
   * thing that could take it — the mint-to-first-handshake stretch as much as
   * each disconnect-to-rejoin one. While a host IS connected the single-host
   * rule already refuses a second. Arming only on disconnect left the first
   * stretch unbounded: an Electron that never completed a handshake kept its
   * mint admissible for the life of the Vite server, and the environment this
   * token now rides is still readable by a same-user debugger or a crash dump.
   *
   * The initial window has to outlast the launcher's post-server build steps
   * (`prebuild`, `db:generate`, `build:main:dev`), which run between this call
   * and the Electron spawn that connects.
   */
  let hostRejoinDeadline = now() + desktopBrowserBridgeHostRejoinWindowMs;

  io.use((socket, next) => {
    const auth = socket.handshake.auth;
    if (!isRecord(auth)) {
      next(new Error("Desktop browser bridge authentication failed"));
      return;
    }

    const role = auth.role;
    if (
      role !== desktopBrowserBridgeRole.Host &&
      role !== desktopBrowserBridgeRole.Client
    ) {
      next(new Error("Desktop browser bridge role is invalid"));
      return;
    }
    if (auth.token !== roleTokens[role]) {
      next(new Error("Desktop browser bridge authentication failed"));
      return;
    }
    if (role === desktopBrowserBridgeRole.Host && hostSocketId !== null) {
      next(new Error("Desktop browser bridge already has a host"));
      return;
    }
    if (role === desktopBrowserBridgeRole.Host && now() > hostRejoinDeadline) {
      next(new Error(desktopBrowserBridgeHostExpiredMessage));
      return;
    }

    socket.data.role = role;
    if (role === desktopBrowserBridgeRole.Host) {
      hostSocketId = socket.id;
    }
    next();
  });

  io.on("connection", (socket) => {
    const role = socket.data.role;
    if (role === desktopBrowserBridgeRole.Host) {
      registerHostSocket(socket);
      return;
    }
    registerClientSocket(socket);
  });

  return {
    close: async () => {
      await io.close();
    },
  };

  function registerHostSocket(socket) {
    socket.on(desktopBrowserBridgeEvent.manifest, (candidate) => {
      // The PARSED value, never `candidate`. Zod strips unknown keys, so
      // validating and then relaying the raw envelope validates one object and
      // forwards a different one — every field the schema rejected still
      // crosses, and here it would also be cached in `manifest` and replayed to
      // every client that joins later.
      const parsed = parseBridgeManifest(candidate);
      if (parsed === null) {
        return;
      }
      manifest = parsed;
      io.to(CLIENT_ROOM).emit(desktopBrowserBridgeEvent.manifest, manifest);
    });

    socket.on(desktopBrowserBridgeEvent.response, (payload) => {
      const response = parseBridgeResponse(payload);
      if (response === null) {
        return;
      }
      // ISS-8249: a valid response the size cap refuses used to be dropped here
      // with no emit, so the caller learned about it only when its own 30s
      // window elapsed and reported a timeout — a different fact entirely. The
      // cap stays; the refusal is now correlated back to the request.
      //
      // The HOST refuses first, before it emits (`handleHostRequest`), because a
      // frame that reaches this handler has already crossed the transport and an
      // over-cap one never would. This arm is the second line: it still answers
      // a peer host that does not check, and it is what the broker's own
      // contract test drives.
      if (!isWithinBridgePayloadLimit(response)) {
        io.to(response.clientId).emit(desktopBrowserBridgeEvent.response, {
          clientId: response.clientId,
          error: {
            message: desktopBrowserBridgePayloadTooLargeMessage,
            reason: desktopBrowserBridgeErrorReason.PayloadTooLarge,
          },
          requestId: response.requestId,
        });
        return;
      }
      io.to(response.clientId).emit(
        desktopBrowserBridgeEvent.response,
        response
      );
    });

    socket.on(desktopBrowserBridgeEvent.callback, (payload) => {
      const callback = parseBridgeCallback(payload);
      if (callback === null || !isWithinBridgePayloadLimit(callback)) {
        return;
      }
      io.to(callback.clientId).emit(
        desktopBrowserBridgeEvent.callback,
        callback
      );
    });

    socket.on("disconnect", () => {
      if (hostSocketId !== socket.id) {
        return;
      }
      hostSocketId = null;
      manifest = null;
      hostRejoinDeadline = now() + desktopBrowserBridgeHostRejoinWindowMs;
      io.to(CLIENT_ROOM).emit(desktopBrowserBridgeEvent.hostDisconnected);
    });
  }

  function registerClientSocket(socket) {
    socket.join(CLIENT_ROOM);
    if (manifest !== null) {
      socket.emit(desktopBrowserBridgeEvent.manifest, manifest);
    }

    socket.on(desktopBrowserBridgeEvent.request, (payload) => {
      const classified = classifyBridgeRequest(payload);
      // ISS-8413, ISS-8249's defect one direction over. A request the size cap
      // or the schema refused used to `return` here with no emit, so the caller
      // learned nothing until its own 30s window elapsed and reported a
      // timeout — the one thing that had NOT happened, and the reading that
      // makes the obvious next move (retry) exactly wrong.
      if (classified.outcome !== desktopBrowserBridgeRequestOutcome.Accepted) {
        refuseClientRequest(socket, payload, classified.outcome);
        return;
      }
      const request = classified.request;
      if (hostSocketId === null) {
        socket.emit(desktopBrowserBridgeEvent.response, {
          clientId: socket.id,
          error: {
            message: "Desktop browser bridge host is unavailable",
            reason: desktopBrowserBridgeErrorReason.HostUnavailable,
          },
          requestId: request.requestId,
        });
        return;
      }
      // Spread the PARSED request, not `payload`. The schema bounds `args`, but
      // Zod strips rather than rejects unknown keys, so relaying the raw
      // envelope let a token holder hang arbitrary unvalidated fields off it and
      // have the broker forward them to the host under the transport cap.
      io.to(hostSocketId).emit(desktopBrowserBridgeEvent.request, {
        ...request,
        clientId: socket.id,
      });
    });

    socket.on("disconnect", () => {
      if (hostSocketId === null) {
        return;
      }
      io.to(hostSocketId).emit(desktopBrowserBridgeEvent.clientDisconnected, {
        clientId: socket.id,
      });
    });
  }
}

function isLaunchToken(value) {
  return (
    typeof value === "string" &&
    value.length >= desktopBrowserBridgeMinimumTokenLength
  );
}

function isLoopbackOrigin(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CLIENT_ROOM = "desktop-browser-bridge:clients";

/**
 * Answer a refused client request on the id it arrived with.
 *
 * The id comes off the RAW envelope because a refusal is precisely the case
 * where no parsed request exists to read it from. A payload carrying no usable
 * id has nothing to correlate to, so it is still dropped — the caller it came
 * from cannot be identified, and inventing an id would settle some other
 * in-flight request with this one's failure.
 *
 * The id is echoed off an envelope that did NOT validate, and the broker does
 * not track which ids a client holds in flight, so a client that reuses one of
 * its own live ids on a refused frame settles that request early and sees the
 * real answer dropped as unknown. The blast radius is the sending socket alone
 * — this is `socket.emit`, never a broadcast — and the renderer mints a
 * `crypto.randomUUID()` per request, so it cannot collide in practice. Tracking
 * ids here would mean an unbounded map keyed on external input, which is the
 * worse trade.
 */
function refuseClientRequest(socket, payload, outcome) {
  const requestId = readRefusableRequestId(payload);
  if (requestId === null) {
    return;
  }
  socket.emit(desktopBrowserBridgeEvent.response, {
    clientId: socket.id,
    error: clientRequestRefusalError(outcome),
    requestId,
  });
}

function clientRequestRefusalError(outcome) {
  if (outcome === desktopBrowserBridgeRequestOutcome.TooLarge) {
    return {
      message: desktopBrowserBridgeRequestTooLargeMessage,
      reason: desktopBrowserBridgeErrorReason.PayloadTooLarge,
    };
  }
  return {
    message: desktopBrowserBridgeInvalidRequestMessage,
    reason: desktopBrowserBridgeErrorReason.InvalidRequest,
  };
}

function readRefusableRequestId(payload) {
  if (!isRecord(payload)) {
    return null;
  }
  const requestId = payload.requestId;
  const isUsable =
    typeof requestId === "string" &&
    requestId.length > 0 &&
    requestId.length <= desktopBrowserBridgeLimits.identifierLength;
  if (isUsable) {
    return requestId;
  }
  return null;
}
