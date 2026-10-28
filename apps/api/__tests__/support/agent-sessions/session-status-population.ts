import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { vi } from "vitest";
import { buildSessionListRecord, installDb } from "./service.test-harness";

/**
 * ISS-4985: a seeded session population plus a NARROW evaluator for the
 * `where` the Status facet builds, so a facet test can assert the IDs a filter
 * RETURNS instead of the Prisma argument it constructed.
 *
 * Why this exists (whitlockk, #4737). The sibling facet tests mock `findMany` to
 * resolve `[]` for every filter, so the service RESULT is identical whether or
 * not the predicate under test is correct — the argument-shape assertion is the
 * only thing holding them up, and the repo's behavior-test rule calls exactly
 * that out. Seeding a population and filtering it with the predicate the
 * production builder emitted turns "the query says X" into "the caller gets these
 * rows".
 *
 * It is NOT a Prisma emulator and must never grow into one. It understands
 * precisely the clause shapes the Status facet emits — `AND`, `OR`, and
 * `artifact.is.<field>` with a scalar or `{ in: [...] }` — and THROWS on anything
 * else. That throw is the load-bearing part: an evaluator that silently ignored
 * an unrecognized clause would quietly answer "matches" for a predicate it never
 * applied, restoring the very vacuity this file removes (and, worse, hiding a
 * dropped org-scope clause). A facet whose predicate outgrows these shapes must
 * teach the evaluator or use the real DB-backed integration harness under
 * `apps/api/__tests__/integration/`.
 */

const ORG_ID = "org-1";
const OTHER_ORG_ID = "org-2";

export const SEEDED_ORGANIZATION_ID = ORG_ID;

/**
 * One row per status that matters to the retired-input contract, plus an
 * out-of-org row so a predicate that drops the org scope is caught by the same
 * assertion rather than passing unnoticed.
 *
 * `completed`/`abandoned` rows are the stragglers the ISS-4654 backfill missed or
 * a version-skewed Desktop wrote after it ran — the population the cloud Inactive
 * predicate deliberately still reaches.
 */
export const SEEDED_SESSION_STATUS_ROWS: readonly {
  id: string;
  organizationId: string;
  status: string;
  /** Offset from the seed instant, in seconds. Negative is the past. */
  endedAtOffsetSeconds: number | null;
  lastActivityAtOffsetSeconds: number;
  endsWithError: boolean | null;
}[] = [
  {
    id: "in-org-inactive",
    organizationId: ORG_ID,
    status: SESSION_STATUS.INACTIVE,
    endedAtOffsetSeconds: -60,
    lastActivityAtOffsetSeconds: -120,
    endsWithError: false,
  },
  {
    id: "in-org-error",
    organizationId: ORG_ID,
    status: SESSION_STATUS.ERROR,
    endedAtOffsetSeconds: -60,
    lastActivityAtOffsetSeconds: -120,
    endsWithError: true,
  },
  {
    id: "in-org-active",
    organizationId: ORG_ID,
    status: SESSION_STATUS.ACTIVE,
    endedAtOffsetSeconds: null,
    lastActivityAtOffsetSeconds: -30,
    endsWithError: null,
  },
  {
    id: "other-org-inactive",
    organizationId: OTHER_ORG_ID,
    status: SESSION_STATUS.INACTIVE,
    endedAtOffsetSeconds: -60,
    lastActivityAtOffsetSeconds: -120,
    endsWithError: false,
  },
  // Two rows storing `active` beside a recorded end that nothing followed, one
  // per `endsWithError` verdict. Both must be returned by the ACTIVE facet and
  // by neither terminal one. Seeded here rather than only in the clause-shape
  // suites because this is the one place in `apps/api/app/agent-sessions` that
  // asserts the IDs a Status filter RETURNS.
  {
    id: "in-org-reconciled-inactive",
    organizationId: ORG_ID,
    status: SESSION_STATUS.ACTIVE,
    endedAtOffsetSeconds: -30,
    lastActivityAtOffsetSeconds: -60,
    endsWithError: false,
  },
  {
    id: "in-org-reconciled-error",
    organizationId: ORG_ID,
    status: SESSION_STATUS.ACTIVE,
    endedAtOffsetSeconds: -30,
    lastActivityAtOffsetSeconds: -60,
    endsWithError: true,
  },
  // Ended, then came back — activity AFTER the end. It must stay in Active: a
  // predicate that subtracts every ended row loses this one entirely while a
  // two-column `lastActivityAt <= sessionEndedAt` arm would still return it,
  // so the two failures are distinguishable here.
  {
    id: "in-org-resumed-active",
    organizationId: ORG_ID,
    status: SESSION_STATUS.ACTIVE,
    endedAtOffsetSeconds: -120,
    lastActivityAtOffsetSeconds: -30,
    endsWithError: null,
  },
];

