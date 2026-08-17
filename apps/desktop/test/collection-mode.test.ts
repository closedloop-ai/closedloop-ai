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
 *   - FEA-3741 (slice 1): a per-tool collector toggle OFF routes the harness to
 *     "disabled" in the SSOT AND makes the manager skip it entirely — no live
 *     watcher AND no historical/tool-home import — so its scan never runs.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  type CollectionMode,
  type CollectorEnabledState,
  getActiveCollectionMode,
  type HooksInstalledState,
} from "../src/main/collectors/engine/collection-mode.js";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import { createMutualExclusivityMonitor } from "../src/main/collectors/engine/mutual-exclusivity-monitor.js";
import type {
  Harness,
  NormalizedSession,
} from "../src/main/collectors/types.js";
import { COLLECTION_VIOLATION_SESSION_PREFIX } from "../src/main/database/db-constants.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  makeSession as baseSession,
  fakeCollector,
} from "./normalized-session-test-utils.js";

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
// FEA-3741 (slice 1) — per-tool collector toggle routes through the SSOT.
// ---------------------------------------------------------------------------

test("FEA-3741: an explicit per-tool disable resolves to 'disabled' regardless of hook/watcher state", () => {
  const claudeOff: CollectorEnabledState = { claude: false };
  // Even with hooks installed (which would otherwise be "hooks"), a disabled
  // toggle wins. The runtime's live-hook processEvent gate depends on exactly
  // this: it drops a Claude hook payload when this SSOT reports "disabled", so a
  // user with hooks installed who toggles Claude collection off stops all live
  // capture (not just the watcher/historical lanes).
  assert.equal(
    getActiveCollectionMode("claude", HOOKS_ON, claudeOff),
    "disabled" satisfies CollectionMode
  );
  // Watcher-only harnesses are disabled the same way.
  assert.equal(
    getActiveCollectionMode("cursor", HOOKS_OFF, { cursor: false }),
    "disabled" satisfies CollectionMode
  );
  assert.equal(
    getActiveCollectionMode("copilot", HOOKS_OFF, { copilot: false }),
    "disabled" satisfies CollectionMode
  );
});

test("FEA-3741: a toggle only disables its own harness; others keep their normal mode", () => {
  const onlyClaudeOff: CollectorEnabledState = { claude: false };
  assert.equal(
    getActiveCollectionMode("claude", HOOKS_ON, onlyClaudeOff),
    "disabled"
  );
  // Cursor/Copilot are not in the map (or true) → unchanged watcher mode.
  assert.equal(
    getActiveCollectionMode("cursor", HOOKS_ON, onlyClaudeOff),
    "watcher"
  );
  assert.equal(
    getActiveCollectionMode("copilot", HOOKS_ON, onlyClaudeOff),
    "watcher"
  );
});

