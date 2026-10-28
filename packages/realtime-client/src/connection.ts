import {
  RealtimeErrorCode,
  type RealtimeErrorCode as RealtimeErrorCodeValue,
  toRealtimeErrorCode,
} from "@repo/realtime-contract/error-codes";
import {
  drainPayloadSchema,
  errorPayloadSchema,
  type IssuedRealtimeToken,
  PROTOCOL_VERSION,
  RealtimeEvent,
  type RefreshPayload,
  realtimeServiceUrlSchema,
  refreshAckSchema,
} from "@repo/realtime-contract/protocol";
import { io } from "socket.io-client";
import { z } from "zod";
import { backoffDelayMs, clampTimerDelayMs } from "./backoff";
import { createChannelRegistry } from "./channels";
import { startListenerPoll } from "./poll";
import { type RealtimeClientPort, RealtimeStatus } from "./port";
import {
  type CreateRealtimeSocket,
  RECONNECT_BACKOFF,
  type RealtimeSocket,
  realtimeSocketOptions,
  type SocketAuth,
} from "./socket";
import { createStatusStore } from "./status";
import { createTokenRefresher, type TokenLifetime } from "./token-refresh";

export type SocketIoRealtimeClientOptions = {
  /**
   * The service URL to use when a token names none and the client is on no
   * URL yet, e.g.
   * `wss://realtime.example.com`. Only its origin is used: socket.io's path is
   * fixed by the contract.
   */
  url?: string;
  /** `POST /realtime/token`, through the host's own API client. */
  getToken: () => Promise<IssuedRealtimeToken>;
  clientVersion: string;
  /** Defaults to socket.io-client's `io`. */
  createSocket?: CreateRealtimeSocket;
  /** Epoch milliseconds; defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to `Math.random`. */
  random?: () => number;
};

export type RealtimeClient = RealtimeClientPort & {
  /** Disconnects for good and reports `closed`. */
  close: () => void;
};

/**
 * PLN-2106 step 2. One socket at a time, bound to the URL the latest token
 * names (ISS-11210 ask 3), else to the URL it is already on, else to `url`.
 * socket.io reconnects a dropped transport by itself; the reconnects it leaves
 * to the caller (a refused handshake, a server-initiated disconnect, a drain
 * hint, an expired token) are scheduled here.
 */
