"use client";

import type {
  TranscriptAccessResponse,
  TranscriptAvailability,
  TranscriptFileDescriptor,
} from "@repo/api/src/types/desktop-transcripts";
import type { NormalizedSession } from "@repo/lib/harness/types";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { useApiClient } from "../../shared/api/use-api-client";
import {
  fetchAndParseTranscript,
  isCloudParseableHarness,
  TranscriptFetchError,
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
 * Parsed transcript trust window (owner, 2026-07-08): while the detail page is
 * observed, the parsed session is fresh for an hour — no refetch on focus or
 * remount. Paired with `gcTime: 0` so the (potentially large) parsed session is
 * freed the moment the last observer unmounts; returning re-fetches and re-parses.
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
 * Fetch the per-file transcript descriptors (availability + signed URLs) for a
 * session. Descriptors carry short-lived signed URLs, so this refetches on mount
 * (`staleTime: 0`); the durable 60-minute cache lives on the parsed result keyed
 * by `rawSha256` (see `useSessionTranscript`).
 */
export function useTranscriptAccess(
  sessionId: string,
  options?: { enabled?: boolean }
) {
  const api = useApiClient();
  return useQuery({
    queryKey: agentSessionKeys.transcriptAccess(sessionId),
    queryFn: () => fetchTranscriptAccess(api, sessionId),
    staleTime: 0,
    enabled: Boolean(sessionId) && (options?.enabled ?? true),
  });
}

export type UseSessionTranscriptOptions = {
  /** Session harness — selects the parser and gates unsupported harnesses. */
  harness: string;
  /**
   * Which transcript file to read — `main` (default) or a `subagent:{id}`
   * sidechain (FEA-2717 deep-link addressing). Folded into the query key so each
   * file caches independently.
   */
  fileKey?: string;
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
  /** True when the main file exceeds the auto-load cap and awaits explicit load. */
  isOversized: boolean;
  /** Verified archive byte size of the main file, or null before first upload. */
  byteSize: number | null;
  /** True once the user has requested the deferred (oversized) load. */
  isDeferredLoadRequested: boolean;
  /** True when the harness has no cloud parser (only claude/codex today). */
  isUnsupportedHarness: boolean;
  /** Descriptor or fetch/parse error, whichever is present. */
  error: Error | null;
  /** Request the deferred fetch+parse for an oversized main file. */
  loadFullTranscript: () => void;
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
  const enabled = options.enabled ?? true;
  const fileKey = options.fileKey ?? MAIN_TRANSCRIPT_FILE_KEY;
  const [isDeferredLoadRequested, setDeferredLoadRequested] = useState(false);

  // The oversized "Load full transcript" opt-in is scoped to a single file: the
  // `?file=` switcher (Task 5) navigates client-side without remounting the
  // panel (the only remount boundary is `key={session.id}`), so reset the gate
  // when the file changes — otherwise loading one oversized file would silently
  // auto-load the next, defeating the 25 MB auto-load cap.
  const previousFileKeyRef = useRef(fileKey);
  if (previousFileKeyRef.current !== fileKey) {
    previousFileKeyRef.current = fileKey;
    if (isDeferredLoadRequested) {
      setDeferredLoadRequested(false);
    }
  }

  const access = useTranscriptAccess(sessionId, { enabled });
  const mainFile = access.data?.files?.find((file) => file.fileKey === fileKey);
  const availability = mainFile?.availability;
  const rawSha256 = mainFile?.rawSha256 ?? null;
  const byteSize = mainFile?.byteSize ?? null;
  const isReadable = Boolean(mainFile?.url) && Boolean(rawSha256);
  const isUnsupportedHarness = !isCloudParseableHarness(options.harness);
  const isOversized =
    byteSize != null && byteSize > TRANSCRIPT_AUTO_LOAD_MAX_BYTES;

  const shouldParse =
    enabled &&
    isReadable &&
    !isUnsupportedHarness &&
    (!isOversized || isDeferredLoadRequested);

  const parsed = useQuery({
    queryKey: agentSessionKeys.transcriptFile(
      sessionId,
      fileKey,
      rawSha256 ?? ""
    ),
    queryFn: async ({ signal }) => {
      // Re-mint the signed URL: the descriptor query's URL may be minutes old.
      // PLN-1289 — "a retry refetches descriptors first."
      const fresh = await fetchTranscriptAccess(api, sessionId);
      const file = fresh.files?.find((entry) => entry.fileKey === fileKey);
      if (!file?.url) {
        throw new TranscriptFetchError(
          0,
          "Transcript is no longer available for reading."
        );
      }
      return fetchAndParseTranscript({
        url: file.url,
        sessionId,
        harness: options.harness,
        signal,
      });
    },
    enabled: shouldParse,
    staleTime: TRANSCRIPT_PARSED_STALE_MS,
    gcTime: 0,
    retry: false,
  });

  const refetchAccess = access.refetch;
  const refetchParsed = parsed.refetch;
  const retry = useCallback(() => {
    // Both refetch — access re-mints a fresh signed URL, parsed re-fetches + re-
    // parses. `refetch()` bypasses `staleTime`, so this recovers an expired URL.
    refetchAccess().catch(() => undefined);
    refetchParsed().catch(() => undefined);
  }, [refetchAccess, refetchParsed]);

  const loadFullTranscript = useCallback(() => {
    setDeferredLoadRequested(true);
  }, []);

  return {
    access: access.data,
    mainFile,
    availability,
    session: parsed.data,
    isAccessLoading: access.isLoading,
    isParsing: shouldParse && parsed.isFetching,
    isReadable,
    isOversized,
    byteSize,
    isDeferredLoadRequested,
    isUnsupportedHarness,
    error: (access.error as Error | null) ?? (parsed.error as Error | null),
    loadFullTranscript,
    retry,
  };
}
