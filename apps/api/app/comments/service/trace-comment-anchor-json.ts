import type { TraceTextAnchor } from "@repo/api/src/types/comment";
import {
  COMMENT_ANCHOR_SCHEMA_VERSION,
  type CommentAnchor,
  type CommentAnchorTrace,
  parseStoredCommentAnchor,
  StoredCommentAnchorReadStatus,
  toStoredCommentAnchor,
} from "@repo/api/src/types/comment-anchor";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import type { Prisma } from "@repo/database";
import {
  CommentDataInvalidReason,
  reportCommentDataInvalid,
} from "@/app/comments/comment-data-invalid";

/**
 * Serialize a {@link TraceTextAnchor} for persistence in comment metadata.
 *
 * ISS-5589: this is the PRODUCER half of the keys-covered guard that
 * `traceTextAnchorShape` applies on the schema side
 * (`packages/api/src/types/comment.ts`). The schema-side guard is not sufficient
 * on its own: this function hand-enumerates the anchor's fields and used to be
 * bound only to `Prisma.InputJsonObject` — an open index signature that proves
 * nothing about key coverage. A field added to `TraceTextAnchor` AND taught to
 * the schema still compiled here and was silently dropped on every persist,
 * which is exactly the silent-loss class the schema-side guard exists to close,
 * displaced one layer down into the writer.
 *
 * `total` is the fix: `satisfies Record<keyof TraceTextAnchor, unknown>` makes
 * it total over the contract's key set, and the emitted object is spread FROM
 * it, so the guard is load-bearing rather than a lookalike sitting beside the
 * real emission. A newly-added optional field lands in `required` typed as
 * `… | undefined`, which the closing `satisfies Prisma.InputJsonObject` then
 * rejects — forcing the author to decide explicitly how it is written.
 *
 * Absent optionals must stay ABSENT rather than materialize as `null` (the
 * round-trip test pins this), hence the conditional spreads on the two the
 * contract declares as `?: T | null`.
 */
export function traceTextAnchorToJsonObject(
  anchor: TraceTextAnchor
): Prisma.InputJsonObject {
  const actor = anchor.actor;
  const total = {
    traceId: anchor.traceId,
    turnId: anchor.turnId,
    row: anchor.row,
    selectedText: anchor.selectedText,
    sourceText: anchor.sourceText,
    startOffset: anchor.startOffset,
    endOffset: anchor.endOffset,
    sessionId: anchor.sessionId,
    // The nested `actor` object needs its OWN guard: `keyof TraceTextAnchor`
    // only proves the `actor` KEY is written, never the keys inside it.
    actor:
      actor === null || actor === undefined
        ? actor
        : ({ name: actor.name, human: actor.human } satisfies Record<
            keyof NonNullable<TraceTextAnchor["actor"]>,
            unknown
          >),
  } satisfies Record<keyof TraceTextAnchor, unknown>;

  const { sessionId, actor: actorJson, ...required } = total;
  return {
    ...required,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(actorJson === undefined ? {} : { actor: actorJson }),
  } satisfies Prisma.InputJsonObject;
}

/**
 * ISS-11212: the `CommentThread.anchor` column value for a trace comment, the
 * `{ v, kind: "trace", ...anchor }` envelope the migration also writes.
 */
export function traceTextAnchorToStoredJson(
  anchor: TraceTextAnchor
): Prisma.InputJsonObject {
  return {
    v: COMMENT_ANCHOR_SCHEMA_VERSION,
    kind: CommentAnchorKind.Trace,
    ...traceTextAnchorToJsonObject(anchor),
  };
}

/**
 * The `CommentThread.anchor` column value for any anchor kind. A trace anchor
 * goes through {@link traceTextAnchorToStoredJson}, so it is stored exactly as
 * the legacy create stored it.
 */
export function commentAnchorToStoredJson(
  anchor: CommentAnchor
): Prisma.InputJsonObject {
  if (anchor.kind === CommentAnchorKind.Trace) {
    const { kind: _kind, ...trace } = anchor;
    return traceTextAnchorToStoredJson(trace);
  }
  return toStoredCommentAnchor(anchor);
}

type StoredTraceTextAnchorRead =
  | { ok: true; anchor: TraceTextAnchor }
  | { ok: false; reason: CommentDataInvalidReason };

