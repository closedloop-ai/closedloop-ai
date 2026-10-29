/**
 * E2E regression (ISS-10624): the guided-onboarding "Session discovery" step
 * states a REAL byte percentage on a machine whose store holds more sessions
 * per harness than the current sweep finds on disk.
 *
 * THE BUG. On the operator's machine the step rendered "1,092 sessions found
 * (Claude Code 946, Codex 146)" with every progress bar an indeterminate
 * hatched sweep and an em-dash where the percentage belongs. Continue was
 * clickable, so nothing trapped the user — the screen simply looked
 * permanently hung. The store legitimately held 2,454 Claude sessions against
 * 946 transcripts still on disk (the rest had been pruned by retention), so the
 * fold withheld the session RATIO — ISS-10582 later ruled that the analyzed
 * COUNT survives that and only the quotient is given up — and no other lane
 * could supply a numerator:
 * a byte numerator reached the renderer only as the ETA's `remainingBytes`,
 * which only a `measured` ETA carries — never during the `calculating` window
 * a progress bar exists for.
 *
 * THE FIX this guards. `OnboardingInventoryWire` now carries `parsedBytes` (the
 * parse lane's own position, on every read, beside the `eligibleParseBytes`
 * denominator that was always there), `onboarding-local-state-source.ts`
 * projects it, and `parseBytes()` in `use-onboarding-session-discovery.ts`
 * prefers it over the ETA route. So the overall bar is DETERMINATE while the
 * estimate is still calculating.
 *
 * Would fail before the change: the byte lane has no numerator, the session
 * lane is withdrawn, and the overall bar renders indeterminate — no
 * `aria-valuenow`, a `progress-hatch` indicator, and a caption that is not a
 * percentage.
 *
 * WHY A FRESH PROFILE CANNOT REPRODUCE IT. An empty store is a SETTLED EMPTY
 * analyzed read, which reconciles fine, so progress is a measured 0% and the
 * bar is already determinate. The fixture below therefore builds the
 * operator's actual condition instead — see `Fixture` under the test.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { DESKTOP_WELCOME_CTA_LABEL } from "@repo/app/onboarding/components/guided-onboarding-welcome-copy.ts";
import { ONBOARDING_SOURCE_RATIO_UNAVAILABLE_FLAG_KEY } from "../../../../packages/api/src/types/onboarding-source-ratio-unavailable-flag";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
  desktopGuestGuidedOnboardingStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import { setImportPaused } from "./helpers/import-pause";
import { seedClaudeTranscripts } from "./helpers/seed";
import {
  countHarnessSessionRows,
  SeedHarness,
  seedHarnessSessionSurplus,
} from "./helpers/seed-harness-sessions-db";

const SESSION_DISCOVERY_EYEBROW = "Session discovery";

/** `aria-label` of the step's overall bar (guided-onboarding-analysis-step.tsx). */
const OVERALL_BAR_LABEL = "Overall import progress";
/** `aria-label` of the Claude row's bar — `harnessDisplayLabel("claude")`. */
const CLAUDE_BAR_LABEL = "Claude Code import progress";
/** The indeterminate treatment's class (packages/design-system … progress.tsx). */
const INDETERMINATE_HATCH = ".progress-hatch";

/**
 * A caption that IS a whole percentage.
 *
 * Deliberately a positive shape assertion rather than a not-equal against
 * `KPI_NO_VALUE`. The repo rule an absence assertion must obey is "never hold
 * your own copy of the product copy", and importing that constant here is not
 * available: `@repo/app/shared/lib/format-utils` reaches `@repo/lib/format-bytes`
 * through an extension-less subpath, which resolves in the app and NOT under the
 * Playwright spec loader, where it aborts the WHOLE suite at load time
 * (`test/AGENTS.md` → "Import hazard"). This pattern re-types nothing, cannot go
 * stale when the placeholder is reworded, and fails on every non-percentage the
 * caption can render — the em-dash and the withheld-operand label alike.
 */
