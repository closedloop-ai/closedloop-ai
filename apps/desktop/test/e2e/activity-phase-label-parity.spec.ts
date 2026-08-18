/**
 * ISS-4896 (Electron twin): the canonical activity-phase label (ISS-4790 /
 * PR #4229) holds through the LAUNCHED desktop renderer.
 *
 * The web twin is `e2e/activity-phase-label-parity.spec.ts`. Both drive the same
 * shared panels out of `@repo/app` (the Activity phases strip and the Activity
 * breakdown beneath it), but the two adapters feed them from entirely different
 * producers — the cloud detail projection on web, the local SQLite read
 * (`shared-agent-session-detail-projection.ts` `mapDetail`) here — so per
 * `apps/desktop/AGENTS.md` a renderer UI fix needs a real-surface regression on
 * EACH adapter, not one plus an assumption.
 *
 * What this pins, and why it is not just "does the word match a constant":
 * during #4229 a concurrent lane reintroduced a third spelling inside the
 * strip's `describeKind`, so the strip named a span one word while the breakdown
 * directly below it named the SAME span another. The assertions therefore
 * compare the strip's word to the breakdown's word on the same rendered screen
 * first, and only then check the agreed word is canonical.
 *
 * The tiling is seeded straight into `session_activity_segments` because the
 * cases that matter are hard to provoke through the classifier: an EVIDENCED
 * catch-all span (projected `active`) and an EVIDENCE-FREE one (projected
 * `unavailable`) were mis-named in two different directions, and an unknown
 * compound key (`auto-review`) is the titleize case that read "Auto Review" on
 * one surface and "Auto-review" on another.
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
import {
  ACTIVITY_PHASE_LABEL,
  UNKNOWN_ACTIVITY_PHASE_LABEL,
} from "@repo/api/src/activity-phase-labels.ts";
import { SESSION_ACTIVITY_PHASES_FLAG_KEY } from "@repo/api/src/types/session-activity-phases-flag.ts";
import { labelize } from "@repo/api/src/utils/string.ts";
// Explicit `.ts` (as the sibling `@repo/…` imports here do): this Electron
// Playwright spec resolves workspace packages through the pnpm symlink, and
// neither `@repo/api` nor `@repo/app` ships an `exports` map. The module itself
// is deliberately dependency-free, so importing it pulls no further graph in.
import { ActivitySegmentKind } from "@repo/app/agents/components/activity/activity-segment-kind.ts";
import { ActivityBreakdownSlot } from "@repo/app/agents/lib/session-activity-phases.ts";
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

const TILED_SESSION_ID = "iss-4896-tiled-session";
const TILED_SESSION_NAME = "iss-4896 tiled session";
const UNTILED_SESSION_ID = "iss-4896-untiled-session";
const UNTILED_SESSION_NAME = "iss-4896 untiled session";

/** The unknown/future classifier key both surfaces must titleize identically. */
const UNKNOWN_PHASE_KEY = "auto-review";
/** Derived through the shared helper the three production resolvers now call. */
const UNKNOWN_PHASE_DISPLAY = labelize(UNKNOWN_PHASE_KEY);

const CLASSIFIER_VERSION = 5;
const MINUTE_MS = 60_000;
const TILING_START_MS = Date.parse("2026-06-10T12:00:00.000Z");

/**
 * The seeded tiling. ORDER IS LOAD-BEARING: the strip paints its slices
 * chronologically, so the Nth rendered tile names the Nth phase key here.
 */
const SEGMENTS: ActivitySegmentSeed[] = [
  {
    confidence: 0.92,
    endMs: TILING_START_MS + 10 * MINUTE_MS,
    evidenceLayers: ["declared"],
    phase: "implement",
    startMs: TILING_START_MS,
  },
  // Catch-all WITH evidence → `active` fill. Pre-#4229 the strip read this span
  // off its fill kind and fell through to the raw lowercase phase, so the tile
  // said "other" while the breakdown row said "Other".
  {
    confidence: 0.41,
    endMs: TILING_START_MS + 15 * MINUTE_MS,
    evidenceLayers: ["structural"],
    phase: "other",
    startMs: TILING_START_MS + 10 * MINUTE_MS,
  },
  // Catch-all WITHOUT evidence → `unavailable` fill. Pre-#4229 this tile read
  // "Unattributed" while the breakdown beneath it read "Other" for the same
  // milliseconds — and `unattributed` means spend the classifier never saw.
  {
    confidence: 0.08,
    endMs: TILING_START_MS + 20 * MINUTE_MS,
    evidenceLayers: [],
    phase: "other",
    startMs: TILING_START_MS + 15 * MINUTE_MS,
  },
  {
    confidence: 0.55,
    endMs: TILING_START_MS + 25 * MINUTE_MS,
    evidenceLayers: ["structural"],
    phase: UNKNOWN_PHASE_KEY,
    startMs: TILING_START_MS + 20 * MINUTE_MS,
  },
  // Short on purpose: a majority-idle tiling folds the strip behind a collapsed
  // disclosure, which would hide the tiles this spec reads.
  {
    confidence: 0,
    endMs: TILING_START_MS + 27 * MINUTE_MS,
    evidenceLayers: [],
    phase: "idle",
    startMs: TILING_START_MS + 25 * MINUTE_MS,
  },
];

