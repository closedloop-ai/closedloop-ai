import { Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { seedOwnerOrderingCorpus } from "@/__tests__/support/branches/branch-owner-seed-ordering.test-fixtures";
import {
  corpusMigrationSql,
  migrationWithCeiling,
} from "@/__tests__/support/branches/iss12463-branch-owner-backfill-migration.test-helpers";
import {
  FIRST_PUSHED_AT,
  GIT_PUSH_METHOD,
  HAS_DATABASE,
  seedBranch,
  seedCommit,
  seedEvidenceLink,
  seedGitHubConnection,
  seedPullRequestDetail,
} from "@/__tests__/utils/branch-identity-sql-fixture";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { GITHUB_SHADOW_CLERK_PREFIX } from "@/app/comments/github-shadow-identity";
import { branchOwnerSeedCandidateSql } from "./branch-owner-seed-sql";

/**
 * ISS-12463 / PLN-2192 T-3.4: what the branch Owner backfill stamps, against
 * real Postgres, by executing the SHIPPED migration file.
 *
 * Lives in apps/api rather than packages/database because the parity case
 * needs `branchOwnerSeedCandidateSql`, and packages/database cannot import
 * apps/api. The fixture is committed (the held-row case needs a second
 * connection to see it); every migration run happens inside a transaction on
 * `client` that is rolled back, so nothing it writes survives the case, and is
 * scoped to the case's own organization (`corpusMigrationSql`), so it never
 * locks or stamps another suite's branches.
 */
describe.skipIf(!HAS_DATABASE)("ISS-12463 branch Owner backfill", () => {
  const organizations = createCommittedTestOrganizationTracker();
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: keys().DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.removeAllListeners("notice");
    await organizations.cleanup();
  });

  it("stamps exactly the (branch, user) pairs branchOwnerSeedCandidateSql selects", async () => {
    const corpus = await seedCorpus(organizations);
    await client.query("BEGIN");
    const expected = await readCandidates(client, corpus.branchIds);
    // Pinned by hand so the parity below runs over a corpus whose ordering
    // clauses decide owners, not over one that would agree under any order.
    expect(expected).toEqual(corpus.expected);

    await client.query(corpusMigrationSql(corpus.organizationId));

    const after = await readAssignees(client, corpus.branchIds);
    const stamped = new Map(
      [...after].filter(([id, assignee]) => assignee !== corpus.before.get(id))
    );
    expect(stamped).toEqual(expected);
  });

  it("seeds the pusher, the earliest commit author and the PR creator, and leaves updated_at alone", async () => {
    const corpus = await seedCorpus(organizations);
    await client.query("BEGIN");
    const updatedBefore = await readUpdatedAt(client, corpus.branchIds);

    await client.query(corpusMigrationSql(corpus.organizationId));

    const after = await readAssignees(client, corpus.branchIds);
    expect(after.get(corpus.pushed)).toBe(corpus.pusher);
    expect(after.get(corpus.committed)).toBe(corpus.committer);
    expect(after.get(corpus.pullRequested)).toBe(corpus.prAuthor);
    expect(await readUpdatedAt(client, corpus.branchIds)).toEqual(
      updatedBefore
    );
  });

  it("is idempotent: a second run selects nothing", async () => {
    const corpus = await seedCorpus(organizations);
    const notices = captureNotices(client);
    await client.query("BEGIN");

    await client.query(corpusMigrationSql(corpus.organizationId));
    await client.query(corpusMigrationSql(corpus.organizationId));

    expect(notices.at(-2)).not.toMatch(SELECTED_NOTHING_RE);
    expect(notices.at(-1)).toMatch(SELECTED_NOTHING_RE);
  });

  it("raises the ceiling in the pre-flight, before any write", async () => {
    const corpus = await seedCorpus(organizations);
    // SHARE admits every read but no UPDATE of artifacts, so a write reached
    // before the ceiling check would wait into lock_timeout instead of raising.
    const holder = await holdLock("LOCK TABLE artifacts IN SHARE MODE");
    try {
      await client.query("BEGIN");
      await client.query("SAVEPOINT before_ceiling");

      await expect(
        client.query(migrationWithCeiling(TEST_CEILING, corpus.organizationId))
      ).rejects.toThrow(CEILING_RE);
      await client.query("ROLLBACK TO SAVEPOINT before_ceiling");
    } finally {
      await releaseLock(holder);
    }

    expect(await readAssignees(client, corpus.branchIds)).toEqual(
      corpus.before
    );
  });

  it("skips a branch row a live transaction holds through every pass, and stamps the rest", async () => {
    const corpus = await seedCorpus(organizations);
    const holder = await holdBranchRow(corpus.pushed);
    try {
      const notices = captureNotices(client);
      await client.query("BEGIN");

      await client.query(corpusMigrationSql(corpus.organizationId));

      const after = await readAssignees(client, corpus.branchIds);
      expect(after.get(corpus.pushed)).toBeNull();
      expect(after.get(corpus.committed)).toBe(corpus.committer);
      expect(after.get(corpus.pullRequested)).toBe(corpus.prAuthor);
      expect(notices.at(-1)).toMatch(ONE_SKIPPED_RE);
    } finally {
      await releaseLock(holder);
    }
  });

  it("stamps a branch row released after the main pass on a retry pass", async () => {
    const corpus = await seedCorpus(organizations);
    const holder = await holdBranchRow(corpus.pushed);
    const notices = captureNotices(client);
    await client.query("BEGIN");
    const pid = await backendPid(client);

    const migration = client.query(corpusMigrationSql(corpus.organizationId));
    try {
      await waitForRetrySleep(pid);
    } finally {
      await releaseLock(holder);
    }
    await migration;

    const after = await readAssignees(client, corpus.branchIds);
    expect(after.get(corpus.pushed)).toBe(corpus.pusher);
    expect(notices.at(-1)).toMatch(ONE_RETRIED_RE);
  });
});

