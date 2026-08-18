"use client";

import {
  type TranscriptAccessResponse,
  TranscriptAvailability,
  type TranscriptAvailabilitySummary,
  type TranscriptFileDescriptor,
} from "@repo/api/src/types/desktop-transcripts";
import type { NormalizedSession } from "@repo/lib/harness/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApiClient } from "../../shared/api/use-api-client";
import { useFeatureFlagEnabled } from "../../shared/feature-flags/use-feature-flag-enabled";
import {
  type TranscriptBytesSource,
  useTranscriptBytesTransport,
} from "../data-source/transcript-bytes-transport";
import {
  fetchAndParseTranscript,
  isCloudParseableHarness,
  type TranscriptDownloadProgress,
  TranscriptFetchError,
  TranscriptParseError,
} from "../lib/parse-transcript";
import { MAIN_TRANSCRIPT_FILE_KEY } from "../lib/session-transcript-href";
import { agentSessionKeys } from "./use-agent-sessions";

/**
 * Auto-fetch cap (meeting decision, PLN-1290 Task 3): files at or below this size
 * hydrate automatically; larger ones show their byte size behind an explicit
 * "Load full transcript" action so a 275 MB outlier never auto-downloads. P95
 * (~1.5 MB) is well under the cap.
 */
export const TRANSCRIPT_AUTO_LOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * PostHog flag (FEA-3447) gating the streaming download-progress UI — the
 * percent/bytes indicator and a Cancel button shown while a large transcript
 * downloads. Off ⇒ the prior behavior (a bare skeleton spinner, no cancel). The
 * flag only toggles the UI/progress reporting; the parsed result is identical.
 */
export const TRANSCRIPT_DOWNLOAD_PROGRESS_FLAG = "transcript-download-progress";

/**
 * Parsed transcript trust window (owner, 2026-07-08): while the detail page is
 * observed, the parsed session is fresh for an hour — no refetch on focus or
 * remount. Paired with `gcTime: 0` so the (potentially large) parsed session is
 * freed the moment the last observer unmounts; returning re-fetches and re-parses.
 *
 * This durable window is safe ONLY for a CLOUD read, whose query key folds in the
 * archive `rawSha256` — a re-upload mints a new key, so the cache can never serve
 * bytes that changed underneath it. A desktop-LOCAL read has no archive identity
 * (`rawSha256` null → the key's sha slot is `""`, stable across edits), so an
 * active local `.jsonl` that keeps changing would otherwise stay pinned to its
 * first parse for the whole window. Local reads therefore use `staleTime: 0`
 * (see `parsedStaleTime`) so a live detail refetch / remount / refocus re-parses
 * the current on-disk copy instead of the stale first snapshot.
 */
const TRANSCRIPT_PARSED_STALE_MS = 60 * 60 * 1000;

function fetchTranscriptAccess(
  api: ReturnType<typeof useApiClient>,
  sessionId: string
): Promise<TranscriptAccessResponse> {
  return api.get<TranscriptAccessResponse>(
    `/agent-sessions/${sessionId}/transcript`
  );
}

/**
 * Synthesize a read descriptor for a LOCAL-only transcript file from the
 * detail's availability summary (desktop-local surface). The cloud fields
 * (`url`/`rawSha256`/`byteSize`) are null — there is no archived copy to sign —
 * but the desktop byte transport (`supportsLocalFallback`) resolves the on-disk
 * `.jsonl` over IPC without them, keyed by `externalSessionId`. So this
 * descriptor exists purely to make the file `isReadable` on the local surface
 * (which the read state gates on `supportsLocalFallback`, not the cloud url), so
 * the parse runs and the transport serves the local bytes.
 */
function localDescriptorFromSummary(
  summary: TranscriptAvailabilitySummary
): TranscriptFileDescriptor {
  return {
    fileKey: summary.fileKey,
    availability: summary.availability,
    url: null,
    byteSize: null,
    rawSha256: null,
    uploadedAt: summary.uploadedAt,
    lastObservedAt: null,
    // Carry the terminal skip reason through to the local descriptor so the
    // panel can render the permanent state on either surface (FEA-3476).
    permanentFailureReason: summary.permanentFailureReason,
  };
}