const WHOLE_PERCENT_CAPTION = /^\d+%$/;

/**
 * A source row on a store that has outlived its transcripts: BOTH counts, each
 * beside its own label.
 *
 * Retargeted from `/^[\d,]+ found\s*·\s*Analyzed count unavailable$/` because
 * ISS-10582 changed which half is given up. #7547 withdrew the analyzed COUNT
 * on a store that overshot its disk, which on a pruned install deleted a real
 * measurement from the screen forever; the count is now stated and only the
 * QUOTIENT between the two is withheld. So the row no longer says "unavailable"
 * — it says both numbers — and the old assertion described behavior this change
 * deliberately removed. What it PROVED (that the fixture really tripped the
 * overshoot, so the percentage under test came from the byte lane and not the
 * session ratio) is not weakened but restated: the numbers are parsed out and
 * the analyzed one is required to exceed the found one, which is a strictly
 * stronger claim than a copy of a label.
 */
const FOUND_WITH_ANALYZED_STATED = /^([\d,]+) found\s*·\s*([\d,]+) analyzed$/;

/**
 * The `data-paused` marker a HELD bar carries (`packages/design-system` →
 * `progress.tsx`). A withheld RATIO has settled, so the row's bar holds: the
 * hatch stays, saying the amount is unknown, and the travelling sheen — which
 * claims work is advancing — comes off. Held on a row that still states 430
 * analyzed is the ISS-10582 half of this: the count being present is exactly
 * what used to let the row fall back to "unread" and sweep forever.
 */
const PAUSED_INDICATOR = '[data-paused="true"]';

/** Transcripts imported by the first launch. Their bytes are the NUMERATOR. */
const IMPORTED_TRANSCRIPTS = 30;
/** Transcripts added after that import. Their bytes are what stays PENDING. */
const PENDING_TRANSCRIPTS = 150;
/**
 * Store rows written directly for `claude`, on top of the imported ones.
 *
 * Only the SURPLUS matters: it has to push the store's claude count past the
 * 180 transcripts the sweep will find on disk, which is what makes the fold
 * withhold the session ratio. 400 clears that with room for the pending
 * transcripts that land before the import parks.
 */
const STORE_SURPLUS_ROWS = 400;

/** Roughly 4 KB of transcript body per file, so the byte totals are not noise. */
const TRANSCRIPT_PADDING = "seeded onboarding corpus. ".repeat(160);

const STEP_BUDGET_MS = 30_000;
const IMPORT_SETTLE_BUDGET_MS = 180_000;
const PROGRESS_BUDGET_MS = 60_000;

