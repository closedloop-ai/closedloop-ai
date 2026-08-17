/**
 * @file commit-sha-pr-correlation-scan.test.ts
 * @description ISS-5735: planner guard for the boot-time commit-SHA → PR
 * correlation.
 *
 * `commit-sha-pr-correlation.test.ts` already covers WHAT
 * `correlateCommitShaPrLinks` mints, and it is green whether the PR side is
 * seeked through the ISS-5735 expression indexes or walked in full — a handful
 * of fixture rows behave identically either way. The defect this file exists for
 * is invisible to that: the pass runs on EVERY desktop boot with no `LIMIT` and
 * no time window, so a PR side that is walked rather than seeked costs
 * commits × PRs on every launch, and grows with both corpora forever.
 *
 * Two things make that regression easy to reintroduce silently, which is why the
 * assertions here are about the PLAN and not about the DDL:
 *   - The indexes are PARTIAL, so SQLite reaches them only where it can prove
 *     the query's terms imply `kind = 'pull_request' AND <col> IS NOT NULL`.
 *     Folding either term into an `OR`, or back into the match expression's
 *     parenthesised body, makes them unreachable with every behavioural
 *     assertion still green.
 *   - The desktop store is never `ANALYZE`d, so the join order is chosen with no
 *     statistics. Dropping the `CROSS JOIN` that pins the commit corpus as the
 *     driving loop flips `pr_art` outer, which puts the SHA prefix equality on
 *     the wrong side to be seeked at all.
 *
 * The statement it plans is CAPTURED from a real production-path call, never
 * transcribed: the store is opened with the `onStatement` hook, the correlation
 * runs through the exported production function, and the EXPLAIN replays the SQL
 * that reached the driver adapter. Rewriting the query therefore moves this
 * assertion with it — a hand-copied statement would stay green while the boot
 * pass drifted back onto the product-sized scan.
 *
 * The fixture deliberately mints from the SHORTEST commit SHA the match
 * expression admits — `MIN_ABBREV_SHA_LEN` hex against a full 40-hex PR head,
 * the production-common abbreviated case. That is also what pins the index
 * prefix length: the indexed equality is only ever a NECESSARY condition for the
 * real prefix match, and it stops being one the moment `SHA_PREFIX_INDEX_LEN`
 * exceeds the floor, so the fixture is derived from the floor rather than
 * hardcoded and the relation is asserted outright.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  correlateCommitShaPrLinks,
  MIN_ABBREV_SHA_LEN,
  SHA_PREFIX_INDEX_LEN,
} from "../src/main/database/pr-link-maintenance.js";
import type { CapturedStatement } from "../src/main/database/prisma-client.js";
import { createWriteQueue } from "../src/main/database/write-queue.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

type QueryPlanRow = { detail: string };
type SqliteMasterRow = { sql: string | null };

const NOW = "2026-08-16T12:00:00.000Z";
const REPO = "closedloop-ai/symphony-alpha";
const FULL_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
/**
 * What `git commit` prints, and what the commit artifact stores verbatim — cut
 * to the shortest length the match expression admits, so the seek is exercised
 * at the one length where an over-long indexed prefix would drop it.
 */
const ABBREV_SHA = FULL_SHA.slice(0, MIN_ABBREV_SHA_LEN);
const MERGE_SHA = "0123456789abcdef0123456789abcdef01234567";

const HEAD_INDEX_NAME = "idx_artifacts_head_sha_p7";
const MERGE_INDEX_NAME = "idx_artifacts_merge_commit_sha_p7";

/** The seek this whole change exists to produce, on each SHA column. */
const HEAD_SEEK_RE = new RegExp(
  `SEARCH pr_art USING INDEX ${HEAD_INDEX_NAME} \\(<expr>=\\?\\)`
);
const MERGE_SEEK_RE = new RegExp(
  `SEARCH pr_art USING INDEX ${MERGE_INDEX_NAME} \\(<expr>=\\?\\)`
);
/**
 * `idx_artifacts_kind` is the all-rows index — reaching the PR side through it
 * IS the scan, whether the plan word is SCAN or SEARCH. The commit side legally
 * drives through it (one pass over the authored commits is the pass's own
 * population), so this is pinned to the `pr_art` alias rather than the index.
 */
