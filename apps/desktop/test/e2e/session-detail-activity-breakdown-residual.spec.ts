/**
 * ISS-5128 (Electron twin): the Activity breakdown's `Derived` mode reconciles
 * its header to the session's OWN cost by carrying the shortfall in an explicit
 * `Unattributed` row — instead of heading itself with the smaller sum of the
 * priced phases.
 *
 * The web twin is `e2e/session-detail-activity-breakdown-residual.spec.ts`. Both
 * drive the SAME shared panel out of `@repo/app`
 * (`agents/components/detail/session-activity-breakdown.tsx`), but the two
 * adapters feed it from entirely different producers — a mocked cloud detail
 * payload on web, the local SQLite read (`shared-agent-sessions-api.ts`
 * `mapDetail`) here — and gate it behind different flag mechanisms (PostHog on
 * web, the persisted Labs setting here). Per `apps/desktop/AGENTS.md` a renderer
 * UI fix needs a real-surface regression on EACH adapter, so this spec exists to
 * prove the desktop half, not to re-prove the component.
 *
 * WHY THE FIXTURE LOOKS LIKE THIS. The defect only exists in `Derived` mode, and
 * Derived requires priced phases — `resolveActivitySegments` admits it only when
 * the per-phase costs sum ABOVE zero. On desktop those two dollar figures come
 * from two DIFFERENT tables, which is exactly why they can disagree:
 *   - the phases are priced from `token_events` (`mapDetail` calls
 *     `buildActivitySegments(session.activitySegmentRows, session.tokenEvents)`),
 *   - the session's own `estimatedCost` is `sumTokenUsage`, over `token_usage`.
 * So the fixture seeds the raw tiling, a SMALL set of priced `token_events`, and
 * a LARGER `token_usage` rollup. A tiling-only seed cannot reach this state at
 * all: with no token events every phase costs $0 and the panel resolves to
 * `CostUnavailable`, which reconciles by its own separate path and would make
 * the whole spec vacuous.
 *
 * BOTH flag states are covered over the SAME store and the SAME corpus, because
 * closed-by-default is the contract: the OFF launch must still render the
 * pre-fix (smaller) total with no residual row, or the gate is not load-bearing.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 *     (an isolated CODEX_HOME keeps the operator's real Codex rollouts out of
 *     the seeded store)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
// Explicit `.ts` (as the sibling `@repo/…` imports here do): this Electron
// Playwright spec resolves workspace packages through the pnpm symlink, and
// neither `@repo/api` nor `@repo/app` ships an `exports` map. All three modules
// are deliberately dependency-free constant modules, so importing them pulls no
// further graph in.
import { ACTIVITY_PHASE_LABEL } from "@repo/api/src/activity-phase-labels.ts";
import { SESSION_ACTIVITY_PHASES_FLAG_KEY } from "@repo/api/src/types/session-activity-phases-flag.ts";
import { ActivityBreakdownSlot } from "@repo/app/agents/lib/session-activity-phases.ts";
import {
  gotoHash,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  type ActivitySegmentSeed,
  type ActivityTokenEventSeed,
  seedSessionActivitySegments,
  seedSessionTokenEvents,
  waitForActivitySegmentsSchema,
} from "./helpers/seed-activity-segments";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SESSION_ID = "iss-5128-partially-attributed-session";
const SESSION_NAME = "iss-5128 partially attributed session";

const CLASSIFIER_VERSION = 5;
const MINUTE_MS = 60_000;
const TILING_START_MS = Date.parse("2026-06-10T12:00:00.000Z");

/**
 * Two contiguous, evidenced phases. Contiguous on purpose: a gap would let a
 * token event fall outside every span and accrue to the aggregator's synthesized
 * `other` remainder, silently adding a third row the assertions would then have
 * to explain.
 */