/**
 * Reads a trace thread's `anchor` column back into the legacy
 * {@link TraceTextAnchor}, or `null` when it is not a valid v1 trace anchor.
 * PLN-2120 decision 3: that failure is reported as `comments.data_invalid` and
 * the caller leaves the thread out, never coercing it.
 */
export function readStoredTraceTextAnchor(
  value: unknown,
  thread: { organizationId: string; threadId: string }
): TraceTextAnchor | null {
  const read = parseStoredTraceTextAnchor(value);
  if (read.ok) {
    return read.anchor;
  }
  reportAnchorFailureOnce(read.reason, thread);
  return null;
}

/**
 * Reads a thread's `anchor` column for the unified DTO: `null` for a column not
 * yet backfilled, and `undefined` for an unknown version or a corrupt value,
 * whose thread the caller leaves out. Both are reported, as the legacy read
 * reports them.
 */
export function readStoredCommentAnchor(
  value: unknown,
  thread: { organizationId: string; threadId: string }
): CommentAnchor | null | undefined {
  const read = parseStoredCommentAnchor(value);
  if (read.status === StoredCommentAnchorReadStatus.Valid) {
    return read.anchor;
  }
  if (read.status === StoredCommentAnchorReadStatus.Absent) {
    reportAnchorFailureOnce(CommentDataInvalidReason.AnchorMissing, thread);
    return null;
  }
  reportAnchorFailureOnce(CommentDataInvalidReason.AnchorUnparseable, thread);
  return undefined;
}

export function resetReportedTraceAnchorFailures(): void {
  reportedAnchorFailures.clear();
}

/**
 * Trace lists are polled every few seconds, so a bad row is reported once per
 * thread and reason per process rather than on every read. Clearing at the cap
 * keeps the set bounded at the cost of one repeat report per thread.
 */
const REPORTED_ANCHOR_FAILURES_CAP = 1000;
const reportedAnchorFailures = new Set<string>();

function reportAnchorFailureOnce(
  reason: CommentDataInvalidReason,
  thread: { organizationId: string; threadId: string }
): void {
  const key = `${reason}:${thread.threadId}`;
  if (reportedAnchorFailures.has(key)) {
    return;
  }
  if (reportedAnchorFailures.size >= REPORTED_ANCHOR_FAILURES_CAP) {
    reportedAnchorFailures.clear();
  }
  reportedAnchorFailures.add(key);
  reportCommentDataInvalid({ reason, ...thread });
}

function parseStoredTraceTextAnchor(value: unknown): StoredTraceTextAnchorRead {
  const read = parseStoredCommentAnchor(value);
  if (read.status === StoredCommentAnchorReadStatus.Absent) {
    return { ok: false, reason: CommentDataInvalidReason.AnchorMissing };
  }
  if (
    read.status === StoredCommentAnchorReadStatus.Valid &&
    read.anchor.kind === CommentAnchorKind.Trace
  ) {
    return { ok: true, anchor: commentAnchorToTraceTextAnchor(read.anchor) };
  }
  return { ok: false, reason: CommentDataInvalidReason.AnchorUnparseable };
}

/**
 * Rebuilt field by field rather than by dropping `kind`, so the legacy DTO keeps
 * the key order `traceTextAnchorSchema` produced when the anchor was read out of
 * `metadata`, and absent optionals stay absent.
 */
function commentAnchorToTraceTextAnchor(
  anchor: CommentAnchorTrace
): TraceTextAnchor {
  const actor = anchor.actor;
  const total = {
    traceId: anchor.traceId,
    turnId: anchor.turnId,
    row: anchor.row,
    selectedText: anchor.selectedText,
    sourceText: anchor.sourceText,
    startOffset: anchor.startOffset,
    endOffset: anchor.endOffset,
    sessionId: anchor.sessionId,
    actor:
      actor === null || actor === undefined
        ? actor
        : ({ name: actor.name, human: actor.human } satisfies Record<
            keyof NonNullable<TraceTextAnchor["actor"]>,
            unknown
          >),
  } satisfies Record<keyof TraceTextAnchor, unknown>;

  const { sessionId, actor: actorValue, ...required } = total;
  return {
    ...required,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(actorValue === undefined ? {} : { actor: actorValue }),
  };
}
