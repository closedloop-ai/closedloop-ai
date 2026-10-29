/**
 * ISS-7522 Desktop Branches corpus builder with canonical monitored activity.
 *
 * This is the same 500-row product-path shape as branches-corpus.perf.ts, but
 * every Branch link carries the persisted activity evidence the canonical
 * activity query consumes. It prevents a no-carrier fast path from being judged
 * only against the empty synthetic corpus.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity.ts";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/session-monitored-activity.ts";
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

type MonitoredCorpusBranch = {
  repoFullName: string;
  branchName: string;
  sessionId: string;
  sourceEventId: string;
  activityAt: string;
  costUsd: number;
};

type MonitoredActivityEvidenceRow = {
  repoFullName: unknown;
  branchName: unknown;
  completeness: unknown;
  eventCount: unknown;
  eventKind: unknown;
  sourceEventId: unknown;
  occurredAt: unknown;
  eventCompleteness: unknown;
};

test("ISS-7522 builds a monitored-activity Desktop Branches corpus", async () => {
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
  const branches = Array.from({ length: CORPUS_BRANCH_COUNT }, (_, index) =>
    monitoredCorpusBranch(index, activityAt)
  );
  for (const branch of branches) {
    await seedNoPullRequestBranch(userDataDir, {
      repoFullName: branch.repoFullName,
      branchName: branch.branchName,
      sessionId: branch.sessionId,
      activityAt: branch.activityAt,
      canonicalActivityEvidenceJson: monitoredActivityEvidence(
        branch.sourceEventId,
        branch.activityAt
      ),
      costUsd: branch.costUsd,
    });
  }
  await seedAgentComponent(userDataDir, {
    id: "iss-7522-monitored-readiness-component",
    kind: "subagent",
    key: "iss-7522-monitored-readiness",
    name: "ISS-7522 monitored readiness",
    content: "Fixed monitored-activity corpus DB-host readiness sentinel.",
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
    expect(
      readCount(
        db,
        "session_artifact_links",
        "json_type(evidence, '$.monitoredSessionActivity') IS NOT NULL"
      )
    ).toBe(CORPUS_BRANCH_COUNT);
    expectCanonicalActivityEvidence(db, branches);
    expect(readCount(db, "agent_components")).toBe(1);
  } finally {
    db.close();
  }
});

function monitoredActivityEvidence(
  sourceEventId: string,
  occurredAt: string
): string {
  return JSON.stringify({
    monitoredSessionActivity: {
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [
        {
          kind: MonitoredSessionActivityEventKind.AgentAction,
          sourceEventId,
          occurredAt,
          completeness: BranchActivityEvidenceCompleteness.Complete,
        },
      ],
    },
  });
}

function expectCanonicalActivityEvidence(
  db: DatabaseSync,
  branches: readonly MonitoredCorpusBranch[]
): void {
  const rows = db
    .prepare(`
      SELECT
        a.repo_full_name AS repoFullName,
        a.branch_name AS branchName,
        json_extract(sal.evidence, '$.monitoredSessionActivity.completeness') AS completeness,
        json_array_length(sal.evidence, '$.monitoredSessionActivity.events') AS eventCount,
        json_extract(sal.evidence, '$.monitoredSessionActivity.events[0].kind') AS eventKind,
        json_extract(sal.evidence, '$.monitoredSessionActivity.events[0].sourceEventId') AS sourceEventId,
        json_extract(sal.evidence, '$.monitoredSessionActivity.events[0].occurredAt') AS occurredAt,
        json_extract(sal.evidence, '$.monitoredSessionActivity.events[0].completeness') AS eventCompleteness
      FROM session_artifact_links sal
      JOIN artifacts a ON a.id = sal.artifact_id
    `)
    .all() as MonitoredActivityEvidenceRow[];
  expect(rows).toHaveLength(CORPUS_BRANCH_COUNT);
  const rowKeys = new Set(rows.map(monitoredActivityEvidenceRowKey));
  for (const branch of branches) {
    expect(rowKeys.has(corpusBranchActivityEvidenceRowKey(branch))).toBe(true);
  }
}

function monitoredCorpusBranch(
  index: number,
  activityAt: string
): MonitoredCorpusBranch {
  const suffix = String(index).padStart(4, "0");
  return {
    repoFullName: `closedloop-perf/repository-${index % CORPUS_REPOSITORY_COUNT}`,
    branchName: `iss-7522-monitored-activity-${suffix}`,
    sessionId: `iss-7522-monitored-session-${suffix}`,
    sourceEventId: `iss-7522-activity-${suffix}`,
    activityAt,
    costUsd: (index % 25) / 100,
  };
}

function corpusBranchActivityEvidenceRowKey(
  branch: MonitoredCorpusBranch
): string {
  return [
    branch.repoFullName,
    branch.branchName,
    BranchActivityEvidenceCompleteness.Complete,
    1,
    MonitoredSessionActivityEventKind.AgentAction,
    branch.sourceEventId,
    branch.activityAt,
    BranchActivityEvidenceCompleteness.Complete,
  ].join("\0");
}

function monitoredActivityEvidenceRowKey(
  row: MonitoredActivityEvidenceRow
): string {
  return [
    row.repoFullName,
    row.branchName,
    row.completeness,
    row.eventCount,
    row.eventKind,
    row.sourceEventId,
    row.occurredAt,
    row.eventCompleteness,
  ].join("\0");
}

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
