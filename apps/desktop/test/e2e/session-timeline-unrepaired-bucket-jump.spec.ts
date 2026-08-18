/**
 * Session Timeline jump HONESTY on the launched desktop renderer: a control on
 * this strip never claims something the transcript did not do. Two regressions,
 * one launched app.
 *
 * - **ISS-5124** — a bar never ANNOUNCES a jump it cannot make.
 * - **ISS-5843** — the selection line never MOVES to a place the transcript did
 *   not go.
 *
 * They share this file rather than owning one each because
 * `apps/desktop/test/AGENTS.md` ("Add the regression to the existing harness
 * spec rather than a new one where possible") is a cost rule with teeth here:
 * `apps/desktop/playwright.config.ts` runs a handful of workers, not one per
 * spec, so a sibling spec is two more Electron launches plus another schema
 * migration on every required `desktop-e2e` run. And the seed ISS-5843
 * needs already existed: {@link REPAIRED_SESSION_ID} is forty timed rows over
 * the same window with the same prose, which is precisely its precondition.
 *
 * The web twin is `e2e/session-timeline-unrepaired-bucket-jump.spec.ts`. Both
 * drive the SAME shared `AgentSessionDetailView` out of `@repo/app` — the markup
 * and CSS are byte-identical across surfaces — but the DATA behind it comes from
 * entirely different producers: the cloud detail projection on web, the local
 * SQLite read here. Per `packages/app/AGENTS.md` ("UI bug fix ⇒ regression e2e",
 * "cover every adapter that mounts the surface") that makes this a required
 * second regression, not a duplicate of the first.
 *
 * ## The bug is BORN on this adapter
 *
 * It is the desktop producer that mints the number the bar lies about.
 * `buildTraceActivityFields` (`main/database/session-trace.ts`) folds the
 * sync-time TIMELINE-EVENT array and writes `bucket.tl0 ??= index` — an index
 * into THAT array, in a different numbering space from `turnItems._row`.
 * `alignBucketRowsToTranscript` is the only thing that ever converts one into
 * the other, and it bails when the transcript carries no timed row; the raw
 * index then survived into `tl0`, which is the entire basis on which
 * `getBucketButtonLabel` promises `Jump to activity bucket …`.
 *
 * The two folds disagree about the SAME rows, and that is what this fixture
 * exploits rather than fabricates: `bucketIndex` FLOORS an unparseable instant
 * into bucket 0, so an untimed event still sets `tl0`, while `hasTimedTraceRow`
 * REJECTS that same row, so the repair has nothing to work from. One fold keeps
 * the row, the other drops it. `events.created_at` is a genuinely nullable
 * column with no default and no filter on the read path (see
 * `helpers/seed-session-timeline-events.ts` for the schema citations), so this
 * is a real population, not a contrived one.
 *
 * ## Every assertion here is paired
 *
 * The claims are absences — no bar named `Jump to activity bucket`, no scroll —
 * and an absence passes just as well when nothing rendered. So the spec seeds
 * TWO sessions that differ in EXACTLY one respect: whether their event rows
 * carry a parseable `created_at`. Same count, same summaries, same session
 * window, same seeding path. {@link REPAIRED_SESSION_ID} is the positive control
 * for the label absence, and the scroll case asserts against a scroller this
 * spec first proves can move.
 *
 * ISS-6006 moved the `.no-jump` demotion here. It used to be left to the web
 * twin because the ISS-5479 gate was a Labs toggle that defaulted OFF, so this
 * adapter never painted it and the web surface was the only one that could be
 * asserted. Retiring that gate as ENABLED makes packaged Desktop the surface the
 * change actually lands on, so the announced state and the withdrawn affordance
 * are pinned on BOTH fixtures below — present on every unrepaired bar, absent on
 * every repaired one — rather than deferred. The `.reach` composition stays with
 * the web twin; nothing about the retirement changed where it renders.
 *
 * ## ISS-5843, and why it runs on the repaired session FIRST
 *
 * Since ISS-5819 the strip holds ONE position model: the active row resolves to
 * an absolute column that both the `.tl-here` marker and the scrubber thumb
 * read. `useTraceJump` committed that row BEFORE it knew whether the scroll
 * could land, so a click resolving to `EmptyTranscript` still moved the marker
 * onto a bucket the transcript never went to — the UI stating a location the
 * reader was never taken to.
 *
 * That scenario needs jumpABLE bars (an unjumpable one returns before
 * `scrollToTraceRow` and would satisfy the absence for ISS-5124's reason
 * instead), so it runs against {@link REPAIRED_SESSION_ID} — on the SAME visit
 * that already serves as ISS-5124's positive control. It goes first because its
 * own control asserts a pristine `.tl-here` (nothing clicked yet), which only a
 * freshly launched app can guarantee; and because it ends by stripping that
 * page's `[data-row]` anchors, a mutation the later navigation to
 * {@link UNREPAIRABLE_SESSION_ID} discards with the remount.
 *
 * Anchors are stripped rather than seeded away because this adapter is where
 * the reachable production shape lives. `session-transcript-panel.tsx` opens the
 * strip's `hasRenderedRows` gate off the RESOLVED items, while
 * `renderTranscriptContent`'s oversized branch pre-empts the projection and
 * paints "Large transcript / Load full transcript" with no `SessionTrace` at
 * all. The gate reads what the panel resolved; `planTraceScroll` reads what it
 * PAINTED. Removing the attributes reproduces exactly the fact
 * `findTraceScrollTarget` observes, without seeding a transcript over the
 * oversized branch's byte threshold.
 *
 * Its load-bearing claim is that the marker does not MOVE — not that it
 * disappears. After a landing click the reader is legitimately parked
 * somewhere, and `activeRow` is never written back to `null`. A "did not move"
 * claim is vacuous if the two bars it uses resolve to the same place, so the
 * spec first drives both bars with the anchors INTACT and asserts they land on
 * different positions.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
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

const SESSION_TITLE_SELECTOR = ".sd3-head h1";
const BAR_SELECTOR = ".sd3-bars2 .sd3-bar2";
const SCROLLER_SELECTOR = ".sd3-scroll";
const HERE_SELECTOR = ".sd3-bars2-wrap .tl-here";
/** The transcript's landable anchors — `TRACE_ROW_SELECTOR` in the renderer. */
const TRACE_ANCHOR_SELECTOR = ".st [data-row]";
const JUMP_NAME = /^Jump to activity bucket/;
const INERT_NAME = /^Activity bucket/;

