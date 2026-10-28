/**
 * The local SQLite event index must resolve to a timed transcript row before a timeline bar promises a jump. Timed rows provide the positive control.
 *
 * ISS-12276: the windowed trace's Electron twin of the web off-window jump in
 * `e2e/session-timeline-jump-position.spec.ts`, folded in here to reuse this
 * launch. A bar whose row is outside the mounted window must land that row in
 * the real scroller, below the sticky header.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { gotoHash, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";
import {
  type SessionEventSeed,
  seedSessionEvents,
} from "./helpers/seed-session-timeline-events";

const UNREPAIRABLE_SESSION_ID = "iss-5124-untimed-transcript-session";
const UNREPAIRABLE_SESSION_NAME = "ISS-5124 untimed transcript session";
const REPAIRED_SESSION_ID = "iss-5124-timed-transcript-session";
const REPAIRED_SESSION_NAME = "ISS-5124 timed transcript session";
const LONG_SESSION_ID = "iss-12276-long-transcript-session";
const LONG_SESSION_NAME = "ISS-12276 long transcript session";

const SESSION_TITLE_SELECTOR = ".sd3-head h1";
const BAR_SELECTOR = ".sd3-bars2 .sd3-bar2";
const SCROLLER_SELECTOR = ".sd3-scroll";
/** The transcript's landable anchors — `TRACE_ROW_SELECTOR` in the renderer. */
const TRACE_ANCHOR_SELECTOR = ".st [data-row]";
/** `TRACE_FLASH_CLASS` in the renderer: the anchor a jump landed on. */
const TRACE_FLASH_SELECTOR = ".st [data-row].st-flash";
const STICKY_HEAD_SELECTOR = ".sd3-stickyhead";
const HERE_SELECTOR = ".sd3-bars2-wrap .tl-here";
const JUMP_NAME = /^Jump to activity bucket/;
const INERT_NAME = /^Activity bucket/;

const MOUNT_TIMEOUT_MS = 30_000;

const SESSION_START = "2026-06-10T12:00:00.000Z";
const SESSION_END = "2026-06-10T14:00:00.000Z";
const START_MS = Date.parse(SESSION_START);
const EVENT_INTERVAL_MS = 3 * 60_000;

/**
 * Enough turns that the windowed trace mounts only a slice of them. A
 * non-prompt event between two prompts is its own group, so every prompt stays
 * its own anchor instead of coalescing into one bubble.
 */
const LONG_EVENT_COUNT = 600;
const LONG_EVENT_INTERVAL_MS = 10_000;
const LONG_INTERLEAVED_EVENT_TYPE = "Notification";

/**
 * Enough rows, with enough prose, that the transcript genuinely OVERFLOWS its
 * scroller. Below that threshold `scrollTop` is pinned at 0 by the browser and
 * "the transcript did not move" would be true of every session — which is what
 * {@link assertScrollerOverflows} exists to rule out before the assertion runs.
 */
const EVENT_COUNT = 40;

/**
 * `UserPromptSubmit` with a NULL `tool_name`: `eventKindToTimelineKind` routes
 * a type containing `"prompt"` to the `human` kind only when the event is not
 * tool-like, and that is what keeps each row its OWN transcript turn. A
 * tool-like event would be swallowed by `buildToolsTurn` into a single `tools`
 * card, and forty rows would collapse into one that cannot overflow anything.
 */
const PROMPT_EVENT_TYPE = "UserPromptSubmit";

/**
 * The last seeded row's text. Waiting on it proves the transcript finished
 * hydrating, which is what makes the scroller's extent stable enough to park
 * against. Matched on the leading prefix so `truncateDetail` cannot drop it.
 */
const LAST_ROW_TEXT = `ISS-5124 transcript row ${EVENT_COUNT - 1}`;

/** Where to park: part-way down, clear of both clamping ends. */
const PARK_FRACTION = 0.6;

/**
 * Largest `scrollTop` change still read as "did not move". Absorbs sub-pixel
 * rounding, not scrolling: the behaviour this test rules out moves the
 * transcript ~2000px.
 */
const SCROLL_DRIFT_TOLERANCE_PX = 24;

/**
 * The rows are identical across both sessions except for `createdAt`, so the
 * pair isolates exactly one variable. `null` is the ISS-5124 shape: the
 * projection copies it verbatim into `TurnItem.t` and `Date.parse` yields `NaN`
 * for `tMs`, which `hasTimedTraceRow` rejects — while the bucket fold has
 * already floored the same row into bucket 0 and stamped its `tl0`.
 */
