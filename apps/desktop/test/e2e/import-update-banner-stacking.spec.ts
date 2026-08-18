/**
 * E2E regression (ISS-5367): the corrected composition at the top of the window
 * — the ready-to-install update banner stacked directly above the COLLAPSED
 * import splash — proven through the LAUNCHED app, with real layout.
 *
 * The renderer suites for this fix assert relationships between class names in
 * jsdom, which has no layout engine (wongk review). Everything ISS-5367 is
 * actually about is geometric: whether a band bleeds to the window edges, where
 * a control sits when the row beside it is empty, whether one strip is the click
 * target or merely contains one. None of that is observable in jsdom, and
 * `apps/desktop/AGENTS.md` requires a launched-Electron regression for a
 * renderer UI bug fix. Neither `auto-update-flow.spec.ts` (which drives the feed
 * → IPC → quit handoff and never looks at the banner) nor
 * `collapsible-import-splash.spec.ts` (which drives the disclosure and never
 * looks at the update banner) covers this composition.
 *
 * What each phase proves, and how it would have failed before the fix:
 *   1. WITH a count, from a genuine import: the rail is inset by the strip's own
 *      padding and keeps a corner radius. Before the fix it was
 *      `absolute inset-x-0 bottom-0 rounded-none` — a square band spanning the
 *      full window width, which is the second of the two saturated bands the
 *      ticket is named for.
 *   2. With NO count: the controls still hold the strip's right content edge.
 *      Before `ml-auto` the free space belonged to the count's `flex-1`, so the
 *      phases with no known total (Scanning, Computing — the two that run
 *      longest) collapsed the controls back against the label with the rest of
 *      the row empty.
 *   3. Stacked with the ready update banner: that banner is a status line
 *      containing a Relaunch button on a centred line, not one full-width button
 *      painted in solid primary.
 *
 * NOTHING here is stubbed on the import side. The no-count phase is the REAL
 * scan: the collapsed strip mounts as soon as the renderer paints and prints no
 * count until the collector reports a total, so the sampler below is installed
 * before anything else and latches the first frame that qualifies. That window
 * was measured at ~2.8s against the seeded corpus this spec uses, and it widens
 * on a slower runner because the scan is what has to finish. (A renderer-side
 * stub is not available even as a fallback: `desktopApi` is a frozen,
 * non-configurable `contextBridge` binding — verified, `Cannot redefine
 * property: desktopApi`.)
 *
 * ONE BOUNDARY, deliberate: the ready-to-install update state is driven by the
 * `desktop:update-status` window event the preload bridge re-emits, not by a
 * real update feed. The feed → updater → IPC half is `auto-update-flow.spec.ts`'s
 * job; what is unproven anywhere else is the rendered result, which is what this
 * asserts.
 *
 * Test ids and copy are pinned as LITERALS: importing renderer modules from a
 * spec aborts the whole Electron run under Playwright's Node loader (see the
 * same note in `collapsible-import-splash.spec.ts`). The renderer suites import
 * the exported constants, so drift there goes red first.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktop-app";
import { seedClaudeTranscripts } from "./helpers/seed";

const HIDE_DETAILS_LABEL = "Hide import details";
const SHOW_DETAILS_LABEL = "Show import details";
const BANNER_TEST_ID = "first-launch-import-banner";
const UPDATE_READY_TEST_ID = "update-banner-ready";
const RELAUNCH_LABEL = "Relaunch";

/**
 * The first launch only has to get the splash on screen so it can be collapsed.
 */
const FIRST_LAUNCH_SESSION_COUNT = 60;

/**
 * The second launch is sized for the SCAN, not the import: the no-count phase
 * lasts exactly as long as the collector takes to report a total, so a corpus
 * this size is what makes that phase a window rather than a race. Measured at
 * ~2.8s of no-count frames locally; a slower runner scans for longer, not
 * shorter. It also keeps the import in flight for the later phases, so the
 * splash cannot settle and dismiss itself mid-spec.
 */
const SECOND_LAUNCH_SESSION_COUNT = 2000;

/** How long the sampler waits for a qualifying no-count frame before failing. */
const NO_COUNT_LATCH_DEADLINE_MS = 60_000;

/** The same, for the frame after the collector has reported a total. */
const WITH_COUNT_LATCH_DEADLINE_MS = 120_000;

