import assert from "node:assert/strict";
import { test } from "vitest";
import { parseBranchListSnapshot } from "../src/main/database/branch-list-snapshot-read.js";
import {
  DB_HOST_STORE_OP_PREFIX,
  dispatchDbHostStoreOp,
} from "../src/main/database/db-host/db-host-store-op-registry.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestPrisma } from "./prisma-test-utils.js";

test("production store IPC dispatch reaches branches.listSnapshot against real SQLite", async () => {
  const opened = await openTestPrisma();
  const db = { prisma: opened.prisma } as SqliteAgentDatabase;

  try {
    const snapshot = await dispatchDbHostStoreOp(
      {},
      db,
      `${DB_HOST_STORE_OP_PREFIX}branches.listSnapshot`,
      [{ eligibleBranchIds: [], denominatorEligibleBranchIds: [] }]
    );

    assert.deepEqual(parseBranchListSnapshot(snapshot), {
      linkRows: [],
      prRows: [],
      commitRows: [],
      tokenRows: [],
      activityRows: [],
      sessionBranchCountEntries: [],
    });
  } finally {
    await opened.close();
  }
});
