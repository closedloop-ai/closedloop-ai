import type {
  ResolvedTranscriptFetch,
  TranscriptBytesTransport,
} from "@repo/app/agents/data-source/transcript-bytes-transport";
import { TranscriptBytesTransportProvider } from "@repo/app/agents/data-source/transcript-bytes-transport";
import { TranscriptFetchError } from "@repo/app/agents/lib/parse-transcript";
import type { ReactNode } from "react";
import type { TranscriptPrepareResult } from "../../shared/transcript-read-contract.js";

/**
 * Desktop transcript byte transport (FEA-3324 Option B2 / PLN-1138 Phase 2).
 *
 * Replaces the shared default (renderer-direct signed-S3 fetch): the renderer
 * hands only the file id to the main process, which mints the signed URL and
 * streams the bytes into a local cache, then returns an opaque same-origin
 * `app://renderer/transcripts/…` URL. The shared `fetchAndParseTranscript` then
 * GETs that URL under the unchanged `connect-src 'self' app:` — the (multi-MB)
 * transcript bytes never cross the IPC bridge and no remote origin is added to
 * the renderer.
 *
 * Only exercised in cloud mode: signed-out / offline detail omits `transcripts`,
 * so `useSessionTranscript` stays disabled and this resolver is never called.
 */
/** Map a raw prepare envelope to the shared transport result (or throw). */
function mapPrepareResult(
  result: TranscriptPrepareResult
): ResolvedTranscriptFetch {
  if (result.kind === "error") {
    throw new TranscriptFetchError(0, result.message);
  }
  if (result.kind === "oversized") {
    // A large LOCAL file: surface the size so the hook shows the explicit
    // "Load full transcript" gate — no bytes were staged.
    return {
      kind: "oversized",
      byteSize: result.byteSize,
      source: result.source,
    };
  }
  // `source` distinguishes the cloud copy from the graceful local fallback
  // (served when the cloud read failed / was not yet readable) so the panel
  // can flag "showing local copy".
  return { kind: "ready", url: result.url, source: result.source };
}

const desktopTranscriptBytesTransport: TranscriptBytesTransport = {
  // Desktop can serve the on-disk `.jsonl` even when the cloud copy is not
  // readable, so the read hook attempts a parse and lets `resolveFetchUrl`
  // produce a local-backed `app://` URL.
  supportsLocalFallback: true,
  // Force-archive override (FEA-3489): re-queue ONE oversized transcript the
  // automatic lane dead-lettered and upload it past the size cap for that file
  // only, via the main-process resumable upload lane. The IPC result and the
  // shared transport result are now the SAME canonical
  // `TranscriptForceArchiveResult` (@repo/api), so it passes through unchanged. A
  // partial test stub / older preload without the bridge degrades to
  // `unavailable` rather than throwing, so the panel offers a retry not a crash.
  forceArchiveOversized: async (input) => {
    const force = window.desktopApi?.forceArchiveTranscript;
    if (typeof force !== "function") {
      return { kind: "unavailable" };
    }
    return await force({
      externalSessionId: input.externalSessionId,
      fileKey: input.fileKey,
    });
  },
  resolveFetchUrl: async ({
    sessionId,
    externalSessionId,
    file,
    maxAutoLoadBytes,
    allowOversized,
    signal,
  }) => {
    const prepare = window.desktopApi?.prepareTranscript;
    if (typeof prepare !== "function") {
      // Partial test stubs may omit the bridge; fail like an unreachable read.
      throw new TranscriptFetchError(
        0,
        "The desktop transcript bridge is unavailable."
      );
    }
    // Already cancelled before we even start: don't kick off a main-process
    // download at all (there'd be no controller registered yet for a cancel to
    // find — firing one here would race its own prepare and leave the download
    // running). Reject immediately so no S3 transfer begins.
    if (signal?.aborted) {
      throw new TranscriptFetchError(0, "Transcript load was cancelled.");
    }
    // Correlation id so a Cancel can abort THIS main-process download (FEA-3678):
    // the actual S3 transfer runs in main, so aborting the renderer query alone
    // leaves it (and its egress) running to completion. Forward the id and, on
    // abort, tell main to cancel the matching download mid-stream. The listener
    // only attaches here (signal not yet aborted), so main has already registered
    // the download's controller by the time any cancel message it sends arrives.
    const requestId = crypto.randomUUID();
    const cancel = window.desktopApi?.cancelTranscriptPrepare;
    const onAbort = () => {
      cancel?.({ requestId }).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await prepare({
        sessionId,
        requestId,
        // Harness id for the LOCAL fallback lookup — main keys the on-disk file
        // by this, not the cloud `sessionId`. Omit when undefined rather than
        // sending `undefined`.
        ...(externalSessionId ? { externalSessionId } : {}),
        fileKey: file.fileKey,
        // Forward the cap + opt-in so main can gate an oversized LOCAL file
        // before staging its bytes (the cloud descriptor carries no size for a
        // not-yet-uploaded file). Omit when undefined rather than sending
        // `undefined`.
        ...(maxAutoLoadBytes == null ? {} : { maxAutoLoadBytes }),
        ...(allowOversized ? { allowOversized } : {}),
      });
      return mapPrepareResult(result);
    } finally {
      // The prepare has resolved (download done) or thrown — the cancel wiring is
      // no longer needed. Detach so the signal doesn't retain this closure.
      signal?.removeEventListener("abort", onAbort);
    }
  },
};

export function DesktopTranscriptTransportProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <TranscriptBytesTransportProvider
      transport={desktopTranscriptBytesTransport}
    >
      {children}
    </TranscriptBytesTransportProvider>
  );
}
