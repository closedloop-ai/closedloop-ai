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
import { getTranscriptObjectBytesRange } from "@repo/aws/transcript-storage";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { MAIN_FILE_KEY } from "@/app/agent-sessions/transcript-availability";
import { IndexKeyOrigin, resolveByAnyIndexKey } from "@/lib/index-key-lookup";
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
  /**
   * ISS-8125: where `externalSessionId` came from, because the two origins need
   * DIFFERENT candidate sets and neither works for the other.
   *
   * `"wire"` (the default, and what `complete/route.ts` sends) is a raw desktop
   * value that has never been through a column, so it is projected to find the
   * rows. `"stored"` is a value read back OUT of an indexed column — what
   * `scripts/backfill-transcript-search.ts` pages over — and projecting THAT
   * digests the projection rather than the original session id, landing on a key
   * no table holds. The sweep then indexes nothing for exactly the sessions
   * whose id had to be bound, silently.
   *
   * Explicit rather than sniffed from the value's shape: `indexKeyCandidates`
   * deliberately withholds the raw form from a projected-shaped WIRE value
   * (ISS-8254 — that is a replayed capture), so shape alone cannot tell the two
   * origins apart, and guessing would relax that guard.
   */
  identityOrigin?: TranscriptIdentityOrigin;
};

/** Whether an `externalSessionId` arrived off the wire or out of a column. */
export const TranscriptIdentityOrigin = {
  Stored: "stored",
  Wire: "wire",
} as const;
export type TranscriptIdentityOrigin =
  (typeof TranscriptIdentityOrigin)[keyof typeof TranscriptIdentityOrigin];

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
      priority: session.priority,
      updatedAt: session.updatedAt,
    })
  );
  return true;
}

type IndexableSession = {
  artifactId: string;
  title: string;
  userId: string | null;
  priority: string | null;
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
    // ISS-8125 (review, davetho): `complete/route.ts` hands this the RAW wire
    // identity, but both tables below store `externalSessionId` PROJECTED — at
    // the same `INDEX_KEY_MAX_BYTES`, since it is one session identity carried
    // by two tables. An exact raw match therefore finds neither for a long id,
    // and the upload returns `Uploaded` while the search document is silently
    // skipped.
    //
    // ISS-8200 (review, davetho): resolved through the SHARED ORDERED probe,
    // not two independent `in` lists. An `in` list picks between a legacy raw
    // row and its projected sibling unordered, and these are two separate
    // statements — so the pair could disagree and pair one row's session
    // metadata with the other row's transcript. `resolveByAnyIndexKey` walks the
    // candidates projected-first on BOTH reads, which is the precedence every
    // write since ISS-8069 lands on, so the two cannot diverge. The second probe
    // is reached only when the byte budget actually bound, so ordinary traffic
    // still issues exactly one lookup per table.
    const origin = indexKeyOriginFor(input);
    const session = await resolveByAnyIndexKey(
      input.externalSessionId,
      (candidate) =>
        db.sessionDetail.findFirst({
          where: {
            computeTargetId: input.computeTargetId,
            externalSessionId: candidate,
            artifact: { is: { organizationId: input.organizationId } },
          },
          select: {
            artifactId: true,
            // ISS-8717: the owner's rename. Selected here for the same reason
            // the Sessions list/detail projection prefers it — `artifact.name`
            // is the collector's channel and every ingest rewrites it, so
            // indexing it alone would title a renamed session with the
            // placeholder and make search contradict the surface the rename was
            // made on.
            nameOverride: true,
            artifact: {
              select: {
                name: true,
                assigneeId: true,
                priority: true,
                updatedAt: true,
                organization: { select: { searchIncludeTranscripts: true } },
              },
            },
          },
        }),
      origin
    );
    if (session === null) {
      return null;
    }

    const transcript = await resolveByAnyIndexKey(
      input.externalSessionId,
      (candidate) =>
        db.sessionTranscript.findFirst({
          where: {
            organizationId: input.organizationId,
            computeTargetId: input.computeTargetId,
            externalSessionId: candidate,
            fileKey: MAIN_FILE_KEY,
            uploadStatus: TranscriptUploadStatus.Uploaded,
          },
          select: { objectStorageKey: true },
        }),
      origin
    );

    const detail = session.record;
    return {
      artifactId: detail.artifactId,
      title: detail.nameOverride ?? detail.artifact.name,
      userId: detail.artifact.assigneeId,
      priority: detail.artifact.priority,
      updatedAt: detail.artifact.updatedAt,
      searchIncludeTranscripts:
        detail.artifact.organization.searchIncludeTranscripts,
      objectStorageKey: transcript?.record.objectStorageKey ?? null,
    };
  });
}

/**
 * ISS-8125: which candidate rule the ordered probe walks, chosen by where the
 * caller's `externalSessionId` came from.
 *
 * A stored value is offered as itself — re-projecting it would digest the
 * projection instead of the session id — while a wire value is projected, and
 * only that branch keeps the ISS-8254 rule that a projected-shaped WIRE value
 * never gets its raw form back.
 */
function indexKeyOriginFor(input: TranscriptIndexInput): IndexKeyOrigin {
  if (input.identityOrigin === TranscriptIdentityOrigin.Stored) {
    return IndexKeyOrigin.Stored;
  }
  return IndexKeyOrigin.Wire;
}
