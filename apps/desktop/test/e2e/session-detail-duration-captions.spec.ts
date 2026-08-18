/**
 * ISS-4902 (fix ISS-4791): the session-detail duration captions state ONE span in
 * ONE unit system, on the ELECTRON adapter.
 *
 * The Session Timeline axis total and the "Activity phases" caption directly
 * beneath it describe the SAME window. The reported defect was an axis reading a
 * bare rounded-up minute total ("728m") stacked above a caption reading "phases
 * span 12h 8m": two numbers, one span, and a reader left to do the unit math by
 * eye. ISS-4684 routed the axis through the same `formatDuration` the caption
 * uses; the shipped regressions are mounted Vitest tests over hand-built props
 * (`packages/app/agents/components/detail/__tests__/session-timeline-axis-format-parity.test.tsx`),
 * which prove the FORMATTER agrees but never that the LOCAL READ feeds the two
 * captions a reconcilable window — the desktop axis end comes from the SQLite
 * session row while the phases span comes from the seeded `session_activity_segments`
 * tiling, and nothing in a props-level test connects those two producers.
 *
 * This seeds a >1-hour tiling — the only span length at which the two unit systems
 * can visibly diverge, since under an hour `formatDuration` itself emits minutes —
 * and reads both captions off the launched renderer.
 *
 * SCOPE: captions only. The activity TAXONOMY half (ISS-4894 / the canonical
 * `ACTIVITY_PHASE_LABEL` map, the strip-vs-breakdown word parity, the two
 * catch-alls, and the retired "Other / unclassified" spelling) already landed on
 * BOTH adapters in #4234 (ISS-4896) — see `apps/desktop/test/e2e/activity-phase-label-parity.spec.ts`
 * here and `e2e/activity-phase-label-parity.spec.ts` on web. This spec deliberately
 * asserts nothing about phase words, so the two do not drift into duplicate
 * coverage of the same contract.
 *
 * Derivation independence (ISS-4792 / ISS-5366): the axis end comes from
 * `useSessionTimelineWindow`'s plotted-activity window. The seed drives the
 * session's `lastActivityAt` to the tiling END and never past it, so the window
 * end and the lifecycle anchors resolve to the same instant. This spec therefore
 * asserts a RECONCILIATION contract — the axis total equals the "phases span"
 * caption beneath it — rather than any particular resolver winning.
 *
 * What actually moves that `lastActivityAt` is NOT the `sessions.last_activity_at`
 * column: the desktop read re-derives the field per row as
 * `max(started_at, max(events.created_at))` (`sync-source.ts`), so a session whose
 * only event sits at its start projects `lastActivityAt === startedAt` no matter
 * what the column says, and the axis renders "calendar span 0s". The seed
 * therefore stamps a real activity event at the tiling end
 * (`SessionListSeed.activityEventAt`) and sets the column to the same instant, so
 * the projected value and the retention/date-window anchor agree.
 *
 * Strip fold hazard: `activity-segments-projection.ts` sets
 * `idleDominant = !truncated && nonIdleDurationMs / spanMs < 0.05` and the shell's
 * `defaultOpen = !idleDominant`, and a folded strip renders no `.sd3-segs-scale`
 * at all — which would make the comparison vacuous rather than red. The seeded
 * tiling is therefore 90% non-idle (75% implement / 15% validate / 10% idle,
 * mirroring the web fixture's ratio) and tiles the session's window EXACTLY, so
 * the phases caption is both present and equal to the axis.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
// Explicit `.ts`, as the sibling `@repo/…` specifiers in these Electron specs
// do: workspace packages resolve through the pnpm symlink and `@repo/api` ships
// no `exports` map. This module is deliberately dependency-free, so importing it
// pulls no further graph in.
import { SESSION_ACTIVITY_PHASES_FLAG_KEY } from "@repo/api/src/types/session-activity-phases-flag.ts";
import {
  gotoHash,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  type ActivitySegmentSeed,
  seedSessionActivitySegments,
  waitForActivitySegmentsSchema,
} from "./helpers/seed-activity-segments";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SESSION_ID = "iss-4902-duration-captions-session";
const SESSION_NAME = "ISS-4902 duration captions session";

const MINUTE_MS = 60_000;
/**
 * 12h 8m — the exact span from the ISS-4791 report, and the reason the seed is
 * anchored to the run clock rather than a fixed date: the desktop boot retention
 * sweep deletes terminal sessions whose `last_activity_at` predates its 90-day
 * window, so a hardcoded instant would silently start failing once it aged out.
 * The SPAN is what the assertions read, and it is invariant to the anchor.
 */
