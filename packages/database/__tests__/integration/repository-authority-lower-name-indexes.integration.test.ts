import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../../scripts/seed/__tests__/fixtures/ephemeral-db";
import {
  requireIndexPredicate,
  requireNonEmptyPlan,
  requireRowsRemovedByFilter,
  requireScanNode,
} from "../test-helpers/explain-plan";
import { settleAll } from "../test-helpers/settle-all";

/**
 * ISS-6452 — migration 20260815120000 builds three `lower(<repo full name>)`
 * expression indexes for `readLockedAuthorityRows`
 * (apps/api/app/agent-sessions/service/artifact-links/shared.ts), the
 * repository-authority read that runs inside every desktop session-ingest write
 * transaction.
 *
 * The sibling static test proves the migration's SQL TEXT is what we think it
 * is. It cannot prove the only thing that actually fixes the ticket: that
 * PostgreSQL PICKS these indexes for the real predicates. Two of the three are
 * partial, so the planner has to prove the partial predicate from the query's
 * own clauses before it may use them — on `pull_request_detail` that proof runs
 * through a strict `lower()` under a strict `= ANY(...)`. If that proof failed,
 * or if the planner simply preferred the org-only index, the migration would pay
 * write amplification on three continuously-written tables and fix nothing, and
 * every static assertion would stay green.
 *
 * So this suite runs against a real Postgres with `prisma migrate deploy`
 * applied, and asserts:
 *
 *  1. each index exists with the exact shape the migration declares (`indexdef`);
 *  2. the planner really pushes each `LOWER(...) IN (...)` predicate into it
 *     instead of discarding the rest of the partition with a post-scan filter;
 *  3. the indexes are PLAN-ONLY — each query returns a byte-identical result set
 *     with the index present and with it dropped, for the populated case and for
 *     the all-NULL `head_repository_full_name` case that is today's production
 *     reality for most `pull_request_detail` rows.
 *
 * Rows are written under throwaway organizations and removed in `afterAll`.
 */

const PULL_REQUEST_TABLE = "pull_request_detail";
/**
 * The authority read self-joins `pull_request_detail` (the CTE's scan plus the
 * outer id lookup), so the relation name alone matches two plan nodes and the
 * fail-closed readers correctly refuse to pick one. PostgreSQL disambiguates the
 * two identical `pull_request` aliases by suffixing the second range-table entry,
 * so this targets the CTE's scan — the only one the new index can serve; the
 * outer node is a primary-key lookup no index change affects.
 */
const PULL_REQUEST_CTE_SCAN = "pull_request_detail pull_request_1";
const PUBLIC_REPOSITORY_TABLE = "public_repositories";
const INSTALLATION_REPOSITORY_TABLE = "github_installation_repositories";

const PULL_REQUEST_INDEX =
  "pull_request_detail_org_lower_head_repo_full_name_idx";
const PUBLIC_REPOSITORY_INDEX = "public_repositories_org_lower_full_name_idx";
const INSTALLATION_REPOSITORY_INDEX =
  "github_installation_repositories_inst_lower_full_name_idx";

/**
 * Eleven decoy organizations alongside the one under test, so the org under test
 * is ~8% of each table. The reasoning is the ISS-6104 fixture's: a cost-based
 * planner prefers a sequential scan when the org predicate merely halves a small
 * table, and the plan assertions would then be measuring the fixture instead of
 * the index. Every decoy carries the SAME repository names, so a plan that ever
 * dropped the org/installation scoping would return 12x the rows and fail the
 * equivalence cases outright.
 */
const ORG_ID = randomUUID();
const DECOY_ORG_IDS: readonly string[] = Array.from({ length: 11 }, () =>
  randomUUID()
);
const ALL_ORG_IDS: readonly string[] = [ORG_ID, ...DECOY_ORG_IDS];

/** Independently generated so no id can alias another table's row. */
const BRANCH_ARTIFACT_IDS: ReadonlyMap<string, string> = new Map(
  ALL_ORG_IDS.map((orgId) => [orgId, randomUUID()])
);
const INSTALLATION_IDS: ReadonlyMap<string, string> = new Map(
  ALL_ORG_IDS.map((orgId) => [orgId, randomUUID()])
);

/** Per-org row counts, sized to the shape the migration's EXPLAIN was measured at. */
const PULL_REQUESTS_PER_ORG = 4000;
const INSTALLATION_REPOSITORIES_PER_ORG = 900;
const PUBLIC_REPOSITORIES_PER_ORG = 600;

