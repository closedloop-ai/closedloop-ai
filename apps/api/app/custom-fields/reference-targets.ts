import { normalizeArtifactSubtype } from "@repo/api/src/types/artifact";
import type { CustomFieldReferenceTarget } from "@repo/api/src/types/custom-field";
import {
  CustomFieldType,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import type { TransactionClient } from "@repo/database/generated/internal/prismaNamespace";
import { getPrismaErrorCode } from "@/lib/db-utils";

/**
 * Raised when a reference value names a target that is not a legal value for
 * the field — unknown, out-of-org, of a disallowed source, or self-referential.
 *
 * Distinct from the generic write errors so the routes can map it to a 4xx.
 * These are all caller mistakes, never server faults.
 */
export class InvalidReferenceTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReferenceTargetError";
  }
}

/** The two field types whose values are artifact references. */
export const REFERENCE_FIELD_TYPES: readonly CustomFieldType[] = [
  CustomFieldType.Reference,
  CustomFieldType.ReferenceMulti,
] as const;

/** Maximum targets a single REFERENCE_MULTI value may hold. */
export const MAX_REFERENCE_TARGETS = 100;

/**
 * The artifact columns a reference chip renders, declared once.
 *
 * Every path that loads a target — write-time validation, the read-side
 * include, and the search/batch-resolution reads — projects exactly this set,
 * because they all feed the same {@link toReferenceTargets} mapper. Three
 * hand-maintained copies of the list is how one of them silently stops
 * selecting `status` and the chip loses it on one surface only.
 *
 * Declared here rather than at the foot of the file: {@link
 * REFERENCE_TARGETS_INCLUDE} reads it during module initialization, so a later
 * declaration would be a temporal-dead-zone crash on import.
 */
export const TARGET_ARTIFACT_SELECT = {
  id: true,
  slug: true,
  name: true,
  type: true,
  subtype: true,
  status: true,
} as const;

/**
 * Canonical form of `artifacts.id`, which is a Postgres `uuid` column.
 *
 * Checked before the target lookup runs, because Postgres rejects a malformed
 * uuid literal in the driver rather than returning no rows: an id like
 * `not-a-uuid` reaching the `where` clause raises a driver error that the route
 * can only report as a 500, when it is the caller having sent a bad id (a 400).
 * The lookup's own "does not exist" branch cannot cover it — the query never
 * gets to run.
 */
const ARTIFACT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The source → artifact contract, declared once AS DATA.
 *
 * Two consumers need this same contract in two incompatible shapes: the write
 * path tests an already-loaded row ({@link isTargetAllowed}), while the search
 * path has to push it into the query ({@link referenceSourceScope}) because it
 * cannot load the organization's entire artifact table and filter afterwards.
 * Deriving both from this table is what stops "what counts as an ISSUE" from
 * being spelled twice and drifting apart.
 *
 * `null` means the source admits every artifact type.
 *
 * `ISSUE` lists both subtype spellings on purpose. Per FEA-3956 / PRD-560 the
 * Feature → Issue rename left existing rows persisted as `FEATURE` and maps the
 * canonical `ISSUE` input back to it in code, but the DB enum accepts `ISSUE`
 * from a skewed newer client — so matching only one spelling would silently
 * reject legitimate targets written by the other.
 *
 * The values are THUNKS so that importing this module still reads nothing off
 * `@repo/database`. Eagerly spelling `ArtifactType.SESSION` here would make the
 * enum a load-time dependency of every transitive importer, and the many suites
 * that mock `@repo/database` with only the members they use would fail at
 * import rather than at the assertion they were written for. A `Record` keyed on
 * the source union rather than a `switch` so a new source fails typecheck here
 * until it is deliberately mapped.
 */
const SOURCE_ARTIFACT_SHAPES: Record<
  ReferenceTargetSource,
  () => ArtifactShape | null
> = {
  [ReferenceTargetSource.Artifact]: () => null,
  [ReferenceTargetSource.Session]: () => ({ type: ArtifactType.SESSION }),
  [ReferenceTargetSource.Branch]: () => ({ type: ArtifactType.BRANCH }),
  [ReferenceTargetSource.Issue]: () => ({
    type: ArtifactType.DOCUMENT,
    subtypes: [ArtifactSubtype.FEATURE, ArtifactSubtype.ISSUE],
  }),
};

