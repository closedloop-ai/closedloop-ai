/**
 * ISS-4773 (Electron twin, wongk review): the Sessions Cost card's honest basis,
 * driven seed-to-render through the real desktop SQLite store, the persisted
 * Labs setting, and the renderer's mounted `SessionsSummaryCards`.
 *
 * `SessionsSummaryCards` is shared through `packages/app` and mounts on web AND
 * here, so the repo's cross-surface rule requires a real-surface regression on
 * EACH adapter. The web twin is `e2e/sessions-cost-billing-honesty.spec.ts`.
 * Component tests already cover the resolver; what only this can prove is that
 * the persisted `SettingsStore` flag actually reaches the mounted card through
 * `DesktopFeatureFlagProvider` — the hop a component test injecting an adapter
 * directly never exercises.
 *
 * Two launches over the SAME store and the SAME corpus:
 *   1. flag at its registry DEFAULT (off) — the card reads the collapsed
 *      not-subscription bucket under "cost", today's behavior,
 *      which is why the flag is closed-by-default.
 *   2. flag persisted ON — the headline drops to confirmed API-billed spend
 *      under its own label and the excluded share is disclosed.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

/**
 * ISS-4773: the Labs flag key, pinned as a LITERAL rather than imported from
 * `src/shared/feature-flags`.
 *
 * That module is main-process code whose transitive imports include
 * extension-less TypeScript subpaths of workspace packages. Vite/vitest resolve
 * them; Playwright's Node loader does not, and importing the registry from a
 * spec aborts the WHOLE Electron e2e run at load time before any test executes.
 * Sibling specs (`sessions-local-authored-pr-gate`, `sessions-quarantine-caveat`)
 * pin their keys the same way for the same reason.
 *
 * Drift is caught elsewhere: `test/feature-flags-cross-surface.test.ts` pins this
 * exact key byte-for-byte against its `packages/app` PostHog twin, so a rename
 * fails there rather than silently making this spec seed a flag nothing reads.
 */
const SESSIONS_COST_BILLING_HONESTY_FLAG_KEY = "sessions-cost-billing-honesty";

/**
 * A metered session ($42, billed to an API key) beside a much larger session
 * whose billing mode was never determined ($16,783). That is the reported
 * ISS-4773 shape: the collapsed bucket is dominated by usage nobody confirmed
 * was ever charged.
 */
const METERED_SESSION_COST = 42;
const UNKNOWN_SESSION_COST = 16_783;
const COLLAPSED_BUCKET_HEADLINE = "$16,825";
const METERED_HEADLINE = "$42";
const HONEST_LABEL = "API-billed Cost";
const SHIPPED_LABEL = "cost";
const BILLING_UNKNOWN_PATTERN = /billing unknown/;
const MOUNT_TIMEOUT_MS = 45_000;

/**
 * ISS-4919 (wongk review) — a subscription-covered total that is REAL but too
 * small for any figure the whole-dollar tile can render. `formatCurrencyWhole`
 * now states a bound for that band, which is the right render for a KPI value
 * and the WRONG one for this card's caption grammar: "+< $0.01 if billed to API"
 * is a "+<" glyph pile wrapped around the quantity the sentence exists to state.
 */
const SUB_FLOOR_SUBSCRIPTION_COST = 0.000_01;
/** A subscription mode, so the cost lands in the `subscriptionEstimatedCost`
 *  ledger this caption reads (`SUBSCRIPTION_BILLING_MODES`). */
const SUBSCRIPTION_BILLING_MODE = "max_20x";
/** The malformed caption that must never reach a real adapter's screen. */
const MALFORMED_BOUND_CAPTION_PATTERN = /\+\s*[<>].*if billed to API/;
/** The caption's stable tail, matched to assert the whole line is dropped. */
const BILLED_TO_API_PATTERN = /if billed to API/;

const SUB_FLOOR_SEEDED: SessionListSeed[] = [
  {
    sessionId: "iss-4919-metered",
    name: "iss-4919 metered session",
    estimatedCost: METERED_SESSION_COST,
    billingMode: "api",
  },
  {
    sessionId: "iss-4919-subscription-subfloor",
    name: "iss-4919 sub-floor subscription session",
    // Real, positive, and below the whole-dollar tile's renderable floor — the
    // exact band that used to render "$0.00" and now renders a bound.
    estimatedCost: SUB_FLOOR_SUBSCRIPTION_COST,
    billingMode: SUBSCRIPTION_BILLING_MODE,
  },
];

