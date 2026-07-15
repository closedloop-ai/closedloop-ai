import {
  TRANSCRIPT_DOWNLOAD_URL_TTL_SECONDS,
  type TranscriptAccessResponse,
  TranscriptAvailability,
  type TranscriptFileDescriptor,
} from "@repo/api/src/types/desktop-transcripts";
import { getSignedTranscriptDownloadUrl } from "@repo/aws";
import { type SessionTranscript, withDb } from "@repo/database";
import { BoundedCache } from "@/lib/bounded-cache";
import {
  deriveTranscriptAvailability,
  hasMainTranscript,
  isTranscriptReadable,
  MAIN_FILE_KEY,
  sessionTranscriptIdentityWhere,
} from "./transcript-availability";

/**
 * Read path for archived transcripts (FEA-2716 / PLN-1289). Authorizes org +
 * session scope, derives the FR8 availability state per file, and mints (or
 * reuses a cached, still-valid) short-lived signed S3 GET URL only for readable
 * files. Transcript bytes never transit apps/api — the browser fetches raw
 * JSONL directly from S3.
 *
 * Transcripts are looked up by session identity `(computeTargetId,
 * externalSessionId)` — the same identity as `SessionDetail` and the
 * `SessionTranscript` unique key — rather than the nullable `sessionDetailId`
 * FK, so a row uploaded before the metadata lane resolved the link is still
 * surfaced.
 */

/**
 * Signed-URL minting seam, injectable so unit tests avoid real S3. Receives the
 * object's current-version `etag` so the default implementation can cache the
 * signature by content identity (see {@link defaultMintDownloadUrl}); a `null`
 * etag means "content identity unknown" and disables caching for that call.
 */
export type MintTranscriptDownloadUrl = (
  key: string,
  etag: string | null
) => Promise<string>;

export type TranscriptReadDeps = {
  mintDownloadUrl?: MintTranscriptDownloadUrl;
};

type FindTranscriptAccessInput = {
  /** Session artifact id (the route `[id]`). */
  id: string;
  organizationId: string;
  deps?: TranscriptReadDeps;
};

type CachedTranscriptDownloadUrl = { url: string; expiresAtMs: number };

/** Bound on distinct cached (objectStorageKey, etag) tuples per process. */
const TRANSCRIPT_SIGNED_URL_CACHE_MAX_ENTRIES = 10_000;
/**
 * Reuse a cached signature only while more than this much of its real lifetime
 * remains, so a URL handed to a client always keeps comfortable headroom before
 * the 5-minute TTL expires. Smaller than the attachments margin (also the TTL's
 * fraction) because the transcript TTL is 5 min, not 1 h.
 */
const TRANSCRIPT_SIGNED_URL_CACHE_SAFETY_MARGIN_MS = 60 * 1000;

/**
 * Per-process, bounded cache of presigned transcript GET URLs keyed by
 * (objectStorageKey, etag). Repeated availability polls and viewer re-opens of
 * an unchanged transcript then receive the SAME URL string, so the browser can
 * serve the (up to ~53 GB) bytes from its own `private` HTTP cache instead of
 * re-downloading the whole object from S3 (per-request egress) on every refresh
 * — the fix the attachments read path already applies via
 * `getCachedSignedDownloadEntry` (FEA-2882). The etag is part of the key
 * because transcripts are mutable (copy-append): when the object changes its
 * etag changes, missing the cache and minting a fresh URL that busts the stale
 * browser copy.
 */
const transcriptDownloadUrlCache = new BoundedCache<
  string,
  CachedTranscriptDownloadUrl
>(TRANSCRIPT_SIGNED_URL_CACHE_MAX_ENTRIES);

function mintTranscriptDownloadUrl(key: string): Promise<string> {
  return getSignedTranscriptDownloadUrl(key, {
    expiresIn: TRANSCRIPT_DOWNLOAD_URL_TTL_SECONDS,
  });
}

