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
 *   service gives it its own refundable budget). An HTTP 408 on the response
 *   still maps to `AckTimeout` — which since ISS-8605 is ENVIRONMENTAL too, so
 *   it defers with budgets intact and terminates on the 24h wall clock rather
 *   than the per-row budget it used to spend.
 * - network failure or no API origin → THROWN as an
 *   `AgentSessionSyncTransportError` (ISS-10602: no HTTP answer, so the service
 *   defers the lane on it and charges no row)
 * - coded 403 → `FeatureDisabled` (capability off: back off) vs
 *   `TargetNotOwned` (wrong/stale computeTargetId: defer without budget burn;
 *   waiting cannot fix it, dead-lettering would strand good sessions)
 * - 400/413 → `ValidationFailed`; 429 → `RateLimited`
 * - ISS-8595: any status the chain above declined whose body names a code
 *   NEITHER contract in this build knows → `UNKNOWN_ACK_REASON`, the
 *   version-skew class. Checked BEFORE the shared module, so a reason this
 *   build cannot read is never turned into a verdict about the row. Resolving
 *   it here is what makes the sync lane's skew branch reachable at all.
 * - ISS-8614: every remaining status is classified by the SHARED module against
 *   this route's profile, so an Appendix A ITEM status this chain does not name
 *   reaches `ValidationFailed` instead of deferring as `IngestionFailed`.
 * - anything left (5xx, deploy-skew 404, an uncoded body) → `IngestionFailed`.
 */
import {
  DesktopAgentSessionsSyncErrorCode,
  SYNC_ACK_DETAIL_MAX_CHARS,
  SYNC_CONTENT_ENCODING_HEADER,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import { desktopAgentSessionsSyncApiResultValidator } from "@repo/api/src/types/agent-session-sync-api-result";
import {
  chargesItemBudget,
  classifySyncFailure,
  SESSION_METADATA_ROUTE_PROFILE,
} from "../../shared/sync-failure-classification.js";
import type { DesktopAgentSessionsAck } from "../cloud/cloud-protocol.js";
import {
  DesktopAgentSessionsAckReason,
  UNKNOWN_ACK_REASON,
} from "../cloud/cloud-protocol.js";
import { errorMessage } from "../diagnostics/component-sync-diagnostics.js";
import { parseRetryAfterMs } from "../transcript/retry-after-header.js";
import {
  extractApiErrorCode,
  extractApiErrorDetailReason,
  isAbortTimeoutError,
  type SessionFetchOptions,
  SessionRequestCredentialKind,
  sendSessionClApiRequest,
} from "../util/api-response-utils.js";
import { gzipJson } from "./agent-session-sync-compression.js";
import type { AgentSessionSyncTransportPayload } from "./agent-session-sync-contract.js";
import {
  AgentSessionSyncTransportError,
  sanitizeUntrustedServerText,
} from "./agent-session-sync-service-helpers.js";

/**
 * Inherited from the socket transport's `AGENT_SESSIONS_ACK_TIMEOUT_MS`. The
 * server route declares `maxDuration = 60` above this, so a slow-but-successful
 * upsert still commits server-side and the retry lands on the idempotent upsert.
 *
 * ISS-5088: firing this deadline no longer trips `AckTimeout` — the server
 * never answered, so it resolves `TransportTimeout` against the lane-wide,
 * refundable `MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS` budget. That budget is now the
 * only one either timeout class spends: ISS-8605 made `AckTimeout` itself
 * environmental and deleted the per-row budget it used to carry.
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
  onUnauthorized?: (rejectedToken: string) => void;
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
   * Resolves to an ack for every server-answered outcome; throws an
   * `AgentSessionSyncTransportError` when no HTTP answer arrived (ISS-10602),
   * and the raw error when the body itself cannot be encoded.
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
        // auth state, and no row caused it. Typed, the service defers the lane
        // on it under `transport_error` rather than `unauthenticated`; the gate
        // and its 24h ceiling are the same either way.
        throw new AgentSessionSyncTransportError(
          "agent-session sync: API origin unavailable"
        );
      }

      // Built before the request so an encoding failure throws raw: it is the
      // row's, and must not be typed as a transport throw below.
      const compress = sendOptions?.compress === true;
      const headers = buildSyncRequestHeaders(compress);
      const body = buildSyncRequestBody(batch, compress);
      let response: Response;
      try {
        response = await sendSessionClApiRequest({
          apiOrigin: origin,
          path: SYNC_PATH,
          method: "POST",
          query: { computeTargetId },
          headers,
          body,
          timeoutMs: AGENT_SESSIONS_HTTP_REQUEST_TIMEOUT_MS,
          fetch: options.fetch,
          credential: {
            token,
            credentialKind: SessionRequestCredentialKind.AccessToken,
          },
          onUnauthorized: options.onUnauthorized,
        });
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
        // Network failure = the HTTP analogue of a dropped socket, and a
        // property of the lane rather than of this batch (ISS-10602).
        throw new AgentSessionSyncTransportError(errorMessage(error), {
          cause: error,
        });
      }

      const responseBody: unknown = await response.json().catch(() => null);
      if (response.ok) {
        return ackFromOkResponse(responseBody);
      }
      return rejectedAck(response.status, responseBody, response.headers);
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
  responseBody: unknown,
  headers: Headers
): DesktopAgentSessionsAck {
  const detail = extractApiErrorDetailReason(responseBody);
  const code = extractApiErrorCode(responseBody);
  const reason = ackReasonForHttpFailure(status, code);
  // ISS-10014: read on EVERY rejection rather than gated on the class, because
  // the transport's class and the dispatch's reason are not the same axis: a
  // newer server's status with a code this build does not know classifies ITEM
  // here, while the dispatch routes that same unknown reason to the stall fold
  // that would honor the hint. Which acks act on it is the dispatch's decision;
  // an ack it ignores the field on costs nothing.
  const retryAfterMs = parseRetryAfterMs(
    headers.get("Retry-After"),
    Date.now()
  );
  return {
    accepted: false,
    reason,
    ...(detail ? { detail } : {}),
    // Omitted, like `detail` above, when the server sent nothing readable — the
    // ack carries no key it has no value for.
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    // ISS-8595: carried only on the skew class, and SANITIZED at admission with
    // the same strip + cap `detail` gets, because this is the one field on the
    // ack whose content a newer cloud chose. The reason itself is already a
    // fixed spelling; this is the log-only "what did they call it" an operator
    // would otherwise have to read a proxy dump for.
    ...(reason === UNKNOWN_ACK_REASON && code
      ? {
          unrecognizedReason: sanitizeUntrustedServerText(
            code,
            SYNC_ACK_DETAIL_MAX_CHARS
          ),
        }
      : {}),
  };
}

/**
 * FEA-4138: build the POST init for one sync request. When `compress` is set
 * (the server negotiated decompression) the body is gzip bytes and carries
 * `Content-Encoding: gzip` — the wire signal the server dispatches on, since
 * the compressed body is opaque until decoded. The batch itself already carries
 * `encoding: "gzip"` so it stays self-describing once decompressed.
 */
function buildSyncRequestHeaders(compress: boolean): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(compress
      ? { [SYNC_CONTENT_ENCODING_HEADER]: SyncPayloadEncoding.Gzip }
      : {}),
  };
}

