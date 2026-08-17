/**
 * ISS-5818 (Electron twin): the Session DETAIL page's prototype-conformance
 * re-layout — status chip in the title, Properties above the Timeline, real `h2`
 * headings inside labelled landmarks — asserted through the LAUNCHED desktop
 * renderer reading a real seeded SQLite corpus.
 *
 * The web twin is `e2e/session-detail-prototype-parity.spec.ts`. Both drive the
 * same shared `AgentSessionDetailView` out of `@repo/app`, but per
 * `packages/app/AGENTS.md` a shared-view BUG FIX needs a real regression on EACH
 * adapter, and here the PRODUCER resolves differently:
 *
 *   - the case the #4739 review caught. On web the
 *     detail's `status` arrives already projected: `projectDisplayedSessionStatus`
 *     turns an awaiting-input row into `waiting` server-side. Here the local
 *     `mapDetail` inherits `mapListItem`'s status, and THAT projection is behind
 *     a SEPARATE Labs flag (`sessions-displayed-status-parity`), deliberately
 *     left OFF below. So this corpus reaches the renderer stored `active` with
 *     `awaiting_input_since` set — the shape that badged "Active" on desktop
 *     while the same session read "Waiting" on web.
 *
 * The bug was visual, so this asserts the corrected RENDERED state. ISS-5999
 * retired the `sessions-detail-prototype-parity` key, so the same-corpus gate-off
 * arm that used to make "the title has a chip" non-vacuous is gone; what replaces
 * it is that every assertion below pins something the pre-ISS-5818/5819 renderer
 * did not emit — a `role="heading"` where it drew a `span`, a named region where
 * it drew nothing, Properties BEFORE the timeline, and 24 columns instead of the
 * producer's own bins.
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

/** Rendered status labels — literals for the same loader reason as the key. */
const INACTIVE_STATUS_LABEL = "Inactive";
const WAITING_STATUS_LABEL = "Waiting";

const SESSION_ID = "iss-5818-prototype-parity-session";
const SESSION_NAME = "iss-5818 prototype parity session";
const WAITING_SESSION_ID = "iss-5818-awaiting-input-session";
const WAITING_SESSION_NAME = "iss-5818 awaiting input session";

const HOUR_MS = 3_600_000;
/** Truncated to the second: the seeder writes canonical ISO strings. */
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const STARTED_AT_MS = NOW_MS - 2 * HOUR_MS;
const ACTIVITY_EVENT_AT_MS = STARTED_AT_MS + 20 * 60_000;

/** The status chip beside the `h1`, scoped to the title row. */
const TITLE_CHIP_SELECTOR = '[data-slot="badge"]';
/** The transcript's own rows — the selector production's scroll code queries. */
const TRACE_ROW_SELECTOR = ".st [data-row]";
const PROPERTIES_SELECTOR = ".sd3-props";
const TIMELINE_SELECTOR = ".sd3-actbar";
/** ISS-5970: the timeline's header row, which the run-level summary trails. */
const TIMELINE_HEAD_SELECTOR = ".sd3-act-head";
/** A rendered duration, e.g. `2h 17m` — the shape the Duration chain prints. */
const DURATION_TEXT_PATTERN = /\d+\s*(h|m|s)/;
const TRACE_HEAD_SELECTOR = ".sd3-tracehead";
const MOUNT_TIMEOUT_MS = 30_000;

/*
 * ISS-5819: the timeline controls, and a session long enough to need them.
 *
 * The two sessions above run for two hours, which FITS the window at its opening
 * scale — correctly showing no scrubber. A spec that drove the controls on those
 * would be asserting the absence of a control for the right reason and reading it
 * as the feature working. This third session runs for 30 days, longer than
 * 24 x 12h, so the scrubber is on screen at every scale.
 *
 * The SEGMENT TILING is not decoration: `ActivityBucket` carries no timestamps,
 * so the tiling is what gives the strip its wall-clock extent on this adapter.
 * Without it a 30-day run measures as minutes and the scrubber never appears.
 */
