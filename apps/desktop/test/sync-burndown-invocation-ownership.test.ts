/**
 * @file sync-burndown-invocation-ownership.test.ts
 * @description ISS-7096 parity for the burn-down: the invocation lane's owed
 * remainder must leave out template sessions another identity owns, because
 * promotion never sends them. Counting them left a remainder no pass could
 * drain, and the lane paged `no_progress` on it every idle stretch (monitor
 * 315255487, 2026-10-12: one install reported 159 owed on all 41 events across
 * three days).
 *
 * Against real SQLite, on both store branches that run the template probe:
 * paired (a delivery key) and never-promoted (no delivery key).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  PENDING_TEMPLATE_PROBE_LIMIT,
  type SyncBurndownQuery,
} from "../src/main/database/sync-burndown-store.js";
import {
  burndownQuery,
  SAMPLE_NOW,
  seedOwedTemplateSession,
} from "./support/sync-burndown-fixtures.js";

const SIGNED_IN = { userId: "user-signed-in", organizationId: "org-signed-in" };
const OTHER_ENVIRONMENT = { userId: "user-other", organizationId: "org-other" };
const OWN_SESSIONS = 2;
/**
 * More foreign sessions than the probe reads, all sorting BEFORE the owned ones
 * (`foreign-` < `own-`), so a filter applied after the `LIMIT` would see only
 * foreign rows and report nothing owed.
 */
const FOREIGN_SESSIONS_PAST_LIMIT = PENDING_TEMPLATE_PROBE_LIMIT + 5;
/** Few enough that the probe's window holds every session. */
const FOREIGN_SESSIONS_WITHIN_LIMIT = 3;
/** Never stamped, so the ISS-6168 boot claim may still make it ours: owed. */
const UNSTAMPED_SESSIONS = 1;

async function sampleTemplateSessions(
  query: SyncBurndownQuery,
  foreignSessions: number
): Promise<number> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "burndown-ownership-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => SAMPLE_NOW,
    });
    try {
      for (let index = 0; index < OWN_SESSIONS; index += 1) {
        await seedOwedTemplateSession(db, `own-${index}`, SIGNED_IN);
      }
      for (let index = 0; index < foreignSessions; index += 1) {
        await seedOwedTemplateSession(
          db,
          `foreign-${index}`,
          OTHER_ENVIRONMENT
        );
      }
      for (let index = 0; index < UNSTAMPED_SESSIONS; index += 1) {
        await seedOwedTemplateSession(db, `unstamped-${index}`);
      }
      const readSyncBurndown = db.syncSource.readSyncBurndown;
      if (!readSyncBurndown) {
        throw new Error("the sync source exposes no burn-down read");
      }
      const sample = await readSyncBurndown(query);
      return sample.invocationOutbox.pendingTemplateSessions;
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("burn-down invocation remainder vs another identity's templates (ISS-7096)", () => {
  for (const [label, invocationSourceKey] of [
    ["paired", burndownQuery().invocationSourceKey],
    ["never promoted", null],
  ] as const) {
    it(`counts only this identity's template sessions (${label})`, async () => {
      const owed = await sampleTemplateSessions(
        {
          ...burndownQuery(),
          invocationSourceKey,
          identity: SIGNED_IN,
        },
        FOREIGN_SESSIONS_PAST_LIMIT
      );

      assert.equal(owed, OWN_SESSIONS + UNSTAMPED_SESSIONS);
    });

    it(`filters nothing when the identity is unknown (${label})`, async () => {
      const owed = await sampleTemplateSessions(
        {
          ...burndownQuery(),
          invocationSourceKey,
          identity: null,
        },
        FOREIGN_SESSIONS_WITHIN_LIMIT
      );

      assert.equal(
        owed,
        OWN_SESSIONS + FOREIGN_SESSIONS_WITHIN_LIMIT + UNSTAMPED_SESSIONS
      );
    });
  }
});
