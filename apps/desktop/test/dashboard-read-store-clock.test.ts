import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InsightsSection } from "@closedloop-ai/loops-api/insights";
import { test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { insertSqliteSession } from "./sqlite-session-fixtures.js";

/**
 * ISS-9279 — the store's clock reaches its date-windowed dashboard READS, not
 * just its writes.
 *
 * `openSqliteAgentDatabase({ now })` stamped writes, boot maintenance and the
 * scheduler, while `dashboard.getInsights` resolved its window from
 * `new Date()`. A store therefore wrote fixtures at one instant and read them
 * back at another, and the gap between the two was however long ago the
 * fixtures were authored — so every date-windowed assertion in the desktop
 * suite was a countdown, green until wall-clock time drifted past the window and
 * then red on every branch at once, which is what happened repo-wide at
 * fixture+90d on 2026-09-05.
 *
 * The pinned instant below is deliberately far in the PAST. The 7-day window it
 * anchors can only contain the seeded row if the read ran on the store's clock;
 * on the real one the row is outside the window by years and the count is 0. So
 * this stays a live mutation kill for as long as the file exists, rather than
 * passing for a while on the strength of the fixture being recent.
 */
const PINNED_NOW = "2026-06-07T12:00:00.000Z";
const IN_WINDOW_STARTED_AT = "2026-06-05T09:00:00.000Z";

test("date-windowed dashboard reads run on the store's injected clock", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-store-clock-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => PINNED_NOW,
  });

  try {
    await insertSqliteSession(db, "store-clock-session", {
      startedAt: IN_WINDOW_STARTED_AT,
      updatedAt: IN_WINDOW_STARTED_AT,
    });

    // No explicit `now` — the point of the test is what the read defaults to.
    const utilization = await db.dashboard.getInsights(
      InsightsSection.Utilization,
      "7"
    );

    assert.equal(
      utilization.kpis.find((stat) => stat.key === "sessions")?.value,
      1
    );

    // The seam is a default, not an override: an explicit `now` still wins, and
    // a window anchored two months after the fixture excludes it.
    const laterWindow = await db.dashboard.getInsights(
      InsightsSection.Utilization,
      "7",
      new Date("2026-08-07T12:00:00.000Z")
    );

    assert.equal(
      laterWindow.kpis.find((stat) => stat.key === "sessions")?.value,
      0
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