const LONG_SESSION_ID = "iss-5819-timeline-controls-session";
const LONG_SESSION_NAME = "iss-5819 timeline controls session";
const LONG_RUN_MS = 30 * 24 * HOUR_MS;
const LONG_RUN_START_MS = NOW_MS - LONG_RUN_MS;
const LONG_RUN_SEGMENTS: ActivitySegmentSeed[] = [
  {
    confidence: 0.9,
    endMs: NOW_MS,
    evidenceLayers: ["structural"],
    phase: "implement",
    startMs: LONG_RUN_START_MS,
  },
];
const SCALE_GROUP_NAME = "Timeline scale";
/**
 * ISS-5819: the scale option to click, matched EXACTLY.
 *
 * `getByRole`'s `name` matches accessible names by SUBSTRING, and this control's
 * label set is built from the scale strings — so `"5m timeline scale"` is a
 * substring of `"15m timeline scale"` and a loose match resolves to two radios
 * and dies on strict mode. Only that one pair collides today, but the toggle's
 * labels are generated from `TIMELINE_SCALE_OPTIONS`, so a future scale is one
 * rename away from reintroducing it.
 *
 * `exact: true` rather than `.first()`: picking whichever renders earlier would
 * keep this test green while it silently clicked the wrong control, which is a
 * vacuous locator rather than a fix.
 */
const SCALE_OPTION_NAME = "5m timeline scale";
const SCRUBBER_NAME = "Session time position";
const GROUP_BY_NAME = /group by/i;
const AXIS_SELECTOR = ".sd3-act-axis";
const BAR_SELECTOR = ".sd3-bars2 .sd3-bar2";
const TIMELINE_VISIBLE_COLUMN_COUNT = 24;

