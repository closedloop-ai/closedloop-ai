/**
 * ISS-4865 (fix ISS-4667) — the per-session LOC/$ Properties-pane figure, on the
 * ELECTRON adapter. Twin of `e2e/session-detail-loc-per-dollar.spec.ts`, which
 * drives the same shared `AgentSessionDetailView` / `formatLocPerDollar`
 * (`packages/app/shared/lib/format-utils.ts`) through mocked HTTP fixtures on
 * the web adapter.
 *
 * The bug: the metric used to be computed and rendered in KLOC/$, so a real
 * 4,004-line / $4,574.72 session floored to a misleading `0.00`. The fix makes
 * the metric render raw lines-per-dollar, and `formatLocPerDollar` switches to
 * significant-digit precision below `0.01` so a genuinely small but non-zero
 * efficiency reads `0.0088` rather than flooring.
 *
 * ISS-9964 / ISS-9980 (RULED 2026-09-11) RETIRED the separate desktop
 * numerator. `sessionLocPerDollarNumeratorLoc` — which read `branchDiffStats`
 * via `Math.max(gitLoc, branchLoc)` — is gone, and the desktop renderer now
 * resolves LOC/$ through the SAME shared derivation the cloud projection uses:
 * lines landed in MERGED authored PRs. The operator's ruling on that file was
 * explicit: "this is already broken, there should not be a separate calculation
 * for desktop and web."
 *
 * The consequence for THIS spec is that the sub-cent case it was written around
 * is no longer reachable on desktop. A locally-collected session has no synced
 * merged-PR count, so its numerator is NOT KNOWABLE and the row renders the
 * placeholder — which is the ONE shared derivation finding no numerator and
 * saying so, NOT a desktop-specific policy. Its sub-cent-precision contract is
 * unaffected and stays pinned by the web twin
 * (`e2e/session-detail-loc-per-dollar.spec.ts`), which can seed the merged
 * count; per the Re-homing Guardrail the desktop copy is deleted rather than
 * re-pointed at a population it cannot produce.
 *
 * What remains here is the placeholder path, which is still worth driving on a
 * real launched renderer against a real seeded SQLite corpus, and it is driven
 * on BOTH of the conditions that reach it: a session with no priced cost at all
 * (no `token_usage` row), and a PRICED session whose merged numerator is not
 * knowable. The priced one is what makes the placeholder load-bearing — with a
 * real divisor in place, only the retired numerator could produce a number, so
 * its resurrection fails here rather than passing unnoticed (whitlockk on #7072).
 *
 * Seeding mechanism (see helpers/seed-loc-per-dollar-db.ts): a session linked
 * to one branch artifact via `relation='created'` (`seedClosedAtOnlySinglePrBranch`
 * and friends in `seed-branches-db.ts` link via `relation='authored'`, which
 * feeds the Branches-page read instead). Because a running app does not
 * observe another process's writes to its own SQLite store, the corpus is
 * seeded with the app DOWN and read on the NEXT boot:
 *   1. Launch the app once so it creates + migrates the schema, then close it.
 *   2. Seed the session + branch artifact + link (+ optional priced cost)
 *      straight into the file.
 *   3. Relaunch — the app's REAL local session-detail read projects the seeded
 *      corpus at boot (no test-only code path).
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { isolatedHarnessHomes } from "../helpers/isolated-harness-homes";
import { gotoHash, launchDesktopApp } from "./helpers/desktop-app";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";
import {
  type SessionDetailLocPerDollarSeed,
  seedSessionDetailLocPerDollarBranch,
} from "./helpers/seed-loc-per-dollar-db";

// The canonical label — `packages/api/src/utils/loc-per-dollar.ts`. Pinned as a
// local literal rather than imported: a desktop e2e spec must never import an
// extension-less `@repo/*` TS subpath, which aborts the WHOLE Electron suite at
// load time before any test runs.
const LOC_PER_DOLLAR_LABEL = "LOC / $";
// The exact lie the ISS-4667 fix removed: a real ratio crushed to two decimal
// places. Asserted as a negative so a regressed build fails on that specific
// defect, not merely on an unexpected string.
const FLOORED_RENDERED = "0.00";
// Local-only data cannot supply the synced merged-PR numerator.
const NOT_APPLICABLE_RENDERED = "—";

const SESSION_TITLE_SELECTOR = ".sd3-head h1";
const PROPERTIES_SECTION_SELECTOR = "section.prd-props-section";
const PROPERTIES_BUTTON_NAME = "Properties";
const MOUNT_TIMEOUT_MS = 30_000;

// A priced local session isolates the missing merged-PR numerator from cost.
const PRICED_COST_USD = 5;
const PRICED_SEED: SessionDetailLocPerDollarSeed = {
  branchName: "iss-9964-priced-desktop",
  costUsd: PRICED_COST_USD,
  repoFullName: "acme/web",
  sessionId: "iss-9964-session-detail-loc-per-dollar-priced",
};

test.describe("Session detail LOC/$ property (ISS-4667)", () => {
  test("session detail withholds LOC/$ on a PRICED local-only session, because the merged numerator is not knowable", async () => {
    test.setTimeout(180_000);

    await withSeededSessionDetail(
      PRICED_SEED,
      "desktop-session-loc-per-dollar-priced",
      async ({ page, pageErrors, propertiesSection }) => {
        const value = locPerDollarValue(propertiesSection);
        await expect(value).toBeVisible();
        // There IS a divisor here, so the placeholder can only come from the
        // numerator — the one shared derivation finding no synced merged-PR
        // count on a local-only corpus and saying so.
        await expect(value).toHaveText(NOT_APPLICABLE_RENDERED);
        await expect(value).not.toHaveText(FLOORED_RENDERED);

        await page.screenshot({
          fullPage: true,
          path: test
            .info()
            .outputPath("session-detail-loc-per-dollar-priced.png"),
        });
        expect(pageErrors).toEqual([]);
      }
    );
  });
});

type SessionDetailScenario = {
  page: Page;
  /** `LaunchedApp.pageErrors` — uncaught renderer errors, asserted `toEqual([])`. */
  pageErrors: Error[];
  propertiesSection: Locator;
};

