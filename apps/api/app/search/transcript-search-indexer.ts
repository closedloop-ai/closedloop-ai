/**
 * FEA-3930 (parent FEA-3800, PLN-1456) — write-time indexer that projects an AI
 * session's transcript CONTENT into the unified-search projection when, and only
 * when, the owning org has opted in via `Organization.searchIncludeTranscripts`.
 *
 * GATED + FAIL-OPEN + BEST-EFFORT: like the other search-index hooks, this runs
 * off the request hot path (the caller wraps it in `waitUntil`) and swallows any
 * error. It fires at transcript ARCHIVE/FINALIZE time (a verified
 * `uploadStatus = uploaded` on the MAIN transcript file). Subagent files are
 * ignored — only the main transcript feeds the session's searchable body so a
 * sidechain upload cannot overwrite it.
 *
 * PRIVACY: the org gate is checked FIRST. When it is off, nothing is read from
 * S3 and no projection row is written. Transcript bytes are read through a
 * BOUNDED ranged GET (`getTranscriptObjectBytesRange`) so a multi-GB archive
 * never buffers whole; only a prefix large enough to fill the capped body is
 * fetched.
 *
 * ORG-SCOPED: every read is scoped to `organizationId`; the session lookup and
 * the projection upsert both carry it, so one org's transcript can never be
 * indexed under another.
 */

import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import {
  boundSearchText,
  MAX_SEARCH_BODY_CHARS,
} from "@repo/api/src/types/search";
import { getTranscriptObjectBytesRange } from "@repo/aws";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { MAIN_FILE_KEY } from "@/app/agent-sessions/transcript-availability";
import {
  agentSessionProjection,
  searchIndexService,
} from "./search-index-service";
import { extractTranscriptSearchText } from "./transcript-search-text";

/**
 * How many bytes of the transcript archive to fetch for text extraction. A
 * generous multiple of the body cap: the JSONL carries tool calls, usage
 * blocks, and metadata between the human/assistant text, so more raw bytes are
 * needed than the final plain-text budget. Still a hard bound on S3 egress and
 * memory for an object that can be tens of GB.
 */
const TRANSCRIPT_SEARCH_READ_BYTES = MAX_SEARCH_BODY_CHARS * 20;

/** Inputs identifying the finalized transcript to (maybe) index. */
export type TranscriptIndexInput = {
  organizationId: string;
  computeTargetId: string;
  externalSessionId: string;
  fileKey: string;
};

/** Injectable S3 read seam so unit tests never hit real S3. */
export type TranscriptSearchIndexDeps = {
  readTranscriptBytes?: (
    key: string,
    maxBytes: number
  ) => Promise<Buffer | null>;
};

export const transcriptSearchIndexService = {
  /**
   * Fail-open, non-blocking transcript index for the write hot path. Schedules
   * the gated index via `waitUntil` and swallows any error (logged). The
   * caller's transcript-complete write is already committed and is never
   * affected by an indexing failure.
   */
  indexAfterCommit(
    input: TranscriptIndexInput,
    deps?: TranscriptSearchIndexDeps
  ): void {
    const work = indexTranscript(input, deps).catch((error) => {
      log.error("search_transcript_index_failed", {
        organizationId: input.organizationId,
        computeTargetId: input.computeTargetId,
        externalSessionId: input.externalSessionId,
        fileKey: input.fileKey,
        error: parseError(error),
      });
    });
    waitUntil(work);
  },

  /**
   * Synchronous variant for the backfill and for tests. Runs the same gated
   * flow and awaits it (throws on failure so the backfill can count it).
   * Returns whether a projection row was written.
   */
  index(
    input: TranscriptIndexInput,
    deps?: TranscriptSearchIndexDeps
  ): Promise<boolean> {
    return indexTranscript(input, deps);
  },
};

/**
 * Gated index flow: only the MAIN transcript, only when the org opted in, only
 * when text was extractable. Returns whether a row was upserted.
 */
async function indexTranscript(
  input: TranscriptIndexInput,
  deps?: TranscriptSearchIndexDeps
): Promise<boolean> {
  // Only the main transcript feeds the session body — subagent files must not
  // overwrite it.
  if (input.fileKey !== MAIN_FILE_KEY) {
    return false;
  }

  const session = await loadIndexableSession(input);
  // Gate: no session row, or the org has not opted into transcript search.
  if (session === null || !session.searchIncludeTranscripts) {
    return false;
  }
  // No verified main-transcript object to read yet (e.g. the row is not
  // uploaded, or has no stored key) — nothing to index.
  if (session.objectStorageKey === null) {
    return false;
  }

  const read = deps?.readTranscriptBytes ?? getTranscriptObjectBytesRange;
  const bytes = await read(
    session.objectStorageKey,
    TRANSCRIPT_SEARCH_READ_BYTES
  );
  if (bytes === null) {
    return false;
  }

  const body = boundSearchText(
    extractTranscriptSearchText(bytes.toString("utf8")),
    MAX_SEARCH_BODY_CHARS
  );

  await searchIndexService.upsert(
    agentSessionProjection({
      artifactId: session.artifactId,
      organizationId: input.organizationId,
      title: session.title,
      body,
      userId: session.userId,
      updatedAt: session.updatedAt,
    })
  );
  return true;
}

type IndexableSession = {
  artifactId: string;
  title: string;
  userId: string | null;
  updatedAt: Date;
  searchIncludeTranscripts: boolean;
  /** Storage key of the verified MAIN transcript, or null when not readable. */
  objectStorageKey: string | null;
};

/**
 * Resolve the session's projection fields, the org's transcript-search gate, and
 * the verified main-transcript object key — all org-scoped. The session is
 * looked up by its identity `(organizationId, computeTargetId,
 * externalSessionId)` — the same identity the transcript archive is keyed on —
 * and its parent Artifact supplies the display name/owner/updatedAt. The object
 * key is read from the SessionTranscript row rather than trusting a
 * caller-supplied key, and only for an `uploaded` main file. Returns null when
 * the session is not yet materialized.
 */
function loadIndexableSession(
  input: TranscriptIndexInput
): Promise<IndexableSession | null> {
  return withDb(async (db) => {
    const session = await db.sessionDetail.findFirst({
      where: {
        computeTargetId: input.computeTargetId,
        externalSessionId: input.externalSessionId,
        artifact: { is: { organizationId: input.organizationId } },
      },
      select: {
        artifactId: true,
        artifact: {
          select: {
            name: true,
            assigneeId: true,
            updatedAt: true,
            organization: { select: { searchIncludeTranscripts: true } },
          },
        },
      },
    });
    if (session === null) {
      return null;
    }

    const transcript = await db.sessionTranscript.findFirst({
      where: {
        organizationId: input.organizationId,
        computeTargetId: input.computeTargetId,
        externalSessionId: input.externalSessionId,
        fileKey: MAIN_FILE_KEY,
        uploadStatus: TranscriptUploadStatus.Uploaded,
      },
      select: { objectStorageKey: true },
    });

    return {
      artifactId: session.artifactId,
      title: session.artifact.name,
      userId: session.artifact.assigneeId,
      updatedAt: session.artifact.updatedAt,
      searchIncludeTranscripts:
        session.artifact.organization.searchIncludeTranscripts,
      objectStorageKey: transcript?.objectStorageKey ?? null,
    };
  });
}