async function defaultMintDownloadUrl(
  key: string,
  etag: string | null
): Promise<string> {
  // Without a content etag we cannot prove the object at `key` is unchanged, so
  // fall back to always-fresh minting rather than risk handing the browser a
  // stable URL that would serve stale cached bytes after a copy-append.
  if (etag === null) {
    return await mintTranscriptDownloadUrl(key);
  }

  // Positional JSON encoding so a key or etag that contains the delimiter
  // cannot collapse two distinct (key, etag) tuples onto one cache entry, which
  // would serve a presigned URL for the wrong object version.
  const cacheKey = JSON.stringify([key, etag]);
  const now = Date.now();

  const cached = transcriptDownloadUrlCache.get(cacheKey);
  if (
    cached &&
    cached.expiresAtMs - TRANSCRIPT_SIGNED_URL_CACHE_SAFETY_MARGIN_MS > now
  ) {
    return cached.url;
  }

  const url = await mintTranscriptDownloadUrl(key);
  transcriptDownloadUrlCache.set(cacheKey, {
    url,
    expiresAtMs: now + TRANSCRIPT_DOWNLOAD_URL_TTL_SECONDS * 1000,
  });
  return url;
}

function missingDescriptor(fileKey: string): TranscriptFileDescriptor {
  return {
    fileKey,
    availability: TranscriptAvailability.Missing,
    url: null,
    byteSize: null,
    rawSha256: null,
    uploadedAt: null,
    lastObservedAt: null,
  };
}

async function toDescriptor(
  row: SessionTranscript,
  mintDownloadUrl: MintTranscriptDownloadUrl
): Promise<TranscriptFileDescriptor> {
  const availability = deriveTranscriptAvailability(row);
  const url = isTranscriptReadable(availability)
    ? await mintDownloadUrl(row.objectStorageKey, row.storedEtag)
    : null;
  return {
    fileKey: row.fileKey,
    availability,
    url,
    // bigint → number: transcript sizes (<= ~53 GB) sit well within 2^53.
    byteSize: row.rawByteSize === null ? null : Number(row.rawByteSize),
    rawSha256: row.rawSha256,
    uploadedAt: row.uploadedAt?.toISOString() ?? null,
    lastObservedAt: row.lastObservedAt.toISOString(),
  };
}

export const transcriptReadService = {
  /**
   * Returns transcript descriptors for a session the caller may view, or `null`
   * when the session is outside the caller's org scope. The route maps `null`
   * to 404 — identical to viewing the session detail, so a caller who cannot
   * see the session cannot tell it apart from one that does not exist (PLN-1289
   * visibility == session-detail visibility; PRD AC10).
   */
  async findTranscriptAccess({
    id,
    organizationId,
    deps,
  }: FindTranscriptAccessInput): Promise<TranscriptAccessResponse | null> {
    const session = await withDb((db) =>
      db.sessionDetail.findFirst({
        where: {
          artifactId: id,
          artifact: { is: { organizationId } },
        },
        select: {
          computeTargetId: true,
          externalSessionId: true,
        },
      })
    );
    if (!session) {
      return null;
    }

    const rows = await withDb((db) =>
      db.sessionTranscript.findMany({
        where: sessionTranscriptIdentityWhere({
          organizationId,
          computeTargetId: session.computeTargetId,
          externalSessionId: session.externalSessionId,
        }),
        orderBy: { fileKey: "asc" },
      })
    );

    const mintDownloadUrl = deps?.mintDownloadUrl ?? defaultMintDownloadUrl;
    const files = await Promise.all(
      rows.map((row) => toDescriptor(row, mintDownloadUrl))
    );
    // The main transcript is always expected: when only subagent rows exist (or
    // none), surface main as an explicit `missing` file so the UI can tell "not
    // uploaded" from "no such file" (PRD AC6).
    if (!hasMainTranscript(rows)) {
      files.unshift(missingDescriptor(MAIN_FILE_KEY));
    }

    return { sessionId: id, files };
  },
};

export const transcriptReadServiceInternalsForTesting = {
  /** Reset the process-wide signed-URL cache so cases don't leak entries. */
  clearDownloadUrlCache: () => transcriptDownloadUrlCache.clear(),
};
