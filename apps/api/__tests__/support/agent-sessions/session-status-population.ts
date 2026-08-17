import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { vi } from "vitest";
import { buildSessionListRecord, installDb } from "./service.test-harness";

/**
 * ISS-4985: a seeded session population plus a NARROW evaluator for the
 * `where` the Status facet builds, so a facet test can assert the IDs a filter
 * RETURNS instead of the Prisma argument it constructed.
 *
 * Why this exists (wongk, #4737). The sibling facet tests mock `findMany` to
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
}[] = [
  {
    id: "in-org-inactive",
    organizationId: ORG_ID,
    status: SESSION_STATUS.INACTIVE,
  },
  { id: "in-org-error", organizationId: ORG_ID, status: SESSION_STATUS.ERROR },
  {
    id: "in-org-active",
    organizationId: ORG_ID,
    status: SESSION_STATUS.ACTIVE,
  },
  {
    id: "other-org-inactive",
    organizationId: OTHER_ORG_ID,
    status: SESSION_STATUS.INACTIVE,
  },
];

/**
 * Installs a `sessionDetail` fake whose `findMany`/`count` EXECUTE the predicate
 * the production query builder produced against {@link SEEDED_SESSION_STATUS_ROWS}.
 * `count` reads the same evaluator as `findMany` so the reported total cannot
 * disagree with the page the caller received.
 */
export function installSeededSessionStatusDb(): void {
  const records = SEEDED_SESSION_STATUS_ROWS.map((row) =>
    buildSessionListRecord({
      artifactId: row.id,
      externalSessionId: `external-${row.id}`,
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
  installDb({
    sessionDetail: {
      findMany: vi.fn((args: { where?: Record<string, unknown> }) =>
        Promise.resolve(select(args))
      ),
      count: vi.fn((args: { where?: Record<string, unknown> }) =>
        Promise.resolve(select(args).length)
      ),
    },
  });
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
  const inList = (expected as { in?: unknown } | null)?.in;
  if (Array.isArray(inList)) {
    return inList.includes(actual);
  }
  throw new Error(
    `session-status-population: unsupported matcher on artifact.${field} — only a string equality or { in: [...] } is understood.`
  );
}