const STRIP_PHASE_KEYS = SEGMENTS.map((segment) => segment.phase);
/** Distinct phase keys, in the order the breakdown rolls them up (first span). */
const BREAKDOWN_PHASE_KEYS = [...new Set(STRIP_PHASE_KEYS)];

// The strip's rendered slices — `data-seg-index` is the attribute the strip's
// own hover delegation resolves a tile by (the decorative `hidden` fills carry
// neither an index nor a label).
const STRIP_TILE_SELECTOR = "ul.sd3-segs-track li.sd3-seg[data-seg-index]";
// The documented shared anchor for the breakdown's bare phase NAME.
const BREAKDOWN_PHASE_NAME_SELECTOR = `[data-slot="${ActivityBreakdownSlot.PhaseName}"]`;
// The session-detail `<h1>` (`agent-session-detail-view.tsx`), which renders the
// session's own name — the only per-SESSION barrier on this screen.
const SESSION_TITLE_SELECTOR = ".sd3-head h1";
const SEGMENT_LABEL_SEPARATOR = " · ";
const MOUNT_TIMEOUT_MS = 30_000;

test.describe("Activity phase label parity (ISS-4896)", () => {
  test("the strip and the Activity breakdown name every span the same way, and the two catch-alls stay distinct", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-phase-label-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts alongside the
    // seeded corpus.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-phase-label-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-phase-label-udd-")
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
        // …and the activity-segment schema THIS spec seeds, which the branch
        // wait does not cover: its last requirement is `last_activity_at`
        // (migration 0005), while `session_activity_segments` lands in 0011 and
        // its `subagent_id` column only in 0022. Returning after 0005 and
        // closing the app here would leave `seedSessionActivitySegments` polling
        // for columns no live migration host is left to create.
        await waitForActivitySegmentsSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      await seedSessionsList(userDataDir, [
        { name: TILED_SESSION_NAME, sessionId: TILED_SESSION_ID },
        { name: UNTILED_SESSION_NAME, sessionId: UNTILED_SESSION_ID },
      ]);
      await seedSessionActivitySegments(
        userDataDir,
        TILED_SESSION_ID,
        SEGMENTS,
        {
          classifierVersion: CLASSIFIER_VERSION,
        }
      );

      // Launch 2 — the real local detail read projects the seeded tiling.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        // ISS-5841: the phases strip and Activity breakdown are a Labs toggle,
        // default OFF. Label parity between those two surfaces only means
        // anything while both render, so this spec opts the gate ON.
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
        await openSessionDetail(page, TILED_SESSION_ID, TILED_SESSION_NAME);

        const breakdownByKey = await readBreakdownPhaseNames(page);
        const stripWords = await readStripPhaseWords(page);

        // Every slice is named by the SAME word the breakdown row for its phase
        // uses. This never consults a constant — it is the assertion that would
        // have caught the reintroduced third spelling.
        expect(stripWords).toEqual(
          STRIP_PHASE_KEYS.map((key) => breakdownByKey.get(key))
        );

        // …and the word they agree on is the canonical one, so "wrong together"
        // is not a way to pass.
        expect(breakdownByKey.get("implement")).toBe(
          ACTIVITY_PHASE_LABEL.implement
        );
        expect(breakdownByKey.get("other")).toBe(ACTIVITY_PHASE_LABEL.other);
        expect(breakdownByKey.get("idle")).toBe(ACTIVITY_PHASE_LABEL.idle);
        expect(breakdownByKey.get(UNKNOWN_PHASE_KEY)).toBe(
          UNKNOWN_PHASE_DISPLAY
        );
        expect(UNKNOWN_PHASE_DISPLAY).not.toBe(UNKNOWN_ACTIVITY_PHASE_LABEL);

        // The evidence-free catch-all carries a DIFFERENT fill but the SAME
        // word: the missing-evidence distinction belongs in the encoding, not in
        // a word that contradicts the row beside it.
        const tiles = page.locator(STRIP_TILE_SELECTOR);
        const evidencedIndex = STRIP_PHASE_KEYS.indexOf("other");
        const evidenceFreeIndex = STRIP_PHASE_KEYS.lastIndexOf("other");
        expect(evidenceFreeIndex).toBeGreaterThan(evidencedIndex);
        await expect(tiles.nth(evidencedIndex)).toHaveAttribute(
          "data-kind",
          ActivitySegmentKind.Active
        );
        await expect(tiles.nth(evidenceFreeIndex)).toHaveAttribute(
          "data-kind",
          ActivitySegmentKind.Unavailable
        );
        expect(stripWords[evidenceFreeIndex]).toBe(ACTIVITY_PHASE_LABEL.other);
        expect(stripWords[evidenceFreeIndex]).not.toBe(
          ACTIVITY_PHASE_LABEL.unattributed
        );

        // A session with NO tiling at all is the OTHER catch-all: the classifier
        // never saw it, so its single honest row must read `unattributed`, not
        // the `other` word the tiled session above renders. Collapsing the two
        // would make these two screens claim the same thing about different data.
        await openSessionDetail(page, UNTILED_SESSION_ID, UNTILED_SESSION_NAME);
        // `toHaveText` with an array pins the row COUNT as well as the words and
        // retries until the panel settles, so a late re-render cannot be read as
        // the previous screen's rows or as a half-rendered one.
        await expect(page.locator(BREAKDOWN_PHASE_NAME_SELECTOR)).toHaveText(
          [ACTIVITY_PHASE_LABEL.unattributed],
          { timeout: MOUNT_TIMEOUT_MS }
        );
        expect(ACTIVITY_PHASE_LABEL.unattributed).not.toBe(
          ACTIVITY_PHASE_LABEL.other
        );

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

/**
 * Drive the renderer to a session detail and wait until THAT session's panel is
 * on screen.
 *
 * The first barrier is the session TITLE, not the Activity breakdown. `gotoHash`
 * only assigns `window.location.hash` and returns, and the breakdown selector is
 * rendered by EVERY session — so on the second navigation of a run it is already
 * satisfied by the previous session's still-mounted panel, and the read that
 * follows would collect the old screen's rows. The title is per-session, so it
 * cannot be satisfied by the screen we are navigating away from. The panel wait
 * stays as the second barrier because `allTextContents()` returns `[]` on an
 * unmounted panel, which would let a read pass vacuously.
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
  await expect(page.locator(BREAKDOWN_PHASE_NAME_SELECTOR).first()).toBeVisible(
    { timeout: MOUNT_TIMEOUT_MS }
  );
}

/**
 * The bucket word each strip slice announces, in render order — read off the
 * slice's accessible name, the only place the strip states a span's phase in
 * words.
 */
async function readStripPhaseWords(page: Page): Promise<string[]> {
  await expect(page.locator(STRIP_TILE_SELECTOR).first()).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
  const labels = await page
    .locator(STRIP_TILE_SELECTOR)
    .evaluateAll((tiles) =>
      tiles.map((tile) => tile.getAttribute("aria-label") ?? "")
    );
  expect(labels).toHaveLength(STRIP_PHASE_KEYS.length);
  return labels.map((label) => label.split(SEGMENT_LABEL_SEPARATOR)[0] ?? "");
}

/**
 * The Activity breakdown's phase name per phase key. The panel renders one row
 * per distinct phase in the tiling's chronological order, so the rows align
 * positionally with {@link BREAKDOWN_PHASE_KEYS}.
 */
async function readBreakdownPhaseNames(
  page: Page
): Promise<Map<string, string>> {
  const names = await page
    .locator(BREAKDOWN_PHASE_NAME_SELECTOR)
    .allTextContents();
  expect(names).toHaveLength(BREAKDOWN_PHASE_KEYS.length);
  return new Map(
    BREAKDOWN_PHASE_KEYS.map((key, index) => [key, names[index]?.trim() ?? ""])
  );
}
