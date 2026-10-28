import type {
  CustomFieldReferenceResolveResponse,
  CustomFieldReferenceSearchResponse,
  CustomFieldReferenceTarget,
} from "@repo/api/src/types/custom-field";
import {
  REFERENCE_SEARCH_DEFAULT_LIMIT,
  REFERENCE_TARGET_SEARCH_ORDER_BY,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import { Prisma, withDb } from "@repo/database";
import { escapeSqlLikeLiteral } from "@/lib/sql-like";
import {
  canonicalArtifactId,
  isReferenceFieldType,
  ReferenceSourceScopeKind,
  referenceSourceScope,
  TARGET_ARTIFACT_SELECT,
  toReferenceTargets,
} from "./reference-targets";

/** Raised when the named field does not exist in the caller's organization. */
export class ReferenceFieldNotFoundError extends Error {
  constructor(fieldId: string) {
    super(`Custom field ${fieldId} was not found.`);
    this.name = "ReferenceFieldNotFoundError";
  }
}

/**
 * Raised when the caller narrows the search to a source the field does not
 * permit, or searches a field that holds no references at all.
 *
 * Rejected rather than filtered down to the permitted set: silently intersecting
 * would answer a question about SESSIONs with a list of ISSUEs and let a caller
 * probe which populations a field touches one empty response at a time.
 */
export class DisallowedReferenceSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisallowedReferenceSourceError";
  }
}

export type ReferenceTargetSearchInput = {
  fieldId: string;
  organizationId: string;
  query?: string;
  sources?: ReferenceTargetSource[];
  limit?: number;
  excludeEntityId?: string;
};

/**
 * The runtime read half of REFERENCE custom fields (ISS-7212).
 *
 * Both entry points take `organizationId` from the AUTHENTICATED caller, never
 * from the request payload. `artifacts` carries no per-user ACL column, so the
 * organization IS the visibility boundary here, and every query below states it.
 */
export const referenceSearchService = {
  /**
   * One bounded page of candidates a reference field may point at.
   *
   * Source scoping is resolved from the FIELD, not from what the caller asked
   * for: `sources` can only narrow within what the field already permits, and
   * anything outside that set is rejected by {@link assertSourcesPermitted}.
   */
  async searchTargets(
    input: ReferenceTargetSearchInput
  ): Promise<CustomFieldReferenceSearchResponse> {
    const field = await withDb((db) =>
      db.customField.findFirst({
        where: { id: input.fieldId, organizationId: input.organizationId },
        select: {
          id: true,
          name: true,
          fieldType: true,
          referenceTargetSources: true,
        },
      })
    );

    if (!field) {
      throw new ReferenceFieldNotFoundError(input.fieldId);
    }

    if (!isReferenceFieldType(field.fieldType)) {
      throw new DisallowedReferenceSourceError(
        `Custom field "${field.name}" is a ${field.fieldType} field and has no reference targets to search.`
      );
    }

    const permitted = field.referenceTargetSources;
    assertSourcesPermitted(field.name, input.sources, permitted);

    const scope = referenceSourceScope(input.sources ?? permitted);
    const limit = input.limit ?? REFERENCE_SEARCH_DEFAULT_LIMIT;

    // A field nobody configured reaches no artifacts at all, so there is nothing
    // to ask the database. Returning here rather than building an empty `OR`
    // keeps the fail-closed decision in code instead of resting on how Prisma
    // compiles a clause-less disjunction.
    if (scope.kind === ReferenceSourceScopeKind.None) {
      return { targets: [], hasMore: false };
    }

    const rows = await withDb((db) =>
      db.artifact.findMany({
        where: buildSearchWhere(input, scope),
        select: TARGET_ARTIFACT_SELECT,
        // Read from the shared constant, not re-spelled here: the ISS-7804
        // indexes are built to serve exactly this order, and the integration
        // suite that guards them derives its EXPLAINed SQL from the same value.
        orderBy: [...REFERENCE_TARGET_SEARCH_ORDER_BY],
        // One more than asked, so a full page can be distinguished from an
        // exhausted one without a second COUNT query.
        take: limit + 1,
      })
    );

    return {
      targets: toReferenceTargets(rows.slice(0, limit)),
      hasMore: rows.length > limit,
    };
  },

  /**
   * Resolves many target ids in ONE query, whatever the caller's page size.
   *
   * The reason this endpoint exists: a 25-row page whose reference column holds
   * several targets per row would otherwise be 25xN point lookups. The single
   * `IN` read here is what keeps that bounded, and `reference-search-service`'s
   * query-count test is what keeps it bounded as the code changes.
   *
   * Deliberately field-agnostic. Per-field source rules are a WRITE-time
   * contract already enforced when the value was stored; re-checking them here
   * would not add a boundary, because the organization scope below is the whole
   * boundary, and would break a chip whose field was later narrowed.
   */
  async resolveTargets(
    targetIds: string[],
    organizationId: string
  ): Promise<CustomFieldReferenceResolveResponse> {
    // Canonicalized rather than rejected at validation. The WRITE path accepts
    // the same case-insensitive form (`normalizeReferenceIds` → `isArtifactId`),
    // so an id a save already accepted has to stay resolvable here; 400-ing it
    // on a read would trade a false negative for a hard failure on data the
    // system itself stored. Doing it before the dedupe also collapses two
    // spellings of one id into a single predicate entry, and leaves every id in
    // the response — `unresolvable` included — in the same canonical spelling
    // as `targets[].id`, which comes straight off the row.
    const requested = [...new Set(targetIds.map(canonicalArtifactId))];

    if (requested.length === 0) {
      return { targets: [], unresolvable: [] };
    }

    const rows = await withDb((db) =>
      db.artifact.findMany({
        where: { id: { in: requested }, organizationId },
        select: TARGET_ARTIFACT_SELECT,
      })
    );

    const byId = new Map(
      toReferenceTargets(rows).map((target) => [target.id, target])
    );

    const targets: CustomFieldReferenceTarget[] = [];
    const unresolvable: string[] = [];
    for (const id of requested) {
      const target = byId.get(id);
      if (target) {
        targets.push(target);
      } else {
        unresolvable.push(id);
      }
    }

    return { targets, unresolvable };
  },
};

