import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { BranchStatus } from "@repo/api/src/types/branch";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
import { PR_INT_MAX } from "@repo/api/src/types/session-artifact-link";
import {
  readCloudGithubBranchOverlays,
  writeCloudGithubBranchOverlays,
} from "../src/main/database/cloud-github-overlay-store.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

test("cloud GitHub overlay store preserves omitted overlays and updates returned rows", async () => {
  const db = await openTestDatabase();
  try {
    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-a",
      ["acme/web"],
      {
        "acme/web::feature/one": {
          status: BranchStatus.Open,
          prNumber: 1,
          prState: GitHubPRState.Open,
          checksStatus: ChecksStatus.Passing,
          additions: 11,
          deletions: 3,
          filesChanged: 2,
        },
        "acme/other::feature/ignored": {
          status: BranchStatus.Open,
          prNumber: 2,
        },
      },
      "2026-07-06T01:00:00.000Z"
    );
    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-a",
      ["acme/web"],
      {
        "acme/web::feature/one": {
          status: BranchStatus.Merged,
          prNumber: 4,
          prState: GitHubPRState.Merged,
        },
        "acme/web::feature/two": {
          status: BranchStatus.Merged,
          prNumber: 3,
          prState: GitHubPRState.Merged,
        },
      },
      "2026-07-06T02:00:00.000Z"
    );

    const overlays = await readCloudGithubBranchOverlays(
      db.prisma,
      "identity-a",
      ["acme/web", "acme/other"]
    );

    assert.deepEqual(Object.keys(overlays).sort(), [
      "acme/web::feature/one",
      "acme/web::feature/two",
    ]);
    assert.equal(
      overlays["acme/web::feature/one"]?.status,
      BranchStatus.Merged
    );
    assert.equal(overlays["acme/web::feature/one"]?.prNumber, 4);
    assert.equal(overlays["acme/web::feature/one"]?.additions, undefined);
    assert.equal(
      overlays["acme/web::feature/two"]?.status,
      BranchStatus.Merged
    );
    assert.equal(overlays["acme/web::feature/two"]?.prNumber, 3);
  } finally {
    await db.close();
  }
});

test("cloud GitHub overlay store round-trips optional LOC fields", async () => {
  const db = await openTestDatabase();
  try {
    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-loc",
      ["acme/web"],
      {
        "acme/web::feature/loc": {
          status: BranchStatus.Merged,
          prNumber: 8,
          prState: GitHubPRState.Merged,
          additions: 144,
          deletions: 21,
          filesChanged: 5,
          mergedAt: "2026-07-06T02:30:00.000Z",
        },
      },
      "2026-07-06T03:00:00.000Z"
    );

    const overlays = await readCloudGithubBranchOverlays(
      db.prisma,
      "identity-loc",
      ["acme/web"]
    );

    assert.equal(overlays["acme/web::feature/loc"]?.additions, 144);
    assert.equal(overlays["acme/web::feature/loc"]?.deletions, 21);
    assert.equal(overlays["acme/web::feature/loc"]?.filesChanged, 5);
    assert.equal(
      overlays["acme/web::feature/loc"]?.mergedAt,
      "2026-07-06T02:30:00.000Z"
    );
  } finally {
    await db.close();
  }
});

test("cloud GitHub overlay store strips legacy PR-author owner fields", async () => {
  const db = await openTestDatabase();
  try {
    await db.prisma.write((client) =>
      client.cloudGithubBranchOverlay.create({
        data: {
          identityKey: "identity-legacy-owner",
          repoFullName: "acme/web",
          branchName: "feature/owner",
          overlay: {
            owner: "legacy-pr-author",
            status: BranchStatus.Open,
          },
          lastSyncedAt: "2026-07-06T04:00:00.000Z",
        },
      })
    );

    const overlays = await readCloudGithubBranchOverlays(
      db.prisma,
      "identity-legacy-owner",
      ["acme/web"]
    );

    assert.deepEqual(overlays["acme/web::feature/owner"], {
      status: BranchStatus.Open,
    });
  } finally {
    await db.close();
  }
});

test("ISS-5413: a sized cloud PR overlay writes its diff stats onto the matching PR artifact", async () => {
  const db = await openTestDatabase();
  try {
    await seedPullRequestArtifact(db, "art-sized", "acme/web", 8);
    await seedPullRequestArtifact(db, "art-other-repo", "acme/api", 8);

    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-loc-writer",
      ["acme/web"],
      {
        "acme/web::feature/loc": {
          status: BranchStatus.Merged,
          prNumber: 8,
          prState: GitHubPRState.Merged,
          additions: 144,
          deletions: 21,
          filesChanged: 5,
        },
      },
      "2026-07-06T03:00:00.000Z"
    );

    assert.deepEqual(await readArtifactLoc(db, "art-sized"), {
      linesAdded: 144,
      linesRemoved: 21,
      filesChanged: 5,
    });
    // Same PR number, different repository — PR identity is (repo, number), so
    // this row must stay untouched.
    assert.deepEqual(await readArtifactLoc(db, "art-other-repo"), {
      linesAdded: null,
      linesRemoved: null,
      filesChanged: null,
    });
  } finally {
    await db.close();
  }
});