/**
 * Find the descriptor for `fileKey` in a fresh cloud access response, falling
 * back to a synthesized LOCAL descriptor when the cloud lane can't serve it but
 * the detail carries a local availability summary and this surface can read a
 * local copy. This is the desktop-local read path: signed-out / offline detail
 * comes from the local SQLite (`mapDetail`), so the cloud descriptor route is
 * inert — without this seed the file would never be readable and the on-disk
 * transcript would never render, even though the byte transport can serve it.
 */
function resolveReadDescriptor(input: {
  cloudFiles: TranscriptFileDescriptor[] | undefined;
  fileKey: string;
  localTranscripts: readonly TranscriptAvailabilitySummary[] | undefined;
  supportsLocalFallback: boolean;
}): TranscriptFileDescriptor | undefined {
  const cloudFile = input.cloudFiles?.find(
    (entry) => entry.fileKey === input.fileKey
  );
  // The cloud descriptor is authoritative whenever it EXISTS — a readable
  // (available/stale) file reads from S3, and a not-yet-readable
  // (pending/failed/missing) one still drives the panel's FR8 state, which must
  // not be masked by a synthesized local `available`. The local seed only fills
  // the gap when the cloud lane returned NO descriptor at all — the
  // desktop-local surface, whose cloud route is inert (empty files).
  if (cloudFile) {
    return cloudFile;
  }
  if (input.supportsLocalFallback) {
    const summary = input.localTranscripts?.find(
      (entry) => entry.fileKey === input.fileKey
    );
    if (summary) {
      return localDescriptorFromSummary(summary);
    }
  }
  return undefined;
}

/**
 * FEA-3481 (G5) — self-healing re-poll interval (ms) for the transcript-access
 * descriptor query while any file is still `uploadPending`. If the user stays on
 * an open detail page while a background upload completes, nothing invalidates
 * `transcripts()` (the live bridge only moves list/usage/detail), so the panel
 * would stay stuck on its `UploadPending` treatment until the user navigates
 * away and back. A short refetch heals that in-place, and clears itself the
 * moment no file is pending (the interval resolver returns `false`), so a
 * resolved/available transcript never keeps polling.
 */
export const TRANSCRIPT_PENDING_REFETCH_INTERVAL_MS = 4000;

/**
 * True when any descriptor is `uploadPending` OR `missing` — both are
 * transient syncing states that the source machine is expected to resolve.
 * `available`/`stale` are terminal-readable; `failed` is terminal-error.
 */
function hasPendingTranscript(
  data: TranscriptAccessResponse | undefined
): boolean {
  return Boolean(
    data?.files?.some(
      (file) =>
        file.availability === TranscriptAvailability.UploadPending ||
        file.availability === TranscriptAvailability.Missing
    )
  );
}

/**
 * Fetch the per-file transcript descriptors (availability + signed URLs) for a
 * session. Descriptors carry short-lived signed URLs, so this refetches on mount
 * (`staleTime: 0`); the durable 60-minute cache lives on the parsed result keyed
 * by `rawSha256` (see `useSessionTranscript`).
 *
 * On the desktop-local surface the cloud route is inert, so this resolves to an
 * empty descriptor set; the caller seeds a local descriptor from the detail's
 * availability summary (`localTranscripts`) instead.
 *
 * While a file is `uploadPending` (an upload is completing under an open detail
 * view) the query self-heals with a short `refetchInterval` (FEA-3481 G5), which
 * clears itself once nothing is pending.
 *
 * `refetchWhileHidden` gates `refetchIntervalInBackground` on the SURFACE, so the
 * self-heal poll does not silently break the codebase's no-poll-when-hidden
 * convention on the web. It is LOAD-BEARING on the desktop only: a
 * permanently-hidden/offscreen renderer reports `document.hidden` indefinitely,
 * and without it React Query pauses the poll in exactly that case — the same gap
 * the list poll covers for the live bridge. On the web (`false`, the default) a
 * backgrounded tab pauses the pending re-poll like every other query and resumes
 * on focus. The caller passes `transport.supportsLocalFallback` (true only on the
 * desktop surface) so background polling stays desktop-scoped.
 */