/**
 * Installs a `sessionDetail` fake whose `findMany`/`count` EXECUTE the predicate
 * the production query builder produced against {@link SEEDED_SESSION_STATUS_ROWS}.
 * `count` reads the same evaluator as `findMany` so the reported total cannot
 * disagree with the page the caller received.
 *
 * ISS-8858: returns the two spies so a caller can assert WHICH read a path took,
 * not only what it answered. A counts read that materialises rows is the defect
 * that ticket exists to remove, and it is invisible to any assertion on the
 * returned number — the number is right either way.
 */
export function installSeededSessionStatusDb(): {
  findMany: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
} {
  // One instant for the whole population, taken per install rather than at
  // module load. Every timestamp below is an offset from it, so the staleness
  // cutoff (computed from `Date.now()` inside the predicate) reads the same
  // clock — a fixed literal would age every row past the cutoff and turn the
  // Active rows Stale as this suite's wall clock moved.
  const seededAt = Date.now();
  const at = (offsetSeconds: number): Date =>
    new Date(seededAt + offsetSeconds * 1000);
  const records = SEEDED_SESSION_STATUS_ROWS.map((row) =>
    buildSessionListRecord({
      artifactId: row.id,
      externalSessionId: `external-${row.id}`,
      sessionEndedAt:
        row.endedAtOffsetSeconds === null ? null : at(row.endedAtOffsetSeconds),
      lastActivityAt: at(row.lastActivityAtOffsetSeconds),
      endsWithError: row.endsWithError,
      artifact: {
        organizationId: row.organizationId,
        name: row.id,
        status: row.status,
        slug: row.id,
        project: null,
        sourceLinks: [],
      },
    })
  );
  const select = (args: { where?: Record<string, unknown> }) =>
    records.filter((record) => matchesSessionWhere(record, args.where ?? {}));
  const findMany = vi.fn((args: { where?: Record<string, unknown> }) =>
    Promise.resolve(select(args))
  );
  const count = vi.fn((args: { where?: Record<string, unknown> }) =>
    Promise.resolve(select(args).length)
  );
  installDb({ sessionDetail: { findMany, count } });
  return { findMany, count };
}

function matchesSessionWhere(
  record: Record<string, unknown>,
  where: Record<string, unknown>
): boolean {
  return Object.entries(where).every(([key, value]) =>
    matchesSessionClause(record, key, value)
  );
}

function matchesSessionClause(
  record: Record<string, unknown>,
  key: string,
  value: unknown
): boolean {
  if (key === "AND") {
    return asClauseList(key, value).every((clause) =>
      matchesSessionWhere(record, clause)
    );
  }
  if (key === "OR") {
    return asClauseList(key, value).some((clause) =>
      matchesSessionWhere(record, clause)
    );
  }
  if (key === "artifact") {
    return matchesArtifactRelation(record, value);
  }
  if (key === "NOT") {
    return !matchesSessionWhere(record, value as Record<string, unknown>);
  }
  if (
    key === "sessionEndedAt" ||
    key === "lastActivityAt" ||
    key === "awaitingInputSince"
  ) {
    return matchesTimestampClause(record, key, value);
  }
  if (key === "endsWithError") {
    return matchesEndsWithErrorClause(record.endsWithError ?? null, value);
  }
  throw new Error(
    `session-status-population: unsupported where key "${key}". Teach the evaluator or use the DB-backed integration harness — silently ignoring it would assert nothing.`
  );
}

function asClauseList(key: string, value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`session-status-population: "${key}" must be an array`);
  }
  return value as Record<string, unknown>[];
}

function matchesArtifactRelation(
  record: Record<string, unknown>,
  value: unknown
): boolean {
  const relation = value as { is?: Record<string, unknown> } | null;
  const is = relation?.is;
  if (!is) {
    throw new Error(
      "session-status-population: only the `artifact: { is: ... }` relation filter is supported"
    );
  }
  const artifact = record.artifact as Record<string, unknown>;
  return Object.entries(is).every(([field, expected]) =>
    matchesArtifactField(artifact[field], field, expected)
  );
}