const SEGMENTS: ActivitySegmentSeed[] = [
  {
    confidence: 0.92,
    endMs: TILING_START_MS + 10 * MINUTE_MS,
    evidenceLayers: ["declared"],
    phase: "implement",
    startMs: TILING_START_MS,
  },
  {
    confidence: 0.74,
    endMs: TILING_START_MS + 20 * MINUTE_MS,
    evidenceLayers: ["structural"],
    phase: "review",
    startMs: TILING_START_MS + 10 * MINUTE_MS,
  },
];

/**
 * The priced events the detail read hands the aggregator — one interior to each
 * span, so each phase carries a positive cost (which is what makes the mode
 * `Derived`) and the row set stays exactly the two seeded phases.
 *
 * Every amount here and below is exactly representable in binary floating point,
 * so the expected strings are the arithmetic and not a rounding argument.
 */
const IMPLEMENT_COST_USD = 1.25;
const REVIEW_COST_USD = 2.25;
const TOKEN_EVENTS: ActivityTokenEventSeed[] = [
  {
    costUsd: IMPLEMENT_COST_USD,
    createdAt: new Date(TILING_START_MS + 5 * MINUTE_MS).toISOString(),
    inputTokens: 1200,
    outputTokens: 300,
  },
  {
    costUsd: REVIEW_COST_USD,
    createdAt: new Date(TILING_START_MS + 15 * MINUTE_MS).toISOString(),
    inputTokens: 800,
    outputTokens: 200,
  },
];

/** What the session actually cost, per its own `token_usage` rollup. */
const SESSION_COST_USD = 88.75;
const SESSION_COST_TEXT = "$88.75";

// The documented shared anchors on the breakdown's cells — asserted through
// `ActivityBreakdownSlot` rather than by currency-shaped text so the Cost
// assertions cannot also sweep up the header figure or the footer.
const PHASE_NAME_SELECTOR = `[data-slot="${ActivityBreakdownSlot.PhaseName}"]`;
const COST_CELL_SELECTOR = `[data-slot="${ActivityBreakdownSlot.CostCell}"]`;
// The panel's own landmark (`aria-label` on its `<section>`), so the header
// figure below is read out of THIS panel and not a sibling money strip.
const BREAKDOWN_SECTION_SELECTOR = 'section[aria-label="Activity breakdown"]';
// The header rollup: the `<span>` immediately after the panel's `<h2>`.
const BREAKDOWN_TOTAL_SELECTOR = `${BREAKDOWN_SECTION_SELECTOR} h2 + span`;
// The session-detail `<h1>` (`agent-session-detail-view.tsx`) — the only
// per-SESSION barrier on this screen, so a mount wait cannot be satisfied by a
// previous screen's still-mounted panel.
const SESSION_TITLE_SELECTOR = ".sd3-head h1";
const MOUNT_TIMEOUT_MS = 30_000;

/** `$` and the thousands separators `formatCost` emits. */
const CURRENCY_NOISE_PATTERN = /[$,]/g;

