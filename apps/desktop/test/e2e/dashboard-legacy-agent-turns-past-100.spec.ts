/**
 * ISS-9864 regression, through the launched app: a token-event-less session
 * with MORE than `MAX_METADATA_MESSAGES` (100) assistant rows paints every one
 * of them on the desktop Event Activity heatmap.
 *
 * The desktop half of the fix is two things this spec exercises in sequence:
 * the boot heal (`recomputeLegacyMessageAgentTurnBuckets`) re-deriving
 * `session_turn_bucket` from the FULL local `$.messages` array with the old
 * `.slice(0, 100)` gone, and the Dashboard reading that table through the
 * insights IPC into the rendered cell. `legacy-message-agent-turn-bucket-heal
 * .test.ts` pins the SQLite repair against the store directly; this spec pins
 * that the repaired rows reach the user-visible number, so a broken store →
 * renderer mapping cannot leave that suite green while the chart still says
 * 100 (davetho review, #7269).
 *
 * The 150 assistant rows sit one second apart inside a single hour, so they
 * land in ONE heatmap cell and the cell's own `title` carries the count. One
 * human row shares the hour, so the Agent toggle is what proves the AGENT
 * half: `Both` reads 151, `Agent` reads 150, `Human` reads 1.
 *
 * Seeding writes `sessions.metadata` while the app is DOWN (the seed sandwich,
 * `seeded-sessions-list.ts`) and waits for the relaunch's heal to converge
 * BEFORE opening the Dashboard, so a red here names which half broke: the DB
 * poll fails when the heal did not carry the rows, the cell assertion fails
 * when the render did not.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, type Page, test } from "@playwright/test";
import { DashboardTourAnchor } from "@repo/app/insights/components/overview/dashboard-tour-anchors.ts";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { DASHBOARD_HEADING } from "./helpers/dashboard-header-copy";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  gotoNav,
  launchDesktopApp,
} from "./helpers/desktop-app";
import {
  applyDesktopBusyTimeout,
  applyDesktopSeedPragmas,
  openSeedClient,
} from "./helpers/desktop-seed-core";
import { insightsTrendSeedAt } from "./helpers/insights-trend-seed";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  seededSessionsEnv,
} from "./helpers/seeded-sessions-list";

const SESSION_ID = "iss-9864-legacy-agent-turns-past-100";
/** Past `MAX_METADATA_MESSAGES` by half again — the heal suite's own shape. */
const AGENT_TURNS = 150;
const HUMAN_TURNS = 1;
const ACTIVITY_ROW = `[data-tour="${DashboardTourAnchor.Activity}"]`;
const HEAL_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 45_000;

/**
 * One instant inside the trend window, snapped to the top of its hour so the
 * whole 151-second span of the seeded rows shares one local hour on any
 * whole- or half-hour offset.
 */
function seedHourStart(): Date {
  const at = insightsTrendSeedAt();
  at.setUTCMinutes(0, 0, 0);
  return at;
}

function legacyMetadata(hourStart: Date): string {
  const messages = Array.from({ length: AGENT_TURNS }, (_, index) => ({
    role: "assistant",
    timestamp: new Date(hourStart.getTime() + (index + 1) * 1000).toISOString(),
  }));
  messages.push({ role: "human", timestamp: hourStart.toISOString() });
  return JSON.stringify({ entrypoint: "codex-tui", messages, tokenSeries: [] });
}

/** Write the legacy blob with the app DOWN, then checkpoint for the next boot. */
async function seedLegacyMetadata(
  userDataDir: string,
  metadata: string
): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopSeedPragmas(client);
    await client.execute({
      sql: "UPDATE sessions SET metadata = ? WHERE id = ?",
      args: [metadata, SESSION_ID],
    });
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/** The stored agent-turn total for the session, read while the app is UP. */
async function storedAgentTurns(userDataDir: string): Promise<number> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopBusyTimeout(client);
    const rs = await client.execute({
      sql: `SELECT COALESCE(SUM(turn_count), 0) AS n
              FROM session_turn_bucket
             WHERE session_id = ? AND turn_kind = 'agent'`,
      args: [SESSION_ID],
    });
    return Number(rs.rows[0]?.n ?? 0);
  } finally {
    client.close();
  }
}

async function openDashboard(page: Page): Promise<void> {
  await gotoNav(page, "dashboard");
  await expect(
    page.getByRole("heading", {
      exact: true,
      level: 1,
      name: DASHBOARD_HEADING,
    })
  ).toBeVisible({ timeout: 30_000 });
  // Widen to "All time" so the past-dated seed is in range regardless of the
  // run clock.
  await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);
}

async function expectHeatmapCell(
  page: Page,
  mode: "Both" | "Agent" | "Human",
  turns: number
): Promise<void> {
  await page.locator(`${ACTIVITY_ROW} [aria-label="${mode}"]`).click();
  await expect(
    page.locator(`${ACTIVITY_ROW} [title$="· ${turns} turns"]`)
  ).toHaveCount(1, { timeout: RENDER_TIMEOUT_MS });
}

test.describe("Dashboard legacy agent turns past 100 (ISS-9864)", () => {
  test("paints all 150 agent turns of a token-event-less session on the Event Activity heatmap", async () => {
    test.setTimeout(300_000);

    const dirs = makeSeededSessionsDirs("desktop-iss9864");
    const hourStart = seedHourStart();

    try {
      // Launch 1 — migrate the schema and skip the first-launch reveal/tour.
      const first = await launchDesktopApp({
        env: seededSessionsEnv(dirs),
        keepUserDataDir: true,
        userDataDir: dirs.userDataDir,
      });
      try {
        await waitForBranchesSchema(dirs.userDataDir);
        await first.page.evaluate(
          ([onboardedKey, tourSeenKey]) => {
            localStorage.setItem(onboardedKey, "1");
            localStorage.setItem(tourSeenKey, "1");
          },
          [dashboardOnboardedStorageKey, dashboardTourSeenStorageKey]
        );
      } finally {
        await first.cleanup();
      }

      // Seed while the app is DOWN: one substantive session whose `metadata`
      // holds 150 assistant rows and NO token events — the population the
      // legacy `$.messages` Agent arm serves. No bucket rows are seeded: the
      // relaunch's boot heal derives them from the blob.
      await seedSessionsList(dirs.userDataDir, [
        {
          sessionId: SESSION_ID,
          at: hourStart.toISOString(),
          name: "ISS-9864 legacy agent turns seed",
        },
      ]);
      await seedLegacyMetadata(dirs.userDataDir, legacyMetadata(hourStart));

      // Launch 2 — the heal runs in boot maintenance; the Dashboard reads what
      // it wrote.
      const launched = await launchDesktopApp({
        env: seededSessionsEnv(dirs),
        keepUserDataDir: true,
        userDataDir: dirs.userDataDir,
      });
      try {
        // Store half: the heal carried every row past the old 100 window.
        await expect
          .poll(() => storedAgentTurns(dirs.userDataDir), {
            timeout: HEAL_TIMEOUT_MS,
          })
          .toBe(AGENT_TURNS);

        // Render half: the same number reaches the cell.
        await openDashboard(launched.page);
        await expectHeatmapCell(launched.page, "Agent", AGENT_TURNS);
        await expectHeatmapCell(launched.page, "Human", HUMAN_TURNS);
        await expectHeatmapCell(
          launched.page,
          "Both",
          AGENT_TURNS + HUMAN_TURNS
        );

        expect(launched.pageErrors).toEqual([]);
      } finally {
        await launched.cleanup();
      }
    } finally {
      cleanupSeededSessionsDirs(dirs);
    }
  });
});
