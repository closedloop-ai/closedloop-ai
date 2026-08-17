import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { BranchStatus } from "@repo/api/src/types/branch";
import { RepositoryDefaultReason } from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
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

test("fork-head identity survives an additive legacy overlay refresh", async () => {
  const db = await openTestDatabase();
  try {
    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-fork",
      ["base/repository"],
      {
        "base/repository::feature/fork": {
          status: BranchStatus.Open,
          prNumber: 42,
          prTitle: "Original",
          headRepositoryProvider: VcsProviderKind.GitHub,
          headRepositoryProviderId: "fork-42",
          headRepositoryFullName: "fork-owner/repository",
        },
      },
      "2026-08-11T10:00:00.000Z"
    );
    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-fork",
      ["base/repository"],
      {
        "base/repository::feature/fork": {
          status: BranchStatus.Merged,
          prNumber: 42,
          prTitle: "Updated by older peer",
        },
      },
      "2026-08-11T11:00:00.000Z"
    );

    const overlay = (
      await readCloudGithubBranchOverlays(db.prisma, "identity-fork", [
        "base/repository",
      ])
    )["base/repository::feature/fork"];
    assert.deepEqual(overlay, {
      status: BranchStatus.Merged,
      prNumber: 42,
      prTitle: "Updated by older peer",
      headRepositoryProvider: VcsProviderKind.GitHub,
      headRepositoryProviderId: "fork-42",
      headRepositoryFullName: "fork-owner/repository",
    });
  } finally {
    await db.close();
  }
});

test("typed fork-head absence replaces identity and is preserved on omission", async () => {
  const db = await openTestDatabase();
  try {
    const key = "base/repository::feature/inaccessible";
    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-unavailable",
      ["base/repository"],
      {
        [key]: {
          prNumber: 84,
          headRepositoryProvider: VcsProviderKind.GitHub,
          headRepositoryProviderId: "fork-84",
          headRepositoryFullName: "fork-owner/private",
        },
      },
      "2026-08-11T10:00:00.000Z"
    );
    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-unavailable",
      ["base/repository"],
      {
        [key]: {
          prNumber: 84,
          headRepositoryUnavailableReason:
            RepositoryDefaultReason.PermissionDenied,
        },
      },
      "2026-08-11T11:00:00.000Z"
    );
    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-unavailable",
      ["base/repository"],
      { [key]: { prNumber: 84, prTitle: "Legacy refresh" } },
      "2026-08-11T12:00:00.000Z"
    );

    const overlay = (
      await readCloudGithubBranchOverlays(db.prisma, "identity-unavailable", [
        "base/repository",
      ])
    )[key];
    assert.equal(
      overlay?.headRepositoryUnavailableReason,
      RepositoryDefaultReason.PermissionDenied
    );
    assert.equal(overlay?.headRepositoryFullName, undefined);
    assert.equal(overlay?.prTitle, "Legacy refresh");
  } finally {
    await db.close();
  }
});

test("changed or removed PR identity cannot inherit the previous fork head", async () => {
  const db = await openTestDatabase();
  try {
    const key = "base/repository::feature/replaced";
    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-replaced",
      ["base/repository"],
      {
        [key]: {
          prNumber: 1,
          headRepositoryProvider: VcsProviderKind.GitHub,
          headRepositoryProviderId: "fork-1",
          headRepositoryFullName: "fork-owner/one",
        },
      },
      "2026-08-11T10:00:00.000Z"
    );
    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-replaced",
      ["base/repository"],
      { [key]: { prNumber: 2, prTitle: "Replacement without authority" } },
      "2026-08-11T11:00:00.000Z"
    );

    let overlay = (
      await readCloudGithubBranchOverlays(db.prisma, "identity-replaced", [
        "base/repository",
      ])
    )[key];
    assert.equal(
      overlay?.headRepositoryUnavailableReason,
      RepositoryDefaultReason.Unknown
    );
    assert.equal(overlay?.headRepositoryProviderId, undefined);

    await writeCloudGithubBranchOverlays(
      db.prisma,
      "identity-replaced",
      ["base/repository"],
      { [key]: { prNumber: null, prTitle: null } },
      "2026-08-11T12:00:00.000Z"
    );
    overlay = (
      await readCloudGithubBranchOverlays(db.prisma, "identity-replaced", [
        "base/repository",
      ])
    )[key];
    assert.equal(overlay?.headRepositoryUnavailableReason, undefined);
    assert.equal(overlay?.headRepositoryProviderId, undefined);
    assert.equal(overlay?.prNumber, null);
  } finally {
    await db.close();
  }
});

async function openTestDatabase() {
  const dir = await mkdtemp(path.join(tmpdir(), "fork-head-overlays-"));
  tempDirs.push(dir);
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered",
    resolveGitPath: () => "/usr/bin/git",
  });
}