test.describe("Session detail prototype parity (ISS-5818 desktop adapter)", () => {
  test("states the session's status in its title and exposes a real outline", async () => {
    test.setTimeout(240_000);

    await withSeededSessions({ prefix: "desktop-parity-on" }, async (page) => {
      // D1: the chip is a SIBLING on the title row, never part of the
      // heading's accessible name (WCAG 2.4.6).
      await expect(
        page.locator("h1").locator("..").locator(TITLE_CHIP_SELECTOR)
      ).toHaveText(INACTIVE_STATUS_LABEL, { timeout: MOUNT_TIMEOUT_MS });

      // D5: real headings inside labelled landmarks, asserted by ROLE so a
      // `span` restyled to look like a heading does not satisfy it.
      await expect(
        page.getByRole("heading", { level: 2, name: "Session Timeline" })
      ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      await expect(
        page.getByRole("heading", { level: 2, name: "Session Trace" })
      ).toBeVisible();
      await expect(
        page.getByRole("region", { name: "Session Trace" })
      ).toBeVisible();

      // D2: identity first, cost chart second — read from the live DOM, so
      // the packaged stylesheet is in the loop, not just the JSX.
      expect(await readRegionOrder(page)).toEqual([
        "title",
        "properties",
        "timeline",
        "trace",
      ]);

      /*
       * ISS-5970: the run-level summary, on the DESKTOP adapter. Asserted
       * here rather than in a spec of its own because each Electron launch
       * costs minutes, and this test already holds a gate-ON page mounted on
       * the seeded corpus. Scoped to the timeline header: the same figures
       * also appear in the Properties rows, so a page-wide match would pass
       * with the strip absent.
       */
      const timelineHead = page.locator(TIMELINE_HEAD_SELECTOR).first();
      await expect(timelineHead).toContainText("cost");
      await expect(timelineHead).toContainText("tokens");
      await expect(timelineHead).toContainText(DURATION_TEXT_PATTERN);

      // #4739 review (codex P2): the labelled region must CONTAIN the
      // transcript it claims to group.
      const traceRows = await page.locator(TRACE_ROW_SELECTOR).count();
      expect(traceRows).toBeGreaterThan(0);
      await expect(
        page
          .getByRole("region", { name: "Session Trace" })
          .locator(TRACE_ROW_SELECTOR)
      ).toHaveCount(traceRows);
    });
  });

  test("badges a locally-awaiting run Waiting, matching what web serves", async () => {
    test.setTimeout(240_000);

    await withSeededSessions(
      { prefix: "desktop-parity-waiting" },
      async (page) => {
        /*
         * #4739 review (wongk). The displayed-status parity Labs flag is OFF, so
         * the local read hands this view a raw `active` status with
         * `awaiting_input_since` set — the desktop-only shape. The chip has to
         * reach "Waiting" from the DTO's own fields, or enabling the layout flag
         * alone splits the two surfaces on the same session.
         */
        await gotoHash(page, `/sessions/${WAITING_SESSION_ID}`);
        await expect(page.locator("h1")).toHaveText(WAITING_SESSION_NAME, {
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(
          page.locator("h1").locator("..").locator(TITLE_CHIP_SELECTOR)
        ).toHaveText(WAITING_STATUS_LABEL, { timeout: MOUNT_TIMEOUT_MS });
      }
    );
  });

  /*
   * ISS-5819 (#4753 review, wongk): the timeline CONTROLS, driven through the
   * launched renderer.
   *
   * They sit behind the SAME Labs key as the re-layout above — ISS-5819 reuses
   * it rather than minting a second one — so this spec is where the desktop half
   * of that gate already lives, and the web twin
   * (`e2e/session-detail-prototype-parity.spec.ts`) drives the identical flow
   * against a PostHog gate and the cloud detail projection. Per
   * `packages/app/AGENTS.md`, the primary interaction on a shared view owes a
   * real regression on EACH adapter, and the two differ in both the gate and the
   * producer: this corpus reaches the shared view through a local SQLite read
   * whose strip and tiling are assembled here, not by a cloud projection.
   *
   * Asserted on EFFECT: a toggle wired to nothing still renders, but it cannot
   * make the axis name two different instants — those ticks are formatted from
   * the very window the bars are plotted over.
   */
  test("the timeline controls change which stretch of the run is on screen", async () => {
    test.setTimeout(240_000);

    await withSeededSessions(
      { prefix: "desktop-timeline-controls-on" },
      async (page) => {
        await gotoHash(page, `/sessions/${LONG_SESSION_ID}`);
        await expect(page.locator("h1")).toHaveText(LONG_SESSION_NAME, {
          timeout: MOUNT_TIMEOUT_MS,
        });

        // The window, not the producer's bin count.
        await expect(page.locator(BAR_SELECTOR)).toHaveCount(
          TIMELINE_VISIBLE_COLUMN_COUNT,
          { timeout: MOUNT_TIMEOUT_MS }
        );

        const scaleGroup = page.getByRole("group", {
          exact: true,
          name: SCALE_GROUP_NAME,
        });
        await expect(scaleGroup).toBeVisible();
        await expect(
          page.getByRole("combobox", { name: GROUP_BY_NAME })
        ).toBeVisible();

        const axis = page.locator(AXIS_SELECTOR);
        const beforeScale = await axis.innerText();
        await scaleGroup
          .getByRole("radio", { exact: true, name: SCALE_OPTION_NAME })
          .click();
        await expect(axis).not.toHaveText(beforeScale);
        await expect(page.locator(BAR_SELECTOR)).toHaveCount(
          TIMELINE_VISIBLE_COLUMN_COUNT
        );

        const scrubber = page.getByRole("slider", {
          exact: true,
          name: SCRUBBER_NAME,
        });
        await expect(scrubber).toBeVisible();
        const beforeScrub = await axis.innerText();
        await scrubber.focus();
        for (let step = 0; step < 30; step += 1) {
          await page.keyboard.press("ArrowRight");
        }
        await expect(axis).not.toHaveText(beforeScrub);
      }
    );
  });
});

/**
 * The four prototype-specified regions in DOM order, each identified by a stable
 * structural anchor. Production-only regions (Activity phases, Activity
 * breakdown) are deliberately not listed — they have no prototype counterpart,
 * so pinning them would make this spec fail on an unrelated ISS-5451 change.
 */
async function readRegionOrder(page: Page): Promise<string[]> {
  return await page.evaluate(
    ({ properties, timeline, traceHead }) => {
      const regionBySelector: [string, string][] = [
        ["h1", "title"],
        [properties, "properties"],
        [timeline, "timeline"],
        [traceHead, "trace"],
      ];
      const order: string[] = [];
      const nodes = document.querySelectorAll(
        regionBySelector.map(([selector]) => selector).join(", ")
      );
      for (const node of Array.from(nodes)) {
        const match = regionBySelector.find(([selector]) =>
          node.matches(selector)
        );
        // Named once, at its FIRST appearance: the timeline container class also
        // wraps its empty state, and a region repeating says nothing about order.
        if (match && !order.includes(match[1])) {
          order.push(match[1]);
        }
      }
      return order;
    },
    {
      properties: PROPERTIES_SELECTOR,
      timeline: TIMELINE_SELECTOR,
      traceHead: TRACE_HEAD_SELECTOR,
    }
  );
}

/**
 * Launch the built app twice against ONE temp profile — once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real local session-detail
 * read projects the seeded corpus at boot.
 *
 * NO Labs flag is seeded: ISS-5999 retired the layout gate, and
 * `sessions-displayed-status-parity` stays off, which is what makes the
 * awaiting-input row arrive stored `active`.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only sessions are the seeded ones.
 */
async function withSeededSessions(
  { prefix }: { prefix: string },
  run: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };

  try {
    const first = await launchDesktopApp({
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
        endedAt: new Date(NOW_MS).toISOString(),
        estimatedCost: 4.82,
        lastActivityAt: new Date(NOW_MS).toISOString(),
        name: SESSION_NAME,
        sessionId: SESSION_ID,
      },
      {
        activityEventAt: new Date(LONG_RUN_START_MS + HOUR_MS).toISOString(),
        at: new Date(LONG_RUN_START_MS).toISOString(),
        endedAt: new Date(NOW_MS).toISOString(),
        estimatedCost: 91.4,
        lastActivityAt: new Date(NOW_MS).toISOString(),
        name: LONG_SESSION_NAME,
        sessionId: LONG_SESSION_ID,
      },
      {
        activityEventAt: new Date(ACTIVITY_EVENT_AT_MS).toISOString(),
        at: new Date(STARTED_AT_MS).toISOString(),
        // Blocked on the user: not ended, and awaiting input since the last
        // activity. `waiting` is never a persisted status — the timestamp IS
        // the signal (root `AGENTS.md`).
        awaitingInputSince: new Date(NOW_MS).toISOString(),
        endedAt: null,
        estimatedCost: 1.5,
        lastActivityAt: new Date(NOW_MS).toISOString(),
        name: WAITING_SESSION_NAME,
        sessionId: WAITING_SESSION_ID,
        status: "active",
      },
    ]);
    await waitForActivitySegmentsSchema(userDataDir);
    await seedSessionActivitySegments(
      userDataDir,
      LONG_SESSION_ID,
      LONG_RUN_SEGMENTS
    );

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await gotoHash(page, `/sessions/${SESSION_ID}`);
      // The session TITLE is the per-session barrier; every session renders a
      // timeline, so waiting on the strip alone could be satisfied by a previous
      // screen.
      await expect(page.locator("h1")).toHaveText(SESSION_NAME, {
        timeout: MOUNT_TIMEOUT_MS,
      });
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
