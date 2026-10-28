/**
 * Direct SQLite seeding of `sessions` rows carrying a HARNESS, for the
 * onboarding session-discovery specs (ISS-10624).
 *
 * `seedSessionsList` (seed-branches-db.ts) deliberately writes no `harness`
 * column — every Branches/Sessions spec riding it is indifferent to which tool
 * produced a row. The onboarding fold is not: it divides a per-harness store
 * count by a per-harness disk count, so a fixture for it has to be able to put
 * MORE rows under one harness than that harness has transcripts on disk. That
 * surplus is the real machine state ISS-10624 was filed from — a store that
 * accumulated sessions whose transcripts have since been pruned — and it is
 * what makes the fold withhold the session RATIO. ISS-10582 later ruled that
 * the analyzed COUNT survives that withholding and only the quotient is given
 * up, so the rows seeded here still reach the screen as a stated number.
 *
 * There is no test-only code path here: `sync-source.ts` counts the harness
 * facet with `SELECT s.harness, COUNT(*) FROM sessions s … GROUP BY s.harness`,
 * so the app's own census runs over exactly these rows.
 *
 * Seed while the app is DOWN and relaunch against the same `--user-data-dir`,
 * for the reason `seed-transcript-sync-db.ts` states: the first read then
 * already sees the corpus instead of racing a poll against a concurrent insert.
 */

import {
  applyDesktopBusyTimeout,
  applyDesktopSeedPragmas,
  openSeedClient,
  SEED_SCHEMA_TIMEOUT_MS,
  waitForMigrationsApplied,
} from "./desktop-seed-core";

/**
 * The `sessions.harness` values the live schema actually carries. Spelled as
 * literals rather than imported from `main/transcript-sync/transcript-sync-types`
 * — that module reaches `@repo/api` through an extension-less subpath, which
 * resolves in the app and NOT under the Playwright spec loader, where it aborts
 * the whole suite at load time (`test/AGENTS.md` → "Import hazard").
 */
export const SeedHarness = {
  Claude: "claude",
  Codex: "codex",
  OpenCode: "opencode",
} as const;
export type SeedHarness = (typeof SeedHarness)[keyof typeof SeedHarness];

export type HarnessSessionSurplusSeed = {
  harness: SeedHarness;
  /** How many rows to write. */
  count: number;
  /** `sessions.id` prefix; the index is appended. Must not collide with a real id. */
  idPrefix: string;
};

/**
 * Write `count` terminal `sessions` rows for one harness.
 *
 * Every timestamp is NOW, deliberately: the usage read the onboarding fold
 * consumes is date-windowed and the boot retention sweep deletes terminal rows
 * whose last activity predates the 90-day window, so an aged row would be
 * counted by neither and the surplus this seed exists to create would not
 * exist by the time the step renders.
 */
export async function seedHarnessSessionSurplus(
  userDataDir: string,
  seed: HarnessSessionSurplusSeed
): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopSeedPragmas(client);
    await waitForMigrationsApplied(client, SEED_SCHEMA_TIMEOUT_MS);
    const now = new Date().toISOString();
    const rows = Array.from({ length: seed.count }, (_unused, index) => ({
      sql: `INSERT INTO sessions
              (id, name, status, started_at, ended_at, updated_at,
               last_activity_at, harness, data_revision)
            VALUES (?, ?, 'inactive', ?, ?, ?, ?, ?, 1)`,
      args: [
        `${seed.idPrefix}${index}`,
        `${seed.idPrefix}${index}`,
        now,
        now,
        now,
        now,
        seed.harness,
      ],
    }));
    await client.batch(rows, "write");
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/** How many `sessions` rows the store currently holds for one harness. */
export async function countHarnessSessionRows(
  userDataDir: string,
  harness: SeedHarness
): Promise<number> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopBusyTimeout(client);
    const rs = await client.execute({
      sql: "SELECT COUNT(*) AS n FROM sessions WHERE harness = ?",
      args: [harness],
    });
    return Number(rs.rows[0]?.n ?? 0);
  } finally {
    client.close();
  }
}
