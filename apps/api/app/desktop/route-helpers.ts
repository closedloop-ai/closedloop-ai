import { gunzipSync } from "node:zlib";
import {
  SYNC_CONTENT_ENCODING_HEADER,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import { SYNC_DECOMPRESSED_BYTE_CEILING } from "@repo/api/src/types/agent-session-sync-limits";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import { DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID } from "@repo/api/src/types/desktop-sync-ack-detail";
import { NextResponse } from "next/server";
import { isUuid } from "@/lib/is-uuid";
import {
  badRequestResponse,
  errorResponse,
  logRequestBodyOverCap,
  payloadTooLargeResponse,
  readCappedRequestText,
  requestBodyTruncationError,
} from "@/lib/route-utils";

/**
 * FEA-3425: shared `computeTargetId` query-param gate for the desktop
 * write-lane routes. Returns the trimmed id, or a 400 response — exactly one
 * of `computeTargetId` / `response` is set.
 *
 * ISS-8734: the id is also shape-checked here. `ComputeTarget.id` is
 * `@db.Uuid`, so a malformed id handed to the ownership lookup is a
 * driver-level P2023 that every consumer's catch reported as a 500 — which the
 * desktop classes as retryable, so a permanent typo was retried as a transient
 * server fault. Answering 400 before any query runs is the caller error it is.
 *
 * Both rejections carry `details.reason`
 * ({@link DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID}) because the 400
 * lands on the far side of a fork the 500 did not: the session sync lane maps
 * 400 to `ValidationFailed` and charges it to the rows in flight, which
 * dead-letters them NON-recoverably after three attempts. The id is lane state
 * read off the relay hello ack, not a property of any row, so the reason is
 * what lets the lane defer with every budget intact instead of converting a
 * self-healing 500 into permanent local data loss.
 */
export function requireComputeTargetId(
  request: Request
):
  | { computeTargetId: string; response: null }
  | { computeTargetId: null; response: NextResponse<ApiResult<never>> } {
  const computeTargetId = new URL(request.url).searchParams
    .get("computeTargetId")
    ?.trim();
  if (!computeTargetId) {
    return {
      computeTargetId: null,
      response: badRequestResponse("computeTargetId is required", {
        details: { reason: DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID },
      }),
    };
  }
  if (!isUuid(computeTargetId)) {
    return {
      computeTargetId: null,
      response: badRequestResponse("computeTargetId must be a UUID", {
        details: { reason: DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID },
      }),
    };
  }
  return { computeTargetId, response: null };
}

type BoundedJsonBodyResponseBuilders = {
  invalidJson?: () => NextResponse<ApiResult<never>>;
  payloadTooLarge?: () => NextResponse<ApiResult<never>>;
  readFailure?: (error: unknown) => NextResponse<ApiResult<never>>;
};

/**
 * FEA-3425: shared request-body scaffold for the desktop write-lane routes
 * (`/desktop/agent-sessions/sync`, `/desktop/analytics`, `/desktop/telemetry`).
 * Streams the body under a byte cap (413 over `maxBytes`), rejects unparseable
 * JSON with 400, and hands back the parsed body otherwise — exactly one of
 * `rawBody` / `response` is set. Validation of the parsed shape stays with
 * each route's handler, which owns the payload schema.
 *
 * ISS-8688: a stream that FAILED to deliver its body — a read reject, or a
 * close short of a declared `Content-Length` — answers 500, not 400. These are
 * the highest-volume body writes we have and the ones cut off when the pool is
 * saturated, so calling that a client error is what misattributed the incident.
 */
export async function readBoundedJsonBody(
  request: Request,
  maxBytes: number,
  responses: BoundedJsonBodyResponseBuilders = {}
): Promise<
  | { rawBody: unknown; response: null }
  | { rawBody: null; response: NextResponse<ApiResult<never>> }
> {
  let bodyText: string;
  try {
    const capped = await readCappedRequestText(request, maxBytes);
    if (!capped.ok) {
      logRequestBodyOverCap(request, maxBytes);
      return {
        rawBody: null,
        response:
          responses.payloadTooLarge?.() ??
          payloadTooLargeResponse("Request body too large"),
      };
    }
    const truncationError = requestBodyTruncationError(
      request,
      capped.bytesRead
    );
    if (truncationError !== null) {
      return {
        rawBody: null,
        response:
          responses.readFailure?.(truncationError) ??
          errorResponse("Failed to read request body", truncationError),
      };
    }
    bodyText = capped.value;
  } catch (error) {
    return {
      rawBody: null,
      response:
        responses.readFailure?.(error) ??
        errorResponse("Failed to read request body", error),
    };
  }

  try {
    return { rawBody: JSON.parse(bodyText) as unknown, response: null };
  } catch {
    return {
      rawBody: null,
      response:
        responses.invalidJson?.() ?? badRequestResponse("Invalid JSON body"),
    };
  }
}

/**
 * FEA-3425: coded 429 envelope shared by the desktop write-lane routes. The
 * desktop clients dispatch on `code` + status, so the code always accompanies
 * the status.
 */
export function rateLimitedResponse(
  code: string,
  retryAfterSeconds?: number
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure("Rate limited", { code }), {
    status: 429,
    // ISS-10014: omitted, never sent empty, when the caller has no truthful
    // delay to state. A desktop on an older build ignores the header, and one
    // on a newer build must not read an absent hint as "wait zero" — so the
    // absent case has to stay distinguishable on the wire.
    ...(retryAfterSeconds === undefined
      ? {}
      : { headers: { "Retry-After": String(retryAfterSeconds) } }),
  });
}

