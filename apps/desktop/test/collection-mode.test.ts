/**
 * @file collection-mode.test.ts
 * @description FEA-1839 — proves the hooks-vs-watcher mutual-exclusivity contract:
 *   - AC-001.1: getActiveCollectionMode returns the documented mode per harness.
 *   - AC-001.2: a Codex harness in hooks mode starts no live watcher, yet the
 *     boot-import-once pass still imports its sessions.
 *   - AC-001.3: a sentinel session emitted by BOTH channels writes exactly one
 *     mutual_exclusivity_violation row (harness=codex); single-channel writes none.
 *   - AC-001.4: the Claude path is unchanged (hooks ⇒ no watcher, watcher ⇒ watcher).
 *   - Monitor unit: one violation per key, order-independent, channel-disjoint.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  type CollectionMode,
  getActiveCollectionMode,
  type HooksInstalledState,
} from "../src/main/collectors/collection-mode.js";
import { CollectorManager } from "../src/main/collectors/collector-manager.js";
import { createMutualExclusivityMonitor } from "../src/main/collectors/mutual-exclusivity-monitor.js";
import type {
  Harness,
  HarnessCollector,
  NormalizedSession,
} from "../src/main/collectors/types.js";
import {
  COLLECTION_VIOLATION_SESSION_PREFIX,
  openSqliteAgentDatabase,
} from "../src/main/database/sqlite.js";

// ---------------------------------------------------------------------------
// AC-001.1 — getActiveCollectionMode is the single source of truth.
// ---------------------------------------------------------------------------

const HOOKS_ON: HooksInstalledState = { claude: true };
const HOOKS_OFF: HooksInstalledState = { claude: false };

test("AC-001.1: Claude follows its hook config", () => {
  assert.equal(getActiveCollectionMode("claude", HOOKS_ON), "hooks");
  assert.equal(getActiveCollectionMode("claude", HOOKS_OFF), "watcher");
});

test("AC-001.1: watcher-only harnesses always watch regardless of hook flags", () => {
  // Codex hooks were removed (PRD-431); Codex now always uses its watcher,
  // alongside the harnesses that never had a hook path.
  for (const harness of ["codex", "cursor", "copilot", "opencode"] as const) {
    assert.equal(getActiveCollectionMode(harness, HOOKS_ON), "watcher");
    assert.equal(getActiveCollectionMode(harness, HOOKS_OFF), "watcher");
  }
});

test("AC-001.1: unknown harness is disabled (defensive default)", () => {
  assert.equal(
    getActiveCollectionMode("mystery" as Harness, HOOKS_OFF),
    "disabled" satisfies CollectionMode
  );
});

// ---------------------------------------------------------------------------
// Mutual-exclusivity monitor unit.
// ---------------------------------------------------------------------------

test("monitor: a single channel never reports a violation", () => {
  const violations: [Harness, string][] = [];
  const monitor = createMutualExclusivityMonitor({
    onViolation: (h, s) => violations.push([h, s]),
  });
  monitor.record("codex", "s1", "hooks");
  monitor.record("codex", "s1", "hooks"); // repeat same channel
  monitor.record("codex", "s2", "watcher");
  assert.equal(violations.length, 0);
});

test("monitor: both channels report exactly one violation per key, order-independent", () => {
  const violations: [Harness, string][] = [];
  const monitor = createMutualExclusivityMonitor({
    onViolation: (h, s) => violations.push([h, s]),
  });
  // watcher first, then hooks.
  monitor.record("codex", "s1", "watcher");
  monitor.record("codex", "s1", "hooks");
  // hooks first, then watcher.
  monitor.record("codex", "s2", "hooks");
  monitor.record("codex", "s2", "watcher");
  // re-emitting an already-reported key does not duplicate.
  monitor.record("codex", "s1", "watcher");
  monitor.record("codex", "s1", "hooks");

  assert.deepEqual(violations, [
    ["codex", "s1"],
    ["codex", "s2"],
  ]);
});

test("monitor: same session id under different harnesses is keyed separately", () => {
  const violations: [Harness, string][] = [];
  const monitor = createMutualExclusivityMonitor({
    onViolation: (h, s) => violations.push([h, s]),
  });
  monitor.record("codex", "shared", "hooks");
  monitor.record("claude", "shared", "watcher");
  // codex saw only hooks, claude saw only watcher — neither collides.
  assert.equal(violations.length, 0);
});

test("monitor: empty/nullish session ids are ignored", () => {
  const violations: [Harness, string][] = [];
  const monitor = createMutualExclusivityMonitor({
    onViolation: (h, s) => violations.push([h, s]),
  });
  monitor.record("codex", "", "hooks");
  monitor.record("codex", null, "watcher");
  monitor.record("codex", undefined, "hooks");
  assert.equal(violations.length, 0);
});

test("monitor: reset() clears state so a mode transition is not a violation", () => {
  const violations: [Harness, string][] = [];
  const monitor = createMutualExclusivityMonitor({
    onViolation: (h, s) => violations.push([h, s]),
  });
  // Watcher captured the session under the old (watcher) mode...
  monitor.record("codex", "s1", "watcher");
  // ...then a config change (e.g. hooks toggle) resets the monitor...
  monitor.reset();
  // ...and the hook handler captures the same session under the new mode.
  monitor.record("codex", "s1", "hooks");
  assert.equal(violations.length, 0, "cross-reset emissions must not collide");
});

// ---------------------------------------------------------------------------
// AC-001.2 / AC-001.4 — CollectorManager watcher gating.
// ---------------------------------------------------------------------------

test("AC-001.2: Codex hooks ⇒ no live watcher, boot import still runs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collection-mode-codex-"));
  const imported: string[] = [];
  const watcherEmissions: [Harness, string][] = [];
  try {
    const manager = new CollectorManager({
      importer: {
        importSession: (session) => {
          imported.push(session.sessionId);
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      // Codex in hooks mode; everything else would watch.
      getCollectionMode: (harness) =>
        harness === "codex" ? "hooks" : "watcher",
      onWatcherEmission: (harness, sessionId) =>
        watcherEmissions.push([harness, sessionId]),
      collectors: [
        fakeCollector("codex", ["codex.jsonl"], [makeSession("codex-session")]),
      ],
    });

    manager.start();
    await waitUntil(() => imported.length === 1);
    manager.stop();

    // Boot-import-once produced the row...
    assert.deepEqual(imported, ["codex-session"]);
    // ...but the live watcher never ran, so no watcher-channel emission fired.
    assert.deepEqual(watcherEmissions, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AC-001.4: watcher-mode harness imports AND reports a watcher emission", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collection-mode-watch-"));
  const imported: string[] = [];
  const watcherEmissions: [Harness, string][] = [];
  try {
    const manager = new CollectorManager({
      importer: {
        importSession: (session) => {
          imported.push(session.sessionId);
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      // Claude in watcher mode (hooks off) — the unchanged Claude path.
      getCollectionMode: () => "watcher",
      onWatcherEmission: (harness, sessionId) =>
        watcherEmissions.push([harness, sessionId]),
      collectors: [
        fakeCollector(
          "claude",
          ["claude.jsonl"],
          [makeSession("claude-session")]
        ),
      ],
    });

    manager.start();
    await waitUntil(() => imported.length === 1);
    manager.stop();

    assert.deepEqual(imported, ["claude-session"]);
    assert.deepEqual(watcherEmissions, [["claude", "claude-session"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-001.3 — violation row is written exactly once to the local store.
// ---------------------------------------------------------------------------

test("AC-001.3: cross-channel collision writes exactly one violation row; single-channel writes none", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collection-mode-db-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-16T12:00:00.000Z",
  });
  try {
    const monitor = createMutualExclusivityMonitor({
      onViolation: (harness, sessionId) =>
        db.recordCollectionModeViolation(harness, sessionId),
    });

    // A sentinel Codex session emitted by BOTH channels.
    monitor.record("codex", "sentinel-collide", "hooks");
    monitor.record("codex", "sentinel-collide", "watcher");
    // A Codex session emitted by ONE channel — must not produce a row.
    monitor.record("codex", "sentinel-solo", "hooks");

    await waitForRows(db, 1);

    const rows = await violationRows(db);
    assert.equal(rows.length, 1, "exactly one violation row");
    assert.equal(rows[0].summary, "codex", "harness recorded as summary");
    // Synthetic, namespaced session_id (never a real harness session id).
    assert.equal(
      rows[0].session_id,
      `${COLLECTION_VIOLATION_SESSION_PREFIX}codex:sentinel-collide`
    );
    assert.deepEqual(JSON.parse(rows[0].data as string), {
      harness: "codex",
      externalSessionId: "sentinel-collide",
    });

    // Re-detection of the same key is idempotent (deterministic id + ON CONFLICT).
    await db.recordCollectionModeViolation("codex", "sentinel-collide");
    assert.equal((await violationRows(db)).length, 1, "still exactly one row");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("AC-001.3: violation row survives a per-session rebuild (synthetic session_id)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collection-mode-rebuild-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-16T12:00:00.000Z",
  });
  try {
    await db.recordCollectionModeViolation("codex", "sess-rebuilt");
    assert.equal((await violationRows(db)).length, 1, "violation written");

    // FEA-1785 data-revision rebuild DELETEs every event for the real session
    // id, then re-derives from the parse. Because the violation row uses a
    // synthetic session_id, the rebuild of the real session must NOT erase it.
    await db.rebuildSessionFromParse(makeSession("sess-rebuilt"), "codex");

    assert.equal(
      (await violationRows(db)).length,
      1,
      "violation row persists across the real session's rebuild"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("AC-001.3: normal operation writes zero violation rows", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "collection-mode-db-clean-")
  );
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-16T12:00:00.000Z",
  });
  try {
    const monitor = createMutualExclusivityMonitor({
      onViolation: (harness, sessionId) =>
        db.recordCollectionModeViolation(harness, sessionId),
    });
    // Hooks-only for codex, watcher-only for claude — disjoint, no collisions.
    monitor.record("codex", "a", "hooks");
    monitor.record("codex", "b", "hooks");
    monitor.record("claude", "c", "watcher");
    // Give any erroneous async write a chance to land before asserting zero.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await violationRows(db)).length, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

type ViolationRow = {
  session_id: string;
  summary: string | null;
  data: string | null;
};

async function violationRows(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
): Promise<ViolationRow[]> {
  const result = await db.prisma.client.$queryRawUnsafe<ViolationRow[]>(
    "SELECT session_id, summary, data FROM events WHERE event_type = $1 ORDER BY session_id ASC",
    "mutual_exclusivity_violation"
  );
  return result;
}

async function waitForRows(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  expected: number
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if ((await violationRows(db)).length >= expected) {
      return;
    }
    if (Date.now() - startedAt > 2000) {
      throw new Error("timed out waiting for violation row");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fakeCollector(
  key: HarnessCollector["key"],
  sources: string[],
  sessions: NormalizedSession[]
): HarnessCollector {
  return {
    key,
    cacheName: key,
    allowUnscopedSourceAdmission: true,
    watchRoots: () => [],
    watchMatch: () => true,
    listSources: () => sources,
    parse: async () => sessions,
  };
}

function makeSession(sessionId: string): NormalizedSession {
  return {
    sessionId,
    name: sessionId,
    cwd: "/sandbox/project",
    model: "gpt-5",
    version: null,
    slug: null,
    gitBranch: null,
    startedAt: "2026-06-16T12:00:00.000Z",
    endedAt: "2026-06-16T12:05:00.000Z",
    teams: [],
    userMessages: 1,
    assistantMessages: 1,
    tokensByModel: {},
    messageTimestamps: [],
    toolUses: [],
    plans: [],
    compactions: [],
    apiErrors: [],
    fileModifiedAt: null,
    turnDurations: [],
    entrypoint: "codex",
    permissionMode: null,
    thinkingBlockCount: 0,
    toolResultErrors: [],
    usageExtras: { service_tiers: [], speeds: [], inference_geos: [] },
    messages: [],
    tokenSeries: [],
    diffStats: null,
    slashCommands: [],
    artifacts: { prs: [], issues: [], repo: null },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2000) {
      throw new Error("timed out waiting for collector import");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
