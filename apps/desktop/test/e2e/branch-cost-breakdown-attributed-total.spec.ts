/**
 * ISS-6949 regression, launched Desktop — the Branch-detail "Cost breakdown"
 * header must show the branch's canonical attributed cost, not the
 * phase-attribution rollup residue.
 *
 * The two figures come from different tables: `attributedCostUsd` is
 * `token_usage.cost_usd_estimated / branch_count`, while the phase rollups are
 * priced from `token_events` inside projected activity segments. Seeding a
 * session whose segment-priced spend covers only PART of its `token_usage` cost
 * reproduces the production divergence end to end — real SQLite, real
 * main-process projection, real renderer.
 *
 * This is a focused sibling of `branch-details.spec.ts` rather than an addition
 * to it (`apps/desktop/test/AGENTS.md` prefers extending the owning harness
 * "where possible"): that harness does no two-launch seeding and no
 * activity-segment or token-event seeding, whereas `branches-zero-spend-card.spec.ts`
 * — the pattern this follows — is exactly that shape.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  gotoNav,
  launchDesktopApp,
} from "./helpers/desktop-app";
import {
  applyDesktopSeedPragmas,
  openSeedClient,
} from "./helpers/desktop-seed-core";
import {
  seedSessionActivitySegments,
  seedSessionTokenEvents,
  waitForActivitySegmentsSchema,
  waitForActivityTokenEventsSchema,
} from "./helpers/seed-activity-segments";
import {
  type BranchDetailsSeed,
  seedBranchDetails,
} from "./helpers/seed-branch-details-db";
import {
  pricedTokenUsageBatchItem,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SEED: BranchDetailsSeed = {
  repoFullName: "acme/web",
  branchName: "iss-6949-attributed-cost-e2e",
  sessionId: "iss-6949-attributed-cost-e2e-session",
  mergedPullRequest: {
    number: 6949,
    title: "Reconcile the Branch cost breakdown",
    mergedAt: "2026-08-04T15:00:00.000Z",
  },
  activePullRequest: {
    number: 6950,
    title: "Follow-up review cycle",
    openedAt: "2026-08-05T16:00:00.000Z",
  },
};

/** The session's whole priced cost, in `token_usage`. Branch count is 1. */
const ATTRIBUTED_COST_USD = 24;
/** Only this much of it lands inside a priced, phase-attributed segment. */
const ROLLUP_COST_USD = 8;

const SEGMENT_START_MS = Date.parse("2026-08-04T12:00:00.000Z");
const SEGMENT_END_MS = Date.parse("2026-08-04T12:30:00.000Z");

/**
 * THREE facts have to be true before a priced segment reaches a phase rollup,
 * and `seedClosedAtOnlySinglePrBranch` supplies none of them — its corpus is
 * a Branches-LIST fixture, and the list never runs the phase projector. Each was
 * measured against the launched app, not assumed.
 *
 * 1. The PR is seeded with `closed_at` and a NULL
 *    `opened_at`. `normalizeCycles` calls that a MALFORMED cycle, drops it, and
 *    marks the projection `malformed_evidence`; the only surviving cycle is then
 *    the active PR, opened a day AFTER the segment.
 * 2. Its branch link carries `relation = 'authored'`, which is not an
 *    `ArtifactRefRelation` member at all, so `toArtifactRefRelation` nulls it and
 *    `branchLifecycleEventsForBranchLink` emits NOTHING. The write relation the
 *    extractor really produces is `created`.
 * 3. That link is observed at seed time ("now"), hours to weeks after the
 *    segment. `phaseForSegment` classifies a segment ONLY from the lifecycle
 *    events its own window CONTAINS, so a write outside the span leaves the
 *    segment with no phase — and `projectSegment` drops it returning `null`,
 *    silently, adding no completeness reason at all.
 *
 * Any one of them alone yields ZERO projected segments, which is the difference
 * between a fixture that reproduces ISS-6949 and one that reproduces nothing:
 * with no segments the card renders the em dash (case 1) or `$0.00` (cases 2/3)
 * on BOTH sides of this fix. Anchoring a real write inside the segment, within a
 * well-formed cycle, is what makes the `$8` rollup residue real — so the
 * header's `$24.00` is a value only the reconciliation can produce.
 */
const MERGED_PR_OPENED_AT = "2026-08-04T10:00:00.000Z";
const BRANCH_WRITE_RELATION = "created";
const BRANCH_WRITE_AT = new Date(
  SEGMENT_START_MS + 15 * 60 * 1000
).toISOString();

// Copy pinned as literals: a desktop e2e spec must not import workspace TS
// subpaths — an extension-less `@repo/*` import aborts the WHOLE Electron suite
// at load time, before any test runs (see branches-zero-spend-card.spec.ts).
const COST_BREAKDOWN_TITLE = "Cost breakdown";
const ATTRIBUTED_TOTAL_TEXT = "$24.00";
const ROLLUP_RESIDUE_TEXT = "$8.00";
/**
 * whitlockk review (PR #7912): the footnote was pinned on the browser twin only, so
 * it could vanish or drift on this shell with every suite still green.
 *
 * `BranchMetricDisclosure.DefaultIncomplete`, spelled out because a desktop e2e
 * spec must not import workspace TS subpaths. The browser twin locates the same
 * sentence through the constant itself, so a reword reddens there rather than
 * leaving this literal to rot silently.
 *
 * It is that member and not `CostIncomplete` because nothing in this seed has
 * unavailable cost: the one segment's one token event is priced, the two PR
 * cycles normalize cleanly, so phase coverage is Complete and the rows are short
 * only because the $8 they can place does not round to the session's $24.
 */
