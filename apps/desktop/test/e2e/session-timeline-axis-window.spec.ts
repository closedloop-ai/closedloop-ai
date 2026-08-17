/**
 * ISS-4833 / ISS-4822 / ISS-5137 (Electron twin): the Session Timeline axis
 * anchors on the PLOTTED-ACTIVITY window through the LAUNCHED desktop renderer,
 * and that window covers the phase tiling's whole span — idle tail included.
 *
 * The web twin is `e2e/session-timeline-axis-window.spec.ts`. Both drive the
 * same shared `AgentSessionDetailView` out of `@repo/app`, but the two adapters
 * feed it from entirely different producers — the cloud detail projection on
 * web, the local SQLite read (`shared-agent-session-detail-projection.ts` `mapDetail`) here —
 * and the gate itself resolves differently too (a PostHog flag on web, the
 * desktop Labs setting here). So per `packages/app/AGENTS.md` this needs a real
 * regression on EACH adapter, not one plus an assumption.
 *
 * The seeded session is the SES 019fa57e shape: `ended_at` stamped stale
 * (FEA-3594 sweeper/heal) at the session start while the phase tiling runs three
 * hours past it. Under the PRIOR derivation the axis measured `startedAt` to the
 * session's LIFECYCLE end rather than to anything plotted — see
 * {@link PRIOR_AXIS_TOTAL} for the exact shape that takes on this adapter, where
 * `lastActivityAt` is derived from event rows rather than read from a column.
 * ISS-5366 retired the `session-timeline-axis-reconciliation` Labs gate to its
 * enabled state, so the reconciled total is what this seeded corpus must now
 * render with no seeding at all — and `PRIOR_AXIS_TOTAL` is kept as the negative
 * assertion that proves it is not silently rendering the old window.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { gotoHash, launchDesktopApp } from "./helpers/desktop-app";
import {
  type ActivitySegmentSeed,
  seedSessionActivitySegments,
  waitForActivitySegmentsSchema,
} from "./helpers/seed-activity-segments";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SESSION_ID = "iss-4833-stale-end-session";
const SESSION_NAME = "iss-4833 stale end session";

const HOUR_MS = 3_600_000;
/**
 * One captured instant every seeded timestamp is offset from, so the expected
 * durations below are exact regardless of how long the run takes. Truncated to
 * the second because `formatDuration` floors to whole seconds.
 */
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
/** `started_at` / `ended_at` / `updated_at` — the seeder writes all three. */
const SESSION_AT_MS = NOW_MS - 5 * HOUR_MS;
/**
 * The `sessions.last_activity_at` COLUMN. On desktop this is the retention/
 * default-window anchor only — the rendered `lastActivityAt` is derived from
 * event rows (see {@link PRIOR_AXIS_TOTAL}) — so this is set late purely to keep
 * the row inside the Sessions read's default window and past the boot retention
 * sweep.
 */
const LAST_ACTIVITY_MS = NOW_MS;
const TILING_START_MS = NOW_MS - 4 * HOUR_MS;
/** Where ATTRIBUTED work stops — the last non-idle segment's end. */
const WORK_END_MS = NOW_MS - HOUR_MS;
/**
 * ISS-5137: where the TILING stops, half an hour of idle past the last work.
 *
 * This is the shape the desktop classifier actually produces — `appendIdleTiling`
 * closes the tail with an idle pad — and until ISS-5137 the reconciled window
 * excluded idle segments, so the axis stopped at {@link WORK_END_MS} while the
 * "phases span …" caption one row beneath it measured the tiling INCLUDING this
 * pad. Two adjacent captions, two different numbers, on the normal synced shape.
 */
const TILING_END_MS = WORK_END_MS + 30 * 60_000;

/**
 * The PRIOR axis total on THIS adapter: `startedAt` → `resolveSessionDurationEnd`
 * = `lastActivityAt`, which on desktop is DERIVED (`sync-source.ts`) as the
 * latest `events.created_at` floored at `started_at` — deliberately NOT the
 * `sessions.last_activity_at` column, which is only the retention/window anchor.
 * The seeded corpus's one event is the substantive `PreToolUse` at the session
 * start, so the derived last-activity IS the start and the prior axis renders a
 * flat "0s".
 *
 * That is not a degenerate fixture — it is the ISS-4833 complaint in its sharpest
 * desktop form: an axis claiming ZERO span for a session with four hours of
 * plotted activity under it. (The web twin shows the other face of the same bug,
 * an axis inflated past everything drawn, because the cloud producer takes
 * `lastActivityAt` from the column.)
 */
const PRIOR_AXIS_TOTAL = "0s";
/**
 * The RECONCILED total: the plotted-activity window. Its END is the tiling's
 * OWN span end (NOW-30m, idle tail included, the same value the "phases span …"
 * caption reports) — NOT the stale `ended_at` (NOW-5h). Its START is the seeded
 * tool event at the session start, the earliest thing plotted.
 *
 * ISS-5137: the idle tail is what makes this number a discriminator. Under the
 * ISS-4833 derivation the window stopped at the last WORK segment and this read
 * `4h 0m` — a real regression on this adapter that the previous single-segment
 * corpus could not express.
 */