/**
 * Subpixel slack. Every assertion below compares two measured edges of the same
 * layout rather than a measurement against a constant, so this only absorbs
 * device-pixel rounding, never a real offset — the defects it has to catch are
 * a control stranded hundreds of pixels from the edge and a band overhanging the
 * strip by its whole padding.
 */
const EDGE_TOLERANCE_PX = 2;

type CompactRowGeometry = {
  /** Whether the row is printing a count at the instant it was measured. */
  hasCount: boolean;
  stripWidth: number;
  /** The strip's own right padding — the edge the controls must hold. */
  paddingRight: number;
  /** How far the expand control's right edge sits from the strip's right edge. */
  controlsGapFromRight: number;
  /** The rail's left/right inset inside the strip, and its corner radius. */
  railInsetLeft: number;
  railInsetRight: number;
  railRadiusPx: number;
  railWidth: number;
};

type StackedComposition = {
  updateStripTag: string;
  updateStripRole: string | null;
  updateStripWidth: number;
  relaunchWidth: number;
  relaunchLabel: string;
  /** Distance from the strip's edges to its content group, both sides. */
  contentInsetLeft: number;
  contentInsetRight: number;
  updateStripBottom: number;
  importStripTop: number;
  updateStripBackground: string;
  /** The same property resolved on a probe painted at solid `--primary`. */
  solidPrimaryBackground: string;
};

test.describe("Update banner + collapsed import splash stacking (ISS-5367)", () => {
  test("keeps the rail contained, the controls right-aligned without a count, and the relaunch action inside a status strip", async () => {
    // Two launches: the collapsed preference lives in the renderer's local
    // storage, so proving the collapsed row at all needs the same profile twice.
    // Boot + import twice comfortably exceeds the 60s suite default.
    test.setTimeout(300_000);

    const firstHome = seedTranscriptHome(
      "iss5367-stacking-a-",
      FIRST_LAUNCH_SESSION_COUNT
    );
    const secondHome = seedTranscriptHome(
      "iss5367-stacking-b-",
      SECOND_LAUNCH_SESSION_COUNT
    );
    let userDataDir: string | undefined;

    try {
      const first = await launchDesktopApp({
        userDataPrefix: "desktop-iss5367-stacking-e2e-",
        env: { CLAUDE_HOME: firstHome },
        keepUserDataDir: true,
      });
      userDataDir = first.userDataDir;

      try {
        const banner = first.page.getByTestId(BANNER_TEST_ID);
        await expect(banner).toBeVisible({ timeout: 60_000 });
        await banner.getByRole("button", { name: HIDE_DETAILS_LABEL }).click();
        await expect(
          banner.getByRole("button", { name: SHOW_DETAILS_LABEL })
        ).toBeVisible();
      } finally {
        await first.cleanup();
      }

      // Relaunch against the SAME profile with NEW transcripts: the stored
      // choice makes the splash mount already collapsed, and the fresh import
      // gives it a reason to mount at all.
      const second = await launchDesktopApp({
        userDataDir,
        env: { CLAUDE_HOME: secondHome },
        keepUserDataDir: true,
      });

      try {
        const { page } = second;

        // --- 1. NO count: the phases with no known total ------------------
        // Installed first and started immediately: the collapsed strip paints
        // with no count from the renderer's very first frame and keeps it until
        // the collector reports a total, so this has to be sampling before any
        // other wait burns that window.
        const scanning = await page.evaluate(LATCH_COMPACT_ROW, {
          deadlineMs: NO_COUNT_LATCH_DEADLINE_MS,
          wantCount: false,
        });
        expect(
          scanning,
          "the collapsed strip must render a no-count frame during the scan"
        ).not.toBeNull();
        const withoutCount = scanning as CompactRowGeometry;
        expect(withoutCount.hasCount).toBe(false);
        assertRailIsContained(withoutCount);
        assertControlsHoldTheRightEdge(withoutCount);

        // The strip really is the collapsed one, and it really is the second
        // launch's persisted choice rather than a fresh expanded panel.
        const banner = page.getByTestId(BANNER_TEST_ID);
        await expect(banner).toBeVisible({ timeout: 60_000 });
        await expect(
          banner.getByRole("button", { name: SHOW_DETAILS_LABEL })
        ).toBeVisible({ timeout: 60_000 });

        // --- 2. WITH a count, from the same genuine import ----------------
        const counted = await page.evaluate(LATCH_COMPACT_ROW, {
          deadlineMs: WITH_COUNT_LATCH_DEADLINE_MS,
          wantCount: true,
        });
        expect(
          counted,
          "the collapsed strip must print the import count once a total is known"
        ).not.toBeNull();
        const withCount = counted as CompactRowGeometry;
        assertRailIsContained(withCount);
        // `ml-auto` is inert here, because the count's `flex-1` has already
        // taken the free space. Asserted anyway: the invariant is that the
        // controls hold the edge in EVERY phase, and the pre-fix build only
        // managed it in this one.
        assertControlsHoldTheRightEdge(withCount);
        // Same strip, not a narrower one that right-aligns by accident.
        expect(
          Math.abs(withoutCount.stripWidth - withCount.stripWidth)
        ).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);

        // --- 3. Stacked with the ready update banner ----------------------
        await page.evaluate(DISPATCH_UPDATE_DOWNLOADED);
        await expect(page.getByTestId(UPDATE_READY_TEST_ID)).toBeVisible();

        const composition = await page.evaluate(READ_STACKED_COMPOSITION);
        expect(composition).not.toBeNull();
        const stacked = composition as unknown as StackedComposition;

        // The strip states the condition; a discrete control carries the verb.
        // Before the review fix the whole strip WAS the button, so the only
        // thing distinguishing a bar that quits and reinstalls the app from the
        // passive informational strip in the same component was a 14px icon.
        expect(stacked.updateStripTag).toBe("DIV");
        expect(stacked.updateStripRole).toBe("status");
        expect(stacked.relaunchLabel).toBe(RELAUNCH_LABEL);
        expect(stacked.relaunchWidth).toBeGreaterThan(0);
        expect(stacked.relaunchWidth).toBeLessThan(
          stacked.updateStripWidth / 2
        );

        // Centred, like every sibling banner in the stack. `justify-start` left
        // the line hard against the window's left edge.
        expect(
          Math.abs(stacked.contentInsetLeft - stacked.contentInsetRight)
        ).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);

        // Not a saturated slab: the strip is a wash over the app background, so
        // its resolved paint cannot equal solid `--primary`.
        expect(stacked.updateStripBackground).not.toBe(
          stacked.solidPrimaryBackground
        );
        // …and the comparison is not vacuous: the probe really resolved a paint.
        expect(stacked.solidPrimaryBackground).not.toBe("rgba(0, 0, 0, 0)");

        // …and the two really are stacked, update banner above import strip,
        // which is the composition the whole ticket is about.
        expect(stacked.updateStripBottom).toBeLessThanOrEqual(
          stacked.importStripTop + EDGE_TOLERANCE_PX
        );
      } finally {
        await second.cleanup();
      }
    } finally {
      fs.rmSync(firstHome, { recursive: true, force: true });
      fs.rmSync(secondHome, { recursive: true, force: true });
      if (userDataDir !== undefined) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
    }
  });
});