test("ISS-10624: session discovery states a real byte percentage when the analyzed read is withdrawn", async () => {
  test.setTimeout(600_000);

  const homes = createHarnessHomes();
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-onboarding-analysis-progress-")
  );

  try {
    // ── Fixture, part 1: a corpus this profile has ALREADY imported. ────────
    // Its bytes are eligible in every later sweep and are NOT pending in any
    // later import pass, which is exactly what puts the parse numerator above
    // zero while work is still outstanding.
    seedClaudeTranscripts(
      homes.claudeHome,
      transcripts("imported", IMPORTED_TRANSCRIPTS)
    );
    await seedGuestProfileWithImportedCorpus(userDataDir, homes.env);

    // ── Fixture, part 2: the operator's actual condition. ───────────────────
    // More sessions in the store for `claude` than the sweep can find on disk,
    // plus a fresh corpus the next launch has not imported yet.
    seedClaudeTranscripts(
      homes.claudeHome,
      transcripts("pending", PENDING_TRANSCRIPTS)
    );
    await seedHarnessSessionSurplus(userDataDir, {
      count: STORE_SURPLUS_ROWS,
      harness: SeedHarness.Claude,
      idPrefix: "iss10624-pruned-transcript-session-",
    });

    const launched = await launchDesktopApp({
      env: homes.env,
      keepFirstRunState: true,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await gotoNav(launched.page, "dashboard");

      // Park the backfill through the SHIPPED control the import banner's Pause
      // button invokes, so the byte remainder stops draining and the percentage
      // under test holds still. Retried for a few seconds because the IPC
      // resolves through `getAgentDashboardRuntime()?`, which is a silent no-op
      // until the dashboard runtime is composed.
      await setImportPaused(launched.page, true);

      await launched.page
        .getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
        .click({ timeout: STEP_BUDGET_MS });
      await expect(
        launched.page.getByText(SESSION_DISCOVERY_EYEBROW)
      ).toBeVisible({ timeout: STEP_BUDGET_MS });

      const overallBar = launched.page.getByRole("progressbar", {
        name: OVERALL_BAR_LABEL,
      });
      await expect(overallBar).toBeVisible({ timeout: STEP_BUDGET_MS });

      // The regression assertion. A determinate Radix bar carries a numeric
      // `aria-valuenow`; an indeterminate one omits it. Bounded STRICTLY inside
      // 0 and 100 so nothing a hardcoded end-stop could satisfy passes here:
      // `progressPercentFromRatio` never rounds INTO either end, so a corpus
      // that is genuinely part-parsed reads somewhere between.
      let percent = 0;
      await expect(async () => {
        const stated = await overallBar.getAttribute("aria-valuenow");
        expect(stated).not.toBeNull();
        const value = Number(stated);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThan(100);
        percent = value;
      }).toPass({ timeout: PROGRESS_BUDGET_MS });

      // And it is determinate in the SIGHTED rendering too, not merely in the
      // accessibility tree: the bug was a hatched sweep that never stopped.
      await expect(overallBar.locator(INDETERMINATE_HATCH)).toHaveCount(0);

      // The caption states that same percentage rather than a placeholder.
      // Located by POSITION, not by `aria-live`: ISS-10584 dropped that
      // attribute once the percentage started advancing with the import, since
      // a polite region re-announcing a number every couple of seconds for a
      // multi-minute import talks over everything else in the dialog. The
      // caption is still the first span of the div following the bar.
      const caption = overallBar
        .locator("xpath=following-sibling::div[1]/span[1]")
        .first();
      await expect(caption).toHaveText(WHOLE_PERCENT_CAPTION);
      await expect(caption).toHaveText(`${percent}%`);

      // The fixture really did trip the overshoot, and the row STATES both
      // counts rather than giving one of them up (ISS-10582). Without this the
      // test could pass on a session-lane ratio and prove nothing about
      // ISS-10624 either.
      const claudeBar = launched.page.getByRole("progressbar", {
        name: CLAUDE_BAR_LABEL,
      });
      const claudeStatus = claudeBar
        .locator("xpath=following-sibling::span[1]")
        .first();
      await expect(claudeStatus).toHaveText(FOUND_WITH_ANALYZED_STATED);
      const stated = FOUND_WITH_ANALYZED_STATED.exec(
        (await claudeStatus.textContent()) ?? ""
      );
      expect(stated).not.toBeNull();
      const [statedFound, statedAnalyzed] = [stated?.[1], stated?.[2]].map(
        (group) => Number((group ?? "").replaceAll(",", ""))
      );
      // The overshoot itself, on the real render: the restored count is ABOVE
      // its own denominator, which is the state the whole screen has to survive
      // without claiming completion.
      expect(statedAnalyzed).toBeGreaterThan(statedFound);

      // And that row HOLDS rather than travelling. A settled withholding is not
      // work in flight, so the sheen comes off while the hatch — "amount
      // unknown" — stays; on this store the sweep would otherwise never stop.
      await expect(claudeBar.locator(PAUSED_INDICATOR)).toHaveCount(1);
      await expect(claudeBar.locator(INDETERMINATE_HATCH)).toHaveCount(1);
    } finally {
      await launched.cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    removeDirs([homes.claudeHome, homes.codexHome]);
  }
});

/**
 * `aria-label` of the Claude row's bar once the ISS-10961 gate is OPEN: the bar
 * names the shortfall the row's own words name, instead of calling a withheld
 * read "progress".
 */
const CLAUDE_BAR_RATIO_UNAVAILABLE_LABEL = "Claude Code percentage unavailable";

/**
 * The same row's status text with the gate open: both counts, then the clause
 * that says which quotient is missing.
 *
 * Re-typed here rather than imported for the reason the caption assertion above
 * states: `guided-onboarding-analysis-step.tsx` is a TSX component module and
 * pulling it through the Playwright spec loader risks aborting the whole suite
 * at load time. The literal is pinned against the component's exported constant
 * by `guided-onboarding-source-ratio-unavailable.test.tsx`, which imports it.
 */
const FOUND_ANALYZED_AND_RATIO_WITHHELD =
  /^([\d,]+) found\s*·\s*([\d,]+) analyzed\s*·\s*Percentage unavailable$/;

/** The settled "nothing to state here" mark (lucide `CircleSlashIcon`). */
const WITHHELD_GLYPH = "svg.lucide-circle-slash";

test("ISS-10961: the overshot source row SAYS its percentage is unavailable once the gate is open", async () => {
  test.setTimeout(600_000);

  // The gate's own seam (ISS-8753). It is read BEFORE the auth path precisely
  // because the harness launches with no account, which is otherwise a terminal
  // closed answer for every key — and it is re-seeded on BOTH launches because
  // the standard seeder rewrites the profile each time.
  const openTheGate = (dir: string) => {
    seedDesktopFeatureFlags(dir, {
      [ONBOARDING_SOURCE_RATIO_UNAVAILABLE_FLAG_KEY]: true,
    });
  };

  const homes = createHarnessHomes();
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-onboarding-ratio-unavailable-")
  );

  try {
    seedClaudeTranscripts(
      homes.claudeHome,
      transcripts("imported", IMPORTED_TRANSCRIPTS)
    );
    await seedGuestProfileWithImportedCorpus(
      userDataDir,
      homes.env,
      openTheGate
    );
    seedClaudeTranscripts(
      homes.claudeHome,
      transcripts("pending", PENDING_TRANSCRIPTS)
    );
    await seedHarnessSessionSurplus(userDataDir, {
      count: STORE_SURPLUS_ROWS,
      harness: SeedHarness.Claude,
      idPrefix: "iss10961-pruned-transcript-session-",
    });

    const launched = await launchDesktopApp({
      beforeLaunch: openTheGate,
      env: homes.env,
      keepFirstRunState: true,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await gotoNav(launched.page, "dashboard");
      await setImportPaused(launched.page, true);
      await launched.page
        .getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
        .click({ timeout: STEP_BUDGET_MS });
      await expect(
        launched.page.getByText(SESSION_DISCOVERY_EYEBROW)
      ).toBeVisible({ timeout: STEP_BUDGET_MS });

      // The assignment arrives over IPC after mount, so the row renders the
      // shipped presentation for a frame and then flips. Awaiting the OPEN name
      // is what makes this "after the assignment returns" rather than a race.
      const claudeBar = launched.page.getByRole("progressbar", {
        name: CLAUDE_BAR_RATIO_UNAVAILABLE_LABEL,
      });
      await expect(claudeBar).toBeVisible({ timeout: PROGRESS_BUDGET_MS });
      // ...and the two presentations cannot coexist: the name that made a held
      // bar and a sweeping one announce identically is gone from this row.
      await expect(
        launched.page.getByRole("progressbar", { name: CLAUDE_BAR_LABEL })
      ).toHaveCount(0);

      // The regression itself, in the row's own words. Paired with the count
      // comparison below so a row that rendered nothing could not satisfy it.
      const claudeStatus = claudeBar
        .locator("xpath=following-sibling::span[1]")
        .first();
      await expect(claudeStatus).toHaveText(FOUND_ANALYZED_AND_RATIO_WITHHELD);
      const stated = FOUND_ANALYZED_AND_RATIO_WITHHELD.exec(
        (await claudeStatus.textContent()) ?? ""
      );
      expect(stated).not.toBeNull();
      const [statedFound, statedAnalyzed] = [stated?.[1], stated?.[2]].map(
        (group) => Number((group ?? "").replaceAll(",", ""))
      );
      // ISS-10582's ruling survives the gate: BOTH counts are still on screen
      // and the overshoot is still the real one. This fix gives up nothing.
      expect(statedAnalyzed).toBeGreaterThan(statedFound);

      // The sighted half of the same statement, by shape rather than hue.
      await expect(
        claudeBar
          .locator("xpath=preceding-sibling::div[1]")
          .locator(WITHHELD_GLYPH)
      ).toHaveCount(1);

      // And the bar is still the honest held hatch — settled, not travelling,
      // and still refusing to claim an amount it cannot form.
      await expect(claudeBar.locator(PAUSED_INDICATOR)).toHaveCount(1);
      await expect(claudeBar.locator(INDETERMINATE_HATCH)).toHaveCount(1);
    } finally {
      await launched.cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    removeDirs([homes.claudeHome, homes.codexHome]);
  }
});

function createHarnessHomes(): {
  claudeHome: string;
  codexHome: string;
  env: Record<string, string>;
} {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-onboarding-progress-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-onboarding-progress-codex-")
  );
  return {
    claudeHome,
    codexHome,
    env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
  };
}

function removeDirs(dirs: string[]): void {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** `count` seed transcripts under one id prefix, each a few KB on disk. */
function transcripts(
  prefix: string,
  count: number
): { sessionId: string; slug: string; userText: string }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    sessionId: `iss10624-${prefix}-${index}`,
    slug: `iss10624-${prefix}-${index}`,
    userText: `${prefix} ${index}: ${TRANSCRIPT_PADDING}`,
  }));
}