function matchesArtifactField(
  actual: unknown,
  field: string,
  expected: unknown
): boolean {
  if (typeof expected === "string") {
    return actual === expected;
  }
  const matcher = (expected as { in?: unknown; notIn?: unknown } | null) ?? {};
  if (Array.isArray(matcher.in)) {
    return matcher.in.includes(actual);
  }
  // ISS-8858: the UNKNOWN facet matches by EXCLUSION — it gathers the statuses
  // the display fold does not recognize, which by definition cannot be listed.
  // Reachable here for the first time now that a caller asks every bucket for a
  // count rather than one facet at a time.
  if (Array.isArray(matcher.notIn)) {
    return !matcher.notIn.includes(actual);
  }
  throw new Error(
    `session-status-population: unsupported matcher on artifact.${field} — only a string equality or { in: [...] } / { notIn: [...] } is understood.`
  );
}

/**
 * The SESSION-level timestamp clause shapes this evaluator understands:
 * `null` / `{ not: null }`, `{ lt: Date }` (the ISS-5366 staleness cutoff), and
 * `{ lte | gt: FieldRef }` (a two-column comparison). Kept broader than what
 * the facet emits today so a derived arm that comes back is EXECUTED here
 * rather than throwing.
 *
 * BOOLEAN, not three-valued, and that is only sound because every seeded row
 * carries a real `lastActivityAt`: a `NOT` over a clause SQL would answer NULL
 * negates to `true` here where SQL rejects the row. A missing column THROWS
 * rather than defaulting, so a future seed that drops one cannot quietly take
 * this approximation outside the range where it holds. The three-valued reading
 * lives in the sibling `displayed-status-facet.test-harness.ts`, which evaluates
 * the same predicates over records that DO carry nulls.
 */
function matchesTimestampClause(
  record: Record<string, unknown>,
  key: "sessionEndedAt" | "lastActivityAt" | "awaitingInputSince",
  value: unknown
): boolean {
  const actual = record[key];
  if (actual !== null && !(actual instanceof Date)) {
    throw new Error(
      `session-status-population: row is missing a "${key}" value, so the boolean evaluator cannot answer this clause honestly.`
    );
  }
  if (value === null) {
    return actual === null;
  }
  const filter = value as {
    not?: unknown;
    lt?: unknown;
    lte?: unknown;
    gt?: unknown;
  };
  if (filter.not === null) {
    return actual !== null;
  }
  if (filter.lt instanceof Date) {
    return actual !== null && actual.getTime() < filter.lt.getTime();
  }
  const operator = filter.lte === undefined ? "gt" : "lte";
  const other = resolveSeededFieldRef(record, filter[operator]);
  if (other === undefined) {
    throw new Error(
      `session-status-population: unsupported ${key} clause ${JSON.stringify(value)}`
    );
  }
  if (actual === null || other === null) {
    return false;
  }
  return operator === "lte"
    ? actual.getTime() <= other.getTime()
    : actual.getTime() > other.getTime();
}

/**
 * Resolve a Prisma `FieldRef` against the SAME seeded row. Returns `undefined`
 * (distinct from a `null` column) when the operand is not a field reference at
 * all, so the caller can report an unsupported clause instead of guessing.
 */
function resolveSeededFieldRef(
  record: Record<string, unknown>,
  operand: unknown
): Date | null | undefined {
  if (typeof operand !== "object" || operand === null) {
    return undefined;
  }
  const ref = operand as { modelName?: unknown; name?: unknown };
  if (ref.modelName !== "SessionDetail" || typeof ref.name !== "string") {
    return undefined;
  }
  const referenced = record[ref.name];
  if (referenced === null || referenced instanceof Date) {
    return referenced;
  }
  throw new Error(
    `session-status-population: field reference "${ref.name}" resolves to no timestamp on the seeded row.`
  );
}

/**
 * The nullable `endsWithError` column. A boolean literal is an equality SQL
 * answers NULL for an unset row, so `null` never satisfies
 * `{ endsWithError: false }` — it needs an explicit `{ endsWithError: null }`
 * clause.
 */
function matchesEndsWithErrorClause(actual: unknown, value: unknown): boolean {
  if (value === null) {
    return actual === null;
  }
  if (typeof value === "boolean") {
    return actual === value;
  }
  throw new Error(
    `session-status-population: unsupported endsWithError clause ${JSON.stringify(value)}`
  );
}
