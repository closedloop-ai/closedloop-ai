/**
 * @file desktop-agent-sessions-client.ts
 * @description FEA-3425 (PLN-1437 Phase 1): HTTP transport for the Lane-1
 * agent-session metadata sync. Posts the same `AgentSessionSyncTransportPayload`
 * the relay socket used to carry to `POST /desktop/agent-sessions/sync`,
 * authenticated with the first-party Desktop session token (mirroring
 * `desktop-transcripts-client.ts`), and translates the HTTP outcome into the
 * client-side `DesktopAgentSessionsAck` union so `AgentSessionSyncService`'s
 * retry/dead-letter machinery applies unchanged.
 *
 * Failure translation is deliberately conservative and dispatches on
 * code + status, never status alone (the route's 403 is ambiguous without the
 * FEA-3425 `code` metadata):
 * - no token / thrown token read / HTTP 401 → `Unauthenticated` (client-only:
 *   the sync service defers with every retry budget intact — auth loss is
 *   never a payload problem)
 * - client-side abort timeout → `TransportTimeout` (ISS-5088: the server never
 *   answered, so the stall is lane-wide, not attributable to this batch — the
 *   service gives it its own refundable budget). A server-answered HTTP 408
 *   still maps to `AckTimeout`, which keeps the `MAX_CONSECUTIVE_TIMEOUTS`
 *   calibration inherited from the socket transport.
 * - network failure → THROWN (parity with a dropped socket: the service's
 *   FEA-3364 thrown-transport budget applies)
 * - coded 403 → `FeatureDisabled` (capability off: back off) vs
 *   `TargetNotOwned` (wrong/stale computeTargetId: defer without budget burn;
 *   waiting cannot fix it, dead-lettering would strand good sessions)
 * - 400/413 → `ValidationFailed`; 429 → `RateLimited`; anything else
 *   (5xx, deploy-skew 404) → `IngestionFailed` (bounded, live-recoverable)
 */