/**
 * Boot once to create a signed-out profile, let it import the corpus already on
 * disk, mark the tour as seen, and shut down.
 *
 * The completed import is load-bearing, not setup hygiene: the next launch's
 * pending scan drops those unchanged sources, so its remaining-byte population
 * is the NEW transcripts only while the inventory sweep still sizes every file
 * on disk. That gap is the parse numerator the step renders.
 *
 * The guest guided-run key is removed rather than seeded, and the first-launch
 * latch with it, for the reason `guest-guided-onboarding.spec.ts` states: their
 * absence is the first-run state, and the tour key alone is what stops a
 * competing overlay.
 */
async function seedGuestProfileWithImportedCorpus(
  userDataDir: string,
  env: Record<string, string>,
  beforeLaunch?: (dir: string) => void
): Promise<void> {
  const first = await launchDesktopApp({
    beforeLaunch,
    env,
    keepFirstRunState: true,
    keepUserDataDir: true,
    userDataDir,
  });
  try {
    await gotoNav(first.page, "dashboard");
    await expect(async () => {
      const imported = await countHarnessSessionRows(
        userDataDir,
        SeedHarness.Claude
      );
      expect(imported).toBeGreaterThanOrEqual(IMPORTED_TRANSCRIPTS);
    }).toPass({ timeout: IMPORT_SETTLE_BUDGET_MS });
    await first.page.evaluate(
      ([tourSeenKey, guestRunKey, onboardedKey]) => {
        localStorage.setItem(tourSeenKey, "1");
        localStorage.removeItem(onboardedKey);
        localStorage.removeItem(guestRunKey);
      },
      [
        dashboardTourSeenStorageKey,
        desktopGuestGuidedOnboardingStorageKey,
        dashboardOnboardedStorageKey,
      ]
    );
  } finally {
    await first.cleanup();
  }
}
