import { ArtifactType } from "@repo/api/src/types/artifact";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { chunksOf } from "@/lib/chunks-of";
import {
  branchOwnerSeedCandidateSql,
  branchOwnerSeedOwnerLateralSql,
} from "./branch-owner-seed-sql";

/**
 * ISS-12463 (operator ruling 2026-10-16, option 1): a branch's Owner is its
 * assignee, seeded ONCE from the Owner chain `branchOwnerSeedOwnerLateralSql`
 * resolves, and only while the branch holds no assignee. Later evidence never
 * moves a seeded assignee, and no system path overwrites one.
 *
 * Raw SQL so `updated_at` is not bumped; no activity receipt and no assignment
 * notification (PLN-2192 AC-006). The seeded person must be a non-shadow user of
 * the branch's own organization (AC-005); inactive users and tombstoned
 * branches are allowed (PLN-2192 design decisions).
 *
 * Returns the number of branches stamped.
 */
export async function seedBranchOwners(
  tx: TransactionClient,
  organizationId: string,
  branchIds: readonly string[]
): Promise<number> {
  const ids = [...new Set(branchIds)];
  let stamped = 0;
  for (const chunk of chunksOf(ids, BRANCH_OWNER_SEED_CHUNK_SIZE)) {
    // SKIP LOCKED: callers reach this holding branch_detail row locks, while
    // other writers (POST /artifact-links/branches) lock artifacts before
    // branch_detail, so waiting here can deadlock (PR #8890 review). A row held
    // elsewhere stays NULL and is seeded on the branch's next ingest or upsert,
    // each of which re-runs this, or by the C4 backfill; set-if-NULL makes a
    // late seed equivalent to an on-time one. Rows this transaction already
    // locks are not skipped.
    //
    // The owners reach the UPDATE as one id-keyed map rather than a join: a
    // join of the target against the page lets stale statistics rescan the
    // organization's branches once per seeded row (ISS-12463 C6). A row
    // skipped above has no key in the map, so it is never written.
    stamped += await tx.$executeRaw(Prisma.sql`
      WITH locked AS MATERIALIZED (
        SELECT l.id, l.organization_id
        FROM artifacts l
        WHERE l.organization_id = ${organizationId}::uuid
          AND l.id = ANY(${chunk}::uuid[])
          AND l.type = ${ArtifactType.Branch}::"ArtifactType"
          AND l.assignee_id IS NULL
        FOR NO KEY UPDATE SKIP LOCKED
      ),
      seed AS MATERIALIZED (
        SELECT jsonb_object_agg(a.id, branch_owner.user_id) AS owners
        FROM locked a
        ${branchOwnerSeedOwnerLateralSql()}
      )
      UPDATE artifacts t
      SET assignee_id = ((SELECT owners FROM seed) ->> t.id::text)::uuid
      WHERE t.organization_id = ${organizationId}::uuid
        AND t.id = ANY(${chunk}::uuid[])
        AND t.type = ${ArtifactType.Branch}::"ArtifactType"
        AND t.assignee_id IS NULL
        AND ((SELECT owners FROM seed) ->> t.id::text) IS NOT NULL
    `);
  }
  return stamped;
}

/**
 * ISS-12463 (PLN-2192 T-1.2, AC-008): a GitHub connection created for, or
 * re-bound to, `login` can make the commit-author and PR-creator rungs resolve
 * on branches no branch write will revisit. Seeds every unassigned branch of the
 * org whose Owner chain resolves to that login's user, a page at a time by id,
 * each page in its own transaction; the write is `seedBranchOwners`, so a branch
 * row held elsewhere is skipped rather than waited on, and its next evidence
 * write re-seeds it.
 *
 * Returns the number of branches stamped. A failed page rejects with a
 * `BranchOwnerLoginSeedError` carrying what the pages before it committed.
 */
export async function seedBranchOwnersForLogin(
  organizationId: string,
  login: string
): Promise<number> {
  if (login === "") {
    return 0;
  }
  let stamped = 0;
  let pagesCommitted = 0;
  let after: string | null = null;
  let pageSize: number;
  do {
    const cursor: string | null = after;
    let page: { ids: string[]; stamped: number };
    try {
      page = await withDb.tx(async (tx) => {
        const ids = await readLoginSeedCandidatePage(
          tx,
          organizationId,
          login,
          cursor
        );
        return {
          ids,
          stamped: await seedBranchOwners(tx, organizationId, ids),
        };
      });
    } catch (error) {
      throw new BranchOwnerLoginSeedError(error, { pagesCommitted, stamped });
    }
    pagesCommitted += 1;
    stamped += page.stamped;
    pageSize = page.ids.length;
    after = page.ids.at(-1) ?? after;
  } while (pageSize === BRANCH_OWNER_SEED_CHUNK_SIZE);
  return stamped;
}

/**
 * The next page, by id after `after`, of unassigned branches whose Owner chain
 * resolves to the user `login` is connected as. A user holds one connection per
 * org, so the commit-author and PR-creator rungs reach that user only through
 * `login`, and the commit/PR `EXISTS` holds for every resolution this
 * connection can create; it keeps the lateral off the org's other branches.
 * Commits are org-scoped through their branch, not
 * `commit_detail.organization_id` (PRD-510 D4), as the rung-2 lateral is.
 */
async function readLoginSeedCandidatePage(
  tx: TransactionClient,
  organizationId: string,
  login: string,
  after: string | null
): Promise<string[]> {
  const afterSql =
    after === null ? Prisma.empty : Prisma.sql`AND a.id > ${after}::uuid`;
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT seed.id
    FROM (${branchOwnerSeedCandidateSql(Prisma.sql`
      a.organization_id = ${organizationId}::uuid
      ${afterSql}
      AND (
        EXISTS (
          SELECT 1 FROM commit_detail c
          WHERE c.branch_artifact_id = a.id AND c.author_login = ${login}
        )
        OR EXISTS (
          SELECT 1 FROM pull_request_detail pr
          WHERE pr.organization_id = a.organization_id
            AND pr.branch_artifact_id = a.id
            AND pr.author_login = ${login}
        )
      )
    `)}) seed
    WHERE seed.user_id = ANY(ARRAY(
      SELECT gc.user_id FROM github_user_connections gc
      WHERE gc.organization_id = ${organizationId}::uuid
        AND gc.login = ${login}
    ))
    ORDER BY seed.id
    LIMIT ${BRANCH_OWNER_SEED_CHUNK_SIZE}
  `);
  return rows.map((row) => row.id);
}

/**
 * Ids bind as one `uuid[]`, so this bounds rows locked per statement, not bind
 * parameters; it is also the page size of `seedBranchOwnersForLogin`.
 */
const BRANCH_OWNER_SEED_CHUNK_SIZE = 500;

/**
 * A `seedBranchOwnersForLogin` page failed. Each page commits on its own, so the
 * pages before it stay stamped; the message is the cause's.
 */
export class BranchOwnerLoginSeedError extends Error {
  readonly pagesCommitted: number;
  readonly stamped: number;

  constructor(
    cause: unknown,
    progress: { pagesCommitted: number; stamped: number }
  ) {
    super(parseError(cause), { cause });
    this.name = "BranchOwnerLoginSeedError";
    this.pagesCommitted = progress.pagesCommitted;
    this.stamped = progress.stamped;
  }
}