export function useTranscriptAccess(
  sessionId: string,
  options?: { enabled?: boolean; refetchWhileHidden?: boolean }
) {
  const api = useApiClient();
  return useQuery({
    queryKey: agentSessionKeys.transcriptAccess(sessionId),
    queryFn: () => fetchTranscriptAccess(api, sessionId),
    staleTime: 0,
    enabled: Boolean(sessionId) && (options?.enabled ?? true),
    refetchInterval: (query) =>
      hasPendingTranscript(query.state.data)
        ? TRANSCRIPT_PENDING_REFETCH_INTERVAL_MS
        : false,
    refetchIntervalInBackground: options?.refetchWhileHidden ?? false,
  });
}

/**
 * Result of the parse query. `parsed` carries the normalized session; `oversized`
 * carries the on-disk size of a LOCAL fallback file the desktop declined to stage
 * (over the auto-load cap, no opt-in yet) — surfaced as the "Load full transcript"
 * gate rather than an error, and without ever parsing the file.
 */
type ParsedTranscriptResult =
  | { kind: "parsed"; session: NormalizedSession | null }
  | { kind: "oversized"; byteSize: number };

/**
 * Derive the descriptor-level read flags for the main file. Extracted to keep
 * the hook body within its complexity budget.
 * - `isReadable`: the cloud copy is readable (signed url + sha) OR this surface
 *   can serve a local copy (desktop) — a file the cloud can't read is still
 *   renderable on desktop. The file must exist in the descriptor first (a
 *   session with no transcript files is not readable on either surface).
 * - `isCloudOversized`: the descriptor's `byteSize` is over the auto-load cap. A
 *   LOCAL fallback file has no descriptor size, so its oversize is reported
 *   separately by the resolve step and folded in by the caller.
 */
function deriveDescriptorReadState(
  mainFile: TranscriptFileDescriptor | undefined,
  supportsLocalFallback: boolean
): { byteSize: number | null; isReadable: boolean; isCloudOversized: boolean } {
  const byteSize = mainFile?.byteSize ?? null;
  const isCloudReadable =
    Boolean(mainFile?.url) && Boolean(mainFile?.rawSha256);
  return {
    byteSize,
    isReadable: Boolean(mainFile) && (isCloudReadable || supportsLocalFallback),
    isCloudOversized:
      byteSize != null && byteSize > TRANSCRIPT_AUTO_LOAD_MAX_BYTES,
  };
}

/**
 * Classify a surfaced transcript error into the stage it came from so the panel
 * can render an accurate message. A `TranscriptParseError` means the bytes were
 * fetched but the parser threw (a code/format bug — Retry re-fetches the same
 * bytes and fails again); anything else (a descriptor/access error or a
 * `TranscriptFetchError`) is a fetch gap that a fresh Retry may recover.
 */
function classifyTranscriptError(
  error: Error | null
): "fetch" | "parse" | undefined {
  if (!error) {
    return undefined;
  }
  return error instanceof TranscriptParseError ? "parse" : "fetch";
}

/**
 * Re-mint the descriptor, resolve the byte-source URL per surface, and parse —
 * or surface a gated oversized LOCAL file. Extracted from the hook's `queryFn`
 * to keep the hook body within its complexity budget; `onSource` reports which
 * copy was served so the hook can flag "local copy".
 */
