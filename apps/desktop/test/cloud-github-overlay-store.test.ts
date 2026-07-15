import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { BranchStatus } from "@repo/api/src/types/branch";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
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
