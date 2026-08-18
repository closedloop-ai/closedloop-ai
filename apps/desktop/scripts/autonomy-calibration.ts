/**
 * PLN-1545 / FEA-3781 T2 — autonomy calibration harness.
 *
 * Recomputes the session autonomy score over a REAL local `agent-dashboard.sqlite`
 * and prints the resulting distribution, tier split, and per-tier examples. It
 * exists because the defect this plan fixes (`autonomy` pinned at 100 for 92% of
 * sessions) is a DISTRIBUTION defect: no unit assertion would have caught it, and
 * no unit assertion proves it fixed. The evidence is the shape of the histogram
 * over real data, so tier cut-points must be set from an observed distribution
 * rather than inherited from one the formula never produced.
 *
 * Usage (from apps/desktop):
 *   pnpm run calibrate:autonomy                     # default store under Electron userData
 *   pnpm exec tsx scripts/autonomy-calibration.ts <path-to-agent-dashboard.sqlite>
 *
 * This is a CALIBRATION INSTRUMENT, not a product code path — nothing in the app
 * imports it. It deliberately imports the REAL production deriver
 * (`deriveAutonomyAndSteering`) rather than mirroring it, so the numbers it prints
 * are the numbers the app produces; re-running it after a formula change measures
 * the change rather than a copy of it.
 *
 * The one thing it DOES mirror is `ancestorAutonomy` (now in
 * `autonomy-calibration-lib.ts`) — the sibling implementation in
 * `closedloop-ai/workflow` (`packages/telemetry/src/report.ts`,
 * `summarizeSessionAutonomy`). That lives in a different repository, so it cannot
 * be imported; it is reproduced as a labelled reference column because it is
 * the only one of the candidate formulas with a plausible `Manual`/low-autonomy
 * population, which makes it a useful sanity anchor. See PLN-1545 "Prior art" for
 * why porting either direction is out of scope.
 *
 * The store is copied to a temp directory before opening, so a running Desktop
 * app holding the WAL cannot be disturbed and the harness never writes.
 *
 * ISS-5303 split the pure scoring half into `autonomy-calibration-lib.ts` so it
 * can be unit-tested. What is left here is exactly the part that cannot be: the
 * argv/filesystem entry, the store snapshot, the SQL reads — and the unguarded
 * `await main()` at the bottom, which is why nothing may ever import this file.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { isHeadlessEntrypoint } from "@repo/lib/session-trace/headless";
import {
  type SessionInput,
  scoreSession,
  text,
} from "./autonomy-calibration-lib.js";
import { renderCalibrationReport } from "./autonomy-calibration-report.js";

const DEFAULT_STORE_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "Closedloop",
  "agent-dashboard.sqlite"
);

async function main(): Promise<void> {
  const storePath = process.argv[2] ?? DEFAULT_STORE_PATH;
  if (!existsSync(storePath)) {
    process.stderr.write(
      `No store at ${storePath}\nPass a path: pnpm exec tsx scripts/autonomy-calibration.ts <agent-dashboard.sqlite>\n`
    );
    process.exitCode = 1;
    return;
  }
  const workDir = mkdtempSync(join(tmpdir(), "autonomy-calibration-"));
  try {
    const snapshot = snapshotStore(storePath, workDir);
    const inputs = await loadSessionInputs(snapshot);
    const scored = inputs.map(scoreSession);
    process.stdout.write(renderCalibrationReport(storePath, scored));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Copy the store (and its WAL/SHM sidecars) so the harness reads a stable
 * snapshot and can never contend with — or write to — a live Desktop store.
 *
 * SIDECARS FIRST, MAIN FILE LAST. A running Desktop can checkpoint mid-copy,
 * which folds the WAL into the main file and then resets the WAL with a fresh
 * salt. Copying the main file first would pair a pre-checkpoint main snapshot
 * with a post-reset WAL whose salt no longer matches; SQLite discards a
 * mismatched WAL SILENTLY, so the harness would read a truncated corpus and
 * report a distribution with no error to warn you. Taking the WAL first inverts
 * the race: if a checkpoint lands before the main copy, the main file already
 * contains those frames, so a discarded WAL costs nothing. This ordering can
 * only ever lose the newest few frames, never a checkpoint's worth.
 */
function snapshotStore(storePath: string, workDir: string): string {
  const target = join(workDir, "agent-dashboard.sqlite");
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${storePath}${suffix}`)) {
      copyFileSync(`${storePath}${suffix}`, `${target}${suffix}`);
    }
  }
  copyFileSync(storePath, target);
  return target;
}

/**
 * Rebuild the exact per-session timestamp streams `buildSessionTraceSyncFields`
 * feeds the deriver: `role:"human"` transcript messages are prompts; every other
 * message, every event row, and every token event is agent activity. Extracted in
 * SQL (`json_each` over `metadata.$.messages`) rather than by hydrating each
 * session's metadata blob into JS — same reason the analytics reads do it that
 * way (see apps/desktop/src/main/database/AGENTS.md).
 */
async function loadSessionInputs(dbPath: string): Promise<SessionInput[]> {
  const client = createClient({ url: `file:${dbPath}` });
  try {
    const sessions = await client.execute(
      `SELECT id,
              harness,
              json_extract(metadata, '$.entrypoint') AS entrypoint
       FROM sessions`
    );
    const messages = await client.execute(
      `SELECT s.id AS id,
              json_extract(m.value, '$.role') AS role,
              json_extract(m.value, '$.timestamp') AS ts
       FROM sessions s, json_each(s.metadata, '$.messages') m
       WHERE json_extract(m.value, '$.timestamp') IS NOT NULL
         AND json_extract(m.value, '$.role') IS NOT NULL`
    );
    const events = await client.execute(
      "SELECT session_id AS id, created_at AS ts FROM events"
    );
    const tokenEvents = await client.execute(
      "SELECT session_id AS id, created_at AS ts FROM token_events"
    );

    const byId = new Map<string, SessionInput>();
    for (const row of sessions.rows) {
      const id = text(row.id);
      if (!id) {
        continue;
      }
      byId.set(id, {
        id,
        harness: text(row.harness),
        // Matches what `buildSessionTraceSyncFields` feeds the deriver: the
        // entrypoint leg only, never `permissionMode` (FEA-3781 T8).
        headless: isHeadlessEntrypoint(text(row.entrypoint)),
        promptTimestamps: [],
        agentActivityTimestamps: [],
        activityTimestamps: [],
      });
    }
    for (const row of messages.rows) {
      const session = byId.get(text(row.id) ?? "");
      const ts = text(row.ts);
      if (!(session && ts)) {
        continue;
      }
      session.activityTimestamps.push(ts);
      if (text(row.role) === "human") {
        session.promptTimestamps.push(ts);
      } else {
        session.agentActivityTimestamps.push(ts);
      }
    }
    for (const row of [...events.rows, ...tokenEvents.rows]) {
      const session = byId.get(text(row.id) ?? "");
      const ts = text(row.ts);
      if (!(session && ts)) {
        continue;
      }
      session.activityTimestamps.push(ts);
      session.agentActivityTimestamps.push(ts);
    }
    return [...byId.values()];
  } finally {
    client.close();
  }
}

await main();