/** Distinct head-repository names a PR row can carry, before lowercasing. */
const HEAD_REPOSITORY_NAME_CARDINALITY = 400;

/**
 * The names the ingest asks for. `collectNormalizedRepositoryNames` lowercases
 * via `normalizeRepoFullName`, while the stored columns keep provider casing —
 * which is the whole reason the predicate is function-wrapped.
 */
const REQUESTED_PR_NAMES: readonly string[] = [
  "acme/repo-1",
  "acme/repo-2",
  "acme/repo-3",
];
const REQUESTED_REPO_NAMES: readonly string[] = [
  "acme/gh-repo-1",
  "acme/gh-repo-2",
  "acme/gh-repo-3",
];
const REQUESTED_PUBLIC_NAMES: readonly string[] = [
  "acme/pub-1",
  "acme/pub-2",
  "acme/pub-3",
];

/**
 * Upper bound on rows a scan may discard after the fact. The healthy plans push
 * the name predicate into the index, so the only post-scan filter left is the
 * authority-column OR-chain over the handful of matching rows. Before the index,
 * the `pull_request_detail` scan discarded ~3,973 — the org's whole partition.
 */
const MAX_ROWS_REMOVED_BY_FILTER = 64;

type IdRow = { id: string };

describe.skipIf(!process.env.DATABASE_URL)(
  "ISS-6452 repository-authority lower(full_name) indexes (integration)",
  () => {
    let ctx: EphemeralDbContext;

    beforeAll(async () => {
      ctx = await setupEphemeralDb();
      await seedAuthoritySources(ctx);
    }, 180_000);

    afterAll(async () => {
      if (!ctx) {
        return;
      }
      // `setupEphemeralDb` opens a PrismaClient and a pg.Pool against the SHARED
      // database, so a failing cleanup step must not leak either for the rest of
      // the run. `settleAll` runs every step and surfaces all their errors,
      // rather than `finally` replacing the first error with the teardown's.
      await settleAll(
        [
          () =>
            ctx.prisma.$executeRawUnsafe(
              `DELETE FROM "${PULL_REQUEST_TABLE}" WHERE "organization_id" = ANY($1::uuid[])`,
              [...ALL_ORG_IDS]
            ),
          () =>
            ctx.prisma.$executeRawUnsafe(
              `DELETE FROM "${PUBLIC_REPOSITORY_TABLE}" WHERE "organization_id" = ANY($1::uuid[])`,
              [...ALL_ORG_IDS]
            ),
          () =>
            ctx.prisma.$executeRawUnsafe(
              `DELETE FROM "${INSTALLATION_REPOSITORY_TABLE}" WHERE "installation_id" IN (
                 SELECT "id" FROM "github_installations" WHERE "organization_id" = ANY($1::uuid[])
               )`,
              [...ALL_ORG_IDS]
            ),
          () =>
            ctx.prisma.$executeRawUnsafe(
              'DELETE FROM "github_installations" WHERE "organization_id" = ANY($1::uuid[])',
              [...ALL_ORG_IDS]
            ),
          () =>
            ctx.prisma.$executeRawUnsafe(
              'DELETE FROM "artifacts" WHERE "organization_id" = ANY($1::uuid[])',
              [...ALL_ORG_IDS]
            ),
          () =>
            ctx.prisma.$executeRawUnsafe(
              'DELETE FROM "organizations" WHERE "id" = ANY($1::uuid[])',
              [...ALL_ORG_IDS]
            ),
          () => teardownEphemeralDb(ctx),
        ],
        "ISS-6452 authority index suite teardown failed"
      );
    }, 180_000);

    it("migration 20260815120000 built a PARTIAL expression index on pull_request_detail", async () => {
      const def = await indexDefinition(
        ctx,
        PULL_REQUEST_TABLE,
        PULL_REQUEST_INDEX
      );

      // Column order is load-bearing: organization_id must lead so the index
      // serves the org-scoped equality prefix before the name lookup.
      expect(def).toContain(
        "(organization_id, lower(head_repository_full_name))"
      );
      // Partial, so the index stays small while nearly every row's
      // head_repository_full_name is still NULL (the column landed in ISS-5826).
      expect(def).toContain("WHERE (head_repository_full_name IS NOT NULL)");
      expect(def).not.toContain("UNIQUE");
    });

    it("migration 20260815120000 built a TOTAL expression index on public_repositories", async () => {
      const def = await indexDefinition(
        ctx,
        PUBLIC_REPOSITORY_TABLE,
        PUBLIC_REPOSITORY_INDEX
      );

      expect(def).toContain("(organization_id, lower(full_name))");
      // full_name is NOT NULL here, so there is nothing for a partial predicate
      // to exclude — an added WHERE would be dead weight, not a size win.
      expect(def).not.toContain("WHERE");
      expect(def).not.toContain("UNIQUE");
    });

    it("migration 20260815120000 built an installation-scoped PARTIAL expression index", async () => {
      const def = await indexDefinition(
        ctx,
        INSTALLATION_REPOSITORY_TABLE,
        INSTALLATION_REPOSITORY_INDEX
      );

      // installation_id leads even though the query never filters it directly:
      // it is bound from the joined installation row. Dropping it regresses the
      // plan to a BitmapAnd that touches other tenants' rows before the join.
      expect(def).toContain("(installation_id, lower(full_name))");
      expect(def).toContain("WHERE (removed_at IS NULL)");
      expect(def).not.toContain("UNIQUE");
    });

    it("pushes the pull_request_detail name predicate into the index instead of scanning the org partition", async () => {
      const plan = await explain(ctx, PULL_REQUEST_AUTHORITY_SQL, [
        ORG_ID,
        [...REQUESTED_PR_NAMES],
      ]);

      expect(plan).toContain(PULL_REQUEST_INDEX);
      // Both reads are scoped to the CTE's own scan node. Reading them off the
      // whole plan would bind them to whichever node sorts first.
      const indexCond = requireIndexPredicate(plan, PULL_REQUEST_CTE_SCAN);
      expect(indexCond).toContain("organization_id");
      expect(indexCond).toContain("lower(head_repository_full_name)");
      // The scan must not walk the org's whole PR partition. The healthy plan
      // DOES report this metric — the fixture seeds name-matching rows that carry
      // no authority snapshot, so the OR-chain discards a handful of them — which
      // means its absence signals a different plan ran, and
      // `requireRowsRemovedByFilter` throws rather than reading zero from a line
      // that was never printed. Before the index this node discarded ~3,973.
      expect(
        requireRowsRemovedByFilter(requireScanNode(plan, PULL_REQUEST_CTE_SCAN))
      ).toBeLessThanOrEqual(MAX_ROWS_REMOVED_BY_FILTER);
    });

    it("pushes the public_repositories name predicate into the index", async () => {
      const plan = await explain(ctx, PUBLIC_REPOSITORY_AUTHORITY_SQL, [
        ORG_ID,
        [...REQUESTED_PUBLIC_NAMES],
      ]);

      expect(plan).toContain(PUBLIC_REPOSITORY_INDEX);
      const indexCond = requireIndexPredicate(plan, PUBLIC_REPOSITORY_TABLE);
      expect(indexCond).toContain("organization_id");
      expect(indexCond).toContain("lower(full_name)");
    });

    it("pushes the installation-repository name predicate into the index alongside installation_id", async () => {
      const plan = await explain(ctx, INSTALLATION_REPOSITORY_AUTHORITY_SQL, [
        ORG_ID,
        [...REQUESTED_REPO_NAMES],
      ]);

      expect(plan).toContain(INSTALLATION_REPOSITORY_INDEX);
      const indexCond = requireIndexPredicate(
        plan,
        INSTALLATION_REPOSITORY_TABLE
      );
      // Both columns in one Index Cond is the whole point of leading with
      // installation_id — a name-only index degrades to a BitmapAnd here.
      expect(indexCond).toContain("installation_id");
      expect(indexCond).toContain("lower(full_name)");
    });

    it.each([
      {
        label: "pull_request_detail",
        sql: PULL_REQUEST_AUTHORITY_SQL,
        index: PULL_REQUEST_INDEX,
        names: REQUESTED_PR_NAMES,
      },
      {
        label: "public_repositories",
        sql: PUBLIC_REPOSITORY_AUTHORITY_SQL,
        index: PUBLIC_REPOSITORY_INDEX,
        names: REQUESTED_PUBLIC_NAMES,
      },
      {
        label: "github_installation_repositories",
        sql: INSTALLATION_REPOSITORY_AUTHORITY_SQL,
        index: INSTALLATION_REPOSITORY_INDEX,
        names: REQUESTED_REPO_NAMES,
      },
    ])("$label returns an identical non-empty result set with and without the index", async ({
      sql,
      index,
      names,
    }) => {
      const { withIndex, withoutIndex } = await compareWithAndWithoutIndex(
        ctx,
        sql,
        index,
        [...names]
      );

      // Non-empty matters: an equivalence check over two empty sets proves
      // nothing about whether the partial index can hide a matching row.
      expect(withIndex.length).toBeGreaterThan(0);
      expect(withIndex).toEqual(withoutIndex);
    });

    it("returns an identical empty result set for a head repository nobody has recorded", async () => {
      // The all-NULL / no-match state most pull_request_detail rows are in today.
      // Guards the partial predicate from the other side: the honest answer is
      // the empty set, and it must stay the empty set rather than becoming
      // unreachable rows the index quietly excluded.
      const { withIndex, withoutIndex } = await compareWithAndWithoutIndex(
        ctx,
        PULL_REQUEST_AUTHORITY_SQL,
        PULL_REQUEST_INDEX,
        ["acme/never-recorded"]
      );

      expect(withIndex).toEqual([]);
      expect(withIndex).toEqual(withoutIndex);
    });
  }
);