test.describe("Session detail Activity breakdown residual (ISS-5128)", () => {
  test("the breakdown header reconciles to the session cost and names the shortfall", async () => {
    test.setTimeout(240_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-breakdown-residual-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts alongside the
    // seeded corpus.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-breakdown-residual-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-breakdown-residual-udd-")
    );
    const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      // `waitForBranchesSchema` holds for the WHOLE migration history
      // (`waitForMigrationsApplied`), which is the only complete barrier: the
      // seeds below write columns from all over that history (`token_events`
      // arrives in 0001 but its `transport_id` only in 0043,
      // `session_activity_segments` in 0011 and its `subagent_id` in 0022), and
      // this launch is torn down immediately afterwards, freezing the schema
      // wherever the chain happened to be.
      const first = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
        await waitForActivitySegmentsSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      // The session and its `token_usage` rollup — `SessionListSeed.estimatedCost`
      // writes BOTH `sessions.cost_usd_estimated` and the `token_usage` row the
      // detail's `estimatedCost` is actually summed from.
      await seedSessionsList(userDataDir, [
        {
          estimatedCost: SESSION_COST_USD,
          name: SESSION_NAME,
          sessionId: SESSION_ID,
        },
      ]);
      await seedSessionActivitySegments(userDataDir, SESSION_ID, SEGMENTS, {
        classifierVersion: CLASSIFIER_VERSION,
      });
      await seedSessionTokenEvents(userDataDir, SESSION_ID, TOKEN_EVENTS);

      // Launch 2 — the seeded store and corpus. ISS-5366 retired the ISS-5000
      // gate, so the RECONCILIATION itself is unconditional: nothing here opts
      // into how the header computes its total.
      //
      // ISS-5841 then gated the Activity breakdown's phase region behind a Labs
      // toggle, default OFF, so the panel this spec reads is no longer mounted
      // on a stock profile. Seeding that toggle ON restores the surface under
      // test without weakening the assertion — the shortfall arithmetic below is
      // unchanged and still fails if the header stops reconciling.
      const on = await launchDesktopApp({
        beforeLaunch: (dir) => {
          seedDesktopFeatureFlags(dir, {
            [SESSION_ACTIVITY_PHASES_FLAG_KEY]: true,
          });
        },
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await openSessionDetail(on.page);

        // The fix, now unconditional: the header is the session's own cost, not
        // the attributed slice it used to present as the total.
        await expect(on.page.locator(BREAKDOWN_TOTAL_SELECTOR)).toHaveText(
          SESSION_COST_TEXT,
          { timeout: MOUNT_TIMEOUT_MS }
        );
        // And the missing spend is NAMED on screen as its own row rather than
        // folded into the header — a reconciled total whose column does not add
        // up is the same lie inverted.
        await expect(on.page.locator(PHASE_NAME_SELECTOR)).toHaveText(
          [
            ACTIVITY_PHASE_LABEL.implement,
            ACTIVITY_PHASE_LABEL.review,
            ACTIVITY_PHASE_LABEL.unattributed,
          ],
          { timeout: MOUNT_TIMEOUT_MS }
        );
        // The panel presents the Cost column as the decomposition of that
        // header, so the rendered cells must still add up to it — the residual
        // row buys reconciliation with the rest of the screen WITHOUT breaking
        // the decomposition.
        expect(await sumRenderedCostCents(on.page)).toBe(
          toCents(SESSION_COST_TEXT)
        );

        expect(on.pageErrors).toEqual([]);
      } finally {
        await on.cleanup();
      }
    } finally {
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });
});

/**
 * Drive the renderer to the seeded session's detail and wait until THAT
 * session's breakdown is on screen.
 *
 * The session TITLE is the first barrier: `gotoHash` only assigns
 * `window.location.hash` and returns, so a panel-shaped wait can be satisfied by
 * a previously-mounted screen. The breakdown's own header is the second, because
 * the Cost/phase reads below return `[]` on an unmounted panel, which would let
 * them pass vacuously.
 */
async function openSessionDetail(page: Page): Promise<void> {
  await gotoHash(page, `/sessions/${SESSION_ID}`);
  await expect(page.locator(SESSION_TITLE_SELECTOR)).toHaveText(SESSION_NAME, {
    timeout: MOUNT_TIMEOUT_MS,
  });
  await expect(page.locator(BREAKDOWN_TOTAL_SELECTOR)).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
}

/**
 * The whole Cost column as rendered, in cents. Read off the documented slot so a
 * future money cell elsewhere on the screen cannot join the sum, and compared in
 * integer cents so the assertion is about what the user sees rather than about
 * float equality.
 */
async function sumRenderedCostCents(page: Page): Promise<number> {
  const rendered = await page.locator(COST_CELL_SELECTOR).allTextContents();
  expect(rendered.length).toBeGreaterThan(0);
  return rendered.reduce((total, cell) => total + toCents(cell), 0);
}

/** A rendered `formatCost` string as integer cents. */
function toCents(rendered: string): number {
  const value = Number(rendered.trim().replace(CURRENCY_NOISE_PATTERN, ""));
  // An em dash (the cost-unavailable cell) parses to NaN — fail here, where the
  // reason is legible, rather than as a silently-wrong sum downstream.
  expect(Number.isFinite(value)).toBe(true);
  return Math.round(value * 100);
}