async function resolveAndParseTranscript(input: {
  api: ReturnType<typeof useApiClient>;
  transport: ReturnType<typeof useTranscriptBytesTransport>;
  sessionId: string;
  externalSessionId: string | undefined;
  fileKey: string;
  harness: string;
  allowOversized: boolean;
  localTranscripts: readonly TranscriptAvailabilitySummary[] | undefined;
  signal: AbortSignal | undefined;
  onSource: (source: TranscriptBytesSource) => void;
  onProgress: ((progress: TranscriptDownloadProgress) => void) | undefined;
}): Promise<ParsedTranscriptResult> {
  // Re-mint the signed URL: the descriptor query's URL may be minutes old.
  // PLN-1289 — "a retry refetches descriptors first." On the desktop-local
  // surface the route is inert (empty files); the local descriptor is seeded
  // from the detail summary so the transport can still serve the on-disk copy.
  const fresh = await fetchTranscriptAccess(input.api, input.sessionId).catch(
    (error): TranscriptAccessResponse => {
      // A failed access fetch is fatal for the CLOUD path, but the desktop-local
      // path has no cloud route — swallow it so the local descriptor seed below
      // still drives a local read. Re-thrown when there is no local fallback.
      if (input.transport.supportsLocalFallback) {
        return { sessionId: input.sessionId, files: [] };
      }
      throw error;
    }
  );
  const file = resolveReadDescriptor({
    cloudFiles: fresh.files,
    fileKey: input.fileKey,
    localTranscripts: input.localTranscripts,
    supportsLocalFallback: input.transport.supportsLocalFallback,
  });
  if (!file) {
    throw new TranscriptFetchError(
      0,
      "Transcript is no longer available for reading."
    );
  }
  // Resolve the byte-source URL per surface: web fetches the descriptor's signed
  // S3 URL directly; desktop routes through the main process, which prefers the
  // cloud copy but gracefully falls back to the local `.jsonl` (served
  // same-origin over `app://`, FEA-3324 B2) and reports which copy it served via
  // `source`. It also gates an oversized LOCAL file before staging — forward the
  // cap + opt-in so a 275 MB local outlier hits the explicit-load gate instead of
  // auto-parsing.
  const resolved = await input.transport.resolveFetchUrl({
    sessionId: input.sessionId,
    externalSessionId: input.externalSessionId,
    file,
    maxAutoLoadBytes: TRANSCRIPT_AUTO_LOAD_MAX_BYTES,
    allowOversized: input.allowOversized,
    // Thread the query signal so the desktop transport can abort the main-process
    // download when the user cancels (FEA-3678); the web transport ignores it.
    signal: input.signal,
  });
  input.onSource(resolved.source);
  if (resolved.kind === "oversized") {
    // Not an error — the local file is gated; carry the size to the panel's
    // "Load full transcript" state without parsing.
    return { kind: "oversized", byteSize: resolved.byteSize };
  }
  return await fetchTranscriptWithCacheMissRetry({
    ...input,
    file,
    resolved,
  });
}

/**
 * Fetch + parse the resolved `app://` (or signed-S3) transcript URL, transparently
 * re-preparing once on a cache-miss (FEA-3624).
 *
 * The desktop transport returns an opaque `app://renderer/transcripts/<sha>.jsonl`
 * URL that main serves from a content-addressed userData cache. That cache is
 * bounded (512 MB / 24h) and swept — including a sweep that runs INSIDE
 * `prepareTranscript` right after the download — so the file the URL points at can
 * be evicted between prepare returning and this fetch (or on any later re-fetch of
 * the held URL). At serve time the `app://` handler has no signed URL / token to
 * re-download, so a missing cache file is a bare 404 and the transcript dies with
 * no recovery. Re-`resolveFetchUrl` re-runs the idempotent prepare, which
 * re-downloads the bytes into the cache and hands back a live URL — so a transient
 * cache miss self-heals in-place instead of surfacing a dead `app://` URL.
 *
 * Scope is deliberately narrow: only a 404 (cache-miss) retries, only ONCE, and
 * only when a re-resolve is possible (`kind === "ready"`). A 403/5xx or a repeated
 * 404 propagates as before (the panel's retryable "Couldn't load" state), and a
 * `TranscriptParseError` is never retried (same bytes → same failure). A re-resolve
 * that now reports the file as `oversized` (a LOCAL file that grew past the cap
 * between resolves) is surfaced as the "Load full transcript" gate, not thrown as
 * the stale 404. The web surface never hits the cache-miss recovery in practice:
 * its resolved URL is a signed S3 URL, whose 404 is a genuinely expired/missing
 * archive — and the re-resolve returns the SAME signed URL (there is no per-request
 * re-mint here), so the retry just re-fetches and harmlessly re-raises the same
 * 404. The descriptor re-mint only happens on a full `retry()` (a fresh
 * `resolveAndParseTranscript` refetches descriptors first), so a single retry here
 * is still safe and cheap.
 *
 * On the successful (re-)fetch the served `source` is reported via `onSource` so
 * `transcriptSource` reflects the copy the rendered bytes actually came from, even
 * when the retry re-resolved to a different lane than the first resolve.
 */