function buildSyncRequestBody(
  batch: AgentSessionSyncTransportPayload,
  compress: boolean
): string | Uint8Array<ArrayBuffer> {
  // `Uint8Array<ArrayBuffer>`, not the bare alias (which defaults to
  // `ArrayBufferLike` and so admits shared memory): a fetch body may never be
  // backed by a `SharedArrayBuffer`, and `gzipJson` returns non-shared bytes.
  return compress ? gzipJson(batch) : JSON.stringify(batch);
}

/**
 * Every rejection class either contract in THIS build can name — the desktop's
 * ack reasons plus the shared route error codes. Built from both consts rather
 * than listed, so a member added to either is covered without a second edit
 * here, and read as the negative test in {@link isUnrecognizedRejectionCode}.
 *
 * Both halves are load-bearing. `internal_error` is a live route code that is
 * deliberately NOT an ack reason, so testing the ack enum alone would reclassify
 * traffic today's server already sends.
 *
 * `Object.create(null)`-style prototype hazards do not apply: this is a Set of
 * values, never an object indexed by the untrusted key.
 */
const KNOWN_REJECTION_CODES: ReadonlySet<string> = new Set<string>([
  ...Object.values(DesktopAgentSessionsAckReason),
  ...Object.values(DesktopAgentSessionsSyncErrorCode),
]);

/**
 * ISS-8595: whether the server named a rejection class this build cannot map.
 *
 * This is the ONLY place a future reason survives translation. Without it every
 * unrecognized failure collapses into `ingestion_failed` here, and the sync
 * lane's version-skew branch — the one PRD-699 Appendix A exists for — is
 * reachable by no production input at all.
 */
function isUnrecognizedRejectionCode(code: string | null): boolean {
  return code !== null && code.length > 0 && !KNOWN_REJECTION_CODES.has(code);
}

function ackReasonForHttpFailure(
  status: number,
  code: string | null
): DesktopAgentSessionsAckReason | typeof UNKNOWN_ACK_REASON {
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
  // ISS-8595 is checked here — after the statuses this route NAMES, ahead of
  // the shared module's answer below — and that is not the module's resolution
  // order run backwards. "Coded reason" there means a code this route's profile
  // MAPS, and this route ships no `codes` map; this asks the opposite question,
  // whether the server named a class neither contract in this build can read.
  // Appendix A puts THAT in ENVIRONMENTAL, beside the outage and the timeout,
  // which is exactly what `deferUnrecognizedReason` applies.
  //
  // The named statuses still win, unchanged: a newer server sending a new code
  // alongside a 400 or a 429 keeps the classification the ROUTE earns it. What
  // must not win is a verdict reached only through Appendix A's DEFAULT table,
  // for a status this route has never been seen to emit — a 422 here is already
  // evidence of skew, and a 422 whose code we cannot read is that evidence
  // twice. The two answers are not symmetric: `ValidationFailed` is terminal and
  // spends the row's dead-letter budget, while `UNKNOWN_ACK_REASON` defers with
  // every budget intact, bounded by the same 24h wall clock, and logs the name
  // the peer used. Guessing the row's fault from an unreadable reason is the
  // ISS-7730 shape the shared module exists to delete.
  if (isUnrecognizedRejectionCode(code)) {
    return UNKNOWN_ACK_REASON;
  }
  // ISS-8614: every status the chain above declined, and whose reason this build
  // could read, is the SHARED module's to classify — so this lane no longer
  // answers a status Appendix A already ruled on. The chain stays because a
  // REASON is finer than a class (`ack_timeout`, `rate_limited` and
  // `ingestion_failed` are all ENVIRONMENTAL, and the class cannot pick between
  // them), but the fallthrough was a blanket `ingestion_failed`, which silently
  // deferred any Appendix A ITEM status this route did not already name.
  if (
    chargesItemBudget(
      classifySyncFailure(SESSION_METADATA_ROUTE_PROFILE, status)
    )
  ) {
    return DesktopAgentSessionsAckReason.ValidationFailed;
  }
  return DesktopAgentSessionsAckReason.IngestionFailed;
}