test("FEA-3741: omitting the enabled state (or an explicit true) preserves always-on defaults", () => {
  // Omitted entirely — the pre-FEA-3741 always-on behavior.
  assert.equal(getActiveCollectionMode("claude", HOOKS_ON), "hooks");
  assert.equal(getActiveCollectionMode("cursor", HOOKS_OFF), "watcher");
  // Present but explicitly enabled — same as omitted.
  const allOn: CollectorEnabledState = {
    claude: true,
    cursor: true,
    copilot: true,
  };
  assert.equal(getActiveCollectionMode("claude", HOOKS_OFF, allOn), "watcher");
  assert.equal(getActiveCollectionMode("copilot", HOOKS_OFF, allOn), "watcher");
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
        fakeCollector("codex", {
          sources: ["codex.jsonl"],
          sessions: [makeSession("codex-session")],
        }),
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
        fakeCollector("claude", {
          sources: ["claude.jsonl"],
          sessions: [makeSession("claude-session")],
        }),
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
// FEA-3741 (slice 1) — a disabled harness starts NO watcher AND NO import.
// ---------------------------------------------------------------------------

test("FEA-3741: isCollectorEnabled=false skips the harness entirely (no watcher, no tool-home import)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collection-mode-off-"));
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
      // Would otherwise watch (and boot-import) both harnesses...
      getCollectionMode: () => "watcher",
      // ...but the cursor toggle is OFF: it must be skipped whole. Claude stays
      // enabled to prove the gate is per-harness (only cursor is suppressed).
      isCollectorEnabled: (harness) => harness !== "cursor",
      onWatcherEmission: (harness, sessionId) =>
        watcherEmissions.push([harness, sessionId]),
      collectors: [
        fakeCollector("claude", {
          sources: ["claude.jsonl"],
          sessions: [makeSession("claude-session")],
        }),
        fakeCollector("cursor", {
          sources: ["cursor.jsonl"],
          sessions: [makeSession("cursor-session")],
        }),
      ],
    });

    manager.start();
    // Only the enabled harness ever imports.
    await waitUntil(() => imported.length === 1);
    // Give any (incorrect) cursor import a chance to run before asserting none.
    await new Promise((resolve) => setTimeout(resolve, 50));
    manager.stop();

    // The disabled cursor collector produced NO import (its tool-home walk never
    // ran) and NO live-watcher emission.
    assert.deepEqual(imported, ["claude-session"]);
    assert.deepEqual(watcherEmissions, [["claude", "claude-session"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3741: omitting isCollectorEnabled keeps every harness on (always-on default)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collection-mode-default-"));
  const imported: string[] = [];
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
      getCollectionMode: () => "watcher",
      // No isCollectorEnabled provided → unchanged always-on posture.
      onWatcherEmission: () => {},
      collectors: [
        fakeCollector("cursor", {
          sources: ["cursor.jsonl"],
          sessions: [makeSession("cursor-session")],
        }),
      ],
    });

    manager.start();
    await waitUntil(() => imported.length === 1);
    manager.stop();

    assert.deepEqual(imported, ["cursor-session"]);
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
    // The monitor invokes onViolation *synchronously* from record() (see
    // mutual-exclusivity-monitor.ts), so counting callbacks is a deterministic
    // proxy for "did any DB write get issued" — no arbitrary sleep needed to
    // prove the negative.
    let violationCallbacks = 0;
    const monitor = createMutualExclusivityMonitor({
      onViolation: (harness, sessionId) => {
        violationCallbacks++;
        return db.recordCollectionModeViolation(harness, sessionId);
      },
    });
    // Hooks-only for codex, watcher-only for claude — disjoint, no collisions.
    monitor.record("codex", "a", "hooks");
    monitor.record("codex", "b", "hooks");
    monitor.record("claude", "c", "watcher");
    assert.equal(
      violationCallbacks,
      0,
      "disjoint channels fire no violation callback, so no write is issued"
    );
    assert.equal((await violationRows(db)).length, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FEA-3640 — the live-watcher seam that feeds the transcript archive lane's
// shared ~5 min activity flush (previously Claude-hook-only). The positive case
// delivers a REAL watcher event: gating this seam on `viaWatcher` alone would
// also catch the startup sweep and the catch-up poll (both low-duty imports),
// arming a timer for every historical session.
// ---------------------------------------------------------------------------

type CollectorManagerWatchDirectory = ConstructorParameters<
  typeof CollectorManager
>[0]["watchDirectory"];

/** Capture attached watch listeners so a test can fire a deterministic event. */
function fakeWatchDirectory() {
  const listeners: Array<{ root: string; fire: (filename: string) => void }> =
    [];
  const watchDirectory: NonNullable<CollectorManagerWatchDirectory> = (
    root,
    listener
  ) => {
    listeners.push({ root, fire: (filename) => listener("change", filename) });
    return { on: () => undefined, close: () => undefined };
  };
  return { listeners, watchDirectory };
}

test("FEA-3640: a real live-watcher event reports transcript activity with the changed source", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collection-mode-tsact-"));
  const activity: [Harness, string, string][] = [];
  try {
    // The watched file must exist: event paths are constrained to regular files
    // under the watched root before they become importable sources.
    const source = path.join(dir, "rollout-9.jsonl");
    await writeFile(source, "{}\n");
    const watch = fakeWatchDirectory();
    const manager = new CollectorManager({
      importer: {
        importSession: () => ({ skipped: false, reactivated: false }),
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      watchDirectory: watch.watchDirectory,
      onLiveTranscriptActivity: (harness, sessionId, sourcePath) =>
        activity.push([harness, sessionId, sourcePath]),
      collectors: [
        // No `sources`: the boot sweep imports nothing, so the only import — and
        // the only chance to fire the sink — is the live event below.
        fakeCollector("codex", {
          sources: [],
          sessions: [makeSession("rollout-9")],
          watchRoots: [dir],
        }),
      ],
    });

    manager.start();
    await waitUntil(() => watch.listeners.length === 1);
    for (const listener of watch.listeners) {
      listener.fire("rollout-9.jsonl");
    }
    await waitUntil(() => activity.length === 1);
    manager.stop();

    assert.deepEqual(activity, [["codex", "rollout-9", source]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3640: a watcher-mode STARTUP/catch-up import reports no transcript activity", async () => {
  // The startup sweep and the 60s catch-up poll both run with viaWatcher=true
  // (as low-duty imports). Arming the ~5 min flush for those would observe the
  // whole historical corpus as `live`, pushing a freshly-imported backlog ahead
  // of real live work — so only HarnessImportMode.LiveWatcher counts.
  const dir = await mkdtemp(path.join(os.tmpdir(), "collection-mode-tssweep-"));
  const imported: string[] = [];
  const activity: [Harness, string, string][] = [];
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
      getCollectionMode: () => "watcher",
      onLiveTranscriptActivity: (harness, sessionId, sourcePath) =>
        activity.push([harness, sessionId, sourcePath]),
      collectors: [
        fakeCollector("codex", {
          sources: ["rollout-9.jsonl"],
          sessions: [makeSession("rollout-9")],
        }),
      ],
    });

    manager.start();
    await waitUntil(() => imported.length === 1);
    manager.stop();

    assert.deepEqual(imported, ["rollout-9"]); // the sweep DID import
    assert.deepEqual(activity, []); // ...but armed no live flush
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3640: a hooks-mode (boot-only) import reports no transcript activity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collection-mode-tsboot-"));
  const imported: string[] = [];
  const activity: [Harness, string, string][] = [];
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
      getCollectionMode: () => "hooks",
      onLiveTranscriptActivity: (harness, sessionId, sourcePath) =>
        activity.push([harness, sessionId, sourcePath]),
      collectors: [
        fakeCollector("claude", {
          sources: ["claude.jsonl"],
          sessions: [makeSession("claude-session")],
        }),
      ],
    });

    manager.start();
    await waitUntil(() => imported.length === 1);
    manager.stop();

    assert.deepEqual(imported, ["claude-session"]);
    assert.deepEqual(activity, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3640: a throwing transcript-activity sink never fails the import", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collection-mode-tsthrow-"));
  const imported: string[] = [];
  try {
    const source = path.join(dir, "rollout-9.jsonl");
    await writeFile(source, "{}\n");
    const watch = fakeWatchDirectory();
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
      getCollectionMode: () => "watcher",
      watchDirectory: watch.watchDirectory,
      onLiveTranscriptActivity: () => {
        throw new Error("transcript lane exploded");
      },
      collectors: [
        fakeCollector("codex", {
          sources: [],
          sessions: [makeSession("rollout-9")],
          watchRoots: [dir],
        }),
      ],
    });

    manager.start();
    await waitUntil(() => watch.listeners.length === 1);
    for (const listener of watch.listeners) {
      listener.fire("rollout-9.jsonl");
    }
    // The session still imports despite the sink throwing on the live path.
    await waitUntil(() => imported.length === 1);
    manager.stop();

    assert.deepEqual(imported, ["rollout-9"]);
  } finally {
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

function makeSession(sessionId: string): NormalizedSession {
  return baseSession({
    sessionId,
    cwd: "/sandbox/project",
    model: "gpt-5",
    startedAt: "2026-06-16T12:00:00.000Z",
    endedAt: "2026-06-16T12:05:00.000Z",
    userMessages: 1,
    assistantMessages: 1,
    entrypoint: "codex",
  });
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
