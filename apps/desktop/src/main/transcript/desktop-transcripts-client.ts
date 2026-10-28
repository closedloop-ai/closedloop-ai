/**
 * @file desktop-transcripts-client.ts
 * @description Typed client for the transcript control plane (FEA-2714 routes,
 * consumed by FEA-2715). Mirrors the desktop-identity-client transport: a Bearer
 * token from `DesktopSessionManager` + the configured API origin. Three
 * operations:
 *   - `syncPlan`  → POST /desktop/transcripts/sync-plan (server owns the offset)
 *   - `uploadPut` / `uploadPart` → PUT delta bytes straight to S3 via presigned
 *     URLs (transcript bytes never transit apps/api)
 *   - `complete`  → POST /desktop/transcripts/complete (server verifies vs S3)
 *
 * Unlike the identity client (which swallows failures to null), these methods
 * THROW {@link TranscriptSyncClientError} on any transport / status / schema
 * failure so the executor can record a precise `lastError` and drive backoff.
 */
import type { Readable } from "node:stream";
import { SYNC_ACK_DETAIL_MAX_CHARS } from "@repo/api/src/types/agent-session";
import {
  asTranscriptForbiddenCode,
  type TranscriptCompleteRequest,
  type TranscriptCompleteResponse,
  type TranscriptForbiddenCode,
  type TranscriptSkipRequest,
  type TranscriptSkipResponse,
  type TranscriptSyncPlanRequest,
  type TranscriptSyncPlanResponse,
  transcriptCompleteResponseSchema,
  transcriptSkipResponseSchema,
  transcriptSyncPlanResponseSchema,
} from "@repo/api/src/types/desktop-transcripts";
import { sanitizeUntrustedServerText } from "../agent-sync/agent-session-sync-service-helpers.js";
import {
  extractApiFailureEnvelopeCode,
  SessionRequestCredentialKind,
  sendSessionClApiRequest,
  unwrapApiEnvelope,
} from "../util/api-response-utils.js";
import { parseRetryAfterMs } from "./retry-after-header.js";

const CONTROL_REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_REQUEST_TIMEOUT_MS = 120_000;

/** S3's full-object CRC64NVME header for the `fullPut` presigned PutObject. */
const S3_CRC64NVME_HEADER = "x-amz-checksum-crc64nvme";
/** Matches `TRANSCRIPT_CONTENT_TYPE` in packages/aws (signed on the fullPut). */
const TRANSCRIPT_CONTENT_TYPE = "application/x-ndjson";

/**
 * ISS-8608: S3's XML error `<Code>` — the element that says WHICH failure this
 * was, where the bare status cannot (a 403 is both an expired presign and a
 * bucket policy; a 400 is both a stalled socket and an oversize object).
 *
 * The PATTERN is bounded and linear: a restricted character class, a hard
 * 128-character cap, and bounded whitespace for an intermediary that
 * pretty-prints. It does not bound the INPUT — `response.text()` already
 * materializes the whole body today, and this change does not alter that.
 *
 * The first PARSEABLE match wins — not simply the first `<Code>` element, since
 * one whose contents fall outside the class is skipped and a later one can be
 * captured instead. S3 does not mint that shape (its contract puts `<Code>` as
 * the first child of `<Error>`, and the endpoint is S3's own signed URL rather
 * than one a caller chose), but the distinction is stated because the tests pin
 * both halves: a `<Message>` ahead of the code, and a code the class rejects.
 *
 * Searched inside the `<Error>` envelope ONLY — see {@link parseS3ErrorCode}.
 */
const S3_ERROR_CODE_PATTERN =
  /<Code>\s{0,16}([A-Za-z0-9._-]{1,128})\s{0,16}<\/Code>/;

/**
 * ISS-8608: the `<Error>` envelope S3 wraps every REST error in. Both halves are
 * required before a `<Code>` inside them counts, because the ticket's own
 * acceptance criterion puts MALFORMED XML on the environmental side, and only
 * the ITEM codes cost the row its budget: a truncated or invented body carrying
 * `<Code>EntityTooLarge</Code>` with no closing `</Error>` would otherwise spend
 * five attempts and dead-letter a healthy transcript — the exact loss shape this
 * ticket removes. Failing the envelope check yields no code, which
 * `classifyS3PutFailure` answers ENVIRONMENTAL.
 *
 * Bounded and linear like the code pattern: a literal tag name and bounded
 * whitespace, matched with `exec` and sliced, never a `.*` spanning the body.
 */
const S3_ERROR_ENVELOPE_OPEN = /<Error\s{0,16}>/;
const S3_ERROR_ENVELOPE_CLOSE = /<\/Error\s{0,16}>/;

