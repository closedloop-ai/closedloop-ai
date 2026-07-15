/**
 * @file per-event-git-branch.test.ts
 * @description FEA-2990 — per-event git_branch attribution, end to end on the
 * desktop write path. Imports a session whose tool uses span two branches (plus
 * a branch-less one) and asserts:
 *   1. `events.git_branch` is persisted per event from NormalizedToolUse.gitBranch
 *      (Claude), and null-safe when the tool use carries no branch.
 *   2. The `agent_component_session_usage` rollup is grouped by branch, so a
 *      single session that switched branches mid-run splits its component usage
 *      per (component, branch).
 *   3. The sync payload built by the sync-source carries that per-event branch
 *      additively (the '' no-branch sentinel maps to null so the cloud applies
 *      its session-level fallback). The cloud-side zod round-trip is covered by
 *      the api vitest suite (desktop-components-sync.test.ts) which imports the
 *      real `syncedComponentUsageSchema`.
 *
 * These assertions FAIL against the pre-FEA-2990 (branch-dropped) behavior: the
 * events table had no git_branch column, the rollup keyed only by
 * (session, kind, key), and the sync payload omitted the branch.
 *
 * Runs against an ephemeral on-disk SQLite store created by the production
 * migration runner (via openTestDb). Run: `node --import tsx --test <file>`.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { selectComponentUsageRows } from "../src/main/database/sync-source.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession as makeSession } from "./normalized-session-test-utils.js";

const SESSION_ID = "fea-2990-session";

/**
 * A session with three Bash tool uses: two on distinct branches and one with no
 * branch (undefined — the Codex/legacy shape). Distinct timestamps so the import
 * dedup does not collapse them.
 */
function makeMultiBranchSession() {
  return makeSession({
    sessionId: SESSION_ID,
    startedAt: "2026-06-07T10:00:00.000Z",
    endedAt: "2026-06-07T10:10:00.000Z",
    toolUses: [
      {
        name: "Bash",
        timestamp: "2026-06-07T10:01:00.000Z",
        input: { command: "ls" },
        gitBranch: "feat/a",
      },
      {
        name: "Bash",
        timestamp: "2026-06-07T10:02:00.000Z",
        input: { command: "pwd" },
        gitBranch: "feat/a",
      },
      {
        name: "Bash",
        timestamp: "2026-06-07T10:03:00.000Z",
        input: { command: "git status" },
        gitBranch: "feat/b",
      },
      {
        // No per-event branch (Codex / legacy): must persist null and roll up
        // under the '' sentinel.
        name: "Read",
        timestamp: "2026-06-07T10:04:00.000Z",
        input: { file_path: "/x" },
      },
    ],
  });
}

test("FEA-2990: events.git_branch persisted per event, null-safe", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2990-events-"));
  const db = await openTestDb(dir);
  try {
    await db.importer.importSession(makeMultiBranchSession(), "claude");

    const rows = await db.prisma.client.$queryRawUnsafe<
      { tool_name: string; git_branch: string | null; created_at: string }[]
    >(
      `SELECT tool_name, git_branch, created_at
       FROM events
       WHERE session_id = ? AND event_type = 'PostToolUse'
       ORDER BY created_at ASC`,
      SESSION_ID
    );

    // Three Bash events (two feat/a, one feat/b) + one branch-less Read.
    const branchByTs = new Map(rows.map((r) => [r.created_at, r.git_branch]));
    assert.equal(branchByTs.get("2026-06-07T10:01:00.000Z"), "feat/a");
    assert.equal(branchByTs.get("2026-06-07T10:02:00.000Z"), "feat/a");
    assert.equal(branchByTs.get("2026-06-07T10:03:00.000Z"), "feat/b");
    // Null-safe: the branch-less tool use persists NULL, not '' or a crash.
    assert.equal(branchByTs.get("2026-06-07T10:04:00.000Z"), null);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2990: usage rollup is grouped by branch (multi-branch session splits)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2990-usage-"));
  const db = await openTestDb(dir);
  try {
    await db.importer.importSession(makeMultiBranchSession(), "claude");

    const usage = await db.prisma.client.$queryRawUnsafe<
      {
        component_kind: string;
        component_key: string;
        git_branch: string;
        invocations: number;
      }[]
    >(
      `SELECT component_kind, component_key, git_branch, invocations
       FROM agent_component_session_usage
       WHERE session_id = ? AND component_key IN ('Bash', 'Read')
       ORDER BY component_key ASC, git_branch ASC`,
      SESSION_ID
    );

    // Bash split into two branch buckets (2 on feat/a, 1 on feat/b); Read has no
    // branch, so it rolls up under the '' sentinel.
    const key = (r: { component_key: string; git_branch: string }) =>
      `${r.component_key}|${r.git_branch}`;
    const invByKey = new Map(usage.map((r) => [key(r), Number(r.invocations)]));

    assert.equal(invByKey.get("Bash|feat/a"), 2, "feat/a Bash count");
    assert.equal(invByKey.get("Bash|feat/b"), 1, "feat/b Bash count");
    assert.equal(
      invByKey.get("Read|"),
      1,
      "branch-less Read under '' sentinel"
    );
    // A branch-dropped rollup would produce a SINGLE Bash row (git_branch '')
    // with invocations=3 — assert the split instead.
    assert.equal(
      invByKey.get("Bash|"),
      undefined,
      "no collapsed single-bucket Bash row"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2990: sync source carries per-event branch additively (with '' → null)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2990-sync-"));
  const db = await openTestDb(dir);
  try {
    await db.importer.importSession(makeMultiBranchSession(), "claude");

    const grouped = await db.prisma.read((client) =>
      selectComponentUsageRows(client, [SESSION_ID])
    );
    const rows = grouped.get(SESSION_ID) ?? [];

    // The sync source must expose git_branch on each row so the payload builder
    // can carry it. Bash appears once per branch; Read carries the '' sentinel.
    const bashBranches = new Set(
      rows
        .filter((r) => r.component_key === "Bash")
        .map((r) => (r.git_branch === "" ? null : r.git_branch))
    );
    assert.deepEqual(
      [...bashBranches].sort(),
      ["feat/a", "feat/b"],
      "both per-event branches present in the sync source rows"
    );

    // Map to the wire shape exactly as buildBoundedComponentUsage does: the ''
    // no-branch sentinel becomes null so the cloud reads it as "no per-event
    // branch" and applies the session-level fallback (never clearing rows).
    const wire = rows.map((row) => ({
      componentKind: row.component_kind,
      componentKey: row.component_key,
      gitBranch: row.git_branch === "" ? null : row.git_branch,
      invocations: row.invocations,
    }));
    const readWire = wire.find((w) => w.componentKey === "Read");
    assert.equal(
      readWire?.gitBranch,
      null,
      "branch-less Read → gitBranch null"
    );
    const bashWire = wire.filter((w) => w.componentKey === "Bash");
    assert.ok(
      bashWire.every(
        (w) => w.gitBranch === "feat/a" || w.gitBranch === "feat/b"
      ),
      "Bash wire rows carry a real per-event branch"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