async function fetchTranscriptWithCacheMissRetry(input: {
  transport: ReturnType<typeof useTranscriptBytesTransport>;
  sessionId: string;
  externalSessionId: string | undefined;
  file: TranscriptFileDescriptor;
  harness: string;
  allowOversized: boolean;
  resolved: { url: string };
  signal: AbortSignal | undefined;
  onSource: (source: TranscriptBytesSource) => void;
  onProgress: ((progress: TranscriptDownloadProgress) => void) | undefined;
}): Promise<ParsedTranscriptResult> {
  try {
    const session = await fetchAndParseTranscript({
      url: input.resolved.url,
      sessionId: input.sessionId,
      harness: input.harness,
      signal: input.signal,
      onProgress: input.onProgress,
    });
    return { kind: "parsed", session };
  } catch (error) {
    if (!(error instanceof TranscriptFetchError && error.status === 404)) {
      throw error;
    }
    // Cache-miss 404: re-prepare (re-download into the cache) and fetch once more.
    const reResolved = await input.transport.resolveFetchUrl({
      sessionId: input.sessionId,
      externalSessionId: input.externalSessionId,
      file: input.file,
      maxAutoLoadBytes: TRANSCRIPT_AUTO_LOAD_MAX_BYTES,
      allowOversized: input.allowOversized,
      // Same cancel wiring on the cache-miss re-prepare (FEA-3678).
      signal: input.signal,
    });
    // Report the re-resolved source so `transcriptSource` reflects the bytes the
    // retry actually fetched (it may have flipped lanes vs. the first resolve),
    // mirroring the `onSource` call the first resolve already made.
    input.onSource(reResolved.source);
    if (reResolved.kind === "oversized") {
      // The re-resolve now gates the file (a LOCAL copy grew past the auto-load
      // cap between resolves). That is a legitimate "Load full transcript" state,
      // not a fetch failure — surface it instead of masking it as the stale 404.
      return { kind: "oversized", byteSize: reResolved.byteSize };
    }
    const session = await fetchAndParseTranscript({
      url: reResolved.url,
      sessionId: input.sessionId,
      harness: input.harness,
      signal: input.signal,
      onProgress: input.onProgress,
    });
    return { kind: "parsed", session };
  }
}

export type UseSessionTranscriptOptions = {
  /** Session harness — selects the parser and gates unsupported harnesses. */
  harness: string;
  /**
   * Harness session id (the on-disk `.jsonl` identity) — distinct from the cloud
   * `sessionId` this hook is keyed by. Forwarded to the byte transport so the
   * desktop LOCAL fallback can resolve the on-disk file (which the local store /
   * discovery index by `externalSessionId`, not the cloud id). Omitted on the web
   * (no local file) and harmless when the surface can't supply it — the fallback
   * just isn't attempted.
   */
  externalSessionId?: string;
  /**
   * Which transcript file to read — `main` (default) or a `subagent:{id}`
   * sidechain (FEA-2717 deep-link addressing). Folded into the query key so each
   * file caches independently.
   */
  fileKey?: string;
  /**
   * The detail's per-file availability summary (`AgentSessionDetail.transcripts`).
   * On the desktop-LOCAL surface the cloud descriptor route is inert, so this
   * seeds a local read descriptor (paired with `transport.supportsLocalFallback`)
   * — without it a local session's on-disk transcript is never readable. Ignored
   * on the web (no local fallback) and when the cloud descriptor is readable.
   */
  localTranscripts?: readonly TranscriptAvailabilitySummary[];
  /** Defaults to true; pass false to hold the reads (e.g. detail not yet loaded). */
  enabled?: boolean;
};