/**
 * The three predicates from `readLockedAuthorityRows`
 * (apps/api/app/agent-sessions/service/artifact-links/shared.ts). The WHERE
 * clauses, the CTE, the window, and `FOR SHARE` are verbatim, because those are
 * what the plan is being asserted about; the SELECT lists are trimmed to `id`,
 * which changes no scan node and keeps the fixture readable.
 */
const PULL_REQUEST_AUTHORITY_SQL = `WITH candidate_authorities AS (
  SELECT
    pull_request.id,
    COALESCE(
      pull_request.head_repository_default_branch_event_at,
      pull_request.head_repository_default_branch_observed_at
    ) AS authority_at,
    MAX(COALESCE(
      pull_request.head_repository_default_branch_event_at,
      pull_request.head_repository_default_branch_observed_at
    )) OVER (
      PARTITION BY LOWER(pull_request.head_repository_full_name)
    ) AS latest_authority_at
  FROM pull_request_detail pull_request
  WHERE pull_request.organization_id = $1::uuid
    AND LOWER(pull_request.head_repository_full_name) = ANY($2::text[])
    AND (
      pull_request.head_repository_default_branch_name IS NOT NULL
      OR pull_request.head_repository_default_branch_availability IS NOT NULL
      OR pull_request.head_repository_default_branch_completeness IS NOT NULL
      OR pull_request.head_repository_default_branch_reason IS NOT NULL
      OR pull_request.head_repository_default_branch_source IS NOT NULL
      OR pull_request.head_repository_default_branch_mechanism IS NOT NULL
      OR pull_request.head_repository_default_branch_trigger IS NOT NULL
      OR pull_request.head_repository_default_branch_credential_type IS NOT NULL
      OR pull_request.head_repository_default_branch_credential_owner_id IS NOT NULL
      OR pull_request.head_repository_default_branch_observation_key IS NOT NULL
      OR pull_request.head_repository_default_branch_observed_at IS NOT NULL
      OR pull_request.head_repository_default_branch_event_at IS NOT NULL
    )
)
SELECT pull_request.id::text AS id
FROM pull_request_detail pull_request
INNER JOIN candidate_authorities candidate
  ON candidate.id = pull_request.id
WHERE candidate.authority_at IS NULL
  OR candidate.authority_at = candidate.latest_authority_at
FOR SHARE OF pull_request`;