type OrganizationTracker = ReturnType<
  typeof createCommittedTestOrganizationTracker
>;

type Corpus = {
  organizationId: string;
  branchIds: string[];
  /** Every fixture branch's assignee before the migration runs. */
  before: Map<string, string | null>;
  /** Every branch the migration must stamp, and with whom. */
  expected: Map<string, string>;
  pushed: string;
  committed: string;
  pullRequested: string;
  pusher: string;
  committer: string;
  prAuthor: string;
};

/**
 * One branch per rung, one per exclusion, one already assigned, and the
 * ordering corpus (`seedOwnerOrderingCorpus`), in one org, so every case reads
 * the same fixture and the parity case covers each.
 */
async function seedCorpus(organizations: OrganizationTracker): Promise<Corpus> {
  const organizationId = await organizations.create();
  const otherOrganizationId = await organizations.create();
  const [pusher, committer, prAuthor, existingAssignee, shadowUser] =
    await Promise.all([
      createTestUser(organizationId),
      createTestUser(organizationId),
      createTestUser(organizationId),
      createTestUser(organizationId),
      createTestUser(organizationId, {
        clerkId: `${GITHUB_SHADOW_CLERK_PREFIX}${organizationId}:4242`,
      }),
    ]);
  const outsiderUser = await createTestUser(otherOrganizationId);

  const pushed = await seedBranch(organizationId, "rung-push", {
    firstPushedAt: FIRST_PUSHED_AT,
  });
  await pushLink(organizationId, pushed, pusher.id, "rung-push");

  const committed = await seedBranch(organizationId, "rung-commit", {
    firstPushedAt: null,
  });
  await seedGitHubConnection({
    organizationId,
    userId: committer.id,
    login: "committer",
  });
  await seedCommit({
    organizationId,
    branchId: committed,
    sha: "c".repeat(40),
    authorLogin: "committer",
    committedAt: FIRST_PUSHED_AT,
  });

  const pullRequested = await seedBranch(organizationId, "rung-pr", {
    firstPushedAt: null,
  });
  await seedGitHubConnection({
    organizationId,
    userId: prAuthor.id,
    login: "pr-author",
  });
  await seedPullRequestDetail(
    organizationId,
    pullRequested,
    "rung-pr",
    "pr-author"
  );

  const outsider = await seedBranch(organizationId, "outsider", {
    firstPushedAt: null,
  });
  await seedGitHubConnection({
    organizationId,
    userId: outsiderUser.id,
    login: "outsider",
  });
  await seedCommit({
    organizationId,
    branchId: outsider,
    sha: "d".repeat(40),
    authorLogin: "outsider",
    committedAt: FIRST_PUSHED_AT,
  });

  const shadow = await seedBranch(organizationId, "shadow", {
    firstPushedAt: null,
  });
  await seedGitHubConnection({
    organizationId,
    userId: shadowUser.id,
    login: "shadow",
  });
  await seedPullRequestDetail(organizationId, shadow, "shadow", "shadow");

  const unattributed = await seedBranch(organizationId, "nobody", {
    firstPushedAt: null,
  });

  const assigned = await seedBranch(organizationId, "assigned", {
    firstPushedAt: FIRST_PUSHED_AT,
  });
  await pushLink(organizationId, assigned, pusher.id, "assigned");
  await withDb((db) =>
    db.artifact.update({
      where: { id: assigned },
      data: { assigneeId: existingAssignee.id },
      select: { id: true },
    })
  );

  const ordered = await seedOwnerOrderingCorpus(organizationId);

  const branchIds = [
    pushed,
    committed,
    pullRequested,
    outsider,
    shadow,
    unattributed,
    assigned,
    ...ordered.keys(),
  ];
  return {
    organizationId,
    branchIds,
    before: new Map<string, string | null>([
      ...branchIds.map((id): [string, string | null] => [id, null]),
      [assigned, existingAssignee.id],
    ]),
    expected: new Map([
      [pushed, pusher.id],
      [committed, committer.id],
      [pullRequested, prAuthor.id],
      ...ordered,
    ]),
    pushed,
    committed,
    pullRequested,
    pusher: pusher.id,
    committer: committer.id,
    prAuthor: prAuthor.id,
  };
}