export type SessionTranscriptState = {
  /** Raw descriptor response — all files' availability, for subagent surfaces. */
  access: TranscriptAccessResponse | undefined;
  /** The main transcript file descriptor, if the session has one. */
  mainFile: TranscriptFileDescriptor | undefined;
  /** Server-observed availability of the main file (drives the UI treatment). */
  availability: TranscriptAvailability | undefined;
  /** Parsed main-transcript session (sha-cached), once fetched + parsed. */
  session: NormalizedSession | null | undefined;
  /** True while descriptors are loading. */
  isAccessLoading: boolean;
  /** True while the main file is being fetched + parsed. */
  isParsing: boolean;
  /** True when the main file is readable (a signed URL was issued). */
  isReadable: boolean;
  /**
   * True when the resolved read is a desktop-LOCAL one — the main file has no
   * archive identity (`rawSha256` null) yet this surface can serve an on-disk
   * copy (`supportsLocalFallback`). Distinguishes "the cloud parse produced no
   * trace" (web — the cloud states are authoritative) from "the LOCAL file
   * produced no trace" (desktop — the projected fallback may still render).
   * Always false on the web (no local fallback).
   */
  isLocalRead: boolean;
  /**
   * Which copy the rendered transcript came from — `cloud` (archived S3) or the
   * desktop `local` graceful fallback (on-disk `.jsonl` served when the cloud
   * read failed / was not yet readable). Undefined before a successful parse.
   * Web always resolves `cloud`.
   */
  transcriptSource: TranscriptBytesSource | undefined;
  /** True when the main file exceeds the auto-load cap and awaits explicit load. */
  isOversized: boolean;
  /** Verified archive byte size of the main file, or null before first upload. */
  byteSize: number | null;
  /** True once the user has requested the deferred (oversized) load. */
  isDeferredLoadRequested: boolean;
  /**
   * Whether the streaming download-progress UI is enabled (FEA-3447 flag). When
   * false the panel keeps the prior skeleton spinner and `downloadProgress` is
   * always null. Read here (not in the panel) so the flag has a single source.
   */
  isDownloadProgressEnabled: boolean;
  /**
   * Live progress of the in-flight transcript download, or null when nothing is
   * downloading (or the flag is off). Drives the percent/bytes indicator on the
   * deferred "Load full transcript" load. `total` is null when the server omits
   * `Content-Length` (indeterminate — bytes only).
   */
  downloadProgress: TranscriptDownloadProgress | null;
  /** True when the harness has no cloud parser (only claude/codex today). */
  isUnsupportedHarness: boolean;
  /** Descriptor or fetch/parse error, whichever is present. */
  error: Error | null;
  /**
   * Which stage the `error` came from, so the UI can render an accurate message
   * instead of a combined "fetching or parsing failed":
   * - `fetch`: the archive couldn't be read (missing / expired URL / 403 / a
   *   descriptor error). A plain Retry (fresh signed URL) may recover it.
   * - `parse`: the bytes were fetched but the parser threw (e.g. a non-Claude
   *   Codex/gpt-* token shape trips `InvalidTokenCountError`). Retry re-fetches
   *   the SAME bytes and fails identically — this is a code bug, not a gap.
   * Undefined when there is no error.
   */
  errorKind: "fetch" | "parse" | undefined;
  /** Request the deferred fetch+parse for an oversized main file. */
  loadFullTranscript: () => void;
  /**
   * Cancel an in-flight download and drop back to the "Load full transcript"
   * gate (FEA-3447). Aborts the parse query's `signal` (threaded into the stream
   * reader) and clears the deferred opt-in, so the download stops mid-stream.
   */
  cancelLoad: () => void;
  /** Refetch descriptors (fresh signed URL) and re-parse — recovery / retry. */
  retry: () => void;
};

/**
 * FEA-2717: fetch, parse, and cache a session's main cloud transcript for the
 * two-phase session-detail render. The metadata skeleton renders from
 * `useAgentSessionDetail`; this hook hydrates the conversation from the archived
 * JSONL.
 *
 * The parsed query re-mints a fresh signed URL inside its own `queryFn` (rather
 * than closing over the descriptor query's possibly-stale URL), so a ~5-minute
 * URL expiry can never race the parse and `retry()` is a plain refetch. The
 * query key folds in `rawSha256`, so a re-upload transparently invalidates.
 */
