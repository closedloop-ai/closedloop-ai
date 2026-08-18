/**
 * Wire contract for the desktop cloud-transcript read bridge (FEA-3324 Option
 * B2 / PLN-1138 Phase 2).
 *
 * The renderer never fetches transcript bytes from S3 directly (that would need
 * both an S3-CORS and a CSP `connect-src` widening — see
 * `content-security-policy.ts`). Instead it asks the main process to *prepare* a
 * transcript file by id; main authorizes and mints the signed S3 URL itself (via
 * the read route, with the first-party session token), streams the bytes into a
 * local cache, and returns an opaque same-origin `app://renderer/transcripts/…`
 * URL the renderer can `fetch()` under the unchanged `connect-src 'self' app:`.
 *
 * Per AGENTS.md, values that cross the main/renderer boundary live in a shared
 * module so the two sides can't drift — the main handler
 * (`main/transcript-read-ipc.ts`), `preload-common.ts`, and the renderer
 * transport all import from here. The renderer supplies only ids (never a URL),
 * so main stays the single authority for what it fetches (SSRF prevention).
 */

/** IPC channel the renderer invokes with a {@link TranscriptPrepareRequest}. */
export const TRANSCRIPT_PREPARE_CHANNEL = "desktop:transcript:prepare";

/**
 * IPC channel the renderer invokes to abort an IN-FLIGHT prepare (FEA-3678).
 * The actual S3 byte download runs in the MAIN process
 * (`prepareTranscript` → `ensureTranscriptCached`), so a renderer-side query
 * abort alone cannot stop it — the transfer (and its egress) would otherwise run
 * to completion after the user clicks Cancel. The renderer passes the same
 * {@link TranscriptPrepareRequest.requestId} it sent to prepare; main aborts the
 * matching download's `AbortController`. Best-effort and idempotent: an unknown
 * or already-finished `requestId` is a no-op.
 */
export const TRANSCRIPT_CANCEL_CHANNEL = "desktop:transcript:cancel";

/** Request half of the cancel bridge — the `requestId` of the prepare to abort. */
export type TranscriptCancelRequest = {
  requestId: string;
};

/**
 * Request half of the bridge. The renderer passes only the identifiers it
 * already holds from the (main-proxied) descriptor read; main re-derives the
 * signed URL from these — it never accepts a renderer-supplied URL.
 */
export type TranscriptPrepareRequest = {
  /**
   * Artifact id of the session whose transcript file to prepare. This is the
   * CLOUD id — it keys the cloud read route (`/agent-sessions/{id}/transcript`),
   * NOT the on-disk transcript. The local files are keyed by the harness
   * `externalSessionId` (below), which is what the local fallback resolves by.
   */
  sessionId: string;
  /**
   * Correlation id for this prepare, so the renderer can later abort THIS
   * in-flight download over {@link TRANSCRIPT_CANCEL_CHANNEL} (FEA-3678). The
   * main process registers an `AbortController` under this id for the duration of
   * the download and drops it on completion; a cancel with the same id aborts the
   * transfer mid-stream (stopping the S3 egress) instead of letting it run to
   * completion after the user clicks Cancel. Optional + additive: older callers
   * and the web transport (no main-process download to cancel) omit it, in which
   * case the download is simply not cancellable (only the 120s timeout bounds it,
   * as before).
   */
  requestId?: string;
  /**
   * Harness session id (the `.jsonl`'s on-disk identity — Claude's projects-path
   * session id or Codex's rollout id). The desktop LOCAL fallback resolver keys
   * on THIS, never the cloud `sessionId`: the two differ, so querying the local
   * store/discovery with the cloud id never matches and the whole fallback
   * silently no-ops. Optional + additive — the web transport omits it (no local
   * file) and older callers may too, in which case no local fallback is
   * attempted. Never used to compose a filesystem path directly; it only selects
   * a candidate that is still re-anchored through the trusted-path guard.
   */
  externalSessionId?: string;
  /** Which transcript file — `main` or `subagent:{fileId}`. */
  fileKey: string;
  /**
   * The renderer's auto-load byte cap (its `TRANSCRIPT_AUTO_LOAD_MAX_BYTES`).
   * Only consulted on the LOCAL fallback path: the cloud descriptor already
   * carries `byteSize` so the renderer gates oversized cloud files before it
   * ever calls prepare, but a local file the cloud can't see has no such size
   * upfront. Main stats the local file and, when it exceeds this cap AND
   * `allowOversized` is not set, returns an {@link TranscriptPrepareResult}
   * `oversized` (without staging the bytes) so the renderer shows the same
   * explicit "Load full transcript" gate it shows for large cloud files. Absent
   * ⇒ no local size gate (the cap stays the renderer's single source of truth;
   * omitting it just disables the gate). Ignored on the cloud path.
   */
  maxAutoLoadBytes?: number;
  /**
   * Set once the user has clicked "Load full transcript" for this file — bypass
   * the local oversize gate and stage the bytes. Mirrors the renderer's
   * `isDeferredLoadRequested`. Ignored on the cloud path (the renderer already
   * gates cloud files itself).
   */
  allowOversized?: boolean;
};