const MOUNT_TIMEOUT_MS = 30_000;

const SESSION_START = "2026-06-10T12:00:00.000Z";
const SESSION_END = "2026-06-10T14:00:00.000Z";
const START_MS = Date.parse(SESSION_START);
const EVENT_INTERVAL_MS = 3 * 60_000;

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
  ]);
  await seedSessionEvents(
    userDataDir,
    UNREPAIRABLE_SESSION_ID,
    eventSeeds(false)
  );
  await seedSessionEvents(userDataDir, REPAIRED_SESSION_ID, eventSeeds(true));
}

test.describe("session timeline jump honesty on the desktop adapter", () => {
  test("announces no jump it cannot make, and moves the selection line only where the transcript went", async () => {
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

        // ── ISS-5843, on this same repaired page. ──────────────────────────
        await assertSelectionLineMovesOnlyWhereTranscriptWent(page);

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

        // This transcript really does carry landable anchors. Load-bearing
        // because the ISS-5843 scenario above ends by STRIPPING them from the
        // repaired session's DOM: if the navigation here did not remount the
        // panel, `planTraceScroll` would return null, the click below would not
        // move the scroller for a reason that has nothing to do with ISS-5124,
        // and the "did not move" claim would pass vacuously.
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

/** The marker's left offset, or `null` when the strip states no position. */
async function hereLeft(page: Page): Promise<string | null> {
  const marker = page.locator(HERE_SELECTOR);
  if ((await marker.count()) === 0) {
    return null;
  }
  return await marker.evaluate((node) => (node as HTMLElement).style.left);
}

/**
 * Press a bar that ANNOUNCES a jump. A bucket with no anchor returns before
 * `scrollToTraceRow` and would satisfy "nothing moved" for ISS-5124's reason
 * rather than ISS-5843's.
 *
 * `dispatchEvent` rather than `click()`, and this is load-bearing for the same
 * reason it is in ISS-5124's own click below: `.sd3-bars2` lives INSIDE
 * `.sd3-scroll`, so Playwright's built-in `scrollIntoViewIfNeeded` moves the
 * transcript on its way to pressing the bar — the harness perturbing the one
 * quantity being measured. Dispatching drives the same React `onClick` with no
 * viewport management.
 */
async function clickJumpableBar(
  page: Page,
  which: "first" | "last"
): Promise<void> {
  const jumpable = page.getByRole("button", { name: JUMP_NAME });
  const target = which === "first" ? jumpable.first() : jumpable.last();
  await target.dispatchEvent("click");
}

/**
 * Reproduce the resolved-but-unpainted transcript: the panel still reports
 * rendered rows, so the bars stay live, but nothing carries the anchor attribute
 * `findTraceScrollTarget` looks for.
 */
async function unpaintTranscriptAnchors(page: Page): Promise<void> {
  // The selector is passed IN rather than closed over: `evaluate` serializes
  // its callback into the page, where a Node-side module constant is not in
  // scope.
  await page.locator(SCROLLER_SELECTOR).evaluate((node, selector) => {
    for (const row of node.querySelectorAll(selector)) {
      row.removeAttribute("data-row");
    }
  }, TRACE_ANCHOR_SELECTOR);
}

/**
 * ISS-5843 on the repaired session: the selection line moves only where the
 * transcript actually went. See this file's header for why it runs here, on
 * this visit, before the navigation to the unrepairable session.
 */
async function assertSelectionLineMovesOnlyWhereTranscriptWent(
  page: Page
): Promise<void> {
  // Wait for the WHOLE transcript: the detail hydrates its rows after first
  // paint, and until it settles the scroller's extent is still growing under
  // any offset parked against it.
  await expect(page.getByText(LAST_ROW_TEXT).first()).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
  await assertScrollerOverflows(page);

  // Two distinct jumpable bars are required below; one cannot land in two
  // places.
  expect(
    await page.getByRole("button", { name: JUMP_NAME }).count()
  ).toBeGreaterThan(1);

  // ── The positive control, FIRST. ──────────────────────────────────────────
  // Before any interaction the strip states no position rather than guessing
  // one. This is why the scenario runs on a freshly launched app.
  await expect(page.locator(HERE_SELECTOR)).toHaveCount(0);

  await clickJumpableBar(page, "first");

  // The marker appears because the transcript really went somewhere. The scroll
  // is settled BEFORE the marker is read: a late scroll event can drive
  // `activeRow` itself, so reading first would capture a value the final
  // comparison is no longer entitled to.
  await expect(page.locator(HERE_SELECTOR)).toHaveCount(1);
  expect(await settleScrollTop(page)).toBeGreaterThan(0);
  const firstLeft = await hereLeft(page);
  expect(firstLeft).not.toBeNull();

  // The two bars must resolve to DIFFERENT positions, and that is asserted
  // rather than assumed: the regression below turns entirely on the marker NOT
  // arriving at the last bar's position, which is vacuous if both bars land on
  // the same one. Two distinct bars can still share a column, so the count
  // above is not this claim.
  await clickJumpableBar(page, "last");
  const lastLeft = await hereLeft(page);
  expect(lastLeft).not.toBe(firstLeft);

  // Back to the first bar, so the position under test is a known one.
  await clickJumpableBar(page, "first");
  expect(await hereLeft(page)).toBe(firstLeft);

  // ── The regression. ───────────────────────────────────────────────────────
  // Only the transcript's painted anchors change, which is the one fact
  // `planTraceScroll` reads.
  //
  // The claim is that the marker does not MOVE, not that it disappears: the
  // reader is legitimately still parked where the last landing put them, and
  // `activeRow` is never written back to null. Pre-fix the position was
  // committed before the scroll was attempted, so this click slid the marker to
  // `lastLeft` while the transcript stayed put.
  await unpaintTranscriptAnchors(page);
  await parkScrollerMidway(page);
  const parked = await settleScrollTop(page);
  expect(parked).toBeGreaterThan(0);

  await clickJumpableBar(page, "last");

  expect(Math.abs((await settleScrollTop(page)) - parked)).toBeLessThanOrEqual(
    SCROLL_DRIFT_TOLERANCE_PX
  );
  expect(await hereLeft(page)).toBe(firstLeft);
}
