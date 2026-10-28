/**
 * @file artifact-link-persistence-repo-bound.test.ts
 * @description ISS-8882: `normalizeRepoFullName` now returns null for a slug
 * past the wire bound, and `resolveRefRepo` cannot tell that from an unresolved
 * BARE name — which it null-scopes on purpose (FEA-2866). Persisting an
 * over-bound ref under that null scope would collapse refs from DIFFERENT
 * repositories onto one `branch::<name>` artifact and set `droppedBareRepo`,
 * holding the session unseen for a resolver sweep that can never recover a slug
 * this long. So the ref is refused before it is prepared, counted out of the
 * denominator, and reported through the logger the file already threads for
 * exactly this class of silent drop. The at-bound slug is the over-rejection
 * guard.
 *
 * The second case drives `backfillArtifactLinksFromTranscripts` end to end,
 * because the completeness check that has to subtract those refusals lives
 * THERE, not in `persistArtifactLinks` — comparing this function's own
 * `captured` against its own `droppedPastWireBound` is a tautology that cannot
 * fail (PR #6627 review, marisolashgrove).
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPOSITORY_FULL_NAME_MAX_LENGTH } from "@repo/api/src/types/session-artifact-link";
import { test } from "vitest";
import { backfillArtifactLinksFromTranscripts } from "../src/main/collectors/parsing/artifact-link-backfill.js";
import type { ArtifactRefRecord } from "../src/main/collectors/parsing/artifact-ref-record.js";
import { persistArtifactLinks } from "../src/main/database/artifact-link-persistence.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makeSession } from "./normalized-session-test-utils.js";

type TestDb = Awaited<ReturnType<typeof openTestDb>>;

const NOW = "2026-06-07T12:00:00.000Z";
const WIRE_BOUND_WARNING_RE = /past the 200-char wire bound/;
const SESSION_ID_RE = /s-8882/;
const SHORT_REPO = "acme/repo";
const OWNER = "acme/";
const AT_BOUND_REPO =
  OWNER + "a".repeat(REPOSITORY_FULL_NAME_MAX_LENGTH - OWNER.length);
// Two DISTINCT repositories, both past the bound. Under the null-scoping this
// test exists to prevent, both would key to the same `branch::main` artifact.
const OVER_BOUND_REPO_A = `${AT_BOUND_REPO}a`;
const OVER_BOUND_REPO_B = `${AT_BOUND_REPO}b`;

function branchRef(
  repoFullName: string,
  branchName: string
): ArtifactRefRecord {
  return {
    targetKind: "branch",
    targetIdentity: `${repoFullName}:${branchName}`,
    relation: "created",
    method: "git_push",
    evidence: "{}",
    observedAt: NOW,
    confidence: "url_match",
    extractorVersion: 7,
    isPrimary: false,
    repoFullName,
    branchName,
  };
}

async function insertSession(db: TestDb, sessionId: string): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
     VALUES ($1, 'inactive', $2, $2, 'claude', 'metered_api')`,
    sessionId,
    NOW
  );
}

test("ISS-8882: an over-bound repo slug refuses its ref instead of null-scoping it, and never collapses two repositories onto one artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-link-repo-bound-"));
  const db = await openTestDb(dir);
  try {
    await insertSession(db, "s-8882");
    const warnings: string[] = [];

    const result = await db.prisma.write((client) =>
      client.$transaction((tx) =>
        persistArtifactLinks(
          tx,
          "s-8882",
          [
            branchRef(OVER_BOUND_REPO_A, "main"),
            branchRef(OVER_BOUND_REPO_B, "main"),
            branchRef(AT_BOUND_REPO, "main"),
            branchRef(SHORT_REPO, "feat/x"),
          ],
          NOW,
          (message) => warnings.push(message)
        )
      )
    );

    assert.equal(result.droppedPastWireBound, 2);
    assert.equal(
      result.captured,
      2,
      "the at-bound and short-slug refs persist"
    );
    assert.equal(
      result.droppedUnresolvedBareRepo,
      false,
      "a permanently-unpersistable slug must not hold the session unseen — a later sweep can never recover it"
    );

    const rows = await db.prisma.client.$queryRawUnsafe<
      { repo_full_name: string | null; branch_name: string | null }[]
    >(
      "SELECT repo_full_name, branch_name FROM artifacts WHERE kind = 'branch' ORDER BY branch_name, repo_full_name"
    );
    assert.deepEqual(rows, [
      { repo_full_name: SHORT_REPO, branch_name: "feat/x" },
      { repo_full_name: AT_BOUND_REPO, branch_name: "main" },
    ]);
    assert.equal(
      rows.filter((row) => row.repo_full_name === null).length,
      0,
      "no over-bound ref is persisted under a NULL repo scope"
    );

    assert.equal(warnings.length, 2, "each permanent drop is reported");
    for (const message of warnings) {
      assert.match(message, WIRE_BOUND_WARNING_RE);
      assert.match(message, SESSION_ID_RE);
    }
  } finally {
    await db.close();
  }
});

test("ISS-8882: the backfill sweep completes and stamps a session whose over-bound ref is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-link-repo-bound-backfill-"));
  const db = await openTestDb(dir);
  const transcriptPath = join(dir, "s-8882-backfill.jsonl");
  writeFileSync(transcriptPath, "{}\n");
  try {
    await insertSession(db, "s-8882-backfill");
    const logs: string[] = [];

    // The push mints two refs: the branch (over-bound slug, refused) and the
    // ISS slug read out of the branch name (no repo scope, persists). So the
    // sweep sees captured 1 of 2 expected. Without the `- droppedPastWireBound`
    // subtraction in the backfill's completeness check, that reads as a partial
    // persistence, throws, and rolls the transaction back — leaving the session
    // unseen and re-throwing on every boot for as long as the transcript lives.
    const result = await backfillArtifactLinksFromTranscripts(db.prisma, {
      listTranscriptFiles: () => [transcriptPath],
      sessionIdFromPath: () => "s-8882-backfill",
      log: (message) => logs.push(message),
      parseSessionFile: () =>
        Promise.resolve(
          makeSession({
            sessionId: "s-8882-backfill",
            startedAt: NOW,
            endedAt: null,
            artifacts: {
              repo: OVER_BOUND_REPO_A,
              prs: [],
              issues: [],
            },
            toolUses: [
              {
                name: "Bash",
                timestamp: NOW,
                input: { command: "git push -u origin feat/iss-8882" },
              },
            ],
          })
        ),
    });

    assert.equal(result.scanned, 1);
    assert.equal(
      result.errors,
      0,
      "a refused over-bound ref is not a partial persistence — the sweep must not throw"
    );
    assert.equal(
      result.captured,
      1,
      "the sibling slug ref still persists; only the over-bound branch ref is refused"
    );
    assert.equal(
      logs.some((message) =>
        message.includes("artifact-link backfill: persist failed")
      ),
      false
    );

    const branches = await db.prisma.client.$queryRawUnsafe<{ n: bigint }[]>(
      "SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'branch'"
    );
    assert.equal(
      Number(branches[0]?.n ?? 0),
      0,
      "the over-bound branch ref is refused, not filed under a NULL repo scope"
    );

    const seen = await db.prisma.client.$queryRawUnsafe<{ n: bigint }[]>(
      "SELECT COUNT(*) AS n FROM artifact_link_backfill_seen WHERE session_id = $1",
      "s-8882-backfill"
    );
    assert.equal(
      Number(seen[0]?.n ?? 0),
      1,
      "the session is stamped seen, so a later boot skips it instead of re-throwing"
    );
  } finally {
    await db.close();
  }
});