const PARTIAL_ROWS_DISCLOSURE =
  "* Calculated from available data. Some qualifying values are unavailable, so this number is incomplete.";
/** The sentence this seed must NOT print — it names a cause this seed lacks. */
const UNAVAILABLE_COST_DISCLOSURE =
  "* Calculated from available qualifying Session costs. Activity with unavailable cost is excluded.";

test.describe("ISS-6949 Branch detail cost breakdown", () => {
  test("header shows the attributed cost, not the phase-rollup residue", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss6949-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss6949-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss6949-udd-")
    );
    const env = {
      CLAUDE_HOME: claudeHome,
      CODEX_HOME: codexHome,
    };

    try {
      // Launch 1 — migrate, then confirm ALL THREE schemas the seeders below
      // need. `waitForBranchesSchema` alone is NOT a substitute: it ends at
      // migration 0005, the activity-segment table lands in 0011 and the
      // token-event cost columns in 0043, so tearing down here on its signal
      // alone can leave the later seeders with no migration host and spinning to
      // timeout (the helper's own docstring says so).
      const first = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      await waitForBranchesSchema(userDataDir);
      await waitForActivitySegmentsSchema(userDataDir);
      await waitForActivityTokenEventsSchema(userDataDir);
      await first.cleanup();

      // Seed while the app is DOWN.
      await seedBranchDetails(userDataDir, SEED);
      await anchorPhaseEvidenceToSegment(userDataDir, SEED.sessionId);
      await topUpSessionTokenUsage(
        userDataDir,
        SEED.sessionId,
        ATTRIBUTED_COST_USD
      );
      await seedSessionActivitySegments(userDataDir, SEED.sessionId, [
        {
          phase: "implement",
          startMs: SEGMENT_START_MS,
          endMs: SEGMENT_END_MS,
        },
      ]);
      // Only $8 of the session's $24 is priced inside that span, so the phase
      // rollups under-cover the branch's real cost — the ISS-6949 shape.
      await seedSessionTokenEvents(userDataDir, SEED.sessionId, [
        {
          createdAt: new Date(SEGMENT_START_MS + 60_000).toISOString(),
          costUsd: ROLLUP_COST_USD,
        },
      ]);

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "branches");
        await expect(
          page.locator("header").getByText("Branches", { exact: true })
        ).toBeVisible({ timeout: 30_000 });
        await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);

        const branchLink = page
          .locator('a[href^="#/branches/"]')
          .filter({ hasText: SEED.branchName });
        await expect(branchLink).toBeVisible({ timeout: 30_000 });
        await branchLink.click();
        await expect(
          page.locator("header").getByText(SEED.branchName, { exact: true })
        ).toBeVisible({ timeout: 30_000 });

        const card = page.locator(".bq-costbd:visible").first();
        await expect(card.getByText(COST_BREAKDOWN_TITLE)).toBeVisible({
          timeout: 30_000,
        });
        const total = card.locator(".bq-sec-count");
        // The defect: this read the $8 residue while the branch's own attributed
        // cost — what the Sessions & timeline tab shows — was $24.
        await expect(total).toHaveText(ATTRIBUTED_TOTAL_TEXT, {
          timeout: 30_000,
        });
        await expect(total).not.toHaveText(ROLLUP_RESIDUE_TEXT);

        // The rows really are short of that header, and this shell has to say
        // so in the same words the browser one does.
        await expect(
          card.getByText(PARTIAL_ROWS_DISCLOSURE, { exact: true })
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          card.getByText(UNAVAILABLE_COST_DISCLOSURE, { exact: true })
        ).toHaveCount(0);

        await page.screenshot({
          fullPage: true,
          path: test.info().outputPath("iss-6949-cost-breakdown.png"),
        });

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
 * Open the merged PR's cycle around the priced segment and move the branch write
 * inside it, so the segment can be classified into a phase at all — see
 * {@link MERGED_PR_OPENED_AT} for what each one is fixing.
 *
 * Patched here rather than in `seedClosedAtOnlySinglePrBranch`: that helper
 * is shared by the Branches List specs, whose subject is an UN-enriched merged
 * PR observed at seed time, and widening it would move evidence those specs
 * assert on.
 */
async function anchorPhaseEvidenceToSegment(
  userDataDir: string,
  sessionId: string
): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopSeedPragmas(client);
    await client.batch(
      [
        {
          sql: "UPDATE pull_requests SET opened_at = ? WHERE id = ?",
          args: [MERGED_PR_OPENED_AT, `pr-${sessionId}`],
        },
        {
          sql: "UPDATE session_artifact_links SET relation = ?, observed_at = ? WHERE id = ?",
          args: [BRANCH_WRITE_RELATION, BRANCH_WRITE_AT, `link-${sessionId}`],
        },
      ],
      "write"
    );
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/**
 * Add a priced `token_usage` row for a session that already exists. The
 * `seedNoPullRequestBranch` / `seedSessionsList` helpers both INSERT INTO
 * `sessions`, which would collide with the row `seedBranchDetails` just created.
 */
async function topUpSessionTokenUsage(
  userDataDir: string,
  sessionId: string,
  costUsd: number
): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopSeedPragmas(client);
    await client.batch(
      [pricedTokenUsageBatchItem(sessionId, costUsd)],
      "write"
    );
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}
