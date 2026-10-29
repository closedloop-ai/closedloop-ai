/**
 * ISS-4656 capture-only Desktop Branches corpus builder.
 *
 * Creates one migrated, sync-off Desktop profile and seeds enough real Branches
 * rows to exercise complete-corpus reads across several legacy 100-row pages.
 * The resulting profile is frozen once and cloned for every compared run.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "../e2e/helpers/desktop-app";
import { seedAgentComponent } from "../e2e/helpers/seed-agent-components-db";
import {
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "../e2e/helpers/seed-branches-db";
import {
  DESKTOP_DB_FILE_NAME,
  DESKTOP_USER_DATA_DIR_ENV,
  requireAbsoluteDirEnv,
} from "./helpers/perf-run";

const CORPUS_BRANCH_COUNT = 500;
const CORPUS_REPOSITORY_COUNT = 10;
const BUILD_TIMEOUT_MS = 15 * 60_000;
const SCHEMA_TIMEOUT_MS = 2 * 60_000;

test("ISS-4656 builds a fixed Desktop Branches corpus", async () => {
  test.setTimeout(BUILD_TIMEOUT_MS);

  const userDataDir = requireAbsoluteDirEnv(
    DESKTOP_USER_DATA_DIR_ENV,
    "Set CLOSEDLOOP_DESKTOP_USER_DATA_DIR to an empty ignored corpus directory."
  );
  const dbPath = path.join(userDataDir, DESKTOP_DB_FILE_NAME);
  if (fs.existsSync(dbPath)) {
    throw new Error(`Refusing to replace existing corpus database: ${dbPath}`);
  }

  const launched = await launchDesktopApp({
    userDataDir,
    keepUserDataDir: true,
  });
  try {
    await waitForBranchesSchema(userDataDir, SCHEMA_TIMEOUT_MS);
  } finally {
    await launched.cleanup();
  }

  const activityAt = new Date().toISOString();
  for (let index = 0; index < CORPUS_BRANCH_COUNT; index += 1) {
    const suffix = String(index).padStart(4, "0");
    await seedNoPullRequestBranch(userDataDir, {
      repoFullName: `closedloop-perf/repository-${index % CORPUS_REPOSITORY_COUNT}`,
      branchName: `iss-4656-server-pagination-${suffix}`,
      sessionId: `iss-4656-perf-session-${suffix}`,
      activityAt,
      costUsd: (index % 25) / 100,
    });
  }
  await seedAgentComponent(userDataDir, {
    id: "iss-4656-perf-readiness-component",
    kind: "subagent",
    key: "iss-4656-perf-readiness",
    name: "ISS-4656 perf readiness",
    content: "Fixed corpus DB-host readiness sentinel.",
    harness: "claude",
    source: "closedloop-perf",
  });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    expect(readCount(db, "sessions")).toBe(CORPUS_BRANCH_COUNT);
    expect(readCount(db, "artifacts", "kind = 'branch'")).toBe(
      CORPUS_BRANCH_COUNT
    );
    expect(readCount(db, "session_artifact_links")).toBe(CORPUS_BRANCH_COUNT);
    expect(readCount(db, "agent_components")).toBe(1);
  } finally {
    db.close();
  }
});

function readCount(
  db: DatabaseSync,
  table: string,
  whereClause?: string
): number {
  const suffix = whereClause ? ` WHERE ${whereClause}` : "";
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${table}${suffix}`)
    .get();
  return Number(row?.count ?? 0);
}
