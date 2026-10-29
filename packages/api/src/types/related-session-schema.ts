// Split from `./related-session.ts` so the "use client" cells that import only
// its shapes and caps do not load `zod` for a parser they never run.
import { z } from "zod";
import { ProvenanceRelationshipKind } from "./provenance-relationship.ts";
import type {
  RelatedSessionOwner,
  RelatedSessionSummary,
  RelatedSessionsBatchResponse,
  RelatedSessionsResult,
} from "./related-session.ts";

const provenanceRelationshipKindSchema = z.enum(ProvenanceRelationshipKind);

const relatedSessionOwnerSchema = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
}) satisfies z.ZodType<RelatedSessionOwner>;

const _relatedSessionOwnerKeysCovered: Record<
  keyof RelatedSessionOwner,
  z.ZodTypeAny
> = relatedSessionOwnerSchema.shape;

/**
 * Reader-side parser for one {@link RelatedSessionSummary} (ISS-9317). Not
 * `.strict()`: a server a deploy ahead may add a field this bundle does not read
 * yet, and that must not fold a whole page of chips to the count fallback.
 *
 * `contributedAt` is an ISO instant or the row is malformed: the cell formats it
 * with `date-fns`, which throws on an invalid date, so a bad timestamp admitted
 * here would be a thrown render instead of this artifact's count fallback.
 */
export const relatedSessionSummarySchema = z.object({
  sessionArtifactId: z.string(),
  slug: z.string().nullable(),
  name: z.string().nullable(),
  status: z.string(),
  owner: relatedSessionOwnerSchema.nullable(),
  kind: provenanceRelationshipKindSchema,
  contributedAt: z.iso.datetime({ offset: true }),
}) satisfies z.ZodType<RelatedSessionSummary>;

/**
 * Compile-time proof the parser covers every field of
 * {@link RelatedSessionSummary}: a field added to the type without teaching the
 * schema fails `tsc` here instead of being stripped from every parsed row.
 */
const _relatedSessionSummaryKeysCovered: Record<
  keyof RelatedSessionSummary,
  z.ZodTypeAny
> = relatedSessionSummarySchema.shape;

/**
 * One artifact's result, with two reader-side folds the wire contract cannot
 * express:
 *
 * - A row whose `kind` this bundle does not know (a server a deploy ahead
 *   classifying provenance a new way) is DROPPED from `items` rather than
 *   failing the page, and stays counted in `total` — so the `+N` overflow reads
 *   it as a session not shown here, which is exactly what it is. A row with a
 *   known kind and a malformed field still fails: that is a broken body, not a
 *   newer one.
 * - `total` is a count or it is nothing: a non-integer, negative, unsafe
 *   (past `Number.MAX_SAFE_INTEGER`), or smaller-than-`items` value folds to
 *   `items.length`, so a bad number can never become a `+N` claim about
 *   sessions that do not exist.
 */
export const relatedSessionsResultSchema = z
  .object({
    items: z
      .array(z.looseObject({ kind: z.unknown() }))
      .transform((rows) =>
        rows.filter(
          (row) => provenanceRelationshipKindSchema.safeParse(row.kind).success
        )
      )
      .pipe(z.array(relatedSessionSummarySchema)),
    total: z.unknown().optional(),
  })
  .transform(
    ({ items, total }): RelatedSessionsResult => ({
      items,
      total: isAdmissibleTotal(total, items.length) ? total : items.length,
    })
  );

/**
 * One artifact's entry failing to parse drops THAT key, not the page: the cell
 * already renders an absent key as the count chip, which is the right claim
 * for an artifact the server described badly, and the other rows on the page
 * keep their chips.
 *
 * The keys are server-supplied, so the fold target has no prototype: on a
 * plain `{}`, a `__proto__` entry would rewire the object instead of storing
 * anything. zod's record happens to strip that key today; this does not lean
 * on it.
 */
export const relatedSessionsBatchResponseSchema = z.object({
  appliedSessionArtifactIds: z.array(z.uuid()).optional(),
  appliedSessionSearch: z.string().optional(),
  results: z
    .record(z.string(), z.unknown())
    .transform((entries): Record<string, RelatedSessionsResult> => {
      const results: Record<string, RelatedSessionsResult> =
        Object.create(null);
      for (const [artifactId, entry] of Object.entries(entries)) {
        const parsed = relatedSessionsResultSchema.safeParse(entry);
        if (parsed.success) {
          results[artifactId] = parsed.data;
        }
      }
      return results;
    }),
}) satisfies z.ZodType<RelatedSessionsBatchResponse, unknown>;

/** Filtering cannot substitute a displayed-pill count for a failed total. */
export const relatedSessionsScopeResponseSchema = z
  .looseObject({
    results: z.record(
      z.string(),
      z
        .looseObject({
          items: z.array(z.unknown()),
          total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        })
        .refine((entry) => entry.total >= entry.items.length)
    ),
  })
  .transform((value) => relatedSessionsBatchResponseSchema.parse(value));

function isAdmissibleTotal(total: unknown, floor: number): total is number {
  return (
    typeof total === "number" && Number.isSafeInteger(total) && total >= floor
  );
}
