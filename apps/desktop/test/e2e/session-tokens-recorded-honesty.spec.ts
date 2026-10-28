/**
 * A local session with no token_usage rows must reach the Desktop Tokens/Cost
 * unavailable state through the real assignment and detail IPC adapters.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  gotoHash,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

/**
 * The flag key as a LITERAL, not imported from
 * `../../src/shared/feature-flags`. A constant imported from the source would
 * follow the source if it regressed; this has to be spelled out to stay a
 * trip-wire. It is pinned against the shared key constant by
 * `apps/desktop/test/feature-flags-cross-surface.test.ts`, which is what stops
 * the two drifting silently.
 */
const TOKENS_HONESTY_FLAG_KEY = "session-tokens-recorded-honesty";

const SESSION_ID = "iss-5637-unrecorded-tokens-session";
const SESSION_NAME = "ISS-5637 unrecorded tokens session";

const SESSION_TITLE_SELECTOR = ".sd3-head h1";
const PROPERTY_ROW_SELECTOR = ".prd-prop";
const PROPERTY_VALUE_SELECTOR = ".prd-prop-value";

const MOUNT_TIMEOUT_MS = 30_000;

/**
 * The pre-fix string, kept as a literal for the same reason as the flag key.
 * This is the fabrication itself: a measured-looking input count on a session
 * where nothing was ever counted, rendered two rows above a Cost dash whose
 * tooltip says "No token usage recorded to price".
 */
const FABRICATED_INPUT_COUNT = "0 in";

/** The shipped sentence, carried on the row's accessible name (ISS-5581). */
const UNRECORDED_SENTENCE = "Token counts were not recorded for this session";

test.describe("session detail reports unrecorded token counts honestly", () => {
  test("a session with no token usage dashes the Tokens row instead of printing four zeros", async () => {
    test.setTimeout(180_000);

    await withSeededSession(
      { flagOn: true, prefix: "desktop-tokens-honesty-on" },
      async (page) => {
        const tokensRow = propertyRow(page, "Tokens");
        await expect(tokensRow).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // The defect: four zeros asserted as measurements.
        await expect(tokensRow).not.toContainText(FABRICATED_INPUT_COUNT);
        // The corrected rendered state — the bug was visual, so this pins the
        // dash itself and not merely the absence of the zeros.
        await expect(
          tokensRow.locator('[data-slot="grid-empty-value"]')
        ).toBeVisible();
        // …and the reason is reachable as text rather than as a bare glyph.
        await expect(tokensRow).toContainText(UNRECORDED_SENTENCE);

        // The row this one was contradicting. Asserted on the SAME rendered
        // panel so the two are compared to each other, not each to a constant:
        // one session, one verdict about whether its tokens were recorded.
        //
        // A literal dash, not the `grid-empty-value` slot the Tokens row uses:
        // this row renders `deriveSessionCostLabel`, whose `formatCostLabel`
        // returns the "—" STRING for every non-Available branch. The two rows
        // reaching one verdict through different renderings is the point — the
        // shared `hasRecordedTokenUsage` predicate is what ties them together,
        // not a shared component.
        const costRow = propertyRow(page, "Cost");
        await expect(costRow).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(costRow.locator(PROPERTY_VALUE_SELECTOR)).toHaveText("—");
      }
    );
  });
});

/**
 * One Properties row, located by its own label rather than by position. The
 * panel's row order is not a contract and shifts as rows are added; the label
 * is. `exact: true` because a substring match on "Cost" would also admit the
 * "Claude-Reported Cost" row when that flag is on.
 */
function propertyRow(page: Page, label: string): Locator {
  return page
    .locator(PROPERTY_ROW_SELECTOR)
    .filter({ has: page.getByText(label, { exact: true }) });
}

/**
 * The Properties panel is a DISCLOSURE, collapsed on first paint, so every row
 * read here is behind one click. Expanding it is the load-bearing precondition
 * for the negative assertions: an unexpanded panel renders no rows at all, and
 * a spec that skipped it would report the fix holding on a screen that never
 * showed the values.
 */
async function expandProperties(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Properties", exact: true });
  await expect(toggle).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await toggle.click();
}

/**
 * Launch the built app twice against ONE temp profile — once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real local session-detail
 * read projects the seeded row at boot. The flag is seeded on BOTH
 * launches because the standard profile seed rewrites the assignment file each
 * time.
 *
 * The session is seeded WITHOUT `estimatedCost` on purpose: that is what leaves
 * it with no `token_usage` row, which is the unrecorded state under test.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only session is the seeded one.
 */
async function withSeededSession(
  { flagOn, prefix }: { flagOn: boolean; prefix: string },
  run: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const seedGate = (dir: string) => {
    if (flagOn) {
      seedDesktopFeatureFlags(dir, { [TOKENS_HONESTY_FLAG_KEY]: true });
    }
  };
  const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };

  try {
    const first = await launchDesktopApp({
      beforeLaunch: seedGate,
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
      { name: SESSION_NAME, sessionId: SESSION_ID },
    ]);

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      beforeLaunch: seedGate,
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await gotoHash(page, `/sessions/${SESSION_ID}`);
      await expect(page.locator(SESSION_TITLE_SELECTOR)).toHaveText(
        SESSION_NAME,
        { timeout: MOUNT_TIMEOUT_MS }
      );
      await expandProperties(page);

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