function seedTranscriptHome(prefix: string, sessionCount: number): string {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  seedClaudeTranscripts(
    claudeHome,
    Array.from({ length: sessionCount }, (_unused, index) => ({
      sessionId: `${prefix}${index}`,
      slug: `${prefix}${index}`,
    })),
    "iss5367-stacking-project"
  );
  return claudeHome;
}

/**
 * Wait for — and latch — the first laid-out frame of the COLLAPSED strip whose
 * count is present (or absent) as asked, then report that frame's geometry.
 *
 * Sampling runs inside the renderer at ~60Hz rather than as a Playwright poll,
 * because the no-count phase is the collector's scan and every CDP round trip
 * spends part of it. Resolves `null` on deadline, so the caller fails with
 * "no such frame" rather than with an unexplained timeout.
 *
 * The rail's reserved slot is the only element unique to the collapsed form, so
 * it is what identifies the strip; the strip is its parent.
 */
const LATCH_COMPACT_ROW = (options: {
  wantCount: boolean;
  deadlineMs: number;
}): Promise<CompactRowGeometry | null> =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = (): void => {
      const slot = document.querySelector(
        '[data-testid="import-splash-rail-slot"]'
      );
      const strip = slot?.parentElement ?? null;
      const toggle =
        strip?.querySelector("[data-import-splash-toggle]") ?? null;
      const rail = slot?.firstElementChild ?? null;
      if (slot && strip && toggle && rail) {
        const stripRect = strip.getBoundingClientRect();
        const toggleRect = toggle.getBoundingClientRect();
        const railRect = rail.getBoundingClientRect();
        const stripStyles = getComputedStyle(strip);
        // ISS-5281 pinned the noun: the count line is the only place the
        // collapsed row prints "transcripts", in either of its two phrasings.
        const hasCount = (strip.textContent ?? "").includes("transcripts");
        // Width guards: the first frames after mount can measure zero before
        // layout settles, and a zero-width strip would make every inset
        // comparison below trivially agree.
        if (
          hasCount === options.wantCount &&
          stripRect.width > 0 &&
          railRect.width > 0
        ) {
          resolve({
            hasCount,
            stripWidth: stripRect.width,
            paddingRight: Number.parseFloat(stripStyles.paddingRight),
            controlsGapFromRight: stripRect.right - toggleRect.right,
            railInsetLeft: railRect.left - stripRect.left,
            railInsetRight: stripRect.right - railRect.right,
            railRadiusPx: Number.parseFloat(
              getComputedStyle(rail).borderTopLeftRadius
            ),
            railWidth: railRect.width,
          });
          return;
        }
      }
      if (Date.now() - startedAt > options.deadlineMs) {
        resolve(null);
        return;
      }
      setTimeout(tick, 16);
    };
    tick();
  });