/**
 * Seed one session behind the two-launch contract (create/migrate schema,
 * close, seed while down, relaunch), navigate straight to its detail route,
 * open the Properties disclosure, then hand the caller the mounted page,
 * captured renderer errors, and the opened section to assert against. Shared
 * by the retained local numerator scenario.
 */
async function withSeededSessionDetail(
  seed: SessionDetailLocPerDollarSeed,
  tmpPrefix: string,
  run: (scenario: SessionDetailScenario) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${tmpPrefix}-claude-`)
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `${tmpPrefix}-udd-`)
  );
  // ISS-7697: `launchDesktopApp` inherits `process.env`, so pinning only
  // CLAUDE_HOME leaves Cursor, Copilot and OpenCode resolving under
  // `os.homedir()` and the boot collectors import the OPERATOR'S REAL local
  // sessions into this profile.
  const harnessHomesRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `${tmpPrefix}-homes-`)
  );
  const env = {
    ...isolatedHarnessHomes(harnessHomesRoot),
    // …except Claude's, which is this scenario's (empty) corpus.
    CLAUDE_HOME: claudeHome,
  };

  try {
    // Launch 1 — create + migrate the SQLite schema, then close so the seed
    // writes with the app DOWN (a running app does not observe another
    // process's writes to its own store).
    const first = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
      // ISS-7682: the harness CAPTURES renderer errors, the caller must ASSERT
      // them. Launch 1 boots the whole renderer (shell, router, first-paint
      // route chunk) before the schema lands, so dropping its `pageErrors`
      // meant this spec could pass with a lazy chunk or route module throwing.
      // Asserted AFTER the wait, not before: the array only holds what has
      // actually been thrown by the time it is read.
      expect(first.pageErrors).toEqual([]);
    } finally {
      await first.cleanup();
    }

    await seedSessionDetailLocPerDollarBranch(userDataDir, seed);

    // Launch 2 — the real local session-detail read projects the seeded
    // corpus.
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });

    try {
      await gotoHash(page, `/sessions/${seed.sessionId}`);
      await expect(page.locator(SESSION_TITLE_SELECTOR)).toHaveText(
        seed.sessionId,
        { timeout: MOUNT_TIMEOUT_MS }
      );

      const propertiesSection = await openProperties(page);
      await run({ page, pageErrors, propertiesSection });
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(harnessHomesRoot, { force: true, recursive: true });
  }
}

/**
 * Open the collapsed Properties disclosure and return it, expanded. `visible=
 * true` scopes past any keep-alive-hidden view, matching
 * `session-detail-properties.spec.ts`'s convention. `data-open` is the
 * section's own disclosure state, so waiting on it (rather than the click's
 * auto-wait alone) waits for the expanded rows rather than racing the click.
 */
async function openProperties(page: Page): Promise<Locator> {
  const propertiesSection = page
    .locator(PROPERTIES_SECTION_SELECTOR)
    .locator("visible=true")
    .first();
  await expect(propertiesSection).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await page
    .getByRole("button", { name: PROPERTIES_BUTTON_NAME })
    .locator("visible=true")
    .first()
    .click();
  await expect(propertiesSection).toHaveAttribute("data-open", "true");
  return propertiesSection;
}

/**
 * The Properties row for the shared LOC/$ metric, scoped to the opened
 * section. Reached through its label — read from the canonical
 * `LOC_PER_DOLLAR_LABEL` literal so this spec cannot drift from the unit the
 * surfaces actually print.
 */
function locPerDollarValue(propertiesSection: Locator): Locator {
  return propertiesSection
    .locator(
      `div.prd-prop:has(span.prd-prop-label:text-is("${LOC_PER_DOLLAR_LABEL}"))`
    )
    .locator(".prd-prop-value-text");
}
