import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { encodeBranchId } from "@repo/api/src/types/branch";
import { BRANCH_LIST_COMPLETE_COHORT_MAX_ROWS } from "@repo/api/src/types/branch-list-work-budget.js";
import { describe, test } from "vitest";
import {
  branchListSnapshotRequestSchema,
  parseBranchListSnapshot,
  readBranchListSnapshot,
} from "../src/main/database/branch-list-snapshot-read.js";
import type {
  DesktopPrisma,
  DesktopPrismaReadClient,
  DesktopPrismaReader,
} from "../src/main/database/prisma-client.js";
import { seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";

describe("Desktop Branch List snapshot read", () => {
  test("executes all five list inputs inside one read transaction", async () => {
    const transaction = {
      sessionArtifactLink: { findMany: () => Promise.resolve([]) },
      $queryRawUnsafe: () => Promise.resolve([]),
    } as unknown as DesktopPrismaReader;
    let transactionCalls = 0;
    const reader = {
      $transaction: <T>(work: (client: DesktopPrismaReader) => Promise<T>) => {
        transactionCalls += 1;
        return work(transaction);
      },
    } as DesktopPrismaReadClient;
    const prisma = {
      read: <T>(work: (client: DesktopPrismaReadClient) => Promise<T>) =>
        work(reader),
    } as DesktopPrisma;

    const snapshot = await readBranchListSnapshot(prisma, {
      eligibleBranchIds: [],
      denominatorEligibleBranchIds: [],
    });

    assert.equal(transactionCalls, 1);
    assert.deepEqual(snapshot, {
      linkRows: [],
      prRows: [],
      commitRows: [],
      tokenRows: [],
      activityRows: [],
      sessionBranchCountEntries: [],
    });
  });

  test("rejects unknown request fields and malformed response envelopes", () => {
    assert.throws(() =>
      branchListSnapshotRequestSchema.parse({
        eligibleBranchIds: [],
        denominatorEligibleBranchIds: [],
        callback: "not clone safe",
      })
    );
    assert.throws(() =>
      parseBranchListSnapshot({ linkRows: [], prRows: [], commitRows: [] })
    );
  });

  test("rejects a complete-cohort request above the shared row budget", () => {
    const oversized = Array.from(
      { length: BRANCH_LIST_COMPLETE_COHORT_MAX_ROWS + 1 },
      (_, index) => `branch-${index}`
    );

    assert.throws(() =>
      branchListSnapshotRequestSchema.parse({
        eligibleBranchIds: oversized,
        denominatorEligibleBranchIds: [],
      })
    );
  });

  test("a concurrent writer cannot split rows and counts across snapshots", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "branch-list-snapshot-"));
    const dbUrl = `file:${path.join(workDir, "snapshot.sqlite")}`;
    const reader = createClient({ url: dbUrl, intMode: "number" });
    const writer = createClient({ url: dbUrl, intMode: "number" });
    try {
      await reader.execute("PRAGMA journal_mode=WAL");
      await reader.execute("CREATE TABLE branches (id TEXT PRIMARY KEY)");
      await reader.execute("INSERT INTO branches (id) VALUES ('before')");
      const transaction = await reader.transaction("read");
      try {
        const rows = await transaction.execute(
          "SELECT id FROM branches ORDER BY id"
        );
        await writer.execute("INSERT INTO branches (id) VALUES ('during')");
        const total = await transaction.execute(
          "SELECT COUNT(*) AS count FROM branches"
        );
        assert.deepEqual(
          rows.rows.map((row) => row.id),
          ["before"]
        );
        assert.equal(Number(total.rows[0]?.count), 1);
        await transaction.commit();
      } finally {
        transaction.close();
      }
      const after = await reader.execute(
        "SELECT COUNT(*) AS count FROM branches"
      );
      assert.equal(Number(after.rows[0]?.count), 2);
    } finally {
      reader.close();
      writer.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("preserves the denominator branch cohort inside the server snapshot", async () => {
    await withAcDb(async (db) => {
      const s = seeder(db);
      const visibleBranch = await s.branch({
        branch: "feature/visible",
        firstPushedAt: "2026-06-01T00:10:00.000Z",
      });
      const denominatorBranch = await s.branch({
        branch: "feature/denominator",
        firstPushedAt: "2026-06-01T00:10:00.000Z",
      });
      await s.session("s1");
      await s.link({
        session: "s1",
        artifactId: visibleBranch,
        method: "git_push",
      });
      await s.link({
        session: "s1",
        artifactId: denominatorBranch,
        method: "git_push",
      });
      await s.tokens("s1", 100);

      const visibleId = encodeBranchId({
        repoFullName: "acme/web",
        branchName: "feature/visible",
      });
      const denominatorId = encodeBranchId({
        repoFullName: "acme/web",
        branchName: "feature/denominator",
      });
      const snapshot = await readBranchListSnapshot(db.prisma, {
        eligibleBranchIds: [visibleId],
        denominatorEligibleBranchIds: [denominatorId, visibleId],
      });

      assert.deepEqual(
        snapshot.tokenRows.map((row) => row.branchName),
        ["feature/visible"]
      );
      assert.equal(snapshot.tokenRows[0]?.inputTokens, 50);
      assert.deepEqual(snapshot.sessionBranchCountEntries, [["s1", 2]]);
      assert.ok(
        snapshot.linkRows.some(
          (row) => row.branchName === "feature/denominator"
        )
      );
    });
  });
});