type TargetArtifactRow = {
  id: string;
  slug: string | null;
  name: string;
  type: ArtifactType;
  subtype: ArtifactSubtype | null;
  status: string;
};

/** True when this field type stores artifact references. */
export function isReferenceFieldType(fieldType: CustomFieldType): boolean {
  return REFERENCE_FIELD_TYPES.includes(fieldType);
}

/**
 * Normalizes a raw reference value into the ordered list of target artifact ids
 * it names, enforcing cardinality.
 *
 * Cardinality is carried by the field TYPE rather than a separate column:
 * REFERENCE holds exactly one target, REFERENCE_MULTI holds many.
 */
export function normalizeReferenceIds(
  fieldType: CustomFieldType,
  rawValue: string | number | string[]
): string[] {
  const ids = Array.isArray(rawValue) ? rawValue : [String(rawValue)];

  for (const id of ids) {
    if (typeof id !== "string" || !isArtifactId(id)) {
      throw new InvalidReferenceTargetError(
        `Invalid value for ${fieldType} field: every target must be an artifact id, but "${id}" is not one.`
      );
    }
  }

  const deduped = [...new Set(ids)];

  if (fieldType === CustomFieldType.Reference && deduped.length > 1) {
    throw new InvalidReferenceTargetError(
      `Invalid value for REFERENCE field: expected a single target, got ${deduped.length}. Use REFERENCE_MULTI for multiple targets.`
    );
  }

  if (deduped.length > MAX_REFERENCE_TARGETS) {
    throw new InvalidReferenceTargetError(
      `REFERENCE_MULTI field value exceeds the maximum of ${MAX_REFERENCE_TARGETS} targets.`
    );
  }

  return deduped;
}

/**
 * Loads the named targets and rejects any that this field may not point at.
 *
 * Returns the resolved rows in the caller's order so the write path can persist
 * `sortOrder` without a second query.
 *
 * `owningEntityId` is the entity the value belongs to; a target equal to it is
 * rejected as a self-reference. Cycles deeper than that (A→B→A) are NOT checked
 * — see the module note in the PR.
 */
export async function resolveAndValidateReferenceTargets(
  field: {
    id: string;
    name: string;
    fieldType: CustomFieldType;
    referenceTargetSources: ReferenceTargetSource[];
  },
  targetIds: string[],
  organizationId: string,
  owningEntityId: string,
  tx?: Pick<TransactionClient, "artifact">
): Promise<TargetArtifactRow[]> {
  if (targetIds.length === 0) {
    return [];
  }

  const selfReference = targetIds.find((id) => id === owningEntityId);
  if (selfReference) {
    throw new InvalidReferenceTargetError(
      `Custom field "${field.name}" cannot reference the entity it is attached to.`
    );
  }

  const findArgs = {
    where: { id: { in: targetIds }, organizationId },
    select: TARGET_ARTIFACT_SELECT,
  };

  const rows = tx
    ? await tx.artifact.findMany(findArgs)
    : await withDb((db) => db.artifact.findMany(findArgs));

  const byId = new Map(rows.map((row) => [row.id, row]));

  const missing = targetIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new InvalidReferenceTargetError(
      `Custom field "${field.name}" references artifacts that do not exist: ${missing.join(", ")}.`
    );
  }

  const allowed = field.referenceTargetSources;
  for (const id of targetIds) {
    const row = byId.get(id) as TargetArtifactRow;
    if (!isTargetAllowed(row, allowed)) {
      throw new InvalidReferenceTargetError(
        `Custom field "${field.name}" only accepts ${describeSources(allowed)}, but ${id} is a ${describeArtifact(row)}.`
      );
    }
  }

  // Every id was proven present by the loop above, so this cast is safe and the
  // ordering is total. Deliberately NOT `orderRowsBy` (lib/order-rows-by.ts):
  // that helper DROPS an id with no row, which is right where a missing row
  // means "absent" and wrong here, where it would silently shorten a validated
  // target list.
  return targetIds.map((id) => byId.get(id) as TargetArtifactRow);
}

/**
 * Full write-side check for a reference value: cardinality, then existence and
 * permitted source for every named target.
 *
 * Returns the ordered target ids to persist. A null/absent value clears the
 * references, which is why it returns an empty list rather than short-circuiting
 * the caller — the write still has to delete the previous rows.
 */