const RECONCILED_AXIS_TOTAL = "4h 30m";

/**
 * A work span followed by an IDLE tail — the shape the desktop classifier emits.
 *
 * Two constraints hold it in place. The idle pad has to be there at all: without
 * it this corpus cannot tell ISS-4833's idle-EXCLUDING window from ISS-5137's
 * idle-INCLUDING one, because both derivations land on the same instant, and
 * that is exactly why the Electron adapter kept passing through the regression
 * (wongk review). And it has to stay a MINORITY of the tiling: FEA-4238 folds a
 * strip whose non-idle share drops under 5% behind a disclosure, so a majority-
 * idle fixture would test the fold instead of the window. Three hours of work to
 * thirty minutes idle is ~86% non-idle.
 */
const SEGMENTS: ActivitySegmentSeed[] = [
  {
    confidence: 0.9,
    endMs: WORK_END_MS,
    evidenceLayers: ["structural"],
    phase: "implement",
    startMs: TILING_START_MS,
  },
  {
    confidence: 0.9,
    endMs: TILING_END_MS,
    evidenceLayers: ["structural"],
    phase: "idle",
    startMs: WORK_END_MS,
  },
];

/**
 * The axis total cell.
 *
 * ISS-4675 (#4238) made the three-slot `tick — total — tick` axis unconditional,
 * so BOTH gate states render ONE total in the MIDDLE slot; what the Labs flag
 * changes is the WINDOW that total measures. Selected STRUCTURALLY rather than by
 * its `title`/qualifier text: those live in `@repo/app`, which this spec cannot
 * import (see the flag-key note above — a `@repo/*` subpath import aborts the
 * whole Electron run at load time), and a copied literal here would drift
 * silently into an unexplained "element not found". Position is the stable
 * contract; the exact title and qualifier are asserted on the web adapter by
 * `session-timeline-axis-tick-honesty.test.tsx`, which CAN import them.
 */
const AXIS_TOTAL_SELECTOR = ".sd3-act-axis > span:nth-child(2)";
const SESSION_TITLE_SELECTOR = ".sd3-head h1";
const MOUNT_TIMEOUT_MS = 30_000;

test.describe("Session Timeline axis window (ISS-4833 desktop adapter)", () => {
  test("the axis anchors on the plotted window, not the stale lifecycle end", async () => {
    test.setTimeout(240_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-axis-window-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts alongside the
    // seeded corpus.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-axis-window-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-axis-window-udd-")
    );
    const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      const first = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
        // …and the activity-segment schema this spec seeds, which the branch
        // wait does not cover (it lands in a later migration).
        await waitForActivitySegmentsSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      await seedSessionsList(userDataDir, [
        {
          at: new Date(SESSION_AT_MS).toISOString(),
          estimatedCost: 4.82,
          lastActivityAt: new Date(LAST_ACTIVITY_MS).toISOString(),
          name: SESSION_NAME,
          sessionId: SESSION_ID,
        },
      ]);
      await seedSessionActivitySegments(userDataDir, SESSION_ID, SEGMENTS);

      // Launch 2 — no flag seeding: the reconciliation is unconditional now.
      await assertAxisTotal(env, userDataDir, RECONCILED_AXIS_TOTAL);

      // The prior window and the reconciled one really do disagree on this
      // corpus, so the assertion above cannot be satisfied by the old
      // derivation quietly surviving.
      expect(PRIOR_AXIS_TOTAL).not.toBe(RECONCILED_AXIS_TOTAL);
    } finally {
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });
});

/** Launch the app on the seeded profile, open the session, read the axis total. */
async function assertAxisTotal(
  env: Record<string, string>,
  userDataDir: string,
  expectedTotal: string
): Promise<void> {
  const { page, pageErrors, cleanup } = await launchDesktopApp({
    env,
    keepUserDataDir: true,
    userDataDir,
  });
  try {
    await openSessionDetail(page);
    // The cell carries a qualifier before the value (ISS-4675), so anchor on the
    // value at the END of the label rather than restating that qualifier here.
    // The expected total is plain digits/letters, so it needs no escaping.
    await expect(page.locator(AXIS_TOTAL_SELECTOR)).toHaveText(
      new RegExp(`${expectedTotal}$`),
      { timeout: MOUNT_TIMEOUT_MS }
    );
    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
  }
}

/**
 * Drive the renderer to the seeded session detail and wait until THAT session's
 * panel is on screen. The session TITLE is the per-session barrier; the axis
 * itself renders on every session, so waiting on it alone could be satisfied by
 * a previous screen.
 */
async function openSessionDetail(page: Page): Promise<void> {
  await gotoHash(page, `/sessions/${SESSION_ID}`);
  await expect(page.locator(SESSION_TITLE_SELECTOR)).toHaveText(SESSION_NAME, {
    timeout: MOUNT_TIMEOUT_MS,
  });
  await expect(page.locator(".sd3-act-axis")).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
}