function assertSourcesPermitted(
  fieldName: string,
  requested: ReferenceTargetSource[] | undefined,
  permitted: ReferenceTargetSource[]
): void {
  if (!requested) {
    return;
  }

  // ARTIFACT is a SUPERSET, not a peer of the other three. The write path
  // accepts an issue, session or branch target on an ARTIFACT-sourced field
  // (`matchesArtifactShape` returns true for its null shape), so refusing to
  // SEARCH those populations would reject a narrowing for values the very next
  // save accepts — and would stop a picker on the widest field from offering the
  // type filter that field needs most. Literal set membership would do exactly
  // that, because `permitted` holds `ARTIFACT` and not the sources it implies.
  if (permitted.includes(ReferenceTargetSource.Artifact)) {
    return;
  }

  const disallowed = requested.filter((source) => !permitted.includes(source));
  if (disallowed.length > 0) {
    throw new DisallowedReferenceSourceError(
      `Custom field "${fieldName}" does not accept ${disallowed.join(", ")}. It accepts ${permitted.join(", ")}.`
    );
  }
}

function buildSearchWhere(
  input: ReferenceTargetSearchInput,
  scope: Exclude<
    ReturnType<typeof referenceSourceScope>,
    { kind: typeof ReferenceSourceScopeKind.None }
  >
) {
  const and: Prisma.ArtifactWhereInput[] = [];

  if (scope.kind === ReferenceSourceScopeKind.Shapes) {
    and.push(scope.where);
  }

  const trimmed = input.query?.trim();
  if (trimmed) {
    // Escaped because Prisma's insensitive `contains` compiles to a bare
    // `ILIKE $n` with NO `ESCAPE` clause, so a typed `%` or `_` would become a
    // pattern operator and quietly widen the search past what was typed.
    const term = escapeSqlLikeLiteral(trimmed);
    and.push({
      OR: [
        { slug: { contains: term, mode: Prisma.QueryMode.insensitive } },
        { name: { contains: term, mode: Prisma.QueryMode.insensitive } },
      ],
    });
  }

  // Self-reference is rejected unconditionally on the write path (ISS-7208), so
  // offering the owning entity as a candidate would only ever produce a value
  // the save then refuses.
  if (input.excludeEntityId) {
    and.push({ id: { not: input.excludeEntityId } });
  }

  return { organizationId: input.organizationId, AND: and };
}