const SEEDED: SessionListSeed[] = [
  {
    sessionId: "iss-4773-metered",
    name: "iss-4773 metered session",
    estimatedCost: METERED_SESSION_COST,
    // A metered mode → the confirmed-API-billed half of the bucket.
    billingMode: "api",
  },
  {
    sessionId: "iss-4773-unknown",
    name: "iss-4773 unknown-billing session",
    estimatedCost: UNKNOWN_SESSION_COST,
    // A null billing mode is the genuinely unclassified bucket — NOT
    // `subscription_unknown`, which is a SUBSCRIPTION mode and never enters
    // this figure at all.
    billingMode: null,
  },
];

test.describe("Sessions Cost billing honesty (ISS-4773)", () => {
  test("the persisted Labs flag moves the headline to confirmed API-billed spend", async () => {
    test.setTimeout(240_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-cost-honesty-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts, inflating the
    // seeded corpus this spec pins.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-cost-honesty-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-cost-honesty-udd-")
    );
    const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      const first = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      await seedSessionsList(userDataDir, SEEDED);

      // Launch 2 — flag at its registry DEFAULT (off). The shipped presentation
      // renders, which is also the closed-by-default guarantee.
      const off = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await gotoNav(off.page, "sessions");
        await off.page.locator('[aria-label="All time"]:visible').click();

        await expect(
          off.page.getByText(SHIPPED_LABEL, { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(
          off.page.getByText(COLLAPSED_BUCKET_HEADLINE, { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(
          off.page.getByText(HONEST_LABEL, { exact: true })
        ).toHaveCount(0);
        await expect(off.page.getByText(BILLING_UNKNOWN_PATTERN)).toHaveCount(
          0
        );

        expect(off.pageErrors).toEqual([]);
      } finally {
        await off.cleanup();
      }

      // Launch 3 — the SAME store, the SAME corpus, flag persisted ON. Only the
      // setting differs, so anything that changes below is the flag's doing.
      const on = await launchDesktopApp({
        beforeLaunch: () =>
          seedDesktopFeatureFlags(userDataDir, {
            [SESSIONS_COST_BILLING_HONESTY_FLAG_KEY]: true,
          }),
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await gotoNav(on.page, "sessions");
        await on.page.locator('[aria-label="All time"]:visible').click();

        // The narrowing is visible in the LABEL, not only in the popover.
        await expect(
          on.page.getByText(HONEST_LABEL, { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(
          on.page.getByText(SHIPPED_LABEL, { exact: true })
        ).toHaveCount(0);

        // The headline is the confirmed figure, not the unknown-dominated one.
        await expect(
          on.page.getByText(METERED_HEADLINE, { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(
          on.page.getByText(COLLAPSED_BUCKET_HEADLINE, { exact: true })
        ).toHaveCount(0);

        // Excluding the unclassified share stops the card OVERstating spend;
        // naming it stops the card UNDERstating the population.
        await expect(on.page.getByText(BILLING_UNKNOWN_PATTERN)).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });

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

  /**
   * ISS-4919 (wongk review): `packages/app/AGENTS.md` requires a regression
   * through EVERY adapter that mounts a shared-UI fix, and `SessionsSummaryCards`
   * mounts on the Electron renderer as well as the web shell. Helper and
   * component tests cover `formatCostMetricDetail`'s drop guard directly; only
   * this proves the guard survives the real mounted card in the Electron shell,
   * against a cost that came out of the local SQLite ledger rather than a mocked
   * HTTP payload. The web twin is the same-named case in
   * `e2e/sessions-cost-billing-honesty.spec.ts`.
   *
   * Run at the flag DEFAULT (off) deliberately — the detail line is the shipped
   * presentation, so that is where the malformed caption would ship.
   */
  test("a sub-floor subscription cost drops the caption instead of rendering a bound", async () => {
    test.setTimeout(240_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-subfloor-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-subfloor-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-subfloor-udd-")
    );
    const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };

    try {
      const first = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      await seedSessionsList(userDataDir, SUB_FLOOR_SEEDED);

      const app = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await gotoNav(app.page, "sessions");
        await app.page.locator('[aria-label="All time"]:visible').click();

        // The card itself still renders — this is a caption drop, not a broken
        // card, and the metered headline is unaffected by the tiny subscription
        // term sitting beside it.
        await expect(
          app.page.getByText(SHIPPED_LABEL, { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(
          app.page.getByText(METERED_HEADLINE, { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // The malformed state, asserted specifically...
        await expect(
          app.page.getByText(MALFORMED_BOUND_CAPTION_PATTERN)
        ).toHaveCount(0);
        // ...and the whole detail line, since a bound carries no figure this
        // sentence can use. Dropping it is the honest outcome: no caption beats
        // a caption that promises an amount and then shows an inequality.
        await expect(app.page.getByText(BILLED_TO_API_PATTERN)).toHaveCount(0);

        expect(app.pageErrors).toEqual([]);
      } finally {
        await app.cleanup();
      }
    } finally {
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });
});
