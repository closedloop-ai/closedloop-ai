"use client";

import type {
  TranscriptFileDescriptor,
  TranscriptForceArchiveResult,
} from "@repo/api/src/types/desktop-transcripts";
import { createContext, type ReactNode, useContext } from "react";
import { TranscriptFetchError } from "../lib/parse-transcript";

/**
 * Resolves the URL {@link import("../lib/parse-transcript").fetchAndParseTranscript}
 * should GET for a transcript file — the one platform-specific step in an
 * otherwise shared read path.
 *
 * - **Web (default):** the short-lived signed S3 URL from the descriptor. The
 *   browser fetches it directly (cross-origin, covered by the bucket's
 *   web-origin CORS at `https://app.closedloop.ai`).
 * - **Desktop:** an implementation (injected by the renderer shell) that hands
 *   the file id to the main process — which mints the signed URL and fetches the
 *   bytes itself — and returns an opaque same-origin
 *   `app://renderer/transcripts/…` URL. So the renderer stays under
 *   `connect-src 'self' app:` and the (multi-MB) bytes never cross the IPC
 *   bridge (FEA-3324 Option B2).
 *
 * Either way the returned URL flows into the same `fetchAndParseTranscript`, so
 * parsing and caching stay identical across surfaces.
 */
/**
 * Where the resolved bytes came from. `cloud` is the archived S3 copy;
 * `local` is the desktop graceful fallback (the on-disk `.jsonl` served over
 * `app://` when the cloud read failed / was not yet readable). The web transport
 * always resolves `cloud` (there is no local file). Surfaced so the panel can
 * show a subtle "showing local copy (cloud unavailable)" indicator.
 */
export type TranscriptBytesSource = "cloud" | "local";

/**
 * Result of resolving a transcript file's byte source.
 * - `ready`: `url` is fetchable now (signed S3 or `app://`).
 * - `oversized`: a LOCAL fallback file exceeds the auto-load cap and was NOT
 *   staged; `byteSize` drives the renderer's explicit "Load full transcript"
 *   gate. Only the desktop transport returns this (the web gates cloud files on
 *   the descriptor's own `byteSize` before ever resolving).
 */
export type ResolvedTranscriptFetch =
  | {
      kind: "ready";
      /** The URL `fetchAndParseTranscript` should GET (signed S3 or `app://`). */
      url: string;
      /** Which copy the URL points at, for the UI indicator. */
      source: TranscriptBytesSource;
    }
  | {
      kind: "oversized";
      /** On-disk byte size of the gated local file. */
      byteSize: number;
      source: TranscriptBytesSource;
    };

export type ResolveFetchUrlInput = {
  sessionId: string;
  /**
   * Harness session id (the on-disk `.jsonl` identity) — distinct from the cloud
   * `sessionId`. The desktop transport forwards it so the main process can key
   * its LOCAL fallback lookup by the identifier the local store/discovery index
   * by; without it the fallback never matches. Omitted on the web (no local
   * file) and when the surface can't supply it.
   */
  externalSessionId?: string;
  file: TranscriptFileDescriptor;
  /**
   * The renderer's auto-load byte cap, forwarded so the desktop main process can
   * gate an oversized LOCAL file before staging its bytes (the cloud descriptor
   * has no size for a not-yet-uploaded file). Omitted ⇒ no local size gate.
   */
  maxAutoLoadBytes?: number;
  /** True once the user opted into loading an oversized file (bypass the gate). */
  allowOversized?: boolean;
  /**
   * The read query's abort signal (FEA-3678). The desktop transport wires it to
   * an IPC cancel so a user Cancel aborts the MAIN-process S3 download mid-stream
   * (a renderer-side query abort alone can't reach it) — stopping the transfer and
   * its egress. The web transport ignores it: its S3 fetch happens later in
   * `fetchAndParseTranscript`, which already receives the same signal. Omitted
   * when the caller has no signal to thread.
   */
  signal?: AbortSignal;
};

/**
 * Result of a user-initiated force-archive of ONE oversized transcript
 * (FEA-3489 / PRD-536). This is the SINGLE canonical `TranscriptForceArchiveResult`
 * from `@repo/api/src/types/desktop-transcripts` — the same shape the desktop IPC
 * bridge returns — aliased here so the shared panel/hook keep referring to it by a
 * surface-agnostic name while both sides type-check against one definition (no
 * drift between the desktop wire type and this transport). See that module's JSDoc
 * for the discriminated terminal-vs-retryable states.
 */
export type ForceArchiveOversizedResult = TranscriptForceArchiveResult;

export type ForceArchiveOversizedInput = {
  /** Harness session id (the local sync store's dead-row identity). */
  externalSessionId: string;
  fileKey: string;
};

export type TranscriptBytesTransport = {
  resolveFetchUrl(
    input: ResolveFetchUrlInput
  ): Promise<ResolvedTranscriptFetch>;
  /**
   * True when this surface can serve a LOCAL copy even if the cloud descriptor's
   * `url`/`rawSha256` are null (desktop). The read hook uses this to still
   * attempt a parse when the cloud copy is unreadable — `resolveFetchUrl` then
   * produces a local-backed `app://` URL. False on the web (no local file), so
   * web readability stays gated on the cloud descriptor exactly as before.
   */
  supportsLocalFallback: boolean;
  /**
   * Force-archive ONE transcript the automatic lane dead-lettered for exceeding
   * the size cap (FEA-3489). Desktop-only: it commands the LOCAL machine to
   * upload past the cap for this file. Undefined on the web (no local file) — the
   * panel then renders the action disabled with an explanation, per PRD-536.
   */
  forceArchiveOversized?: (
    input: ForceArchiveOversizedInput
  ) => Promise<ForceArchiveOversizedResult>;
};

/** Web behavior: fetch the descriptor's signed S3 URL directly (always cloud). */
const defaultTranscriptBytesTransport: TranscriptBytesTransport = {
  supportsLocalFallback: false,
  resolveFetchUrl: ({ file }) => {
    if (!file.url) {
      return Promise.reject(
        new TranscriptFetchError(
          0,
          "Transcript is no longer available for reading."
        )
      );
    }
    return Promise.resolve({ kind: "ready", url: file.url, source: "cloud" });
  },
};

const TranscriptBytesTransportContext = createContext<TranscriptBytesTransport>(
  defaultTranscriptBytesTransport
);

/**
 * Overrides the transcript byte transport for a subtree. Mounted by the desktop
 * renderer shell; the web app relies on the default (direct signed-URL fetch),
 * so it needs no provider.
 */
export function TranscriptBytesTransportProvider({
  transport,
  children,
}: {
  transport: TranscriptBytesTransport;
  children: ReactNode;
}) {
  return (
    <TranscriptBytesTransportContext.Provider value={transport}>
      {children}
    </TranscriptBytesTransportContext.Provider>
  );
}

export function useTranscriptBytesTransport(): TranscriptBytesTransport {
  return useContext(TranscriptBytesTransportContext);
}