const PUBLIC_REPOSITORY_AUTHORITY_SQL = `SELECT repository.id::text AS id
FROM public_repositories repository
WHERE repository.organization_id = $1::uuid
  AND LOWER(repository.full_name) = ANY($2::text[])
FOR SHARE OF repository`;

const INSTALLATION_REPOSITORY_AUTHORITY_SQL = `SELECT repository.id::text AS id
FROM github_installation_repositories repository
INNER JOIN github_installations installation
  ON installation.id = repository.installation_id
WHERE installation.organization_id = $1::uuid
  AND installation.status = 'ACTIVE'::"GitHubInstallationStatus"
  AND repository.removed_at IS NULL
  AND LOWER(repository.full_name) = ANY($2::text[])
FOR SHARE OF repository, installation`;

/** The same predicate ordered by id, so equivalence is a plain deep equality. */
function orderedById(sql: string): string {
  const [body, lockClause] = splitLockClause(sql);
  return `${body}\nORDER BY id\n${lockClause}`;
}

/**
 * `FOR SHARE` must stay the last clause, so the ORDER BY is spliced in ahead of
 * it rather than appended.
 */
function splitLockClause(sql: string): [string, string] {
  const at = sql.lastIndexOf("FOR SHARE OF");
  return [sql.slice(0, at).trimEnd(), sql.slice(at)];
}

