/**
 * @file sqlite-maintenance-facade-cov-iss11283-guards.test.ts
 * @description ISS-11283 (lane C reserve): the guard and failure arms of the
 * maintenance facade `createMaintenanceFacade` spreads onto the store —
 *   - `recordCollectionModeViolation`, `claimProjectionCandidate` and
 *     `releaseProjectionCandidate` refuse an empty key and write nothing;
 *   - `deleteSessionRow` refuses a non-terminal session and reports it;
 *   - `recordCollectionModeViolation`, `captureRepoIdentity` and
 *     `runHistoricalBackfill` log a failed write/read and resolve instead of
 *     rejecting.
 * Failures are real: a SQLite trigger refusing the write, or a store missing
 * the table a query reads. The empty-key guards are proven against a session
 * whose id IS the empty string, so a missing guard would visibly write.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { runGitFixture } from "./helpers/git-fixture.js";

const NOW = "2026-06-07T12:00:00.000Z";
const VIOLATION_EVENT = "mutual_exclusivity_violation";
const REFUSED = "iss11283 refused this write";
const ERROR_CLASS_PREFIX = /^\w*Error: /;
const VIOLATION_FAILED_PREFIX =
  "recordCollectionModeViolation failed (harness=claude): ";
const BACKFILL_FAILED_PREFIX = "historical backfill failed: ";

let dir: string;
let repoDir: string | undefined;
let db: SqliteAgentDatabase;
let lines: string[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "iss11283-maint-facade-"));
  lines = [];
  db = await openTestDb(dir, {
    now: () => NOW,
    log: (message) => {
      lines.push(message);
    },
  });
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
  if (repoDir) {
    await rm(repoDir, { recursive: true, force: true });
    repoDir = undefined;
  }
});

async function seedSession(
  id: string,
  status: string,
  candidateRevision: string | null = null
): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, updated_at, last_activity_at, data_revision, projection_candidate_revision)
     VALUES ($1, $2, $3, $3, 1, $4)`,
    id,
    status,
    NOW,
    candidateRevision
  );
}

async function candidateRevision(id: string): Promise<string | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { projection_candidate_revision: string | null }[]
  >("SELECT projection_candidate_revision FROM sessions WHERE id = $1", id);
  return rows[0]?.projection_candidate_revision ?? null;
}

async function violationRows(): Promise<{ summary: string | null }[]> {
  return await db.prisma.client.$queryRawUnsafe<{ summary: string | null }[]>(
    "SELECT summary FROM events WHERE event_type = $1 ORDER BY summary",
    VIOLATION_EVENT
  );
}

function messagesAfter(prefix: string): string[] {
  return lines
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

describe("maintenance facade empty-key guards (ISS-11283)", () => {
  it("records no collection-mode violation for an empty harness or session id", async () => {
    await db.recordCollectionModeViolation("", "external-1");
    await db.recordCollectionModeViolation("claude", "");
    expect(await violationRows()).toEqual([]);

    // Control: a complete key is recorded, so the empty-key silence is the guard.
    await db.recordCollectionModeViolation("claude", "external-1");
    expect(await violationRows()).toEqual([{ summary: "claude" }]);
  });

  it("claims and releases nothing for an empty session id or revision", async () => {
    await seedSession("", SESSION_STATUS.INACTIVE, "r1");
    await seedSession("sess", SESSION_STATUS.INACTIVE);

    await db.claimProjectionCandidate("", "r2");
    await db.claimProjectionCandidate("sess", "");
    await db.releaseProjectionCandidate("");

    expect(await candidateRevision("")).toBe("r1");
    expect(await candidateRevision("sess")).toBeNull();

    // Control: a complete key does write, and a non-empty id does release.
    await db.claimProjectionCandidate("sess", "r3");
    expect(await candidateRevision("sess")).toBe("r3");
    await db.releaseProjectionCandidate("sess");
    expect(await candidateRevision("sess")).toBeNull();
  });

  it("refuses to delete a non-terminal session and reports the refusal", async () => {
    await seedSession("live", SESSION_STATUS.ACTIVE);
    await seedSession("done", SESSION_STATUS.INACTIVE);

    await expect(db.deleteSessionRow("live")).resolves.toBe(false);
    await expect(db.deleteSessionRow("done")).resolves.toBe(true);

    const remaining = await db.prisma.client.$queryRawUnsafe<{ id: string }[]>(
      "SELECT id FROM sessions ORDER BY id"
    );
    expect(remaining).toEqual([{ id: "live" }]);
  });
});

describe("maintenance facade failure logging (ISS-11283)", () => {
  it("logs a refused collection-mode violation write and resolves", async () => {
    await db.run(
      `CREATE TRIGGER iss11283_refuse_violation BEFORE INSERT ON events
       WHEN NEW.event_type = '${VIOLATION_EVENT}'
       BEGIN SELECT RAISE(ABORT, '${REFUSED}'); END`
    );

    await expect(
      db.recordCollectionModeViolation("claude", "external-1")
    ).resolves.toBeUndefined();

    const messages = messagesAfter(VIOLATION_FAILED_PREFIX);
    expect(messages).toEqual([expect.stringContaining(REFUSED)]);
    expect(messages[0]).not.toMatch(ERROR_CLASS_PREFIX);
    expect(await violationRows()).toEqual([]);
  });

  it("logs a repo-identity capture whose repo write is refused, and returns no repo name", async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), "iss11283-facade-repo-"));
    await runGitFixture(["init", "-q", repoDir]);
    await db.run(
      `CREATE TRIGGER iss11283_refuse_repo BEFORE INSERT ON repos
       BEGIN SELECT RAISE(ABORT, '${REFUSED}'); END`
    );

    await expect(db.captureRepoIdentity("git", repoDir)).resolves.toEqual({
      repoFullName: null,
    });

    const messages = messagesAfter(
      `captureRepoIdentity failed for ${repoDir}: `
    );
    expect(messages).toEqual([expect.stringContaining(REFUSED)]);
    expect(messages[0]).not.toMatch(ERROR_CLASS_PREFIX);
  });

  it("logs a historical backfill whose candidate query fails, and reports 0 resolved", async () => {
    await db.run("ALTER TABLE repo_worktrees RENAME TO repo_worktrees_hidden");

    await expect(db.runHistoricalBackfill("git", 10)).resolves.toBe(0);

    const messages = messagesAfter(BACKFILL_FAILED_PREFIX);
    expect(messages).toEqual([
      expect.stringContaining("no such table: repo_worktrees"),
    ]);
    expect(messages[0]).not.toMatch(ERROR_CLASS_PREFIX);
    await db.run("ALTER TABLE repo_worktrees_hidden RENAME TO repo_worktrees");
  });
});