const PR_KIND_WALK_RE = /\bpr_art\b[^|]*idx_artifacts_kind/;
/** Picks the candidate read out of everything the correlation issued. */
const READ_STATEMENT_RE = /^\s*(?:WITH|SELECT)\b/i;
const ARTIFACTS_TABLE_RE = /\bartifacts\b/;
/** Each index must be partial on exactly what the query can prove. */
function partialPredicateRe(shaColumn: string): RegExp {
  return new RegExp(
    `WHERE\\s+kind\\s*=\\s*'pull_request'\\s+AND\\s+${shaColumn}\\s+IS\\s+NOT\\s+NULL`
  );
}

function noopLog(): void {
  // The correlation logs progress; this file asserts the plan, not the log.
}

async function seedSession(
  h: OpenTestPrisma,
  id: string,
  updatedAt = NOW
): Promise<void> {
  await h.db.query(
    "INSERT INTO sessions (id, status, updated_at, data_revision) VALUES ($1, 'inactive', $2, 1)",
    [id, updatedAt]
  );
}

async function seedArtifact(
  h: OpenTestPrisma,
  fields: {
    id: string;
    kind: string;
    sha?: string | null;
    headSha?: string | null;
    mergeCommitSha?: string | null;
    prNumber?: number | null;
  }
): Promise<void> {
  await h.db.query(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, sha, head_sha, merge_commit_sha,
        pr_number, created_at, last_seen_at)
     VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [
      fields.id,
      fields.kind,
      REPO,
      fields.sha ?? null,
      fields.headSha ?? null,
      fields.mergeCommitSha ?? null,
      fields.prNumber ?? null,
      NOW,
    ]
  );
}