export class TranscriptSyncClientError extends Error {
  readonly status?: number;
  /**
   * ISS-8689: how long the SERVER asked us to wait, from its `Retry-After`
   * header, in milliseconds. Optional and additive on purpose — a server that
   * predates the header, or one whose value we could not parse, leaves it
   * `undefined`, and the lane's own staged schedule owns the delay. Absence
   * must never be read as an instruction (see `parseRetryAfterMs`).
   */
  readonly retryAfterMs?: number;
  /**
   * ISS-8599: WHICH 403 this is, when the server said so in a way this build can
   * name. Optional and additive for the same reason `retryAfterMs` is: a server
   * that predates the split sends no code, and a NEWER server may send one this
   * build has never heard of — `asTranscriptForbiddenCode` folds both to
   * `undefined`, which is the pre-split bare-403 behaviour. Absence is never an
   * instruction.
   */
  readonly forbiddenCode?: TranscriptForbiddenCode;
  /**
   * ISS-8608: this rejection came from a PRESIGNED UPLOAD, not the control
   * plane. Present or absent, never false — and it is not decoration. Without
   * it, "S3 answered 400 with a body we could not read" and "the control plane
   * answered 400" are the same value, and only the first may leave the row's
   * retry budget alone.
   */
  readonly s3Upload?: true;
  /**
   * ISS-8608: the `<Code>` S3 named, when the body carried a readable one.
   * Optional and additive for the same reason `retryAfterMs` and
   * `forbiddenCode` are — absence is never an instruction. An unreadable body
   * classifies like a code this build has never seen, which
   * `classifyS3PutFailure` answers ENVIRONMENTAL.
   */
  readonly s3ErrorCode?: string;
  constructor(
    message: string,
    status?: number,
    retryAfterMs?: number,
    forbiddenCode?: TranscriptForbiddenCode,
    /**
     * Passed ONLY by the presigned-upload arm. Its PRESENCE is what sets
     * {@link s3Upload}, so this constructor cannot mint a code without the
     * marker saying which arm produced it — an invariant a sixth positional
     * parameter could not express.
     */
    s3PutFailure?: { readonly errorCode?: string }
  ) {
    super(message);
    this.name = "TranscriptSyncClientError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.forbiddenCode = forbiddenCode;
    this.s3Upload = s3PutFailure === undefined ? undefined : true;
    this.s3ErrorCode = s3PutFailure?.errorCode;
  }
}

export type DesktopTranscriptsClientOptions = {
  fetch?: typeof fetch;
  getAccessToken: () => Promise<string | null>;
  getApiOrigin: () => string | undefined;
  onUnauthorized?: (rejectedToken: string) => void;
};

export type DesktopTranscriptsClient = {
  syncPlan(
    request: TranscriptSyncPlanRequest
  ): Promise<TranscriptSyncPlanResponse>;
  /**
   * `fullPut`: PUT the whole `[0, planEndOffset)` window with the checksum
   * header. The body is streamed, never buffered, so multi-GB transcripts are
   * never loaded into memory (PRD FR4 / AC5); `contentLength` is the exact byte
   * count S3 must receive.
   */
  uploadPut(
    url: string,
    body: Readable,
    contentLength: number,
    crc64NvmeBase64: string
  ): Promise<void>;
  /**
   * `multipart`: PUT one delta part's raw bytes (S3 verifies the full object at
   * complete). Streamed like `uploadPut`; `contentLength` is the part size.
   */
  uploadPart(url: string, body: Readable, contentLength: number): Promise<void>;
  complete(
    request: TranscriptCompleteRequest
  ): Promise<TranscriptCompleteResponse>;
  /**
   * Record a terminal, non-retryable skip for a file the desktop will never
   * upload (e.g. it exceeds the local size cap) so the cloud stops representing
   * it as "syncing" (FEA-3476). No bytes/checksums — identity + reason only.
   */
  skip(request: TranscriptSkipRequest): Promise<TranscriptSkipResponse>;
};