async function pushLink(
  organizationId: string,
  branchId: string,
  userId: string,
  label: string
): Promise<void> {
  await seedEvidenceLink({
    organizationId,
    branchId,
    userId,
    label,
    method: GIT_PUSH_METHOD,
    observedAt: FIRST_PUSHED_AT,
  });
}

/**
 * `branchOwnerSeedCandidateSql` unscoped, run on `client` so it reads the
 * migration's snapshot, narrowed to this case's branches afterwards.
 */
async function readCandidates(
  client: Client,
  branchIds: readonly string[]
): Promise<Map<string, string>> {
  const candidates = branchOwnerSeedCandidateSql(Prisma.sql`TRUE`);
  const result = await client.query<{ id: string; user_id: string }>(
    candidates.text,
    candidates.values
  );
  const wanted = new Set(branchIds);
  return new Map(
    result.rows
      .filter((row) => wanted.has(row.id))
      .map((row) => [row.id, row.user_id])
  );
}

async function readAssignees(
  client: Client,
  branchIds: readonly string[]
): Promise<Map<string, string | null>> {
  const result = await client.query<{ id: string; assignee_id: string | null }>(
    'SELECT "id", "assignee_id" FROM "artifacts" WHERE "id" = ANY($1::uuid[])',
    [branchIds]
  );
  return new Map(result.rows.map((row) => [row.id, row.assignee_id]));
}

async function readUpdatedAt(
  client: Client,
  branchIds: readonly string[]
): Promise<Map<string, Date>> {
  const result = await client.query<{ id: string; updated_at: Date }>(
    'SELECT "id", "updated_at" FROM "artifacts" WHERE "id" = ANY($1::uuid[])',
    [branchIds]
  );
  return new Map(result.rows.map((row) => [row.id, row.updated_at]));
}

function captureNotices(client: Client): string[] {
  const notices: string[] = [];
  client.on("notice", (notice) => notices.push(notice.message ?? ""));
  return notices;
}

const TEST_CEILING = 2;
const CEILING_RE = /ISS-12463 \(branch Owner to assignee\): more than 2 BRANCH/;
const SELECTED_NOTHING_RE = /seeded 0 of 0 selected branches/;
const ONE_SKIPPED_RE =
  /\(0 on retry passes\); 1 held by a live write through every pass/;
const ONE_RETRIED_RE =
  /\(1 on retry passes\); 0 held by a live write through every pass/;
const RETRY_SLEEP_WAIT_EVENT = "PgSleep";
const RETRY_SLEEP_DEADLINE_MS = 10_000;
const RETRY_SLEEP_POLL_MS = 20;

/** A second connection holding `lockSql` in an open transaction. */
async function holdLock(
  lockSql: string,
  params: readonly unknown[] = []
): Promise<Client> {
  const holder = new Client({ connectionString: keys().DATABASE_URL });
  await holder.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(lockSql, [...params]);
  } catch (error) {
    await holder.end();
    throw error;
  }
  return holder;
}

function holdBranchRow(branchId: string): Promise<Client> {
  return holdLock("SELECT id FROM artifacts WHERE id = $1 FOR UPDATE", [
    branchId,
  ]);
}

async function releaseLock(holder: Client): Promise<void> {
  try {
    await holder.query("ROLLBACK");
  } finally {
    await holder.end();
  }
}

async function backendPid(on: Client): Promise<number> {
  const result = await on.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid"
  );
  const pid = result.rows[0]?.pid;
  if (pid === undefined) {
    throw new Error("pg_backend_pid() returned no row");
  }
  return pid;
}

/**
 * Resolves once backend `pid` is inside a retry pass's `pg_sleep`, which it
 * reaches only after the main write pass has run and left a candidate
 * unassigned. Polled from autocommit queries, each with a fresh activity
 * snapshot.
 */
async function waitForRetrySleep(pid: number): Promise<void> {
  const deadline = Date.now() + RETRY_SLEEP_DEADLINE_MS;
  while (Date.now() < deadline) {
    const rows = await withDb(
      (db) =>
        db.$queryRaw<{ wait_event: string | null }[]>`
        SELECT wait_event FROM pg_stat_activity WHERE pid = ${pid}`
    );
    if (rows[0]?.wait_event === RETRY_SLEEP_WAIT_EVENT) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_SLEEP_POLL_MS));
  }
  throw new Error(
    `backend ${pid} never reached a retry pass within ${RETRY_SLEEP_DEADLINE_MS} ms`
  );
}