const SPAN_MINUTES = 12 * 60 + 8;
const SPAN_MS = SPAN_MINUTES * MINUTE_MS;
const TILING_END_MS = Date.now();
const TILING_START_MS = TILING_END_MS - SPAN_MS;
/** What `formatDuration` (packages/app/shared/lib/format-utils.ts) emits for it. */
const EXPECTED_SPAN_LABEL = "12h 8m";

// A contiguous, exact tiling of the session's whole window: 75% implement, 15%
// validate, 10% idle. Non-idle share is 0.90, an order of magnitude above the
// projection's 0.05 fold threshold, so the strip opens by default.
const IMPLEMENT_END_MS = TILING_START_MS + Math.round(SPAN_MS * 0.75);
const VALIDATE_END_MS = TILING_START_MS + Math.round(SPAN_MS * 0.9);
const SEGMENTS: ActivitySegmentSeed[] = [
  {
    confidence: 0.94,
    endMs: IMPLEMENT_END_MS,
    evidenceLayers: ["declared"],
    phase: "implement",
    startMs: TILING_START_MS,
  },
  {
    confidence: 0.81,
    endMs: VALIDATE_END_MS,
    evidenceLayers: ["structural"],
    phase: "validate",
    startMs: IMPLEMENT_END_MS,
  },
  {
    confidence: 0,
    endMs: TILING_END_MS,
    evidenceLayers: [],
    phase: "idle",
    startMs: VALIDATE_END_MS,
  },
];

// `SESSION_TIMELINE_AXIS_SPAN_PREFIX` (packages/app/agents/lib/session-duration.ts)
// and the `spanLabel` template in `session-activity-segments.tsx`. Pinned as
// literals rather than imported: those modules are `@repo/app` `.tsx` components
// whose self-referencing specifiers only resolve through the renderer's vite
// alias, and importing one aborts the WHOLE Electron suite at load before any
// test runs. Keep in sync with those SSOTs if the wording ever changes.
const AXIS_SPAN_PREFIX = "calendar span";
const PHASES_SPAN_PREFIX = "phases span";

// The axis total, which rides `SESSION_TIMELINE_AXIS_SPAN_TITLE` on its `title` —
// the only titled span in the axis row (the two flanking ticks carry none).
const AXIS_SPAN_SELECTOR = ".sd3-act-axis span[title]";
// The `aria-hidden` scale caption under the phases strip.
const PHASES_SCALE_SELECTOR = ".sd3-segs-scale";
// The session-detail `<h1>` renders `name ?? externalSessionId` — the only
// PER-SESSION barrier on this screen, so it is what "the detail mounted" waits on.
const SESSION_TITLE_SELECTOR = ".sd3-head h1";
/**
 * The ISS-4791 defect shape: a bare rounded-up minute total. `formatDuration`
 * cannot emit this above an hour (it switches to `Hh Mm`), so a match means the
 * axis has fallen back to the minute-scale helper the caption never used.
 */
const BARE_MINUTES_PATTERN = /^\d+m$/;
const MOUNT_TIMEOUT_MS = 30_000;