import {
  DesktopAgentSessionsSyncErrorCode,
  SYNC_CONTENT_ENCODING_HEADER,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import { desktopAgentSessionsSyncApiResultValidator } from "@repo/api/src/types/agent-session-sync-api-result";
import type { DesktopAgentSessionsAck } from "../cloud/cloud-protocol.js";
import { DesktopAgentSessionsAckReason } from "../cloud/cloud-protocol.js";
import type { SessionFetchOptions } from "../util/api-response-utils.js";
import {
  extractApiErrorCode,
  extractApiErrorDetailReason,
  isAbortTimeoutError,
} from "../util/api-response-utils.js";
import { gzipJson } from "./agent-session-sync-compression.js";
import type { AgentSessionSyncTransportPayload } from "./agent-session-sync-contract.js";

/**
 * Inherited from the socket transport's `AGENT_SESSIONS_ACK_TIMEOUT_MS`. The
 * server route declares `maxDuration = 60` above this, so a slow-but-successful
 * upsert still commits server-side and the retry lands on the idempotent upsert.
 *
 * ISS-5088: firing this deadline no longer trips `AckTimeout` (and so no longer
 * spends the batch-attributable `MAX_CONSECUTIVE_TIMEOUTS` budget) — the server
 * never answered, so it resolves `TransportTimeout` against the lane-wide,
 * refundable `MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS` budget instead.
 */
export const AGENT_SESSIONS_HTTP_REQUEST_TIMEOUT_MS = 30_000;

const SYNC_PATH = "/desktop/agent-sessions/sync";

export type DesktopAgentSessionsClientOptions = SessionFetchOptions & {
  /**
   * FEA-3425: invoked when the server rejects the presented session token with
   * HTTP 401 (early revocation/rotation). Lets the owner drop its cached access
   * token so the next retry refreshes instead of re-sending the same rejected
   * credential until local expiry (up to the full token TTL).
   */
  onUnauthorized?: () => void;
};

/**
 * FEA-4138: per-send transport options. `compress` gzip-encodes the body and
 * stamps `Content-Encoding: gzip`; the caller only sets it when the server
 * advertised decompression, so an older server never receives a compressed body.
 */
export type DesktopAgentSessionsSendOptions = {
  compress?: boolean;
};

export type DesktopAgentSessionsClient = {
  /**
   * Sends one prepared (already sanitized/size-capped/chunked) sync payload.
   * Resolves to an ack for every server-answered outcome; throws only on
   * network-level failures, mirroring a dropped socket so the service's
   * thrown-transport budget (FEA-3364) applies.
   */
  sendBatch(
    batch: AgentSessionSyncTransportPayload,
    computeTargetId: string,
    options?: DesktopAgentSessionsSendOptions
  ): Promise<DesktopAgentSessionsAck>;
};

export function createDesktopAgentSessionsClient(
  options: DesktopAgentSessionsClientOptions
): DesktopAgentSessionsClient {
  const fetchImpl = options.fetch ?? fetch;

  return {
    async sendBatch(batch, computeTargetId, sendOptions) {
      let token: string | null;
      try {
        token = await options.getAccessToken();
      } catch {
        token = null;
      }
      if (!token) {
        return unauthenticatedAck();
      }

      const origin = options.getApiOrigin();
      if (!origin) {
        // A missing/invalid API origin is a local configuration fault, not an
        // auth state — throw so the bounded thrown-transport budget applies
        // instead of silently deferring forever as unauthenticated.
        throw new Error("agent-session sync: API origin unavailable");
      }
      const url = new URL(SYNC_PATH, origin);
      url.searchParams.set("computeTargetId", computeTargetId);

      let response: Response;
      try {
        response = await fetchImpl(
          url,
          buildSyncRequestInit(batch, token, sendOptions?.compress === true)
        );
      } catch (error) {
        if (isAbortTimeoutError(error)) {
          // ISS-5088: the LOCAL request deadline fired and the server never
          // answered. That is a transport/liveness condition (the same stall
          // that ping-times-out the relay socket and aborts the component
          // lane's POST in the same window), not a verdict on this payload —
          // classify it lane-wide so it cannot dead-letter a healthy session.
          return {
            accepted: false,
            reason: DesktopAgentSessionsAckReason.TransportTimeout,
          };
        }
        // Network failure = the HTTP analogue of a dropped socket. Rethrow so
        // the service's FEA-3364 thrown-transport budget bounds it.
        throw error;
      }

      const responseBody: unknown = await response.json().catch(() => null);
      if (response.ok) {
        return ackFromOkResponse(responseBody);
      }

      if (response.status === 401) {
        // The server refused a token the local cache still considers valid —
        // early revocation/rotation. Let the owner invalidate it so the next
        // retry presents a freshly refreshed credential.
        options.onUnauthorized?.();
      }
      return rejectedAck(response.status, responseBody);
    },
  };
}

function unauthenticatedAck(): DesktopAgentSessionsAck {
  return {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.Unauthenticated,
  };
}

/**
 * Translate a 2xx sync response body into an ack. Goal stage 2: carries the
 * request-gated per-session `acceptedSessionIds` echo through when the server
 * sent it, and preserves OMISSION when it did not (an older server, or a batch
 * that did not opt in) so the sync service's whole-batch fallback keys on field
 * absence, never on `undefined`. A 2xx whose body is not the sync contract
 * (proxy interference, deploy skew) maps to `IngestionFailed` — bounded retry,
 * never an unbounded defer.
 */
function ackFromOkResponse(responseBody: unknown): DesktopAgentSessionsAck {
  const parsed =
    desktopAgentSessionsSyncApiResultValidator.safeParse(responseBody);
  if (parsed.success && parsed.data.success === true) {
    const acceptedSessionIds = parsed.data.data.acceptedSessionIds;
    return {
      accepted: true,
      ...(acceptedSessionIds ? { acceptedSessionIds } : {}),
    };
  }
  return {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.IngestionFailed,
  };
}

/**
 * Translate a non-2xx sync response into a rejection ack. ISS-5090: carries the
 * server's `details.reason` field/path summary through as the ack's diagnostic
 * `detail`, and preserves OMISSION when the server sent none (an older API, or a
 * rejection class that carries none) rather than serializing an explicit
 * `undefined`/`null` the ack contract does not declare.
 */
function rejectedAck(
  status: number,
  responseBody: unknown
): DesktopAgentSessionsAck {
  const detail = extractApiErrorDetailReason(responseBody);
  return {
    accepted: false,
    reason: ackReasonForHttpFailure(status, extractApiErrorCode(responseBody)),
    ...(detail ? { detail } : {}),
  };
}

/**
 * FEA-4138: build the POST init for one sync request. When `compress` is set
 * (the server negotiated decompression) the body is gzip bytes and carries
 * `Content-Encoding: gzip` — the wire signal the server dispatches on, since
 * the compressed body is opaque until decoded. The batch itself already carries
 * `encoding: "gzip"` so it stays self-describing once decompressed.
 */
function buildSyncRequestInit(
  batch: AgentSessionSyncTransportPayload,
  token: string,
  compress: boolean
): RequestInit {
  // `Uint8Array<ArrayBuffer>`, not the bare alias (which defaults to
  // `ArrayBufferLike` and so admits shared memory): a fetch body may never be
  // backed by a `SharedArrayBuffer`, and `gzipJson` returns non-shared bytes.
  const body: string | Uint8Array<ArrayBuffer> = compress
    ? gzipJson(batch)
    : JSON.stringify(batch);
  return {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(compress
        ? { [SYNC_CONTENT_ENCODING_HEADER]: SyncPayloadEncoding.Gzip }
        : {}),
    },
    body,
    signal: AbortSignal.timeout(AGENT_SESSIONS_HTTP_REQUEST_TIMEOUT_MS),
  };
}

function ackReasonForHttpFailure(
  status: number,
  code: string | null
): DesktopAgentSessionsAckReason {
  if (status === 401) {
    return DesktopAgentSessionsAckReason.Unauthenticated;
  }
  if (status === 403) {
    if (code === DesktopAgentSessionsSyncErrorCode.FeatureDisabled) {
      return DesktopAgentSessionsAckReason.FeatureDisabled;
    }
    // `target_not_owned`, and any UNCODED 403 from a pre-FEA-3425 server:
    // treating an ambiguous 403 as capability-off would park a wrong/stale
    // computeTargetId forever (waiting cannot fix it), while the
    // target-not-owned handling defers with budgets intact and surfaces the
    // condition loudly — the safe default for both meanings.
    return DesktopAgentSessionsAckReason.TargetNotOwned;
  }
  if (status === 400 || status === 413) {
    return DesktopAgentSessionsAckReason.ValidationFailed;
  }
  if (status === 408) {
    return DesktopAgentSessionsAckReason.AckTimeout;
  }
  if (status === 429) {
    return DesktopAgentSessionsAckReason.RateLimited;
  }
  return DesktopAgentSessionsAckReason.IngestionFailed;
}