export function useSessionTranscript(
  sessionId: string,
  options: UseSessionTranscriptOptions
): SessionTranscriptState {
  const api = useApiClient();
  const transport = useTranscriptBytesTransport();
  const queryClient = useQueryClient();
  const downloadProgressEnabled = useFeatureFlagEnabled(
    TRANSCRIPT_DOWNLOAD_PROGRESS_FLAG
  );
  const enabled = options.enabled ?? true;
  const fileKey = options.fileKey ?? MAIN_TRANSCRIPT_FILE_KEY;
  const [isDeferredLoadRequested, setDeferredLoadRequested] = useState(false);
  const { downloadProgress, reportProgress, resetProgress } =
    useThrottledDownloadProgress();

  // The oversized "Load full transcript" opt-in is scoped to a single file: the
  // `?file=` switcher (Task 5) navigates client-side without remounting the
  // panel (the only remount boundary is `key={session.id}`), so reset the gate
  // when the file changes — otherwise loading one oversized file would silently
  // auto-load the next, defeating the 25 MB auto-load cap. Any stale
  // `downloadProgress` from the previous file needs no reset here: clearing the
  // deferred opt-in hides the progress UI, and `loadFullTranscript` resets it
  // before the next download starts.
  const previousFileKeyRef = useRef(fileKey);
  if (previousFileKeyRef.current !== fileKey && isDeferredLoadRequested) {
    setDeferredLoadRequested(false);
  }
  previousFileKeyRef.current = fileKey;

  // `refetchWhileHidden` is desktop-only: the pending self-heal re-poll (G5) must
  // survive a permanently-hidden/offscreen renderer there, but on the web it stays
  // paused-when-hidden per the codebase convention. `supportsLocalFallback` is the
  // surface signal (true only under the desktop transport provider).
  const access = useTranscriptAccess(sessionId, {
    enabled,
    refetchWhileHidden: transport.supportsLocalFallback,
  });
  // Prefer a readable cloud descriptor; on the desktop-local surface (inert
  // cloud route) seed a local descriptor from the detail summary so the on-disk
  // copy is still readable. `resolveReadDescriptor` returns the raw cloud
  // descriptor otherwise, preserving the pending/failed FR8 states.
  const mainFile = resolveReadDescriptor({
    cloudFiles: access.data?.files,
    fileKey,
    localTranscripts: options.localTranscripts,
    supportsLocalFallback: transport.supportsLocalFallback,
  });
  const availability = mainFile?.availability;
  const rawSha256 = mainFile?.rawSha256 ?? null;
  // A LOCAL read: the resolved file carries no archive `rawSha256` yet this
  // surface can serve an on-disk copy. Never true on the web (no local fallback),
  // so the web cloud states stay authoritative over any projected fallback.
  const isLocalRead =
    Boolean(mainFile) && rawSha256 === null && transport.supportsLocalFallback;
  const { byteSize, isReadable, isCloudOversized } = deriveDescriptorReadState(
    mainFile,
    transport.supportsLocalFallback
  );
  const isUnsupportedHarness = !isCloudParseableHarness(options.harness);

  const [transcriptSource, setTranscriptSource] = useState<
    TranscriptBytesSource | undefined
  >(undefined);

  const shouldParse =
    enabled &&
    isReadable &&
    !isUnsupportedHarness &&
    (!isCloudOversized || isDeferredLoadRequested);

  // A cloud read is sha-keyed (a re-upload invalidates), so it earns the durable
  // hour-long trust window. A local read has no archive `rawSha256` — its query
  // key is stable while the on-disk `.jsonl` may keep changing — so it must NOT
  // be pinned: `staleTime: 0` re-parses the current copy on the next detail
  // refetch / remount / refocus instead of serving the first stale snapshot.
  const parsedStaleTime = rawSha256 ? TRANSCRIPT_PARSED_STALE_MS : 0;

  const parsed = useQuery({
    queryKey: agentSessionKeys.transcriptFile(
      sessionId,
      fileKey,
      rawSha256 ?? ""
    ),
    queryFn: ({ signal }): Promise<ParsedTranscriptResult> =>
      resolveAndParseTranscript({
        api,
        transport,
        sessionId,
        externalSessionId: options.externalSessionId,
        fileKey,
        harness: options.harness,
        allowOversized: isDeferredLoadRequested,
        localTranscripts: options.localTranscripts,
        signal,
        onSource: setTranscriptSource,
        onProgress: downloadProgressEnabled ? reportProgress : undefined,
      }),
    enabled: shouldParse,
    staleTime: parsedStaleTime,
    gcTime: 0,
    retry: false,
  });

  // Fold the local oversize signal (from the resolve step) into the cloud one.
  const parsedResult = parsed.data;
  const localOversizedBytes =
    parsedResult?.kind === "oversized" ? parsedResult.byteSize : null;
  const parsedSession =
    parsedResult?.kind === "parsed" ? parsedResult.session : undefined;
  const isOversized = isCloudOversized || localOversizedBytes != null;
  const effectiveByteSize = byteSize ?? localOversizedBytes;

  const refetchAccess = access.refetch;
  const refetchParsed = parsed.refetch;
  const retry = useCallback(() => {
    // Both refetch — access re-mints a fresh signed URL, parsed re-fetches + re-
    // parses. `refetch()` bypasses `staleTime`, so this recovers an expired URL.
    refetchAccess().catch(() => undefined);
    refetchParsed().catch(() => undefined);
  }, [refetchAccess, refetchParsed]);

  const loadFullTranscript = useCallback(() => {
    resetProgress();
    setDeferredLoadRequested(true);
  }, [resetProgress]);

  const cancelLoad = useCallback(() => {
    // Abort the in-flight parse query (its `signal` is threaded into the stream
    // reader, so the download stops mid-stream) and drop the deferred opt-in so
    // the panel returns to the "Load full transcript" gate.
    queryClient
      .cancelQueries({
        queryKey: agentSessionKeys.transcriptFile(
          sessionId,
          fileKey,
          rawSha256 ?? ""
        ),
      })
      .catch(() => undefined);
    resetProgress();
    setDeferredLoadRequested(false);
  }, [queryClient, sessionId, fileKey, rawSha256, resetProgress]);

  // Classify the surfaced error so the panel renders an accurate state. A
  // descriptor (access) error and a `TranscriptFetchError` are both "couldn't
  // read the archive" (fetch); a `TranscriptParseError` is "have the bytes,
  // can't parse them" (parse). Anything else defaults to `fetch` (the retryable,
  // less-alarming framing).
  const error =
    (access.error as Error | null) ?? (parsed.error as Error | null);
  const errorKind = classifyTranscriptError(error);

  // A LOCAL oversize already ran the query (it was enabled, not gated by
  // `shouldParse`) and cached the `oversized` result under the same key, so
  // flipping the opt-in alone won't re-run it. Refetch AFTER the opt-in state
  // has committed (so the recreated queryFn closes over `allowOversized: true`)
  // to re-resolve and stage the bytes. A cloud oversize was disabled and enables
  // on its own, so this refetch is a harmless no-op/duplicate there. Skipped
  // unless a local oversize is currently gated.
  const hasGatedLocalOversize =
    localOversizedBytes != null && isDeferredLoadRequested;
  useEffect(() => {
    if (hasGatedLocalOversize) {
      refetchParsed().catch(() => undefined);
    }
  }, [hasGatedLocalOversize, refetchParsed]);

  return {
    access: access.data,
    mainFile,
    availability,
    session: parsedSession,
    isAccessLoading: access.isLoading,
    isParsing: shouldParse && parsed.isFetching,
    isReadable,
    isLocalRead,
    transcriptSource: parsedSession ? transcriptSource : undefined,
    isOversized,
    byteSize: effectiveByteSize,
    isDeferredLoadRequested,
    isDownloadProgressEnabled: downloadProgressEnabled,
    // Never leak progress when the flag is off (the panel keeps the skeleton).
    downloadProgress: downloadProgressEnabled ? downloadProgress : null,
    isUnsupportedHarness,
    error,
    errorKind,
    loadFullTranscript,
    cancelLoad,
    retry,
  };
}