export async function validateReferenceTargets(
  field: {
    id: string;
    name: string;
    fieldType: CustomFieldType;
    referenceTargetSources: ReferenceTargetSource[];
  },
  targetIds: string[] | null,
  organizationId: string,
  owningEntityId: string,
  tx: Pick<TransactionClient, "artifact">
): Promise<void> {
  if (targetIds === null) {
    return;
  }

  await resolveAndValidateReferenceTargets(
    field,
    targetIds,
    organizationId,
    owningEntityId,
    tx
  );
}

/**
 * Projects target rows into the render-ready shape.
 *
 * Callers pass rows read at request time, never a persisted string — this is
 * the read half of the REFERENCE `ResolvedOnRead` strategy.
 */
export function toReferenceTargets(
  rows: TargetArtifactRow[]
): CustomFieldReferenceTarget[] {
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    artifactType: row.type,
    // The column accepts `ISSUE` from a skewed newer client while the API
    // vocabulary only spells the persisted `FEATURE` (FEA-3956), so fold it
    // here rather than leaking a value the api type does not admit.
    subtype:
      row.subtype === null ? null : normalizeArtifactSubtype(row.subtype),
    status: row.status,
  }));
}

/**
 * Include fragment that joins each value's reference targets.
 *
 * Part of the shared value include so EVERY read path resolves targets live —
 * a read that forgot to join would silently fall back to the empty stored
 * `display_value` and render a reference as blank.
 */
export const REFERENCE_TARGETS_INCLUDE = {
  orderBy: { sortOrder: "asc" as const },
  include: {
    targetArtifact: { select: TARGET_ARTIFACT_SELECT },
  },
} as const;

/**
 * Replaces a value's reference rows with `targets`, in order.
 *
 * Delete-then-create rather than a diff: a reference value is a small ordered
 * set, and rewriting it wholesale keeps `sortOrder` correct without reconciling
 * moves. Callers must run this inside the same transaction as the value upsert.
 */
export async function replaceReferenceRows(
  tx: ReferenceRowWriter,
  customFieldValueId: string,
  targetIds: string[]
): Promise<void> {
  await tx.customFieldValueReference.deleteMany({
    where: { customFieldValueId },
  });

  if (targetIds.length === 0) {
    return;
  }

  try {
    await tx.customFieldValueReference.createMany({
      data: targetIds.map((targetArtifactId, index) => ({
        customFieldValueId,
        targetArtifactId,
        sortOrder: index,
      })),
    });
  } catch (error) {
    // The callers validate every target inside this same transaction, but that
    // check is a `findMany`, and at READ COMMITTED a plain read takes no share
    // lock on the rows it returns. A DELETE of a target artifact can therefore
    // still commit between the check and this insert, and the foreign key
    // rejects the row with P2003. Left unmapped it reaches the route as a raw
    // 500; it is the caller naming a target that no longer exists, which is
    // the same 4xx as naming one that never existed.
    if (getPrismaErrorCode(error) === "P2003") {
      throw new InvalidReferenceTargetError(
        "One or more reference targets were deleted while this value was being saved. Retry with the targets that still exist."
      );
    }
    throw error;
  }
}

function isTargetAllowed(
  row: TargetArtifactRow,
  allowed: ReferenceTargetSource[]
): boolean {
  // Fail CLOSED on an unconfigured field. An empty list means nobody declared
  // what this field may point at, so accepting everything would silently make
  // the per-field target contract unenforceable — the create validator rejects
  // a sourceless reference field precisely so this branch is unreachable in
  // production, and REFERENCE is a new type with no pre-existing rows to spare.
  if (allowed.length === 0) {
    return false;
  }
  return allowed.some((source) =>
    matchesArtifactShape(row, SOURCE_ARTIFACT_SHAPES[source]())
  );
}

function matchesArtifactShape(
  row: TargetArtifactRow,
  shape: ArtifactShape | null
): boolean {
  if (shape === null) {
    return true;
  }
  if (row.type !== shape.type) {
    return false;
  }
  if (!shape.subtypes) {
    return true;
  }
  return row.subtype !== null && shape.subtypes.includes(row.subtype);
}

function describeSources(sources: ReferenceTargetSource[]): string {
  return sources.join(", ");
}