function eventSeeds(timed: boolean): SessionEventSeed[] {
  return Array.from({ length: EVENT_COUNT }, (_, index) => ({
    createdAt: timed
      ? new Date(START_MS + index * EVENT_INTERVAL_MS).toISOString()
      : null,
    eventType: PROMPT_EVENT_TYPE,
    summary: `ISS-5124 transcript row ${index} — carrying enough prose to give the transcript scroller real content to overflow with`,
    toolName: null,
  }));
}

function longSessionSeeds(): SessionEventSeed[] {
  return Array.from({ length: LONG_EVENT_COUNT }, (_, index) => ({
    createdAt: new Date(
      START_MS + index * LONG_EVENT_INTERVAL_MS
    ).toISOString(),
    eventType:
      index % 2 === 0 ? PROMPT_EVENT_TYPE : LONG_INTERLEAVED_EVENT_TYPE,
    summary: `ISS-12276 transcript row ${index}`,
    toolName: null,
  }));
}

/**
 * `idle: true` is load-bearing, not cosmetic. A default `seedSessionsList` row
 * also writes its own `PreToolUse` event at a VALID instant, and that single
 * timed row is enough to give the untimed session a timed turn — which flips
 * `alignBucketRowsToTranscript` from the demotion branch onto the repair branch
 * and would leave this whole spec asserting nothing.
 */
async function seedBothSessions(userDataDir: string): Promise<void> {
  await seedSessionsList(userDataDir, [
    {
      at: SESSION_START,
      endedAt: SESSION_END,
      idle: true,
      name: UNREPAIRABLE_SESSION_NAME,
      sessionId: UNREPAIRABLE_SESSION_ID,
    },
    {
      at: SESSION_START,
      endedAt: SESSION_END,
      idle: true,
      name: REPAIRED_SESSION_NAME,
      sessionId: REPAIRED_SESSION_ID,
    },
    {
      at: SESSION_START,
      endedAt: SESSION_END,
      idle: true,
      name: LONG_SESSION_NAME,
      sessionId: LONG_SESSION_ID,
    },
  ]);
  await seedSessionEvents(
    userDataDir,
    UNREPAIRABLE_SESSION_ID,
    eventSeeds(false)
  );
  await seedSessionEvents(userDataDir, REPAIRED_SESSION_ID, eventSeeds(true));
  await seedSessionEvents(userDataDir, LONG_SESSION_ID, longSessionSeeds());
}

