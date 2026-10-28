import { z } from "zod";
import { realtimeErrorCodeSchema } from "./error-codes";
import { SIGNAL_TYPE_PATTERN } from "./signal";

export const PROTOCOL_VERSION = 1;

/**
 * The HTTP path socket.io serves on, which the service and every client must
 * agree on; the URL's own path would name a socket.io namespace instead.
 */
export const REALTIME_SOCKET_PATH = "/realtime";

/** `POST /realtime/token`'s response body. */
export type IssuedRealtimeToken = {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /**
   * The service URL to connect to (ISS-11210 ask 3). Absent when the API has
   * none configured, and from an API that predates the field.
   */
  url?: string;
};

/**
 * A realtime service URL (`ws://` or `wss://`), parsed to its origin: a path
 * left on it would name a socket.io namespace the service does not serve.
 */
export const realtimeServiceUrlSchema = z
  .url({ protocol: /^wss?$/ })
  .transform((value) => new URL(value).origin);

/** Keeps every event name clear of socket.io's reserved events. */
export const REALTIME_EVENT_PREFIX = "rt:";

export const RealtimeEvent = {
  Join: `${REALTIME_EVENT_PREFIX}join`,
  Leave: `${REALTIME_EVENT_PREFIX}leave`,
  Refresh: `${REALTIME_EVENT_PREFIX}refresh`,
  Signal: `${REALTIME_EVENT_PREFIX}signal`,
  Resync: `${REALTIME_EVENT_PREFIX}resync`,
  Drain: `${REALTIME_EVENT_PREFIX}drain`,
  Error: `${REALTIME_EVENT_PREFIX}error`,
  Welcome: `${REALTIME_EVENT_PREFIX}welcome`,
} as const;
export type RealtimeEvent = (typeof RealtimeEvent)[keyof typeof RealtimeEvent];

export const handshakeAuthSchema = z.object({
  token: z.string().min(1),
  protocol: z.literal(PROTOCOL_VERSION),
  clientVersion: z.string().min(1),
});
export type HandshakeAuth = z.infer<typeof handshakeAuthSchema>;

// Channel strings are not grammar-checked here: a malformed address must
// reach the service so it can answer `bad_scope` rather than a schema error.
const channelField = z.string().min(1);

const failureAckSchema = z.object({
  ok: z.literal(false),
  code: realtimeErrorCodeSchema,
});

export const joinPayloadSchema = z.object({ channel: channelField });
export type JoinPayload = z.infer<typeof joinPayloadSchema>;

export const joinAckSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), channelId: z.string().min(1) }),
  failureAckSchema,
]);
export type JoinAck = z.infer<typeof joinAckSchema>;

export const leavePayloadSchema = z.object({ channel: channelField });
export type LeavePayload = z.infer<typeof leavePayloadSchema>;

export const refreshPayloadSchema = z.object({ token: z.string().min(1) });
export type RefreshPayload = z.infer<typeof refreshPayloadSchema>;

export const refreshAckSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    /** Epoch milliseconds. */
    expiresAt: z.number().int().positive(),
  }),
  failureAckSchema,
]);
export type RefreshAck = z.infer<typeof refreshAckSchema>;

export const signalPayloadSchema = z.object({
  channel: channelField,
  type: z.string().regex(SIGNAL_TYPE_PATTERN),
  data: z.json(),
});
export type SignalPayload = z.infer<typeof signalPayloadSchema>;

export const resyncPayloadSchema = z.object({
  channel: channelField.optional(),
});
export type ResyncPayload = z.infer<typeof resyncPayloadSchema>;

export const drainPayloadSchema = z.object({
  afterMs: z.number().int().nonnegative(),
});
export type DrainPayload = z.infer<typeof drainPayloadSchema>;

export const errorPayloadSchema = z.object({
  channel: channelField.optional(),
  code: realtimeErrorCodeSchema,
});
export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

export const welcomePayloadSchema = z.object({
  connectionId: z.string().min(1),
  protocol: z.literal(PROTOCOL_VERSION),
});
export type WelcomePayload = z.infer<typeof welcomePayloadSchema>;

/** The API route that issues an {@link IssuedRealtimeToken} (PLN-2103 step 5). */
export const REALTIME_TOKEN_PATH = "/realtime/token";

/**
 * The API route that issues the document sync service's per-document
 * {@link IssuedRealtimeToken} (PLN-2099 E4).
 */
export const DOC_SYNC_TOKEN_PATH = "/doc-sync/token";

/**
 * {@link IssuedRealtimeToken} as a host reads it off the wire. A missing or
 * malformed `url` reads as absent rather than failing the token, the way the
 * client already treats it.
 */
export const issuedRealtimeTokenSchema: z.ZodType<IssuedRealtimeToken> =
  z.object(issuedRealtimeTokenShape());

/**
 * ISS-12508 (PLN-2229 OQ-3, Kerensa Whitlock 2026-10-23): what the API reports about
 * the first-open seed it ran before returning a document sync token.
 * `Unconfirmed` means the document may be missing its latest version: the
 * probe or the seed did not complete, so the token was issued anyway (A-1).
 */
export const DocSyncFirstOpenSeed = {
  Unconfirmed: "unconfirmed",
} as const;
export type DocSyncFirstOpenSeed =
  (typeof DocSyncFirstOpenSeed)[keyof typeof DocSyncFirstOpenSeed];

/**
 * `POST /doc-sync/token`'s response body. `firstOpenSeed` is omitted when the
 * seed is confirmed, and by an API that predates it.
 */
export type DocSyncTokenResponse = IssuedRealtimeToken & {
  firstOpenSeed?: DocSyncFirstOpenSeed;
};

/**
 * {@link DocSyncTokenResponse} as a host reads it off the wire. An unknown
 * `firstOpenSeed` reads as absent, so a newer API never fails the token.
 */
export const docSyncTokenResponseSchema: z.ZodType<DocSyncTokenResponse> =
  z.object({
    ...issuedRealtimeTokenShape(),
    firstOpenSeed: z
      .enum([DocSyncFirstOpenSeed.Unconfirmed])
      .optional()
      .catch(undefined),
  });

/** A function, so it is hoisted above the schemas built from it. */
function issuedRealtimeTokenShape() {
  return {
    token: z.string().min(1),
    expiresAt: z.number(),
    url: z.string().optional().catch(undefined),
  };
}