function describeArtifact(row: TargetArtifactRow): string {
  return row.subtype ? `${row.type}/${row.subtype}` : row.type;
}

/**
 * The two delegate methods {@link replaceReferenceRows} actually calls.
 *
 * Narrower than `Pick<TransactionClient, "customFieldValueReference">` on
 * purpose: that pulls in the full 16-method delegate, which a caller can only
 * satisfy with a cast. Stating the two methods used keeps the real transaction
 * client and a test double both structurally valid without one.
 */
type ReferenceRowWriter = {
  customFieldValueReference: {
    deleteMany: (args: {
      where: { customFieldValueId: string };
    }) => Promise<unknown>;
    createMany: (args: {
      data: {
        customFieldValueId: string;
        targetArtifactId: string;
        sortOrder: number;
      }[];
    }) => Promise<unknown>;
  };
};

/** One artifact population, as {@link SOURCE_ARTIFACT_SHAPES} declares it. */
type ArtifactShape = {
  type: ArtifactType;
  subtypes?: ArtifactSubtype[];
};

/** The `where` fragment selecting a single {@link ArtifactShape}. */
export type ArtifactShapeWhere = {
  type: ArtifactType;
  subtype?: { in: ArtifactSubtype[] };
};

/**
 * How far a set of declared sources lets a query reach.
 *
 * Three outcomes, and collapsing any two of them is a security bug rather than
 * a tidy-up:
 *  - `All` — some source admits every artifact type, so the query adds NO type
 *    predicate.
 *  - `None` — no source was declared. Fails CLOSED for the same reason
 *    {@link isTargetAllowed} does; searching the organization's entire artifact
 *    table is the one outcome an undeclared field must never produce.
 *  - `Shapes` — the union of the named populations.
 *
 * A discriminated union rather than a nullable `where` because `All` and `None`
 * are both "no clauses to AND in" and mean exact opposites.
 */
export const ReferenceSourceScopeKind = {
  All: "ALL",
  None: "NONE",
  Shapes: "SHAPES",
} as const;
export type ReferenceSourceScopeKind =
  (typeof ReferenceSourceScopeKind)[keyof typeof ReferenceSourceScopeKind];

export type ReferenceSourceScope =
  | { kind: typeof ReferenceSourceScopeKind.All }
  | { kind: typeof ReferenceSourceScopeKind.None }
  | {
      kind: typeof ReferenceSourceScopeKind.Shapes;
      where: { OR: ArtifactShapeWhere[] };
    };

/**
 * Projects declared sources into the query-side half of the source contract.
 *
 * The read counterpart of {@link isTargetAllowed}: both consume
 * {@link SOURCE_ARTIFACT_SHAPES}, so a source whose definition changes moves
 * the write check and the search filter together.
 */
export function referenceSourceScope(
  sources: ReferenceTargetSource[]
): ReferenceSourceScope {
  if (sources.length === 0) {
    return { kind: ReferenceSourceScopeKind.None };
  }

  const shapes = sources.map((source) => SOURCE_ARTIFACT_SHAPES[source]());
  if (shapes.includes(null)) {
    return { kind: ReferenceSourceScopeKind.All };
  }

  return {
    kind: ReferenceSourceScopeKind.Shapes,
    where: {
      OR: shapes.map((shape) => toShapeWhere(shape as ArtifactShape)),
    },
  };
}

/** True when `value` has the canonical shape of an `artifacts.id`. */
export function isArtifactId(value: string): boolean {
  return ARTIFACT_ID_PATTERN.test(value);
}

/**
 * The one spelling of an artifact id that a JS-side comparison may use.
 *
 * {@link ARTIFACT_ID_PATTERN} is case-INSENSITIVE, and Postgres is too: it
 * accepts an uppercase uuid literal and returns the row with its id rendered in
 * canonical lowercase. Anything that then matches a REQUESTED id against a
 * RETURNED one — a `Map` keyed on the row id, a `Set` dedupe — silently misses
 * unless both sides are canonicalized first, and reports a row the database
 * found as missing.
 */
export function canonicalArtifactId(value: string): string {
  return value.toLowerCase();
}

function toShapeWhere(shape: ArtifactShape): ArtifactShapeWhere {
  if (!shape.subtypes) {
    return { type: shape.type };
  }
  return { type: shape.type, subtype: { in: shape.subtypes } };
}
