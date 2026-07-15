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
import {
  type TranscriptCompleteRequest,
  type TranscriptCompleteResponse,
  type TranscriptSyncPlanRequest,
  type TranscriptSyncPlanResponse,
  transcriptCompleteResponseSchema,
  transcriptSyncPlanResponseSchema,
} from "@repo/api/src/types/desktop-transcripts";
import { unwrapApiEnvelope } from "./api-response-utils.js";

const CONTROL_REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_REQUEST_TIMEOUT_MS = 120_000;

/** S3's full-object CRC64NVME header for the `fullPut` presigned PutObject. */
const S3_CRC64NVME_HEADER = "x-amz-checksum-crc64nvme";
/** Matches `TRANSCRIPT_CONTENT_TYPE` in packages/aws (signed on the fullPut). */
const TRANSCRIPT_CONTENT_TYPE = "application/x-ndjson";

export class TranscriptSyncClientError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "TranscriptSyncClientError";
    this.status = status;
  }
}

export type DesktopTranscriptsClientOptions = {
  fetch?: typeof fetch;
  getAccessToken: () => Promise<string | null>;
  getApiOrigin: () => string | undefined;
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
};

export function createDesktopTranscriptsClient(
  options: DesktopTranscriptsClientOptions
): DesktopTranscriptsClient {
  const fetchImpl = options.fetch ?? fetch;

  async function resolveControlUrl(path: string): Promise<{
    url: URL;
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
    let url: URL;
    try {
      url = new URL(path, origin);
    } catch {
      throw new TranscriptSyncClientError(`invalid API origin for ${path}`);
    }
    return { url, token };
  }

  async function postControl<T>(
    path: string,
    payload: unknown,
    parse: (value: unknown) => { success: boolean; data?: T }
  ): Promise<T> {
    const { url, token } = await resolveControlUrl(path);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new TranscriptSyncClientError(
        `${path} request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!response.ok) {
      throw new TranscriptSyncClientError(
        `${path} returned HTTP ${response.status}`,
        response.status
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
      let detail = "";
      try {
        detail = (await response.text())
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 500);
      } catch {
        // body unavailable — fall back to status-only
      }
      throw new TranscriptSyncClientError(
        detail
          ? `${label} returned HTTP ${response.status}: ${detail}`
          : `${label} returned HTTP ${response.status}`,
        response.status
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
  };
}