export function createDesktopTranscriptsClient(
  options: DesktopTranscriptsClientOptions
): DesktopTranscriptsClient {
  const fetchImpl = options.fetch ?? fetch;

  async function resolveControlRequest(path: string): Promise<{
    apiOrigin: string;
    token: string;
  }> {
    let token: string | null;
    try {
      token = await options.getAccessToken();
    } catch (error) {
      throw new TranscriptSyncClientError(
        `access token unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const origin = options.getApiOrigin();
    if (!(token && origin)) {
      throw new TranscriptSyncClientError("not signed in");
    }
    try {
      new URL(path, origin);
    } catch {
      throw new TranscriptSyncClientError(`invalid API origin for ${path}`);
    }
    return { apiOrigin: origin, token };
  }

  async function postControl<T>(
    path: string,
    payload: unknown,
    parse: (value: unknown) => { success: boolean; data?: T }
  ): Promise<T> {
    const { apiOrigin, token } = await resolveControlRequest(path);
    let response: Response;
    try {
      response = await sendSessionClApiRequest({
        apiOrigin,
        path,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        timeoutMs: CONTROL_REQUEST_TIMEOUT_MS,
        fetch: fetchImpl,
        credential: {
          token,
          credentialKind: SessionRequestCredentialKind.AccessToken,
        },
        onUnauthorized: options.onUnauthorized,
      });
    } catch (error) {
      throw new TranscriptSyncClientError(
        `${path} request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!response.ok) {
      // ISS-8689 (PRD-699 F7): the status code says WHICH class of failure this
      // is; `Retry-After` says how long it will last, which the status cannot.
      // It is the only signal that separates a bucket-unset 503 from a
      // transient one, and reading it here is what makes that separation exist
      // at the call site.
      //
      // ISS-8599: 403 is the one status the body is read for, because it is the
      // one status that answers two unrelated questions (ownership vs org
      // policy) the classifier must not conflate. Every other status keeps the
      // body unread — nothing downstream needs it, and reading a 5xx proxy page
      // buys only latency.
      const forbidden =
        response.status === 403
          ? await readForbiddenDetail(response)
          : EMPTY_FORBIDDEN_DETAIL;
      throw new TranscriptSyncClientError(
        `${path} returned HTTP ${response.status}${forbidden.detail}`,
        response.status,
        parseRetryAfterMs(response.headers.get("Retry-After"), Date.now()),
        forbidden.forbiddenCode
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TranscriptSyncClientError(`${path} returned non-JSON`);
    }
    const parsed = parse(unwrapApiEnvelope(body));
    if (!(parsed.success && parsed.data !== undefined)) {
      throw new TranscriptSyncClientError(`${path} response failed validation`);
    }
    return parsed.data;
  }

  async function put(
    url: string,
    body: Readable,
    contentLength: number,
    headers: Record<string, string>,
    label: string
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "PUT",
        // S3 presigned PUT requires a Content-Length; without it undici would
        // fall back to chunked transfer encoding (unsupported → HTTP 501).
        headers: { ...headers, "Content-Length": String(contentLength) },
        // Node fetch (undici) accepts a Readable body but requires `duplex`.
        body: body as unknown as RequestInit["body"],
        duplex: "half",
        signal: AbortSignal.timeout(UPLOAD_REQUEST_TIMEOUT_MS),
      } as RequestInit & { duplex: "half" });
    } catch (error) {
      throw new TranscriptSyncClientError(
        `${label} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!response.ok) {
      // S3 returns an XML error body — <Error><Code>…</Code><Message>…</Message>…
      // — naming the exact failure (AccessDenied vs SignatureDoesNotMatch vs
      // NoSuchBucket vs …). Fold a bounded, whitespace-collapsed snippet into the
      // error so a presigned-PUT rejection is diagnosable from the log line alone,
      // without S3-side access logs. Best-effort: status still propagates if the
      // body can't be read.
      let raw = "";
      try {
        raw = await response.text();
      } catch {
        // body unavailable — fall back to status-only
      }
      // ISS-8608: match the `<Code>` off the RAW text, BEFORE the collapse and
      // the cut below. S3 puts `<Message>` beside `<Code>` and a verbose one
      // pushes the code past the 500-character cut, where no later read could
      // recover it — so the order of these two lines is the contract, not style.
      const s3ErrorCode = parseS3ErrorCode(raw);
      const detail = raw.replace(/\s+/g, " ").trim().slice(0, 500);
      // ISS-8689: the direct-upload path reads `Retry-After` for the same
      // reason `postControl` does. A lane-wide S3 rejection (429/5xx) reaches
      // the same staged lane-stall schedule, and leaving the field undefined
      // here would silently retry ahead of a minimum S3 did state — the header
      // being rare on this path is not a reason to discard the one that arrives.
      throw new TranscriptSyncClientError(
        detail
          ? `${label} returned HTTP ${response.status}: ${detail}`
          : `${label} returned HTTP ${response.status}`,
        response.status,
        parseRetryAfterMs(response.headers.get("Retry-After"), Date.now()),
        undefined,
        // ISS-8608: the presigned arm marks itself here and ONLY here. The
        // status-less throw above stays untouched — that is ISS-9793's scope.
        { errorCode: s3ErrorCode }
      );
    }
  }

  return {
    syncPlan(request) {
      return postControl("/desktop/transcripts/sync-plan", request, (value) =>
        transcriptSyncPlanResponseSchema.safeParse(value)
      );
    },
    uploadPut(url, body, contentLength, crc64NvmeBase64) {
      return put(
        url,
        body,
        contentLength,
        {
          "Content-Type": TRANSCRIPT_CONTENT_TYPE,
          [S3_CRC64NVME_HEADER]: crc64NvmeBase64,
        },
        "transcript fullPut"
      );
    },
    uploadPart(url, body, contentLength) {
      return put(url, body, contentLength, {}, "transcript uploadPart");
    },
    complete(request) {
      return postControl("/desktop/transcripts/complete", request, (value) =>
        transcriptCompleteResponseSchema.safeParse(value)
      );
    },
    skip(request) {
      return postControl("/desktop/transcripts/skip", request, (value) =>
        transcriptSkipResponseSchema.safeParse(value)
      );
    },
  };
}

/**
 * What a 403 body told us: the code this build can NAME, and the log suffix.
 * One shape so the "no body was read" case and the "body carried nothing
 * recognizable" case are literally the same value at the call site.
 */
type ForbiddenDetail = {
  forbiddenCode?: TranscriptForbiddenCode;
  detail: string;
};

/** The answer for every status that is not 403, and for every unreadable 403. */
const EMPTY_FORBIDDEN_DETAIL: ForbiddenDetail = { detail: "" };

/**
 * ISS-8599: read the machine-readable `code` off a 403 failure envelope.
 *
 * Every way this can come up empty — no body, a non-JSON proxy error page, a
 * server that predates the split, a NEWER server sending a code this build has
 * never heard of — resolves to the same `undefined`, which is the pre-ISS-8599
 * bare-403 classification. A code is only ever an instruction when this build
 * knows what it means; nothing here may guess.
 *
 * A 403 is also the one status this lane is least sure came from OUR server: a
 * proxy, WAF or corporate gateway answers it with a body of its own choosing,
 * and this `code` is not a log line but the input to a LANE-WIDE denial that
 * stands the whole corpus down for up to 24 hours. So the body must prove it is
 * a first-party failure envelope before any of it is read —
 * {@link extractApiFailureEnvelopeCode} gates on the `success: false` that
 * `failure()` emits. A stray `{"code": "transcript_policy_disabled"}` from an
 * intermediary is not our server saying anything, and reads as a bare 403.
 *
 * The RAW value still reaches the message when one was present, because a fixed
 * fold would otherwise leave an operator unable to see that a newer cloud has
 * started sending a class this build cannot act on (the shape ISS-8595 settled
 * for the session lane's unrecognized ack reason). It is untrusted server text
 * headed for the gateway console sink, so it goes through the same C0/DEL strip
 * and cap that lane's `deferUnrecognizedReason` applies — never re-derived here.
 */
async function readForbiddenDetail(
  response: Response
): Promise<ForbiddenDetail> {
  let raw: string | null = null;
  try {
    raw = extractApiFailureEnvelopeCode(await response.json());
  } catch {
    // Unreadable body: indistinguishable from a server that never sent a code.
  }
  if (!raw) {
    return EMPTY_FORBIDDEN_DETAIL;
  }
  const named = sanitizeUntrustedServerText(raw, SYNC_ACK_DETAIL_MAX_CHARS);
  return {
    forbiddenCode: asTranscriptForbiddenCode(raw),
    detail: ` (code: ${named})`,
  };
}

/**
 * ISS-8608: S3's error `<Code>`, when the body is a well-formed `<Error>`
 * envelope carrying one.
 *
 * The envelope gate is the whole point rather than tidiness. A `<Code>` matched
 * anywhere in an arbitrary body lets a truncated response, a proxy error page,
 * or any non-S3 intermediary present a known ITEM code — and an ITEM verdict is
 * the one that spends the per-row retry budget and can dead-letter a healthy
 * transcript. Absent, unparseable and malformed all return `undefined` here and
 * take the environmental default, which is the direction the standard hardwires
 * and the ticket's acceptance criterion names.
 */
function parseS3ErrorCode(raw: string): string | undefined {
  const open = S3_ERROR_ENVELOPE_OPEN.exec(raw);
  if (open === null) {
    return undefined;
  }
  const contentStart = open.index + open[0].length;
  const content = raw.slice(contentStart);
  const close = S3_ERROR_ENVELOPE_CLOSE.exec(content);
  if (close === null) {
    return undefined;
  }
  return S3_ERROR_CODE_PATTERN.exec(content.slice(0, close.index))?.[1];
}