test("ISS-5413: a fresh cloud read replaces the whole diff-stat triple", async () => {
  const db = await openTestDatabase();
  try {
    await seedPullRequestArtifact(db, "art-refresh", "acme/web", 9);
    const overlay = (
      additions: number,
      deletions: number,
      filesChanged?: number
    ) => ({
      "acme/web::feature/refresh": {
        status: BranchStatus.Open,
        prNumber: 9,
        prState: GitHubPRState.Open,
        additions,
        deletions,
        ...(filesChanged === undefined ? {} : { filesChanged }),
      },
    });

    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-refresh",
      ["acme/web"],
      overlay(10, 2, 3),
      "2026-07-06T03:00:00.000Z"
    );
    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-refresh",
      ["acme/web"],
      overlay(40, 6, 8),
      "2026-07-06T04:00:00.000Z"
    );

    assert.deepEqual(await readArtifactLoc(db, "art-refresh"), {
      linesAdded: 40,
      linesRemoved: 6,
      filesChanged: 8,
    });

    // A later read that sizes the lines but not the files cannot land half a
    // triple over the last complete one — `sync-source` reads the three as one
    // record and COALESCEs each to 0.
    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-refresh",
      ["acme/web"],
      overlay(90, 12),
      "2026-07-06T05:00:00.000Z"
    );

    assert.deepEqual(await readArtifactLoc(db, "art-refresh"), {
      linesAdded: 40,
      linesRemoved: 6,
      filesChanged: 8,
    });
  } finally {
    await db.close();
  }
});

test("ISS-5413: the changed-value predicate still corrects a drifted artifact row", async () => {
  const db = await openTestDatabase();
  try {
    await seedPullRequestArtifact(db, "art-drift", "acme/web", 12);
    const overlays = {
      "acme/web::feature/drift": {
        status: BranchStatus.Merged,
        prNumber: 12,
        prState: GitHubPRState.Merged,
        additions: 30,
        deletions: 4,
        filesChanged: 2,
      },
    };

    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-drift",
      ["acme/web"],
      overlays,
      "2026-07-06T03:00:00.000Z"
    );
    // Skipping an unchanged row must not turn into skipping a row that only
    // PARTLY matches: drift one column and the next refresh has to heal it.
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE artifacts SET files_changed = 99 WHERE id = $1",
        "art-drift"
      )
    );
    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-drift",
      ["acme/web"],
      overlays,
      "2026-07-06T04:00:00.000Z"
    );

    assert.deepEqual(await readArtifactLoc(db, "art-drift"), {
      linesAdded: 30,
      linesRemoved: 4,
      filesChanged: 2,
    });
  } finally {
    await db.close();
  }
});

test("ISS-5413: an unsizeable cloud PR overlay leaves the artifact un-enriched", async () => {
  const db = await openTestDatabase();
  try {
    await seedPullRequestArtifact(db, "art-half", "acme/web", 1);
    await seedPullRequestArtifact(db, "art-negative", "acme/web", 2);
    await seedPullRequestArtifact(db, "art-no-pr-number", "acme/web", 3);
    await seedPullRequestArtifact(db, "art-no-files", "acme/web", 4);
    await seedPullRequestArtifact(db, "art-overflow", "acme/web", 5);

    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-unsized",
      ["acme/web"],
      {
        // Only one of the two line counts — writing it alone would mint a
        // half-enriched row that reads as sized while under-reporting.
        "acme/web::feature/half": {
          prNumber: 1,
          additions: 11,
          filesChanged: 1,
        },
        // A negative projected count reads as unknown, not as a subtraction.
        "acme/web::feature/negative": {
          prNumber: 2,
          additions: -1,
          deletions: 4,
          filesChanged: 1,
        },
        // A branch with no PR has nothing to match an artifact on.
        "acme/web::feature/no-pr": {
          additions: 7,
          deletions: 3,
          filesChanged: 1,
        },
        // Lines without a changed-file count is still a partial triple.
        "acme/web::feature/no-files": {
          prNumber: 4,
          additions: 7,
          deletions: 3,
        },
        // Over PR_INT_MAX: storing it would only defer the drop to the sync
        // mapper's identical bound, shipping a partial triple to the cloud.
        "acme/web::feature/overflow": {
          prNumber: 5,
          additions: PR_INT_MAX + 1,
          deletions: 3,
          filesChanged: 1,
        },
      },
      "2026-07-06T03:00:00.000Z"
    );

    for (const id of [
      "art-half",
      "art-negative",
      "art-no-pr-number",
      "art-no-files",
      "art-overflow",
    ]) {
      assert.deepEqual(
        await readArtifactLoc(db, id),
        { linesAdded: null, linesRemoved: null, filesChanged: null },
        id
      );
    }
  } finally {
    await db.close();
  }
});

async function openTestDatabase() {
  const dir = await mkdtemp(path.join(tmpdir(), "cloud-github-overlays-"));
  tempDirs.push(dir);
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered",
    resolveGitPath: () => "/usr/bin/git",
  });
}

type TestDatabase = Awaited<ReturnType<typeof openTestDatabase>>;

/** Raw `artifacts` LOC columns, before bigint→number coercion. */
type ArtifactLocRow = {
  lines_added: number | bigint | null;
  lines_removed: number | bigint | null;
  files_changed: number | bigint | null;
};

async function seedPullRequestArtifact(
  db: TestDatabase,
  id: string,
  repoFullName: string,
  prNumber: number
) {
  await db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', $3, $4, $5, $5)`,
      id,
      `ik-${id}`,
      repoFullName,
      prNumber,
      "2026-07-01T00:00:00.000Z"
    )
  );
}

async function readArtifactLoc(db: TestDatabase, id: string) {
  const rows = await db.prisma.client.$queryRawUnsafe<ArtifactLocRow[]>(
    "SELECT lines_added, lines_removed, files_changed FROM artifacts WHERE id = $1",
    id
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`artifact ${id} not found`);
  }
  return {
    linesAdded: count(row.lines_added),
    linesRemoved: count(row.lines_removed),
    filesChanged: count(row.files_changed),
  };
}

function count(value: number | bigint | null): number | null {
  return value === null ? null : Number(value);
}