export function createSocketIoRealtimeClient(
  options: SocketIoRealtimeClientOptions
): RealtimeClient {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const createSocket = options.createSocket ?? io;
  const fallbackUrl = toServiceUrl(options.url);
  const status = createStatusStore();

  let closed = false;
  // What a join after close hears; a host's own close() reads as internal.
  let closedWith: RealtimeErrorCodeValue = RealtimeErrorCode.Internal;
  let everOpen = false;
  let unauthorizedStreak = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let fetchAttempt = 0;
  let handshakeLifetime: TokenLifetime | undefined;
  let socket: RealtimeSocket | undefined;
  let socketUrl: string | undefined;
  // A token fetched to choose a new socket's URL, presented by that socket's
  // first handshake instead of fetching another.
  let prefetched: FetchedToken | undefined;

  const fetchToken = (): Promise<FetchedToken> =>
    options.getToken().then((issued) => ({ issued, receivedAt: now() }));

  /** Bumps the attempt, so a fetch an earlier attempt started is ignored. */
  const nextFetchAttempt = (): (() => boolean) => {
    fetchAttempt += 1;
    const attempt = fetchAttempt;
    const owner = socket;
    return () => !closed && attempt === fetchAttempt && owner === socket;
  };

  const present = (
    fetched: FetchedToken,
    callback: Parameters<SocketAuth>[0]
  ) => {
    handshakeLifetime = {
      expiresAt: fetched.issued.expiresAt,
      receivedAt: fetched.receivedAt,
    };
    callback({
      token: fetched.issued.token,
      protocol: PROTOCOL_VERSION,
      clientVersion: options.clientVersion,
    });
  };

  /**
   * Fetches a token and the URL to use with it: the token's, else the one the
   * socket is already on, else the configured one. With none of the three
   * there is nowhere to connect.
   */
  const fetchEndpoint = (
    onResolved: (url: string, fetched: FetchedToken) => void,
    onFailed: () => void
  ) => {
    const isCurrent = nextFetchAttempt();
    fetchToken().then(
      (fetched) => {
        if (!isCurrent()) {
          return;
        }
        const url =
          toServiceUrl(fetched.issued.url) ?? socketUrl ?? fallbackUrl;
        if (url === undefined) {
          failWithoutUrl();
        } else {
          onResolved(url, fetched);
        }
      },
      () => {
        if (isCurrent()) {
          onFailed();
        }
      }
    );
  };

  const auth: SocketAuth = (callback) => {
    if (prefetched !== undefined) {
      const fetched = prefetched;
      prefetched = undefined;
      present(fetched, callback);
      return;
    }
    fetchEndpoint(
      (url, fetched) => {
        if (url === socketUrl) {
          present(fetched, callback);
        } else {
          // socket.io binds the URL at creation, so a new URL is a new socket.
          openSocket(url, fetched);
        }
      },
      () => {
        // The handshake waits on this callback forever, so abandon the
        // attempt and retry rather than present no token.
        socket?.disconnect();
        reconnectWithBackoff();
      }
    );
  };

  const start = () => fetchEndpoint(openSocket, reconnectWithBackoff);

  const channels = createChannelRegistry(
    {
      isConnected: () => socket?.connected === true,
      isOpen: () => status.get() === RealtimeStatus.Open,
      emit: (event, payload, ack) => {
        if (socket?.connected) {
          socket.emit(event, payload, ...(ack ? [ack] : []));
        }
      },
    },
    { now, random }
  );
  status.subscribe(channels.onStatusChange);

  const refresher = createTokenRefresher({
    getToken: options.getToken,
    now,
    sendRefresh: (token, onAck) => {
      if (!socket?.connected) {
        return;
      }
      const payload: RefreshPayload = { token };
      socket.emit(RealtimeEvent.Refresh, payload, (raw: unknown) => {
        const ack = refreshAckSchema.safeParse(raw);
        if (ack.success) {
          onAck(ack.data);
        }
      });
    },
  });

  const clearReconnect = () => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const reconnectAfter = (delayMs: number) => {
    clearReconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (closed) {
        return;
      }
      if (socket === undefined) {
        start();
      } else {
        socket.connect();
      }
    }, clampTimerDelayMs(delayMs));
  };

  const reconnectWithBackoff = () => {
    reconnectAfter(backoffDelayMs(reconnectAttempt, RECONNECT_BACKOFF, random));
    reconnectAttempt += 1;
  };

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearReconnect();
    refresher.stop();
    channels.dispose();
    socket?.disconnect();
    status.set(RealtimeStatus.Closed);
  };

  /** Closes for good, reporting `code` to every channel. */
  const closeFor = (code: RealtimeErrorCodeValue) => {
    closedWith = code;
    channels.failAll(code);
    close();
  };

  // A token with no usable URL and no fallback: there is nowhere to connect.
  const failWithoutUrl = () => closeFor(RealtimeErrorCode.Internal);

  const onConnectError = (code: RealtimeErrorCodeValue | undefined) => {
    // At the handshake the service sends `unknown_kind` only for a protocol
    // it does not speak (PLN-2104 decision 2), which no retry can change.
    if (code === RealtimeErrorCode.UnknownKind) {
      closeFor(code);
      return;
    }
    if (code === RealtimeErrorCode.Unauthorized) {
      unauthorizedStreak += 1;
      if (unauthorizedStreak >= MAX_UNAUTHORIZED_STREAK) {
        closeFor(code);
        return;
      }
    } else {
      unauthorizedStreak = 0;
    }
    // A refusal with a code came from the service's middleware, after which
    // socket.io does not reconnect by itself; a transport failure carries no
    // code and socket.io retries it. The next handshake fetches a fresh token.
    if (code !== undefined) {
      reconnectWithBackoff();
    }
  };

  const onServiceError = (payload: unknown) => {
    const parsed = errorPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const { channel, code } = parsed.data;
    if (channel !== undefined) {
      channels.onChannelError(channel, code);
      return;
    }
    if (code === RealtimeErrorCode.TokenExpired) {
      socket?.disconnect();
      reconnectAfter(0);
    }
  };

  const onConnect = () => {
    unauthorizedStreak = 0;
    reconnectAttempt = 0;
    clearReconnect();
    channels.onConnect();
    if (handshakeLifetime !== undefined) {
      refresher.start(handshakeLifetime);
    }
  };

  const onDisconnect = (reason: unknown) => {
    refresher.stop();
    channels.onDisconnect();
    if (closed) {
      return;
    }
    status.set(everOpen ? RealtimeStatus.Degraded : RealtimeStatus.Connecting);
    // socket.io never reconnects after the server disconnects it.
    if (reason === SERVER_DISCONNECT_REASON) {
      reconnectWithBackoff();
    }
  };

  const onDrain = (payload: unknown) => {
    const parsed = drainPayloadSchema.safeParse(payload);
    if (closed || !parsed.success) {
      return;
    }
    // Close before reopening, so the service's per-user and per-org
    // connection caps never count this client twice.
    socket?.disconnect();
    reconnectAfter(parsed.data.afterMs);
  };

  /** Handlers ignore a socket once another has replaced it. */
  const attach = (owned: RealtimeSocket) => {
    const on = (event: string, handler: (...args: unknown[]) => void) => {
      owned.on(event, (...args) => {
        if (owned === socket) {
          handler(...args);
        }
      });
    };
    on("connect", onConnect);
    on(RealtimeEvent.Welcome, () => {
      everOpen = true;
      status.set(RealtimeStatus.Open);
    });
    on("disconnect", onDisconnect);
    on("connect_error", (error) => {
      if (!closed) {
        onConnectError(readHandshakeErrorCode(error));
      }
    });
    owned.io.on("reconnect_attempt", () => {
      if (owned === socket && !closed && everOpen) {
        status.set(RealtimeStatus.Degraded);
      }
    });
    on(RealtimeEvent.Drain, onDrain);
    on(RealtimeEvent.Error, onServiceError);
    on(RealtimeEvent.Signal, channels.onSignal);
    on(RealtimeEvent.Resync, channels.onResync);
  };

  const openSocket = (url: string, fetched: FetchedToken) => {
    const previous = socket;
    socket = undefined;
    previous?.disconnect();
    clearReconnect();
    prefetched = fetched;
    socketUrl = url;
    const created = createSocket(url, realtimeSocketOptions(auth));
    socket = created;
    attach(created);
    created.connect();
  };

  start();

  return {
    join: (channel, listener) => {
      if (closed) {
        listener.onError?.(closedWith);
        const poll = startListenerPoll(listener, false);
        return () => poll?.stop();
      }
      return channels.join(channel, listener);
    },
    status: status.get,
    onStatus: status.subscribe,
    close,
  };
}

type FetchedToken = {
  issued: IssuedRealtimeToken;
  /** The client's clock when `getToken` resolved. */
  receivedAt: number;
};

const MAX_UNAUTHORIZED_STREAK = 2;

const SERVER_DISCONNECT_REASON = "io server disconnect";

/**
 * A well-formed service URL as its origin, else undefined. A token's missing
 * or malformed `url` reads as absent: the field is newer than some APIs a
 * client may talk to.
 */
function toServiceUrl(value: unknown): string | undefined {
  const parsed = realtimeServiceUrlSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
/** socket.io-client hands the middleware's `data` to `connect_error` as `error.data`. */
const handshakeErrorSchema = z.object({
  data: z.object({ code: z.string().min(1) }),
});

function readHandshakeErrorCode(
  error: unknown
): RealtimeErrorCodeValue | undefined {
  const parsed = handshakeErrorSchema.safeParse(error);
  return parsed.success
    ? toRealtimeErrorCode(parsed.data.data.code)
    : undefined;
}
