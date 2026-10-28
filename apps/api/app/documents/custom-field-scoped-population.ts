import {
  CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES,
  CustomFieldQueryRejection,
} from "@repo/api/src/types/custom-field-list-query";
import {
  type Result,
  Result as ResultHelpers,
} from "@repo/api/src/types/result";
import { type Prisma, withDb } from "@repo/database";
import type { CustomFieldEntityIdConstraint } from "./custom-field-list-service";

/**
 * The population a list request actually describes, bounded (ISS-7211 review).
 *
 * Every bound in this feature used to be measured against the ORGANIZATION: a
 * facet read took `CAP + 1` rows org-wide and refused past it. That made the
 * refusal's own guidance — "narrow the request" — unfollowable, because no
 * project, type, assignee, or recency window a caller could add changes an
 * org-wide count (whitlockk). A value used on 20,001 documents refused a five-row
 * project query.
 *
 * This reader is the scoped counterpart: the artifact predicate the request
 * built, read with a real bound. Narrowing the request shrinks exactly the
 * number that decides the refusal, so the guidance is now true.
 *
 * **Which predicate depends on WHEN it is read**, hence
 * {@link ScopedPopulationFactory}: a filter cannot be resolved inside a
 * population already narrowed by that same filter, but everything measured
 * afterwards can and must count the resolved narrowing.
 *
 * **Both entry points are memoized**, because several facets and the sort
 * preflight all consult it within one request and it is the expensive read here.
 * Callers run it inside the list read's `RepeatableRead` transaction, so the
 * count and the ids it hands back describe one snapshot rather than two.
 */
export type ScopedPopulationReader = {
  /**
   * Refuse when the scoped population is larger than one query can carry.
   *
   * `count()` rather than the id scan: the sort path needs only the verdict, and
   * a count is index-backed and marshals one integer instead of tens of
   * thousands of UUIDs.
   */
  ensureWithinBound(): Promise<Result<number, CustomFieldQueryRejection>>;
  /**
   * The scoped population as ids, or a refusal when it exceeds the bound.
   *
   * Reads ONE past the bound so "exactly at it" is distinguishable from "over
   * it", and refuses rather than truncating — a truncated population would let
   * the endpoint report a confident total for a set it never matched.
   */
  ids(): Promise<Result<string[], CustomFieldQueryRejection>>;
};

/**
 * Build a {@link ScopedPopulationReader} for a stage of the resolve.
 *
 * `entityIds` is the custom-field id constraint to FOLD INTO the predicate, and
 * omitting it is a statement, not a default: filter resolution must pass nothing
 * (scoping a filter's resolution by the filter being resolved is circular),
 * while every read after the filters resolve must pass what they resolved to.
 *
 * A factory rather than a re-scope method on the reader, because the predicate
 * then always comes from `buildDocumentListWhere` — the one builder the page
 * read and the honest `count()` also use. Merging an id clause into an
 * already-built `where` would be a second, drift-prone expression of the same
 * predicate, and a spread that silently clobbers an existing `id` constraint.
 */
export type ScopedPopulationFactory = (
  entityIds?: CustomFieldEntityIdConstraint
) => ScopedPopulationReader;

/** Build a {@link ScopedPopulationReader} over an already-built artifact predicate. */
export function createScopedPopulationReader(
  where: Prisma.ArtifactWhereInput
): ScopedPopulationReader {
  let countPromise:
    | Promise<Result<number, CustomFieldQueryRejection>>
    | undefined;
  let idsPromise:
    | Promise<Result<string[], CustomFieldQueryRejection>>
    | undefined;

  const readCount = async (): Promise<
    Result<number, CustomFieldQueryRejection>
  > => {
    const total = await withDb((db) => db.artifact.count({ where }));
    if (total > CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES) {
      return ResultHelpers.err(CustomFieldQueryRejection.FilterTooBroad);
    }
    return ResultHelpers.ok(total);
  };

  const readIds = async (): Promise<
    Result<string[], CustomFieldQueryRejection>
  > => {
    const rows = await withDb((db) =>
      db.artifact.findMany({
        where,
        select: { id: true },
        take: CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES + 1,
      })
    );
    if (rows.length > CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES) {
      return ResultHelpers.err(CustomFieldQueryRejection.FilterTooBroad);
    }
    return ResultHelpers.ok(rows.map((row) => row.id));
  };

  return {
    ensureWithinBound() {
      countPromise ??= readCount();
      return countPromise;
    },
    ids() {
      idsPromise ??= readIds();
      return idsPromise;
    },
  };
}