/**
 * Where the prepared bytes came from. `cloud` is the archived S3 copy (the
 * preferred source); `local` is the graceful fallback served from the on-disk
 * `.jsonl` when the cloud read failed or the file was not cloud-readable yet, so
 * the UI can show a subtle "showing local copy (cloud unavailable)" indicator.
 */
export type TranscriptPrepareSource = "cloud" | "local";

/**
 * Result half of the bridge. `ready` carries the opaque same-origin
 * `app://renderer/transcripts/…` URL plus the {@link TranscriptPrepareSource};
 * `oversized` reports a LOCAL fallback file that exceeds the request's
 * `maxAutoLoadBytes` (its `byteSize` lets the renderer show the "Load full
 * transcript" gate — the bytes are NOT staged until the user opts in with
 * `allowOversized`); `error` carries a human-readable reason (unauthorized, not
 * readable, network failure — with no local copy to fall back to) the renderer
 * surfaces like any other transcript read error. The transcript bytes
 * themselves never cross this IPC channel — only this small envelope does; the
 * bytes ride the `app://` scheme through Chromium's network stack.
 */
export type TranscriptPrepareResult =
  | { kind: "ready"; url: string; source: TranscriptPrepareSource }
  | {
      kind: "oversized";
      byteSize: number;
      source: TranscriptPrepareSource;
    }
  | { kind: "error"; message: string };

/**
 * IPC channel for the user-initiated force-archive override (FEA-3489 / PRD-536).
 * A transcript the automatic archive lane dead-lettered for exceeding the local
 * size cap ("not archived — exceeds size limit") can be force-enqueued by the
 * user for a single upload attempt that bypasses the cap for that one file. Only
 * the desktop offers this (it needs the LOCAL transcript file — the web app
 * reading via the cloud API cannot command a remote machine, consistent with the
 * gateway/local-filesystem boundary).
 */
export const TRANSCRIPT_FORCE_ARCHIVE_CHANNEL =
  "desktop:transcript:force-archive";

/**
 * Request half of the force-archive bridge. Identifies the ONE local transcript
 * file to force past the size cap. `externalSessionId` is the HARNESS session id
 * (the local sync store keys the dead row by it), NOT the cloud `sessionId`.
 */
export type TranscriptForceArchiveRequest = {
  externalSessionId: string;
  fileKey: string;
};

/**
 * Result half of the force-archive bridge. The shape is the single canonical
 * `TranscriptForceArchiveResult` defined in `@repo/api/src/types/desktop-transcripts`
 * (already the runtime home of `TranscriptSkipReason` for this lane); it is
 * re-exported here as the desktop IPC's result type so the main handler, the
 * preload bridge, and the shared renderer transport all reference one shape and
 * cannot drift. Discriminated terminal-vs-retryable states live in that module's
 * JSDoc.
 */
export type { TranscriptForceArchiveResult } from "@repo/api/src/types/desktop-transcripts";