async function indexDefinition(
  ctx: EphemeralDbContext,
  table: string,
  index: string
): Promise<string> {
  const rows = await ctx.prisma.$queryRawUnsafe<{ indexdef: string }[]>(
    "SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2",
    table,
    index
  );
  if (rows.length !== 1) {
    throw new Error(
      `Expected exactly one pg_indexes row for "${index}" on "${table}", found ${rows.length}. The migration did not build it, or built it under another name.`
    );
  }
  return rows[0].indexdef;
}

async function explain(
  ctx: EphemeralDbContext,
  sql: string,
  args: readonly unknown[]
): Promise<string> {
  const rows = await ctx.prisma.$queryRawUnsafe<Record<string, string>[]>(
    `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${sql}`,
    ...args
  );
  return requireNonEmptyPlan(
    rows.map((row) => Object.values(row)[0]).join("\n"),
    `EXPLAIN of the repository-authority read for args=${JSON.stringify(args)}`
  );
}

/**
 * Run a predicate twice inside one transaction — once as the migrated database
 * plans it, then again with the index dropped — and roll back so the index
 * survives for the next case. `DROP INDEX` is transactional in PostgreSQL, which
 * is what makes a real before/after comparison possible inside a test.
 */
async function compareWithAndWithoutIndex(
  ctx: EphemeralDbContext,
  sql: string,
  index: string,
  names: readonly string[]
): Promise<{ withIndex: IdRow[]; withoutIndex: IdRow[] }> {
  const ordered = orderedById(sql);
  const args = [ORG_ID, [...names]];
  let captured: { withIndex: IdRow[]; withoutIndex: IdRow[] } | null = null;

  try {
    await ctx.prisma.$transaction(
      async (tx) => {
        const withIndex = await tx.$queryRawUnsafe<IdRow[]>(ordered, ...args);
        await tx.$executeRawUnsafe(`DROP INDEX "${index}"`);
        const withoutIndex = await tx.$queryRawUnsafe<IdRow[]>(
          ordered,
          ...args
        );
        captured = { withIndex, withoutIndex };
        throw new RollbackSignal();
      },
      { timeout: 60_000 }
    );
  } catch (error) {
    // Anything other than our own sentinel is a real failure — most usefully the
    // DROP INDEX erroring because the migration never built the index.
    if (!(error instanceof RollbackSignal)) {
      throw error;
    }
  }

  if (captured === null) {
    throw new Error(
      `compareWithAndWithoutIndex: the comparison transaction never captured a result for index "${index}"`
    );
  }
  return captured;
}

