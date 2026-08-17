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
 * Why the shipped coverage was not enough: PR #4260's reviewer (wongk) flagged
 * that only the web spec (mocked HTTP fixtures) covered this regression. The
 * desktop LOCAL detail read is a SEPARATE numerator path from the web/cloud
 * session projection: `sync-source.ts`'s ungated `branchLocRows` query, gated
 * on `relation IN ('created', 'workspace')` — DIFFERENT from the Branches-page
 * read's `relation='authored'` gate every existing `seed-branches-db.ts`
 * helper writes — populates `session.branchDiffStats`, and
 * `sessionLocPerDollarNumeratorLoc` reads that via `Math.max(gitLoc, branchLoc)`.
 * Nothing proved that local read, and the formatter it feeds, actually produce
 * the significant-digit rendering end-to-end through a real launched renderer
 * reading a real seeded SQLite corpus, rather than a hand-built props object.
 *
 * This seeds a large-cost / modest-LOC session (same worked numbers as the web
 * spec: 44 lines changed against $5,000 → 0.0088) whose true ratio is non-zero
 * but below `0.01`, so the assertion fails specifically on the 2dp-floor-to-
 * "0.00" failure mode rather than on any arbitrary formatting change. A second
 * test seeds no priced cost at all (no `token_usage` row), covering the
 * genuinely-undefined-ratio placeholder path the same formatter must also get
 * right — asserted as an honest "—", never a fabricated `0.00`.
 *
 * Seeding mechanism (see helpers/seed-loc-per-dollar-db.ts): a session linked
 * to one fully LOC-enriched branch artifact via `relation='created'` (the gate
 * the session-detail LOC read requires; `seedMergedUnenrichedSinglePrBranch`
 * and friends in `seed-branches-db.ts` link via `relation='authored'`, which
 * feeds the Branches-page read instead and would leave
 * `session.branchDiffStats` empty here). Because a running app does not
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
// 44 lines changed against $5,000 of spend → 44 / 5000 = 0.0088. Matches
// `e2e/session-detail-loc-per-dollar.spec.ts`'s worked example verbatim: under
// the `0.01` two-dp floor, which is exactly the band ISS-4667 was flooring to
// "0.00", and far enough from it that the rendering is unambiguous.
const SMALL_RATIO_LINES_ADDED = 40;
const SMALL_RATIO_LINES_REMOVED = 4;
const SMALL_RATIO_COST = 5000;
const SMALL_RATIO_RENDERED = "0.0088";
// The exact lie the fix removed. Asserted as a negative so a re-floored build
// fails on the specific defect, not merely on an unexpected string.
const FLOORED_RENDERED = "0.00";
// The honest not-applicable placeholder for an undefined ratio (no cost to
// divide by). Pinned as a literal for the same `@repo/*`-import-ban reason as
// `LOC_PER_DOLLAR_LABEL` above.
const NOT_APPLICABLE_RENDERED = "—";

const SESSION_TITLE_SELECTOR = ".sd3-head h1";
const PROPERTIES_SECTION_SELECTOR = "section.prd-props-section";
const PROPERTIES_BUTTON_NAME = "Properties";
const MOUNT_TIMEOUT_MS = 30_000;

// A distinctive, non-default repo/branch pair, priced at $5,000 against 44
// lines of churn — a genuine sub-cent ratio.
const SMALL_RATIO_SEED: SessionDetailLocPerDollarSeed = {
  branchName: "iss-4667-small-ratio-desktop",
  costUsd: SMALL_RATIO_COST,
  filesChanged: 3,
  linesAdded: SMALL_RATIO_LINES_ADDED,
  linesRemoved: SMALL_RATIO_LINES_REMOVED,
  repoFullName: "acme/web",
  sessionId: "iss-4667-session-detail-loc-per-dollar-small-ratio",
};

// Same churn, but `costUsd` is omitted on purpose — the seeder then writes NO
// `token_usage` row, so the ratio is genuinely undefined (no cost to divide
// by), not merely zero.
const UNPRICED_SEED: SessionDetailLocPerDollarSeed = {
  branchName: "iss-4667-unpriced-desktop",
  filesChanged: 3,
  linesAdded: SMALL_RATIO_LINES_ADDED,
  linesRemoved: SMALL_RATIO_LINES_REMOVED,
  repoFullName: "acme/web",
  sessionId: "iss-4667-session-detail-loc-per-dollar-unpriced",
};

test.describe("Session detail LOC/$ property (ISS-4667)", () => {
  test("session detail renders a sub-cent LOC/$ ratio instead of flooring it to 0.00", async () => {
    test.setTimeout(180_000);

    await withSeededSessionDetail(
      SMALL_RATIO_SEED,
      "desktop-session-loc-per-dollar-small-ratio",
      async ({ page, pageErrors, propertiesSection }) => {
        const value = locPerDollarValue(propertiesSection);
        await expect(value).toBeVisible();
        await expect(value).toHaveText(SMALL_RATIO_RENDERED);
        await expect(value).not.toHaveText(FLOORED_RENDERED);

        await page.screenshot({
          fullPage: true,
          path: test
            .info()
            .outputPath("session-detail-loc-per-dollar-small-ratio.png"),
        });
        expect(pageErrors).toEqual([]);
      }
    );
  });

  test("session detail renders the not-applicable placeholder for an unpriced LOC/$", async () => {
    test.setTimeout(180_000);

    await withSeededSessionDetail(
      UNPRICED_SEED,
      "desktop-session-loc-per-dollar-unpriced",
      async ({ page, pageErrors, propertiesSection }) => {
        const value = locPerDollarValue(propertiesSection);
        await expect(value).toBeVisible();
        await expect(value).toHaveText(NOT_APPLICABLE_RENDERED);
        await expect(value).not.toHaveText(FLOORED_RENDERED);

        await page.screenshot({
          fullPage: true,
          path: test
            .info()
            .outputPath("session-detail-loc-per-dollar-unpriced.png"),
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
 * by both tests so the launch/seed/navigate/cleanup dance is written once.
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

  try {
    // Launch 1 — create + migrate the SQLite schema, then close so the seed
    // writes with the app DOWN (a running app does not observe another
    // process's writes to its own store).
    const first = await launchDesktopApp({
      env: { CLAUDE_HOME: claudeHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedSessionDetailLocPerDollarBranch(userDataDir, seed);

    // Launch 2 — the real local session-detail read projects the seeded
    // corpus.
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      env: { CLAUDE_HOME: claudeHome },
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