async function seedCreatedLink(
  h: OpenTestPrisma,
  id: string,
  sessionId: string,
  artifactId: string
): Promise<void> {
  await h.db.query(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, is_primary,
        status, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, 'created', 'git_commit', '{}', 0, 'confirmed', 1, $4, $4)`,
    [id, sessionId, artifactId, NOW]
  );
}

async function explain(
  h: OpenTestPrisma,
  statement: CapturedStatement
): Promise<string> {
  const rows = await h.prisma.read((reader) =>
    reader.$queryRawUnsafe<QueryPlanRow[]>(
      `EXPLAIN QUERY PLAN ${statement.sql}`,
      ...statement.args
    )
  );
  return rows.map((row) => row.detail).join(" | ");
}

async function readIndexDdl(
  h: OpenTestPrisma,
  name: string
): Promise<string | undefined> {
  const [row] = await h.prisma.read((reader) =>
    reader.$queryRawUnsafe<SqliteMasterRow[]>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = $1",
      name
    )
  );
  return row?.sql ?? undefined;
}

test("ISS-5735: the boot correlation seeks the SHA-prefix indexes instead of walking every PR", async () => {
  const captured: CapturedStatement[] = [];
  const h = await openTestPrisma(createWriteQueue(), {
    onStatement: (statement) => captured.push(statement),
  });
  try {
    // The indexed equality is a NECESSARY condition for the real prefix match
    // only while the indexed prefix fits inside the abbreviation floor. Below
    // it, every match shorter than the indexed prefix is silently dropped — no
    // error, and no behavioural assertion in the sibling suite goes red — so
    // the relation is asserted here rather than left to the prose.
    assert.ok(
      MIN_ABBREV_SHA_LEN >= SHA_PREFIX_INDEX_LEN,
      `the indexed prefix (${SHA_PREFIX_INDEX_LEN}) must fit inside the abbreviation floor (${MIN_ABBREV_SHA_LEN}); lowering the floor needs a new migration re-cutting ${HEAD_INDEX_NAME}/${MERGE_INDEX_NAME}`
    );

    for (const [name, shaColumn] of [
      [HEAD_INDEX_NAME, "head_sha"],
      [MERGE_INDEX_NAME, "merge_commit_sha"],
    ] as const) {
      const ddl = await readIndexDdl(h, name);
      assert.ok(ddl, `${name} is missing from the migrated schema`);
      assert.match(
        ddl,
        partialPredicateRe(shaColumn),
        `${name} must stay partial on exactly the terms the query can prove, got: ${ddl}`
      );
    }

    // A session that authored an ABBREVIATED commit SHA, and a PR carrying the
    // full OID as its head — the production-common shape.
    await seedSession(h, "sess-plan");
    await seedArtifact(h, {
      id: "commit-plan",
      kind: "commit",
      sha: ABBREV_SHA,
    });
    await seedArtifact(h, {
      id: "pr-plan",
      kind: "pull_request",
      prNumber: 900,
      headSha: FULL_SHA,
      mergeCommitSha: MERGE_SHA,
    });
    await seedCreatedLink(h, "link-plan", "sess-plan", "commit-plan");

    captured.length = 0;
    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(
      minted,
      1,
      "the fixture must actually mint, or the captured plan describes a query that found nothing"
    );

    const candidateReads = captured.filter(
      (statement) =>
        READ_STATEMENT_RE.test(statement.sql) &&
        ARTIFACTS_TABLE_RE.test(statement.sql)
    );
    assert.equal(
      candidateReads.length,
      1,
      `the correlation must resolve its candidates in ONE read of artifacts for this plan to cover it, got: ${JSON.stringify(candidateReads.map((statement) => statement.sql))}`
    );

    const plan = await explain(h, candidateReads[0]);
    assert.match(
      plan,
      HEAD_SEEK_RE,
      `the head_sha arm must seek ${HEAD_INDEX_NAME}, got: ${plan}`
    );
    assert.match(
      plan,
      MERGE_SEEK_RE,
      `the merge_commit_sha arm must seek ${MERGE_INDEX_NAME}, got: ${plan}`
    );
    assert.doesNotMatch(
      plan,
      PR_KIND_WALK_RE,
      `no arm may reach the PR side through the all-rows kind index, got: ${plan}`
    );
  } finally {
    await h.close();
  }
});

test("ISS-5735: an ambiguous SHA stays ambiguous even when one of its PRs is already linked", async () => {
  const h = await openTestPrisma();
  try {
    // Two PRs share the head object, so the SHA attributes to neither. One of
    // them ALREADY carries a created link to this session — the re-mint
    // suppression. The ambiguity count must be taken over the unsuppressed
    // candidate set (as the correlated subquery it replaced was), or removing
    // the already-linked PR from the count makes the remaining one look
    // unambiguous and mints a link the evidence does not support.
    await seedSession(h, "sess-ambig");
    await seedArtifact(h, {
      id: "commit-ambig",
      kind: "commit",
      sha: FULL_SHA,
    });
    await seedArtifact(h, {
      id: "pr-ambig-linked",
      kind: "pull_request",
      prNumber: 901,
      headSha: FULL_SHA,
    });
    await seedArtifact(h, {
      id: "pr-ambig-other",
      kind: "pull_request",
      prNumber: 902,
      headSha: FULL_SHA,
    });
    await seedCreatedLink(h, "link-ambig", "sess-ambig", "commit-ambig");
    await seedCreatedLink(h, "link-ambig-pr", "sess-ambig", "pr-ambig-linked");

    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(minted, 0);

    const result = (await h.db.query(
      "SELECT artifact_id FROM session_artifact_links WHERE session_id = $1 AND artifact_id = $2",
      ["sess-ambig", "pr-ambig-other"]
    )) as { rows: { artifact_id: string }[] };
    assert.equal(
      result.rows.length,
      0,
      "the second PR of an ambiguous SHA must not be minted"
    );
  } finally {
    await h.close();
  }
});

test("ISS-5735: a SHA matching one PR's head and another PR's merge commit is ambiguous", async () => {
  const h = await openTestPrisma();
  try {
    // The two candidate arms are a UNION now rather than an OR over two columns.
    // A SHA that reaches a different PR through each arm must still count as two
    // distinct PRs — deduplicating the arms by PR would collapse this to one.
    await seedSession(h, "sess-cross");
    await seedArtifact(h, {
      id: "commit-cross",
      kind: "commit",
      sha: FULL_SHA,
    });
    await seedArtifact(h, {
      id: "pr-cross-head",
      kind: "pull_request",
      prNumber: 903,
      headSha: FULL_SHA,
    });
    await seedArtifact(h, {
      id: "pr-cross-merge",
      kind: "pull_request",
      prNumber: 904,
      headSha: MERGE_SHA,
      mergeCommitSha: FULL_SHA,
    });
    await seedCreatedLink(h, "link-cross", "sess-cross", "commit-cross");

    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(minted, 0);
  } finally {
    await h.close();
  }
});
