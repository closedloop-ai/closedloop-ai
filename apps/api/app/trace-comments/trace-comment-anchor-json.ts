import type { TraceTextAnchor } from "@repo/api/src/types/comment";
import type { Prisma } from "@repo/database";

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
 *
 * Lives in its own module rather than in `service.ts` because that file is on
 * the shrink-only `noExcessiveLinesPerFile` grandfather list.
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
