/**
 * ISS-5401 (Electron twin): the Sessions Cost tile over a cohort that consumed
 * tokens and priced NOTHING, driven seed-to-render through the real desktop
 * SQLite store and the renderer's mounted `SessionsSummaryCards`.
 *
 * `SessionsSummaryCards` is shared through `packages/app` and mounts on web AND
 * here, so `packages/app/AGENTS.md` ("E2E Coverage for UI Surfaces") requires a
 * real-surface regression on EACH adapter. The web twin is
 * `e2e/sessions-unpriced-cost-tile.spec.ts`, which mocks the HTTP usage payload.
 * What only THIS can prove is that the unpriced state survives the desktop's
 * own producer: the summary is folded locally from `token_usage`
 * (`shared-agent-sessions-usage-summary.ts` `foldUsageAggregate` over
 * `sync-source.ts` `aggregateSqliteUsage`), a completely different derivation
 * from the cloud `groupBy` the web twin stands in for. A component test
 * injecting a payload never exercises either.
 *
 * The seeded shape, and why it is the honest one. `seedSessionsList` writes a
 * `token_usage` row (1,000 input / 500 output) for any seed carrying an
 * `estimatedCost`, and an EXPLICIT `cost_usd_estimated = 0` keeps that row inert
 * against both boot heals — `repriceUnpricedTokenUsage` matches only NULL costs
 * or non-zero baselines, and `healTokenUsageEventConservation` needs a
 * `token_events` join we do not seed. So the fold sees real tokens and a
 * genuine zero in all three ledgers, which is exactly the production cohort:
 * work happened, nothing could be priced.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

/**
 * The Sessions Cost tile's per-surface label (`SESSIONS_COST_METRIC_CARD_LABEL`,
 * ISS-4401), pinned as a literal — importing from `packages/app` would drag
 * extension-less workspace subpaths through Playwright's Node loader and abort
 * the whole Electron run at load time, the same reason the sibling
 * `sessions-cost-billing-honesty.spec.ts` pins its flag key.
 *
 * Every text assertion below uses `{ exact: true }`: Playwright's text matcher
 * is SUBSTRING by default, and the bare word "Cost" also occurs in the table's
 * Cost column header and the Cost filter facet.
 */
const COST_TILE_LABEL = "cost";
/** `SESSIONS_COST_NO_COST_RECORDED_DETAIL` — the reason under the dash. */
const NO_COST_RECORDED_DETAIL = "No cost recorded";
/** The tile's honest-empty glyph (`KPI_NO_VALUE`). */
const NO_VALUE_GLYPH = "—";
/** The fabricated headline this ticket removes. */
const FABRICATED_ZERO = "$0";
const TOTAL_TOKENS_TILE_LABEL = "Total Tokens";
/**
 * Two seeds × `pricedTokenUsageBatchItem`'s fixed 1,000 input + 500 output =
 * 3,000 tokens, which `formatTokenCount` renders as "3.00k". This is the figure
 * that must survive BESIDE the dash: a fix that blanked the whole strip would be
 * a different bug, and this is the assertion that catches it.
 */
const TOTAL_TOKENS_HEADLINE = "3.00k";
const MOUNT_TIMEOUT_MS = 45_000;

const SEEDED: SessionListSeed[] = [
  {
    sessionId: "iss-5401-unpriced-a",
    name: "iss-5401 unpriced session a",
    // An EXPLICIT zero, not the default NULL: NULL would arm the boot reprice
    // (a pricing miss on 'seed-model', so still zero, but no longer an inert
    // fixture) and the state under test would depend on a heal's behaviour.
    estimatedCost: 0,
    // Not a subscription mode — the unknown ledger. A subscription mode would
    // still fold to zero here, but it is the cohort the predicate's KNOWN LIMIT
    // deliberately accepts a column disagreement for, which is a different case
    // (pinned in the component suite).
    billingMode: null,
  },
  {
    sessionId: "iss-5401-unpriced-b",
    name: "iss-5401 unpriced session b",
    estimatedCost: 0,
    billingMode: null,
  },
];

test.describe("Sessions Cost tile over an unpriced cohort (ISS-5401)", () => {
  test("dashes with its reason instead of fabricating $0, and leaves the token figure standing", async () => {
    test.setTimeout(240_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-unpriced-cost-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts — which carry
    // REAL costs, and a single priced session anywhere in the cohort takes the
    // tile off the unpriceable path and silently inverts this spec.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-unpriced-cost-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-unpriced-cost-udd-")
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

      const app = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await gotoNav(app.page, "sessions");
        await app.page.locator('[aria-label="All time"]:visible').click();

        // The tile keeps its identity — it dropped its VALUE, not its label, so
        // the reader can tell which metric is missing.
        const costTile = app.page.locator('[data-slot="card"]').filter({
          has: app.page.getByText(COST_TILE_LABEL, { exact: true }),
        });
        await expect(costTile).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // The headline is the honest-empty dash...
        await expect(costTile.locator('[data-slot="card-title"]')).toHaveText(
          NO_VALUE_GLYPH,
          { timeout: MOUNT_TIMEOUT_MS }
        );
        // ...and the caption says WHY. An uncaptioned dash is indistinguishable
        // from the failed-read dash this same tile renders.
        await expect(
          costTile.getByText(NO_COST_RECORDED_DETAIL, { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // The defect itself: no fabricated zero anywhere on the surface.
        await expect(
          app.page.getByText(FABRICATED_ZERO, { exact: true })
        ).toHaveCount(0);

        // The tokens beside it still read as a real figure — the tile withheld
        // ONE uncomputable number, it did not blank a strip whose other metrics
        // are perfectly well known.
        const tokensTile = app.page.locator('[data-slot="card"]').filter({
          has: app.page.getByText(TOTAL_TOKENS_TILE_LABEL, { exact: true }),
        });
        await expect(tokensTile.locator('[data-slot="card-title"]')).toHaveText(
          TOTAL_TOKENS_HEADLINE,
          { timeout: MOUNT_TIMEOUT_MS }
        );

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
