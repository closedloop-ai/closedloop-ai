import { gunzipSync } from "node:zlib";
import {
  SYNC_CONTENT_ENCODING_HEADER,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import { SYNC_DECOMPRESSED_BYTE_CEILING } from "@repo/api/src/types/agent-session-sync-limits";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import {
  badRequestResponse,
  payloadTooLargeResponse,
  readCappedRequestText,
} from "@/lib/route-utils";

/**
 * FEA-3425: shared `computeTargetId` query-param gate for the desktop
 * write-lane routes. Returns the trimmed id, or a 400 `computeTargetId is
 * required` response — exactly one of `computeTargetId` / `response` is set.
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
      response: badRequestResponse("computeTargetId is required"),
    };
  }
  return { computeTargetId, response: null };
}

/**
 * FEA-3425: shared request-body scaffold for the desktop write-lane routes
 * (`/desktop/agent-sessions/sync`, `/desktop/analytics`, `/desktop/telemetry`).
 * Streams the body under a byte cap (413 over `maxBytes`), rejects unparseable
 * JSON with 400, and hands back the parsed body otherwise — exactly one of
 * `rawBody` / `response` is set. Validation of the parsed shape stays with
 * each route's handler, which owns the payload schema.
 */
export async function readBoundedJsonBody(
  request: Request,
  maxBytes: number
): Promise<
  | { rawBody: unknown; response: null }
  | { rawBody: null; response: NextResponse<ApiResult<never>> }
> {
  let bodyText: string;
  try {
    const capped = await readCappedRequestText(request, maxBytes);
    if (!capped.ok) {
      return {
        rawBody: null,
        response: payloadTooLargeResponse("Request body too large"),
      };
    }
    bodyText = capped.value;
  } catch {
    return { rawBody: null, response: badRequestResponse("Invalid JSON body") };
  }

  try {
    return { rawBody: JSON.parse(bodyText) as unknown, response: null };
  } catch {
    return { rawBody: null, response: badRequestResponse("Invalid JSON body") };
  }
}

/**
 * FEA-3425: coded 429 envelope shared by the desktop write-lane routes. The
 * desktop clients dispatch on `code` + status, so the code always accompanies
 * the status.
 */
export function rateLimitedResponse(
  code: string
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure("Rate limited", { code }), { status: 429 });
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

  let capped: { ok: true; value: Buffer } | { ok: false };
  try {
    capped = await readCappedRequestBytes(request, maxBytes);
  } catch {
    // The compressed request stream errored or was cancelled mid-read (client
    // disconnect, aborted upload). Mirror the legacy `readBoundedJsonBody`
    // path and return the route's 400 envelope rather than letting the reject
    // escape into the handler's generic 500.
    return {
      rawBody: null,
      response: badRequestResponse("Invalid compressed body"),
    };
  }
  if (!capped.ok) {
    return {
      rawBody: null,
      response: payloadTooLargeResponse("Request body too large"),
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
async function readCappedRequestBytes(
  request: Request,
  maxBytes: number
): Promise<{ ok: true; value: Buffer } | { ok: false }> {
  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: true, value: Buffer.alloc(0) };
  }

  const chunks: Buffer[] = [];
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return { ok: true, value: Buffer.concat(chunks) };
    }
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(Buffer.from(value));
  }
}