test.describe("Session detail duration captions (ISS-4902)", () => {
  test("the timeline axis and the phases caption state one span in one unit system", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-duration-captions-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts alongside the seed.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-duration-captions-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-duration-captions-udd-")
    );

    try {
      // Launch 1 — create + migrate the schema, then close so the seed writes
      // with the app DOWN (a running app does not observe another process's
      // writes to its own store).
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
        // …and the activity-segment schema this spec seeds, which the branch wait
        // does NOT cover: its last requirement is `sessions.last_activity_at`
        // (migration 0005), while `session_activity_segments` lands in 0011 and
        // its `subagent_id` column only in 0022. Returning after 0005 and closing
        // the app here would leave the segment seed polling for columns no live
        // migration host is left to create.
        await waitForActivitySegmentsSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      // `at` stamps started_at/ended_at/updated_at; `activityEventAt` writes the
      // event row the projected `lastActivityAt` is derived from, and the
      // `lastActivityAt` column pins the same instant for the date window and
      // the retention sweep. That projected value is the axis end under BOTH
      // states of the reconciliation flag precisely because it is never earlier
      // than `endedAt` (see the flag-independence note above).
      await seedSessionsList(userDataDir, [
        {
          activityEventAt: new Date(TILING_END_MS).toISOString(),
          at: new Date(TILING_START_MS).toISOString(),
          lastActivityAt: new Date(TILING_END_MS).toISOString(),
          name: SESSION_NAME,
          sessionId: SESSION_ID,
        },
      ]);
      await seedSessionActivitySegments(userDataDir, SESSION_ID, SEGMENTS);

      // Launch 2 — the real local detail read projects the seeded tiling.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        // ISS-5841: the phases caption rides on the phases strip, a Labs toggle
        // that is default OFF. This spec's whole subject is the axis and that
        // caption agreeing on one unit system, so it opts the gate ON — with the
        // gate shut there is no caption to compare the axis against.
        beforeLaunch: (dir) => {
          seedDesktopFeatureFlags(dir, {
            [SESSION_ACTIVITY_PHASES_FLAG_KEY]: true,
          });
        },
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoHash(page, `/sessions/${SESSION_ID}`);
        await expect(page.locator(SESSION_TITLE_SELECTOR)).toHaveText(
          SESSION_NAME,
          { timeout: MOUNT_TIMEOUT_MS }
        );

        const axisSpan = page
          .locator(AXIS_SPAN_SELECTOR)
          .locator("visible=true")
          .first();
        await expect(axisSpan).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        // The strip renders its scale caption only while the disclosure is OPEN,
        // which the 90%-non-idle tiling guarantees; its presence is therefore also
        // the guard against a silently folded strip making this comparison vacuous.
        const phasesScale = page
          .locator(PHASES_SCALE_SELECTOR)
          .locator("visible=true")
          .first();
        await expect(phasesScale).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // Both captions state the seeded window, whole and in the SAME `Hh Mm`
        // system. Pinning the full strings (not merely their agreement) means a
        // change that made BOTH wrong together cannot pass.
        await expect(axisSpan).toHaveText(
          `${AXIS_SPAN_PREFIX} ${EXPECTED_SPAN_LABEL}`
        );
        await expect(phasesScale).toHaveText(
          `${PHASES_SPAN_PREFIX} ${EXPECTED_SPAN_LABEL}`
        );

        // …and the axis total is explicitly NOT the bare rounded-up minute form
        // that made "728m" sit above "12h 8m". Read off the live node so this
        // fails on what is painted, not on the constant asserted above.
        const axisSpanText = (await axisSpan.textContent())?.trim() ?? "";
        const axisDuration = axisSpanText.slice(AXIS_SPAN_PREFIX.length).trim();
        expect(axisDuration.length).toBeGreaterThan(0);
        expect(axisDuration).not.toMatch(BARE_MINUTES_PATTERN);

        // The same defect read from the other side: the phases caption's own
        // duration must agree with the axis's, character for character. This is
        // the reconciliation ISS-4902 is about — two captions, one span.
        const phasesScaleText = (await phasesScale.textContent())?.trim() ?? "";
        expect(phasesScaleText.slice(PHASES_SPAN_PREFIX.length).trim()).toBe(
          axisDuration
        );

        await page.screenshot({
          fullPage: true,
          path: test.info().outputPath("session-detail-duration-captions.png"),
        });

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
    }
  });
});