/**
 * FEA-4138: read a possibly-gzip-compressed JSON sync body.
 *
 * The desktop only sends `Content-Encoding: gzip` after the server advertised
 * the `agentSessionSyncCompression` hello-ack capability, so an older desktop
 * (or one talking to a server that never advertised it) still posts plain JSON
 * and hits the legacy `readBoundedJsonBody` path via the `identity` branch here.
 *
 * The COMPRESSED bytes are capped by `maxBytes` (the same 256 KiB request cap),
 * and the decompressed size is bounded by `SYNC_DECOMPRESSED_BYTE_CEILING`
 * (`gunzipSync`'s `maxOutputLength` throws before allocating past it) — a
 * zip-bomb is refused with a 400, never buffered to OOM. Exactly one of
 * `rawBody` / `response` is set.
 */
export async function readBoundedMaybeGzipJsonBody(
  request: Request,
  maxBytes: number
): Promise<
  | { rawBody: unknown; response: null }
  | { rawBody: null; response: NextResponse<ApiResult<never>> }
> {
  const encoding = request.headers
    .get(SYNC_CONTENT_ENCODING_HEADER)
    ?.trim()
    .toLowerCase();
  if (encoding !== SyncPayloadEncoding.Gzip) {
    // Legacy uncompressed (or `identity`) path — unchanged behavior.
    return readBoundedJsonBody(request, maxBytes);
  }

  let capped: { ok: true; value: Buffer; bytesRead: number } | { ok: false };
  try {
    capped = await readCappedRequestBytes(request, maxBytes);
  } catch (error) {
    // The compressed request stream errored or was cancelled mid-read (client
    // disconnect, aborted upload). ISS-8688: that is a failed READ, answered
    // 500 like every other bounded reader — it used to return the route's 400
    // envelope, which is the misattribution the ticket exists to remove.
    return {
      rawBody: null,
      response: errorResponse("Failed to read request body", error),
    };
  }
  if (!capped.ok) {
    logRequestBodyOverCap(request, maxBytes);
    return {
      rawBody: null,
      response: payloadTooLargeResponse("Request body too large"),
    };
  }
  const truncationError = requestBodyTruncationError(request, capped.bytesRead);
  if (truncationError !== null) {
    return {
      rawBody: null,
      response: errorResponse("Failed to read request body", truncationError),
    };
  }

  let jsonText: string;
  try {
    jsonText = gunzipSync(capped.value, {
      maxOutputLength: SYNC_DECOMPRESSED_BYTE_CEILING,
    }).toString("utf8");
  } catch {
    // Malformed gzip OR an over-ceiling decompressed size (zip-bomb guard):
    // reject as a bad request rather than crashing the ingest path.
    return {
      rawBody: null,
      response: badRequestResponse("Invalid compressed body"),
    };
  }

  try {
    return { rawBody: JSON.parse(jsonText) as unknown, response: null };
  } catch {
    return { rawBody: null, response: badRequestResponse("Invalid JSON body") };
  }
}

/**
 * FEA-4138: byte-accumulating counterpart to `readCappedRequestText` for a
 * binary (gzip) body. Reads the raw request bytes, refusing (`ok: false`) once
 * the accumulated COMPRESSED size crosses `maxBytes` — the reader is cancelled
 * at that point so an oversized body is never fully buffered.
 */
export async function readCappedRequestBytes(
  request: Request,
  maxBytes: number
): Promise<{ ok: true; value: Buffer; bytesRead: number } | { ok: false }> {
  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: true, value: Buffer.alloc(0), bytesRead: 0 };
  }

  const chunks: Buffer[] = [];
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return { ok: true, value: Buffer.concat(chunks), bytesRead };
    }
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(Buffer.from(value));
  }
}

/**
 * ISS-7565: request-body cap for the desktop handshake routes — device
 * onboarding, session exchange/refresh/revoke, authorize (mint and token),
 * bootstrap claim, onboarding attempt. MOST read the body before any auth, so
 * an unauthenticated caller decides what gets buffered. A few resolve the Clerk
 * session first (the authorize mint, onboarding attempt, device-onboarding
 * approve); there the cap instead bounds what an AUTHENTICATED caller can make
 * the route buffer. Either way the body is streamed under the cap rather than
 * buffered whole, which is the property the cap exists for.
 *
 * Sized from the widest handshake schema — `bootstrap/claim`, which carries TWO
 * independent 16 KiB PEM fields (`gatewayPublicKeyPem` plus the legacy
 * `gatewayPublicKey` alias) for ~36 KiB worst case once the PEMs' newlines are
 * JSON-escaped. Every one of these schemas is `.strict()` with per-field
 * `.max()`, so a body past this is malformed by construction.
 */
export const DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES = 65_536;