test.describe("session timeline jump honesty on the desktop adapter", () => {
  test("announces jumps only for locally resolved transcript rows", async () => {
    test.setTimeout(300_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5124-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts alongside the
    // seeded corpus.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5124-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5124-udd-")
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

      await seedBothSessions(userDataDir);

      // Launch 2 — the real local detail read projects the seeded rows.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        // ── The positive control, FIRST. ────────────────────────────────────
        // Identical rows, parseable instants. The repair succeeds, so the same
        // producer stamps bars that DO announce a jump. Asserted before the
        // absence so a strip that stopped rendering, a seeder that stopped
        // reaching the read, or a renamed control fails here — loudly — instead
        // of satisfying the absence below in silence.
        await openSessionDetail(
          page,
          REPAIRED_SESSION_ID,
          REPAIRED_SESSION_NAME
        );
        await expect(bars(page).first()).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        expect(
          await page.getByRole("button", { name: JUMP_NAME }).count()
        ).toBeGreaterThan(0);

        /*
         * ISS-6006: the positive control for the demotion treatment asserted on
         * the unrepaired session below. A bar that CAN jump wears neither mark,
         * so `.no-jump` matching nothing here is what makes it matching every
         * bar there mean something. Same page, same selector, opposite verdict.
         */
        const jumpableBars = page.getByRole("button", { name: JUMP_NAME });
        for (const bar of await jumpableBars.all()) {
          await expect(bar).toHaveAttribute("aria-disabled", "false");
        }
        await expect(page.locator(`${BAR_SELECTOR}.no-jump`)).toHaveCount(0);

        // ── The regression. ────────────────────────────────────────────────
        await openSessionDetail(
          page,
          UNREPAIRABLE_SESSION_ID,
          UNREPAIRABLE_SESSION_NAME
        );
        await expect(bars(page).first()).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });

        // Pre-fix, the bucket holding the untimed rows carried the producer's
        // raw array index and was named for a jump it could not make.
        await expect(page.getByRole("button", { name: JUMP_NAME })).toHaveCount(
          0
        );
        // …and the bars are all still here, named for what they are. Pinned
        // against the rendered bar count rather than a literal, so it tracks the
        // strip instead of freezing today's bucket arithmetic.
        const barCount = await bars(page).count();
        expect(barCount).toBeGreaterThan(0);
        await expect(
          page.getByRole("button", { name: INERT_NAME })
        ).toHaveCount(barCount);

        /*
         * ISS-6006: the demotion treatment itself, on PACKAGED Desktop, with no
         * Labs toggle seeded — the launch above seeds none, so this is the
         * shipped default.
         *
         * This is what the ISS-5479 gate used to hold back here, which is why
         * this spec previously left the class composition to the web twin. The
         * retirement makes this adapter the surface the change lands on, so the
         * announced state (`aria-disabled`) and the withdrawn affordance
         * (`.no-jump`) are pinned directly rather than by proxy. Every bar on
         * this fixture is inert, so both marks are asserted against the same
         * rendered `barCount` the name assertion above uses; the repaired
         * session's control proves the selector can come back empty.
         */
        await expect(page.locator(`${BAR_SELECTOR}.no-jump`)).toHaveCount(
          barCount
        );
        for (const bar of await page
          .getByRole("button", { name: INERT_NAME })
          .all()) {
          await expect(bar).toHaveAttribute("aria-disabled", "true");
        }

        // ── The behaviour behind the name. ─────────────────────────────────
        // Wait for the WHOLE transcript first. The detail hydrates its rows
        // after first paint, and until it has settled the scroller's own extent
        // is still growing — the first run of this spec parked against a
        // `scrollHeight` that measured 2091 on two attempts and 2042 on a third,
        // then failed by exactly the amount the content shifted underneath it.
        await expect(page.getByText(LAST_ROW_TEXT)).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await assertScrollerOverflows(page);

        // Prove a missing rendered anchor cannot explain the refused jump.
        await expect(page.locator(TRACE_ANCHOR_SELECTOR).first()).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });

        // Park the transcript AWAY from the top before clicking. This is what
        // makes the assertion falsifiable: the unrepaired `tl0` on this fixture
        // is the producer's index 0, so a pre-fix click resolved onto the first
        // anchor and yanked the reader back to the top. From `scrollTop` 0 that
        // is indistinguishable from doing nothing at all.
        //
        // Deliberately PART-WAY down rather than at the maximum. `scrollTop` is
        // clamped to `scrollHeight - clientHeight`, so a park at the very bottom
        // is silently dragged upward by any later shrink of the content — which
        // reads exactly like the scroll this test is trying to rule out.
        await parkScrollerMidway(page);
        const parked = await settleScrollTop(page);
        expect(parked).toBeGreaterThan(0);

        // Selected by ELEMENT, not by accessible name: the name is one of the
        // things this fix changes, so a name-keyed query would make the pre-fix
        // run fail on a missing element rather than on the wrong scroll.
        //
        // `dispatchEvent` rather than `click()`, and this is load-bearing.
        // `.sd3-bars2` lives INSIDE `.sd3-scroll` (the strip sits in the sticky
        // head of the very scroller under test), so Playwright's built-in
        // `scrollIntoViewIfNeeded` moves the transcript on its way to pressing
        // the bar — the harness perturbing the one quantity being measured. It
        // cost a deterministic 262px on all 11 attempts of the previous run,
        // which is indistinguishable from the app scrolling. Dispatching the
        // event drives the same React `onClick` with no viewport management.
        await bars(page).first().dispatchEvent("click");

        // Tolerance covers sub-pixel rounding and any last settling frame, and
        // is two orders of magnitude below the effect under test: the pre-fix
        // click resolved onto row 0 and travelled the whole parked distance back
        // to the top, so nothing this fix changes can hide inside it.
        //
        // The claim is the app's, not the harness's: `jumpToTimelineRow` returns
        // on `row == null` before reaching `scrollToTraceRow`, so a demoted bar
        // must leave the scroller exactly where the reader left it.
        expect(
          Math.abs((await settleScrollTop(page)) - parked)
        ).toBeLessThanOrEqual(SCROLL_DRIFT_TOLERANCE_PX);

        // ── ISS-12276: a jump to a row outside the mounted window. ─────────
        await openSessionDetail(page, LONG_SESSION_ID, LONG_SESSION_NAME);
        const longJumps = page.getByRole("button", { name: JUMP_NAME });
        await expect(longJumps.first()).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(page.locator(TRACE_ANCHOR_SELECTOR).first()).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        const mountedBefore = await maxMountedRow(page);

        // `dispatchEvent` for the reason given above: the strip sits inside
        // the scroller under test.
        await longJumps.last().dispatchEvent("click");

        // The landed anchor was not in the DOM before the click, sits in the
        // scroller's viewport below the sticky header, and the selection line
        // followed it.
        await expect
          .poll(async () => await landedPlacement(page, mountedBefore ?? 0), {
            timeout: MOUNT_TIMEOUT_MS,
          })
          .toEqual({
            aboveScrollerBottom: true,
            belowStickyHead: true,
            wasOffWindow: true,
          });
        expect(mountedBefore).not.toBeNull();
        await expect(page.locator(HERE_SELECTOR)).toHaveCount(1);

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

function bars(page: Page): Locator {
  return page.locator(BAR_SELECTOR);
}

async function scrollTop(page: Page): Promise<number> {
  return await page
    .locator(SCROLLER_SELECTOR)
    .evaluate((node) => node.scrollTop);
}

/** Proves the scroller can move at all, so "it did not move" means something. */
async function assertScrollerOverflows(page: Page): Promise<void> {
  await expect(page.locator(SCROLLER_SELECTOR)).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
  const overflow = await page
    .locator(SCROLLER_SELECTOR)
    .evaluate((node) => node.scrollHeight - node.clientHeight);
  expect(overflow).toBeGreaterThan(0);
}

/** Scroll part-way down, clear of the clamp at either end. */
async function parkScrollerMidway(page: Page): Promise<void> {
  await page.locator(SCROLLER_SELECTOR).evaluate((node, fraction) => {
    node.scrollTop = Math.floor(
      (node.scrollHeight - node.clientHeight) * fraction
    );
  }, PARK_FRACTION);
}

/**
 * The scroll offset once it has stopped moving on its own — a bounded wait on a
 * STABLE state rather than a fixed sleep, per `e2e/AGENTS.md`. Two consecutive
 * equal reads is the condition; `expect.poll` supplies the interval and the
 * timeout, so a scroller that never settles fails loudly instead of hanging.
 */
async function settleScrollTop(page: Page): Promise<number> {
  let previous = await scrollTop(page);
  await expect
    .poll(async () => {
      const current = await scrollTop(page);
      const isStable = current === previous;
      previous = current;
      return isStable;
    })
    .toBe(true);
  return previous;
}

/**
 * Drive the renderer to a session detail and wait until THAT session's panel is
 * on screen. The title is the first barrier because `gotoHash` only assigns
 * `window.location.hash` and returns, while the timeline strip is rendered by
 * every session and would already be satisfied by a previously-mounted screen —
 * which matters here, where one page visits two sessions in sequence.
 */
async function openSessionDetail(
  page: Page,
  sessionId: string,
  sessionName: string
): Promise<void> {
  await gotoHash(page, `/sessions/${sessionId}`);
  await expect(page.locator(SESSION_TITLE_SELECTOR)).toHaveText(sessionName, {
    timeout: MOUNT_TIMEOUT_MS,
  });
}

/** The highest `data-row` among the anchors the windowed trace has mounted. */
async function maxMountedRow(page: Page): Promise<number | null> {
  return await page
    .locator(SCROLLER_SELECTOR)
    .evaluate((scroller, selector) => {
      const rows = Array.from(
        scroller.querySelectorAll<HTMLElement>(selector),
        (node) => Number(node.dataset.row)
      ).filter(Number.isFinite);
      return rows.length > 0 ? Math.max(...rows) : null;
    }, TRACE_ANCHOR_SELECTOR);
}

/** Where the anchor the jump flashed sits, measured with the real layout. */
async function landedPlacement(page: Page, mountedBefore: number) {
  return await page.locator(SCROLLER_SELECTOR).evaluate(
    (scroller, { flashSelector, mountedMax, stickySelector }) => {
      const landed = scroller.querySelector<HTMLElement>(flashSelector);
      if (!landed) {
        return null;
      }
      const top = landed.getBoundingClientRect().top;
      const stickyBottom =
        scroller.querySelector(stickySelector)?.getBoundingClientRect()
          .bottom ?? scroller.getBoundingClientRect().top;
      return {
        aboveScrollerBottom: top < scroller.getBoundingClientRect().bottom,
        belowStickyHead: top >= stickyBottom - 1,
        wasOffWindow: Number(landed.dataset.row) > mountedMax,
      };
    },
    {
      flashSelector: TRACE_FLASH_SELECTOR,
      mountedMax: mountedBefore,
      stickySelector: STICKY_HEAD_SELECTOR,
    }
  );
}