async function seedAuthoritySources(ctx: EphemeralDbContext): Promise<void> {
  for (const orgId of ALL_ORG_IDS) {
    await ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "organizations" ("id", "clerk_id", "name", "slug", "updated_at")
       VALUES ($1::uuid, $2, $2, $2, now())`,
      orgId,
      `iss6452-${orgId}`
    );
    await ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "artifacts" ("id", "organization_id", "type", "name", "status", "updated_at")
       VALUES ($1::uuid, $2::uuid, 'BRANCH'::"ArtifactType", $3, 'active', now())`,
      branchArtifactId(orgId),
      orgId,
      `iss6452-branch-${orgId}`
    );
    await ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "github_installations"
         ("id", "organization_id", "installation_id", "account_login", "account_type",
          "account_id", "sender_login", "sender_id", "status", "updated_at")
       VALUES ($1::uuid, $2::uuid, $3, $3, 'Organization', $3, $3, $3,
               'ACTIVE'::"GitHubInstallationStatus", now())`,
      installationId(orgId),
      orgId,
      `iss6452-${orgId}`
    );

    await seedPullRequests(ctx, orgId);
    await seedInstallationRepositories(ctx, orgId);
    await seedPublicRepositories(ctx, orgId);
  }

  await ctx.prisma.$executeRawUnsafe(`ANALYZE ${PULL_REQUEST_TABLE}`);
  await ctx.prisma.$executeRawUnsafe(
    `ANALYZE ${INSTALLATION_REPOSITORY_TABLE}`
  );
  await ctx.prisma.$executeRawUnsafe(`ANALYZE ${PUBLIC_REPOSITORY_TABLE}`);
  await ctx.prisma.$executeRawUnsafe("ANALYZE github_installations");
}

/**
 * Three row classes, all of which exist in production and each of which the
 * assertions depend on:
 *
 *  - `g % 7 = 0` — no head-repository snapshot at all, the shape of every row
 *    written before ISS-5826 added the column. These are what the PARTIAL index
 *    excludes, so the fixture must contain them or the partial predicate is
 *    never exercised.
 *  - `g % 11 = 0` — a head repository name but NO default-branch authority, so
 *    the row clears the index predicate and is then discarded by the authority
 *    OR-chain. This is what makes `Rows Removed by Filter` present and small on
 *    the healthy plan; without it the metric is absent and the bound cannot be
 *    read at all.
 *  - the rest — name plus authority, the rows the read actually returns.
 */
async function seedPullRequests(
  ctx: EphemeralDbContext,
  orgId: string
): Promise<void> {
  await ctx.prisma.$executeRawUnsafe(
    `INSERT INTO "${PULL_REQUEST_TABLE}"
       ("id", "organization_id", "branch_artifact_id", "number",
        "head_repository_full_name", "head_repository_default_branch_name",
        "head_repository_default_branch_observed_at")
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, g,
            CASE WHEN g % 7 = 0 THEN NULL
                 ELSE 'Acme/Repo-' || (g % $3::int)::text END,
            CASE WHEN g % 7 = 0 OR g % 11 = 0 THEN NULL ELSE 'main' END,
            CASE WHEN g % 7 = 0 OR g % 11 = 0 THEN NULL ELSE now() END
     FROM generate_series(1, $4::int) AS g`,
    orgId,
    branchArtifactId(orgId),
    HEAD_REPOSITORY_NAME_CARDINALITY,
    PULL_REQUESTS_PER_ORG
  );
}

/** Two percent tombstoned, so the `removed_at IS NULL` partial predicate matters. */
async function seedInstallationRepositories(
  ctx: EphemeralDbContext,
  orgId: string
): Promise<void> {
  await ctx.prisma.$executeRawUnsafe(
    `INSERT INTO "${INSTALLATION_REPOSITORY_TABLE}"
       ("id", "installation_id", "github_repo_id", "full_name", "name", "owner",
        "private", "removed_at", "updated_at")
     SELECT gen_random_uuid(), $1::uuid, 'gh-' || g::text,
            'Acme/GH-Repo-' || g::text, 'GH-Repo-' || g::text, 'Acme', false,
            CASE WHEN g % 50 = 0 THEN now() ELSE NULL END, now()
     FROM generate_series(1, $2::int) AS g`,
    installationId(orgId),
    INSTALLATION_REPOSITORIES_PER_ORG
  );
}

async function seedPublicRepositories(
  ctx: EphemeralDbContext,
  orgId: string
): Promise<void> {
  await ctx.prisma.$executeRawUnsafe(
    `INSERT INTO "${PUBLIC_REPOSITORY_TABLE}"
       ("id", "organization_id", "github_repo_id", "full_name", "owner", "name",
        "html_url", "updated_at")
     SELECT gen_random_uuid(), $1::uuid, 'gh-' || g::text,
            'Acme/Pub-' || g::text, 'Acme', 'Pub-' || g::text,
            'https://example.test/acme/pub-' || g::text, now()
     FROM generate_series(1, $2::int) AS g`,
    orgId,
    PUBLIC_REPOSITORIES_PER_ORG
  );
}

function branchArtifactId(orgId: string): string {
  return requireChildId(BRANCH_ARTIFACT_IDS, orgId, "branch artifact");
}

function installationId(orgId: string): string {
  return requireChildId(INSTALLATION_IDS, orgId, "installation");
}

function requireChildId(
  ids: ReadonlyMap<string, string>,
  orgId: string,
  kind: string
): string {
  const id = ids.get(orgId);
  if (!id) {
    throw new Error(`No ${kind} id was allocated for organization ${orgId}`);
  }
  return id;
}

/** Sentinel used to roll back the drop-the-index comparison transaction. */
class RollbackSignal extends Error {
  constructor() {
    super("iss6452: intentional rollback");
    this.name = "RollbackSignal";
  }
}
