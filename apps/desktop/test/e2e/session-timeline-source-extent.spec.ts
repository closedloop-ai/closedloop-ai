/**
 * Local SQLite source extent and the Desktop assignment must reach the
 * visible and accessible unmeasured interval disclosure.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  gotoHash,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

/**
 * The PostHog key gating the disclosure. Spelled as a LITERAL rather than
 * imported from `../../src/shared/feature-flags`: that module's extension-less
 * `@repo/api/src/types/...` specifiers do not resolve under Playwright's ESM
 * loader, and a spec-level import failure aborts the WHOLE desktop-e2e suite at
 * load time (same note in `session-timeline-synthesized-cost.spec.ts`). The copy
 * is pinned by the ISS-5850 case in
 * `apps/desktop/test/feature-flags-cross-surface.test.ts`, which asserts this
 * exact string against `SESSION_TIMELINE_SOURCE_EXTENT_FLAG_KEY`, so a rename
 * fails there rather than silently leaving this spec seeding a key nothing reads.
 */
const SOURCE_EXTENT_FLAG_KEY = "session-timeline-source-extent";

/**
 * What an uncovered column says. A literal for the same reason as the flag key —
 * its module is `@repo/app` UI code this spec cannot import. Pinned against the
 * exported `TIMELINE_UNMEASURED_INTERVAL_TOOLTIP` by the copy-parity case in
 * `packages/app/agents/components/detail/__tests__/session-timeline-source-extent.test.tsx`,
 * so a copy edit fails THERE with a message naming this spec.
 */
const UNMEASURED_INTERVAL_COPY = "Outside the measured stretch of this session";

const SESSION_ID = "iss-5850-source-extent-session";
const SESSION_NAME = "iss-5850 source extent session";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Truncated to the second: the seeder writes canonical ISO strings. */
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const STARTED_AT_MS = NOW_MS - 2 * HOUR_MS;
/** Ten minutes in — the far edge of what the collector will bin. See the header. */
const ENDED_AT_MS = STARTED_AT_MS + 10 * MINUTE_MS;
/** Forty minutes in — the last plotted transcript row, so the axis runs to here. */
const ACTIVITY_EVENT_AT_MS = STARTED_AT_MS + 40 * MINUTE_MS;

/*
 * The bars that actually answer a hover. `.sd3-bar2` alone also matches the
 * `aria-hidden` unread-tail divs, which carry no `onMouseEnter` and are pinned at
 * full height, so an unscoped scan can hover a dead element and time out on a
 * card that never mounts.
 */
const HOVERABLE_BAR_SELECTOR = ".sd3-bars2 button.sd3-bar2";
/** The wash an uncovered column wears instead of the observed-idle hatch. */
const UNMEASURED_BAR_SELECTOR = `${HOVERABLE_BAR_SELECTOR}.unmeasured`;
/** The same fact in the ACCESSIBILITY tree, so it is not a pointer-only claim. */
const UNMEASURED_NAMED_BAR_SELECTOR = `${HOVERABLE_BAR_SELECTOR}[aria-label*="${UNMEASURED_INTERVAL_COPY}"]`;
const SESSION_TITLE_SELECTOR = ".sd3-head h1";
const MOUNT_TIMEOUT_MS = 30_000;

test.describe("Session Timeline unmeasured intervals (ISS-5850 desktop adapter)", () => {
  test("washes the columns the collector never binned, and names them", async () => {
    test.setTimeout(240_000);

    await withSeededSession(
      { flagOn: true, prefix: "desktop-extent-on" },
      async (page) => {
        await expect(page.locator(HOVERABLE_BAR_SELECTOR).first()).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });

        const unmeasured = page.locator(UNMEASURED_BAR_SELECTOR);
        await expect(unmeasured.first()).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });

        // The pair that stops "withhold the whole strip" passing: the measured
        // stretch is a quarter of the axis, so some columns must survive.
        const unmeasuredCount = await unmeasured.count();
        const total = await page.locator(HOVERABLE_BAR_SELECTOR).count();
        expect(unmeasuredCount).toBeLessThan(total);

        // WCAG 1.4.1: one statement per withheld column, in BOTH trees — so the
        // two counts must agree exactly, not merely both be non-zero.
        await expect(page.locator(UNMEASURED_NAMED_BAR_SELECTOR)).toHaveCount(
          unmeasuredCount
        );
      }
    );
  });
});

/**
 * Launch the built app twice against ONE temp profile — once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real local session-detail read
 * projects the seeded corpus at boot. The flag is seeded on BOTH launches
 * because `seedE2eDesktopSettings` rewrites the assignment file each time.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only session is the seeded one.
 */
async function withSeededSession(
  { flagOn, prefix }: { flagOn: boolean; prefix: string },
  run: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const seedGate = (dir: string) => {
    if (flagOn) {
      seedDesktopFeatureFlags(dir, { [SOURCE_EXTENT_FLAG_KEY]: true });
    }
  };
  const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };

  try {
    const first = await launchDesktopApp({
      beforeLaunch: seedGate,
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedSessionsList(userDataDir, [
      {
        activityEventAt: new Date(ACTIVITY_EVENT_AT_MS).toISOString(),
        at: new Date(STARTED_AT_MS).toISOString(),
        endedAt: new Date(ENDED_AT_MS).toISOString(),
        estimatedCost: 4.82,
        lastActivityAt: new Date(NOW_MS).toISOString(),
        name: SESSION_NAME,
        sessionId: SESSION_ID,
      },
    ]);

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      beforeLaunch: seedGate,
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await gotoHash(page, `/sessions/${SESSION_ID}`);
      // The session TITLE is the per-session barrier; the strip renders on every
      // session, so waiting on it alone could be satisfied by a previous screen.
      await expect(page.locator(SESSION_TITLE_SELECTOR)).toHaveText(
        SESSION_NAME,
        { timeout: MOUNT_TIMEOUT_MS }
      );
      await run(page);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
}