/** The payload the preload bridge re-emits once an update is ready to install. */
const DISPATCH_UPDATE_DOWNLOADED = (): void => {
  window.dispatchEvent(
    new CustomEvent("desktop:update-status", {
      detail: {
        status: "downloaded",
        updateAvailable: true,
        readyToInstall: true,
        version: "99.0.0",
      },
    })
  );
};

/**
 * The two bands together, plus a throwaway probe painted at solid `--primary`
 * so "is this strip a saturated slab" can be answered by comparing two resolved
 * paints rather than by parsing an alpha out of a computed colour string.
 */
const READ_STACKED_COMPOSITION = (): StackedComposition | null => {
  const updateStrip = document.querySelector(
    '[data-testid="update-banner-ready"]'
  );
  const slot = document.querySelector(
    '[data-testid="import-splash-rail-slot"]'
  );
  const importStrip = slot?.parentElement ?? null;
  const relaunch = updateStrip?.querySelector("button") ?? null;
  const lead = updateStrip?.firstElementChild ?? null;
  const trail = updateStrip?.lastElementChild ?? null;
  if (!(updateStrip && importStrip && relaunch && lead && trail)) {
    return null;
  }
  const updateRect = updateStrip.getBoundingClientRect();
  const relaunchRect = relaunch.getBoundingClientRect();
  const probe = document.createElement("div");
  probe.style.backgroundColor = "var(--primary)";
  document.body.append(probe);
  const solidPrimaryBackground = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return {
    updateStripTag: updateStrip.tagName,
    updateStripRole: updateStrip.getAttribute("role"),
    updateStripWidth: updateRect.width,
    relaunchWidth: relaunchRect.width,
    relaunchLabel: (relaunch.textContent ?? "").trim(),
    contentInsetLeft: lead.getBoundingClientRect().left - updateRect.left,
    contentInsetRight: updateRect.right - trail.getBoundingClientRect().right,
    updateStripBottom: updateRect.bottom,
    importStripTop: importStrip.getBoundingClientRect().top,
    updateStripBackground: getComputedStyle(updateStrip).backgroundColor,
    solidPrimaryBackground,
  };
};

/**
 * The rail is a contained meter, not a structural rule: inset by the strip's own
 * padding on both sides and carrying a corner radius. The overlay it replaced
 * escaped that padding entirely and squared off against both window edges.
 */
function assertRailIsContained(geometry: CompactRowGeometry): void {
  expect(geometry.railWidth).toBeGreaterThan(0);
  expect(geometry.railInsetLeft).toBeGreaterThanOrEqual(
    geometry.paddingRight - EDGE_TOLERANCE_PX
  );
  expect(geometry.railInsetRight).toBeGreaterThanOrEqual(
    geometry.paddingRight - EDGE_TOLERANCE_PX
  );
  expect(geometry.railRadiusPx).toBeGreaterThan(0);
}

/**
 * The expand control sits exactly the strip's own right padding from its right
 * edge — the invariant `ml-auto` buys, which has to hold in the phases where the
 * count is absent and there is no `flex-1` sibling to push the controls over.
 */
function assertControlsHoldTheRightEdge(geometry: CompactRowGeometry): void {
  expect(geometry.paddingRight).toBeGreaterThan(0);
  expect(
    Math.abs(geometry.controlsGapFromRight - geometry.paddingRight)
  ).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
}
