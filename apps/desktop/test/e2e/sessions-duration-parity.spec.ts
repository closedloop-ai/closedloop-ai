/**
 * ISS-5131 (Electron twin of `e2e/sessions-duration-parity.spec.ts`): every
 * Sessions Duration surface must measure a completed session `started_at →
 * ended_at`, and neither of the two wrong inputs the reported defect came from —
 * a `last_activity_at` running past the session's own end, and a collector
 * `wallClock` derived from it — may reach any of them.
 *
 * The derivation is `packages/app/agents/lib/session-duration.ts`, mounted by
 * BOTH the web adapter and this renderer (`sessions-table-body.tsx` ->
 * `SyncedSessionsTable` -> `agentSessionToSessionTableRow`), so wongk's
 * cross-surface rule requires a real-surface regression on each adapter.
 *
 * The fixture reproduces the reported `019fb3e3` shape, scaled down: a session
 * started at T0 that really ended at T0 + 3h 33m, whose `last_activity_at` sits
 * at T0 + 4h 54m because it tracks sync rather than agent activity, and whose
 * collector wall window runs to that same later instant via a
 * `metadata.messages` turn (`SessionListSeed.traceMessageAt`) — so the emitted
 * `wallClock` reads "4h 54m". Both surfaces must show "3h 33m", and neither may
 * show "4h 54m".
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  breadcrumbParentLink,
  gotoNav,
  launchDesktopApp,
} from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SESSION_ID = "iss-5131-duration-parity";
const SESSION_NAME = "iss-5131 duration parity session";

const TRUE_SPAN_MS = 3 * 60 * 60 * 1000 + 33 * 60 * 1000;
const INFLATED_SPAN_MS = 4 * 60 * 60 * 1000 + 54 * 60 * 1000;

// Dated relative to the run clock, not pinned to a literal: `last_activity_at`
// is the boot retention sweep's age anchor (it deletes terminal sessions whose
// last activity predates the 90-day window), so a fixed past date would quietly
// become a time bomb that deletes the corpus once the calendar caught up.
const STARTED_AT = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
/** The session's own end — the only instant the Duration may be measured to. */
const ENDED_AT = new Date(Date.parse(STARTED_AT) + TRUE_SPAN_MS).toISOString();
/**
 * The later instant `last_activity_at` and the collector's wall window both
 * reach. `formatTraceDuration` renders that span as "4h 54m".
 */
const SYNC_ACTIVITY_AT = new Date(
  Date.parse(STARTED_AT) + INFLATED_SPAN_MS
).toISOString();

const EXPECTED_DURATION = "3h 33m";
/** The number the defect rendered. It must reach no Duration surface. */
const INFLATED_DURATION = "4h 54m";

/**
 * ISS-4675: the Session Timeline axis total's qualifier and its DOM hook. Mirror
 * of `SESSION_TIMELINE_AXIS_SPAN_PREFIX` / the `.sd3-act-span` class the axis
 * component renders; the desktop e2e tree cannot import `@repo/app` (the spec
 * runs against a packaged renderer), so the literals live here.
 */
const AXIS_SPAN_PREFIX = "calendar span";
const AXIS_SPAN_SELECTOR = ".sd3-act-span";
/** The opening words of the axis total's hover explanation. */
const AXIS_TITLE_RE = /Calendar time/;

const SEEDED: SessionListSeed[] = [
  {
    at: STARTED_AT,
    endedAt: ENDED_AT,
    // The defect's signature: activity recorded AFTER the session's own end,
    // because this column tracks sync rather than agent activity.
    lastActivityAt: SYNC_ACTIVITY_AT,
    name: SESSION_NAME,
    sessionId: SESSION_ID,
    status: "inactive",
    traceMessageAt: SYNC_ACTIVITY_AT,
  },
];

test.describe("Sessions Duration parity (ISS-5131)", () => {
  test("list cell and detail row both measure the session to its own ended_at", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-duration-parity-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts into the store,
    // polluting the seeded corpus this spec pins.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-duration-parity-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-duration-parity-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      // Seed while the app is DOWN (no cross-process WAL contention).
      await seedSessionsList(userDataDir, SEEDED);

      // Launch 2 — the real local IPC read path projects the seeded corpus.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "sessions");
        // Widen to "All time" so the seed is in range regardless of the default
        // window. `:visible` scopes to the mounted Sessions toolbar.
        await page.locator('[aria-label="All time"]:visible').click();

        // Prove the row rendered before asserting anything negative about it.
        const rowLink = page.getByRole("link", { name: SESSION_NAME });
        await expect(rowLink).toBeVisible({ timeout: 30_000 });

        const listDuration = page
          .locator('[role="row"]')
          .filter({ has: rowLink })
          .locator('[data-column-id="duration"]');

        // The LIST cell shows the session's own span...
        await expect(listDuration).toHaveText(EXPECTED_DURATION, {
          timeout: 30_000,
        });
        // ...never the sync-inflated span its `last_activity_at` and its
        // collector `wallClock` both carry.
        await expect(listDuration).not.toHaveText(INFLATED_DURATION);

        await rowLink.click();
        await expect(breadcrumbParentLink(page, "Sessions")).toBeVisible({
          timeout: 30_000,
        });

        // The Properties panel is collapsed by default; the Duration row is
        // inside it.
        await page
          .getByRole("button", { name: "Properties" })
          .filter({ visible: true })
          .click();
        const durationRow = page.locator(".prd-prop").filter({
          has: page.locator(".prd-prop-label", { hasText: "Duration" }),
        });

        // Same value, on the other surface.
        await expect(durationRow).toContainText(EXPECTED_DURATION, {
          timeout: 30_000,
        });
        await expect(durationRow).not.toContainText(INFLATED_DURATION);

        // ISS-4675: the Session Timeline axis on this SAME screen legitimately
        // reaches the LATER activity instant — it must cover every plotted
        // event — so it has to SAY which measure it is or the reader sees two
        // contradicting Durations. That is also why the exclusions above are
        // scoped to the Duration surfaces rather than to the whole page.
        //
        // The axis only mounts when the session has a rendered activity tiling;
        // a seeded session with none short-circuits to "No activity recorded".
        // Skip the assertion in that case rather than pinning the empty state,
        // which is not what this spec is about.
        const axisSpan = page.locator(AXIS_SPAN_SELECTOR);
        if ((await axisSpan.count()) > 0) {
          await expect(axisSpan.first()).toContainText(AXIS_SPAN_PREFIX, {
            timeout: 30_000,
          });
          await expect(axisSpan.first()).toHaveAttribute(
            "title",
            AXIS_TITLE_RE
          );
        }

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });
});
