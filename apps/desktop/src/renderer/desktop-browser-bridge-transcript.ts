import { z } from "zod";
import type {
  TranscriptPrepareRequest,
  TranscriptPrepareResult,
} from "../shared/transcript-read-contract.js";
import { base64ToBytes, bytesToBase64 } from "./shared/bytes-base64";

/**
 * ISS-12135: transcript reads for the browser bridge tab.
 *
 * The preload's `prepareTranscript` answers with an `app://` URL the tab cannot
 * load, and the signed S3 URL main mints behind it must never reach browser
 * JavaScript (which is why the `cloudApiFetch` relay still refuses the
 * transcript route). So the HOST runs the real prepare, which keeps main's
 * sender-trust check and request validation, reads the prepared file inside
 * Electron, and pushes its bytes to the tab over the bridge socket in chunks
 * through a client callback. The tab reassembles them into a `blob:` URL, so
 * the shared transcript transport fetches it exactly as it fetches `app://`.
 */
export function projectTranscriptPrepare(
  prepare: (request: unknown) => unknown,
  fetchPrepared: (url: string) => Promise<Response> = (url) =>
    globalThis.fetch(url)
): (request: unknown, onChunk: unknown) => Promise<BridgedTranscriptResult> {
  return async (request, onChunk) => {
    if (typeof onChunk !== "function") {
      throw new Error("Desktop browser bridge transcript read is invalid");
    }
    const prepared = hostPrepareResultSchema.safeParse(await prepare(request));
    if (!prepared.success) {
      throw new Error("Desktop browser bridge transcript result is invalid");
    }
    if (prepared.data.kind !== "ready") {
      return prepared.data;
    }
    const response = await fetchPrepared(prepared.data.url);
    if (!response.ok) {
      throw new Error(
        `Desktop browser bridge could not read the prepared transcript (HTTP ${response.status})`
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    for (
      let offset = 0;
      offset < bytes.byteLength;
      offset += TRANSCRIPT_CHUNK_BYTES
    ) {
      onChunk(
        bytesToBase64(bytes.subarray(offset, offset + TRANSCRIPT_CHUNK_BYTES))
      );
    }
    return {
      byteLength: bytes.byteLength,
      kind: "ready",
      source: prepared.data.source,
    };
  };
}

/**
 * The tab half: replace the bridged method with one that collects the pushed
 * chunks and answers with the same {@link TranscriptPrepareResult} the
 * Electron preload does, with a `blob:` URL in place of the `app://` one.
 */
export function applyBrowserClientTranscriptApi(
  desktopApi: Record<string, unknown>
): void {
  const bridged = desktopApi.prepareTranscript;
  if (typeof bridged !== "function") {
    return;
  }
  const liveUrls: string[] = [];
  desktopApi.prepareTranscript = async (
    request: TranscriptPrepareRequest
  ): Promise<TranscriptPrepareResult> => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const answer = bridgedResultSchema.safeParse(
      await bridged(request, (chunk: unknown) => {
        if (typeof chunk === "string") {
          chunks.push(base64ToBytes(chunk));
        }
      })
    );
    if (!answer.success) {
      throw new Error("Desktop browser bridge transcript result is invalid");
    }
    if (answer.data.kind !== "ready") {
      return answer.data;
    }
    const blob = new Blob(chunks);
    // A push over the frame cap is dropped on the wire rather than delivered,
    // so a short count means bytes went missing; never parse a partial file.
    if (blob.size !== answer.data.byteLength) {
      throw new Error("Desktop browser bridge transcript arrived incomplete");
    }
    const url = globalThis.URL.createObjectURL(blob);
    retainObjectUrl(liveUrls, url);
    return { kind: "ready", source: answer.data.source, url };
  };
}

/**
 * Keep the newest URLs alive and revoke the rest. The transport fetches a URL
 * right after prepare returns, but a session's subagent files resolve
 * concurrently, so the bound has to cover a burst rather than one file.
 */
function retainObjectUrl(liveUrls: string[], url: string): void {
  liveUrls.push(url);
  while (liveUrls.length > LIVE_TRANSCRIPT_URL_LIMIT) {
    const expired = liveUrls.shift();
    if (expired) {
      globalThis.URL.revokeObjectURL(expired);
    }
  }
}

/**
 * Raw bytes per push. Base64 grows them by a third, so a chunk is about 1.4 MB
 * on the wire, under the bridge's 2 MiB frame cap with room for the envelope.
 */
const TRANSCRIPT_CHUNK_BYTES = 1024 * 1024;
const LIVE_TRANSCRIPT_URL_LIMIT = 16;

const sourceSchema = z.enum(["cloud", "local"]);
const oversizedSchema = z.object({
  byteSize: z.number().int().nonnegative(),
  kind: z.literal("oversized"),
  source: sourceSchema,
});
const errorSchema = z.object({
  kind: z.literal("error"),
  message: z.string(),
});
const hostPrepareResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), source: sourceSchema, url: z.string() }),
  oversizedSchema,
  errorSchema,
]);
const bridgedResultSchema = z.discriminatedUnion("kind", [
  z.object({
    byteLength: z.number().int().nonnegative(),
    kind: z.literal("ready"),
    source: sourceSchema,
  }),
  oversizedSchema,
  errorSchema,
]);

type BridgedTranscriptResult = z.infer<typeof bridgedResultSchema>;