/**
 * The throttle bucket for a download-progress event: an integer percent when the
 * total is known, else a 256 KB step (an indeterminate download has no percent).
 * One published update per bucket keeps a fast multi-chunk download from
 * re-rendering the panel per network chunk (~hundreds for a 25 MB file).
 */
function progressBucket(progress: TranscriptDownloadProgress): number {
  return progress.total == null
    ? Math.floor(progress.loaded / (256 * 1024))
    : Math.floor((progress.loaded / progress.total) * 100);
}

/**
 * Throttled download-progress state for the transcript read (FEA-3447). Publishes
 * at most one update per visible increment (see {@link progressBucket}), plus the
 * terminal byte so the bar always lands on its true end value. Extracted from
 * `useSessionTranscript` to keep that hook within its cognitive-complexity budget.
 */
function useThrottledDownloadProgress(): {
  downloadProgress: TranscriptDownloadProgress | null;
  reportProgress: (progress: TranscriptDownloadProgress) => void;
  resetProgress: () => void;
} {
  const [downloadProgress, setDownloadProgress] =
    useState<TranscriptDownloadProgress | null>(null);
  const bucketRef = useRef(-1);
  const reportProgress = useCallback((progress: TranscriptDownloadProgress) => {
    const isComplete =
      progress.total != null && progress.loaded >= progress.total;
    const bucket = progressBucket(progress);
    if (!isComplete && bucket === bucketRef.current) {
      return;
    }
    bucketRef.current = bucket;
    setDownloadProgress(progress);
  }, []);
  const resetProgress = useCallback(() => {
    bucketRef.current = -1;
    setDownloadProgress(null);
  }, []);
  return { downloadProgress, reportProgress, resetProgress };
}
