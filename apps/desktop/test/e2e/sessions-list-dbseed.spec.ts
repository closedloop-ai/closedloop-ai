/**
 * E2E deep flow (FEA-2939): the Sessions view — list → detail → back — proven
 * against a DB-direct seed.
 *
 * `sessions-flow.spec.ts` drives the transcript importer and is entirely
 * quarantined (`test.fixme`) by the FEA-2187 read-your-writes WAL race: the
 * imported rows intermittently do not surface in the list. As a result the
 * Sessions view — the primary desktop surface — had NO passing spec asserting
 * that rows appear at all.
 *
 * This spec closes that gap the same way the Branches specs did: it seeds the
 * rows straight into the app's SQLite store while the app is DOWN (no
 * cross-process WAL contention) and reads them on the NEXT boot, so there is no
 * importer race to flake on. The Sessions read path projects the `sessions`
 * table directly (no artifact/link join), but a bare seeded row is NOT enough:
 * since FEA-3284 the list read hides low-signal "idle" rows, so `seedSessionsList`
 * gives each row a synthetic `PreToolUse` tool event (FEA-1421,
 * `substantiveToolEventBatchItem` in `helpers/seed-branches-db.ts`), which the
 * read counts as `toolUseCount > 0`.
 *
 * Flow, the way a user would drive it:
 *   1. the seeded sessions appear in the Sessions list,
 *   2. clicking a row opens the session detail, and
 *   3. the Topbar breadcrumb's "Sessions" parent link returns to the list.
 *
 * A second test (FEA-4299) drives the REAL Repository filter facet against a seed
 * spanning every repo-identity path — resolved (live git remote), stored-only /
 * deleted worktree (stored fallback), stale-stored (stored-first), Unknown
 * (dropped from the facet), and a no-match empty state — asserting the row →
 * option → click → filtered-row contract the SessionsView renders from the usage/
 * analytics IPC reads (which the main-process unit suite cannot cover).
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  normalizeDisplayedSessionStatus,
  SESSION_STATUS,
  type SessionStatus,
} from "@repo/api/src/types/session-status.ts";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display.ts";
import {
  breadcrumbNav,
  breadcrumbParentLink,
  gotoNav,
  launchDesktopApp,
} from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

// ISS-4401: mirror of `SESSIONS_COST_METRIC_CARD_LABEL` from
// `@repo/app/agents/components/sessions/cost-metric-card`. That module cannot be
// imported into a Playwright spec — its self-referencing `@repo/app/…` specifiers
// only resolve through the renderer's vite alias, not the spec's Node runtime
// (see the note atop `branches-page.spec.ts`) — so the visible label is asserted
// as a literal here. Keep this in sync with that SSOT if the label ever changes.
const SESSIONS_COST_METRIC_CARD_LABEL = "cost";

test.describe("Sessions list (DB-direct seed, FEA-2939)", () => {
  test("seeded sessions list, open detail, and navigate back", async () => {
    test.setTimeout(180_000);
    const seededSessions = createSeededSessions();
    const targetSession = seededSessions[TARGET_SESSION_INDEX];

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-dbseed-claude-")
    );
    // Isolate CODEX_HOME too: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts into the store,
    // polluting the seeded corpus this spec asserts on.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-dbseed-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-dbseed-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      // EMPTY CLAUDE_HOME/CODEX_HOME so the collectors ingest nothing: the only
      // rows are the ones we seed, so the list is a deterministic corpus.
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      // Seed the sessions straight into the store while the app is DOWN.
      await seedSessionsList(userDataDir, seededSessions);

      // Launch 2 — the real Sessions IPC source reads the seeded corpus at boot.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "sessions");

        // The seed stamps `last_activity_at` to now, so the rows are in-window on
        // every range; widen to "All time" anyway to be independent of the run
        // clock. `:visible` scopes to the Sessions toolbar (keep-alive views stay
        // mounted-but-hidden and also render this control).
        await page.locator('[aria-label="All time"]:visible').click();

        // The Sessions view is a full-width, table-led page: its title shows only
        // in the Topbar breadcrumb, with no in-body <h1>. Assert the seeded rows
        // themselves render (the coverage the quarantined spec cannot provide).
        for (const session of seededSessions) {
          await expect(
            page.getByRole("link", { name: session.name })
          ).toBeVisible({ timeout: 30_000 });
        }

        // ISS-4401 regression: the desktop Sessions summary Cost card carries the
        // per-surface "cost" label (distinguishing its
        // not-subscription-covered figure from the Dashboard's inclusive total),
        // not the old bare "Cost". The info affordance's accessible name follows
        // the label, so scope to it rather than the table's per-session "Cost"
        // column header.
        await expect(
          page.getByRole("button", {
            name: `About ${SESSIONS_COST_METRIC_CARD_LABEL}`,
          })
        ).toBeVisible({ timeout: 30_000 });

        await assertSessionsFilterAndViewControls(page, seededSessions);

        const visibleSessionLinkNames = await visibleSeededSessionLinkNames(
          page,
          seededSessions
        );
        expect(visibleSessionLinkNames).toContain(targetSession.name);
        expect(visibleSessionLinkNames[0]).toBeDefined();
        expect(visibleSessionLinkNames[0]).not.toBe(targetSession.name);

        // Open a non-first session's detail by clicking its session-name link.
        await page.getByRole("link", { name: targetSession.name }).click();

        // Detail mounted: the breadcrumb gains a "Sessions" parent link, and
        // its current-page span names the session we clicked.
        const backLink = breadcrumbParentLink(page, "Sessions");
        await expect(backLink).toBeVisible({ timeout: 30_000 });
        await expect(
          breadcrumbNav(page).locator('[aria-current="page"]')
        ).toHaveText(targetSession.name);

        // The hash navigated to the detail route for the clicked session id.
        await expect
          .poll(() => page.evaluate(() => window.location.hash), {
            timeout: 15_000,
          })
          .toContain(`/sessions/${targetSession.sessionId}`);

        // Clicking the parent link returns to the list: the breadcrumb's
        // "Sessions" link reverts to the current-page span (so the link is gone)
        // and the list rows are visible again.
        await backLink.click();
        await expect(backLink).toHaveCount(0, { timeout: 15_000 });
        await expect(
          page.getByRole("link", { name: targetSession.name })
        ).toBeVisible();

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  // ISS-4605: the Sessions active-filter chip row. Seed a mixed-status corpus,
  // apply Status=Inactive through the REAL Filter popover, then drive the chip
  // row the desktop renderer mounts under the shared SessionsToolbar: the chip
  // renders with the human label, removing it clears that facet (the filtered-out
  // rows return), and clear-all resets everything.
  //
  // ISS-4696: Inactive, NOT Completed. ISS-4586 retired `completed` from the
  // Status FACET, so driving it here would click a menuitem that no longer
  // exists and assert a chip label the option list can no longer resolve. The
  // seeds still STORE the legacy `completed` value on purpose — that is what
  // proves the Inactive facet reaches not-yet-migrated rows.
  test("active-filter chip row: renders, removes one facet, and clears all", async () => {
    test.setTimeout(180_000);
    const seededSessions = createSeededSessions();
    // The inactive seeds are exactly the rows the Inactive Status facet keeps.
    const inactiveSessions = seededSessions.filter(
      (session) => session.status === SESSION_STATUS.INACTIVE
    );
    const activeSession = seededSessions.find(
      (session) => session.status === SESSION_STATUS.ACTIVE
    );
    if (!activeSession) {
      throw new Error("Seed must include an ACTIVE session for the chip test");
    }

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-chips-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-chips-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-chips-udd-")
    );

    try {
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      await seedSessionsList(userDataDir, seededSessions);

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "sessions");
        await page.locator('[aria-label="All time"]:visible').click();

        for (const session of seededSessions) {
          await expect(
            page.getByRole("link", { name: session.name })
          ).toBeVisible({ timeout: 30_000 });
        }

        // Apply Status=Inactive via the real Filter popover (ISS-4586 retired the
        // Completed option; the legacy `completed` seeds fold into Inactive).
        await page.getByRole("button", { name: "Filter", exact: true }).click();
        await openFilterFacet(page, "Status");
        await page
          .getByRole("menuitem", { name: INACTIVE_STATUS_FACET_MENUITEM_NAME })
          .click();
        await page.keyboard.press("Escape");

        // The ACTIVE row is filtered out and a chip names the active facet.
        await expect(
          page.getByRole("link", { name: activeSession.name })
        ).toHaveCount(0);
        await expect(
          page.getByText(INACTIVE_STATUS_CHIP, { exact: true })
        ).toBeVisible({ timeout: 15_000 });

        // Removing the chip clears the facet: the ACTIVE row returns.
        await page
          .getByRole("button", { name: REMOVE_INACTIVE_STATUS_CHIP })
          .click();
        await expect(
          page.getByText(INACTIVE_STATUS_CHIP, { exact: true })
        ).toHaveCount(0);
        await expect(
          page.getByRole("link", { name: activeSession.name })
        ).toBeVisible();

        // Re-apply, then Clear all resets every facet and hides the chip row.
        await page.getByRole("button", { name: "Filter", exact: true }).click();
        await openFilterFacet(page, STATUS_FACET_MENUITEM_NAME);
        await page
          .getByRole("menuitem", { name: INACTIVE_STATUS_FACET_MENUITEM_NAME })
          .click();
        await page.keyboard.press("Escape");
        await expect(
          page.getByText(INACTIVE_STATUS_CHIP, { exact: true })
        ).toBeVisible();

        await page.getByRole("button", { name: "Clear all" }).click();
        await expect(
          page.getByText(INACTIVE_STATUS_CHIP, { exact: true })
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Clear all" })
        ).toHaveCount(0);
        // Clear all also restores the bounded default date range, which excludes
        // today's still-active row by design. Return to All time, then prove the
        // status facet itself was cleared and the ACTIVE row can return.
        await page.locator('[aria-label="All time"]:visible').click();
        await expect(
          page.getByRole("link", { name: activeSession.name })
        ).toBeVisible();
        for (const session of inactiveSessions) {
          await expect(
            page.getByRole("link", { name: session.name })
          ).toBeVisible();
        }

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  // FEA-4299 (shafty023): the unit suite stops at the main-process helpers, but
  // the Electron SessionsView sources the Repository facet from the usage/
  // analytics IPC reads — so the row → option → click → filtered-row contract can
  // regress while the unit suite stays green. This drives the REAL Repository
  // facet against a DB-direct seed that spans every identity path (ISS-5271
  // ruled STORED-FIRST precedence — the durable stored name wins; live
  // resolution only covers rows with no stored name):
  //   - resolved (no stored name, existing worktree → live git remote),
  //   - stored-only / deleted worktree (stored name wins, no live lookup),
  //   - stale-stored (stored name DISAGREES with the cwd's live remote → the
  //     stored name is the identity until the sync lane writes back the fresh
  //     one; the facet offers it and it filters to its row),
  //   - Unknown (no live remote AND no stored repo → dropped from the facet),
  //   - no-match (selecting one repo option filters to exactly its rows).
  test("Repository facet: options match resolved repos and filter the rows", async () => {
    test.setTimeout(180_000);

    const gitRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-repofacet-git-")
    );
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-repofacet-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-repofacet-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-repofacet-udd-")
    );

    // A real git worktree whose `origin` remote resolves LIVE to `acme/live-repo`
    // (the resolved case points its cwd here).
    const liveRepoCwd = path.join(gitRoot, "live-worktree");
    initGitRepoWithOrigin(
      liveRepoCwd,
      `git@github.com:${REPO_FACET_LIVE_FULL_NAME}.git`
    );
    // A path that does NOT exist — a deleted worktree. Live resolution fails, so
    // the durable stored `repoFullName` is the facet identity (FEA-3555).
    const deletedWorktreeCwd = path.join(gitRoot, "deleted-worktree");
    // A second non-existent path for the stale-stored scenario. Using a
    // non-existent cwd prevents the live-first SYNC write-back from
    // superseding the stored name during the initial list hydration.
    const staleWorktreeCwd = path.join(gitRoot, "stale-worktree");

    const seededSessions = createRepoFacetSessions({
      liveRepoCwd,
      deletedWorktreeCwd,
      staleWorktreeCwd,
    });

    try {
      // Launch 1 — create + migrate the schema, then close so the seed writes
      // without cross-process WAL contention.
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      await seedSessionsList(userDataDir, seededSessions);

      // Launch 2 — the real Sessions IPC + usage/analytics reads resolve each
      // seeded row's repo identity (live git first, stored fallback).
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "sessions");
        await page.locator('[aria-label="All time"]:visible').click();

        // Every seeded row renders (including the Unknown-identity one).
        for (const session of seededSessions) {
          await expect(
            page.getByRole("link", { name: session.name })
          ).toBeVisible({ timeout: 30_000 });
        }

        await assertRepositoryFacetOptions(page);
        await assertRepositoryFacetFilters(page, seededSessions);

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
      fs.rmSync(gitRoot, { recursive: true, force: true });
    }
  });
});

type NamedSessionListSeed = Omit<SessionListSeed, "status"> & {
  name: string;
  status: SessionStatus;
};

const SESSION_SEED_DEFINITIONS = [
  {
    sessionId: "fea-2939-sessions-alpha",
    name: "fea-2939 sessions alpha",
    status: SESSION_STATUS.INACTIVE,
  },
  {
    sessionId: "fea-2939-sessions-bravo",
    name: "fea-2939 sessions bravo",
    status: SESSION_STATUS.ACTIVE,
  },
  {
    sessionId: "fea-2939-sessions-charlie",
    name: "fea-2939 sessions charlie",
    status: SESSION_STATUS.INACTIVE,
  },
] as const satisfies readonly Pick<
  NamedSessionListSeed,
  "name" | "sessionId" | "status"
>[];
const TARGET_SESSION_INDEX = 2;
const SEED_TIME_STEP_MS = 60_000;
const STATUS_FACET_MENUITEM_NAME = /^Status/;
// ISS-4696: the menuitem's accessible name IS the facet option's label, so read
// it from the same `SESSION_STATUS_LABELS` map the option list is built from
// rather than repeating the word. (The spec cannot import
// `SESSION_STATUS_FILTER_OPTIONS` itself — pulling the `@repo/app` graph into a
// Playwright spec aborts the whole suite at load — but the LABEL map is the
// shared leaf both sides derive from.)
const INACTIVE_STATUS_FACET_MENUITEM_NAME =
  SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE];
// ISS-4605: the active-filter chip is `<facet label>: <value label>`. The value
// label is the canonical `SESSION_STATUS_LABELS` entry, so the chip reuses that
// SSOT rather than hardcoding the string. ISS-4586 retired the `Completed` /
// `Abandoned` Status-facet options (they fold into the neutral INACTIVE value),
// so the facet the chip test drives is Inactive — the seeded legacy `completed`
// rows normalize to INACTIVE and survive that filter.
const INACTIVE_STATUS_CHIP = `Status: ${SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE]}`;
const REMOVE_INACTIVE_STATUS_CHIP = `Remove ${INACTIVE_STATUS_CHIP}`;

function createSeededSessions(): NamedSessionListSeed[] {
  // Keep terminal fixtures inside the latest completed UTC day. The ACTIVE row
  // must remain fresh so Desktop's boot maintenance does not correctly reap it
  // before the Status-facet assertions exercise the live lifecycle value.
  const completedUtcDay = new Date();
  completedUtcDay.setUTCHours(12, 0, 0, 0);
  completedUtcDay.setUTCDate(completedUtcDay.getUTCDate() - 1);
  const completedUtcDayMs = completedUtcDay.getTime();
  const currentTimeMs = Date.now();

  return SESSION_SEED_DEFINITIONS.map((session, index) => {
    const baseTimeMs =
      session.status === SESSION_STATUS.ACTIVE
        ? currentTimeMs
        : completedUtcDayMs;
    const timestamp = new Date(
      baseTimeMs - index * SEED_TIME_STEP_MS
    ).toISOString();
    return {
      ...session,
      at: timestamp,
      lastActivityAt: timestamp,
    };
  });
}

function visibleSeededSessionLinkNames(
  page: Page,
  sessions: NamedSessionListSeed[]
): Promise<string[]> {
  return page.locator("a:visible").evaluateAll(
    (links, names: string[]) =>
      links
        .map((link) => link.textContent?.trim() ?? "")
        .filter((name) => names.includes(name)),
    sessions.map((session) => session.name)
  );
}

async function assertSessionsFilterAndViewControls(
  page: Page,
  sessions: NamedSessionListSeed[]
): Promise<void> {
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  for (const group of [
    "Status",
    "Autonomy",
    "Harness",
    "Model",
    "Cost",
    "Repository",
  ]) {
    await expect(page.getByRole("menuitem", { name: group })).toBeVisible();
  }

  await openFilterFacet(page, "Status");
  // ISS-4586: the Status facet offers Active / Inactive / Failed (completed &
  // abandoned collapsed into Inactive). Selecting Inactive still reaches the
  // legacy `completed` seeds this corpus carries.
  // `exact` because "Active" is a substring of "Inactive" — a non-exact
  // accessible-name match resolves to both menuitems (strict-mode violation).
  await expect(
    page.getByRole("menuitem", { name: "Active", exact: true })
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Inactive" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Failed" })).toBeVisible();

  await page.getByRole("menuitem", { name: "Inactive" }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("link", { name: sessions[0]?.name ?? "" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: sessions[1]?.name ?? "" })
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await openFilterFacet(page, STATUS_FACET_MENUITEM_NAME);
  // Deselect Inactive and select Failed (Error): no seed is a failed run, so the
  // result is empty.
  await page.getByRole("menuitem", { name: "Inactive" }).click();
  await page.getByRole("menuitem", { name: "Failed" }).click();
  await page.keyboard.press("Escape");
  // FEA-4181: an active status facet is a filter, so an empty result is the
  // honest filtered-empty state, not the old "No sessions found".
  await expect(
    page.getByText("No matching sessions", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText(
      "No sessions match the current filters. Try clearing or widening a filter."
    )
  ).toBeVisible();

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await openFilterFacet(page, STATUS_FACET_MENUITEM_NAME);
  // Clear the Failed filter → no status filter → every seeded row is back.
  await page.getByRole("menuitem", { name: "Failed" }).click();
  await page.keyboard.press("Escape");
  for (const session of sessions) {
    await expect(page.getByRole("link", { name: session.name })).toBeVisible();
  }

  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByText("Show / Hide Columns")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Status" })).toBeChecked();
  await expect(sessionStatusCell(page, sessions[0])).toBeVisible();
  await page.getByRole("switch", { name: "Status" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Status" })).toHaveCount(0);
  await expect(sessionStatusCell(page, sessions[0])).toHaveCount(0);

  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Status" })).not.toBeChecked();
  await page.getByRole("switch", { name: "Status" }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Status", exact: true })
  ).toBeVisible();
  await expect(sessionStatusCell(page, sessions[0])).toBeVisible();
}

async function openFilterFacet(
  page: Page,
  label: string | RegExp
): Promise<void> {
  await page.getByRole("menuitem", { name: label }).click();
}

function sessionStatusCell(page: Page, session: NamedSessionListSeed) {
  // ISS-4586: the badge renders the DISPLAYED label, so a legacy `completed`/
  // `abandoned` seed shows as "Inactive". Locate the cell by the normalized
  // label so it matches what the app actually renders.
  return sessionRow(page, session).getByText(
    SESSION_STATUS_LABELS[normalizeDisplayedSessionStatus(session.status)],
    {
      exact: true,
    }
  );
}

function sessionRow(page: Page, session: NamedSessionListSeed) {
  return page
    .getByRole("link", { name: session.name })
    .locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' group ') and contains(concat(' ', normalize-space(@class), ' '), ' grid ')][1]"
    );
}

// FEA-4299: Repository-facet fixtures. The facet option label is the LAST path
// segment of `repositoryFullName` (`shortRepoName` in
// `packages/app/branches/lib/branch-row.ts`), so `acme/live-repo` renders as the
// option "live-repo".
const REPO_FACET_LIVE_FULL_NAME = "acme/live-repo";
const REPO_FACET_STORED_FULL_NAME = "acme/stored-repo";
// A DIFFERENT stored value on the stale-stored row. ISS-5271 stored-first: the
// stored name is the identity so this surfaces as its own facet option. The row's
// cwd is deliberately a non-existent path so the live-first SYNC write-back
// (`resolveSyncAttributions`) cannot supersede the stored name during hydration.
const REPO_FACET_STALE_FULL_NAME = "acme/stale-repo";
const REPO_FACET_MENUITEM_NAME = /^Repository/;
// The FilterPopover renders each facet option as `<label><session count>`
// (`OptionCount` in `packages/design-system/components/ui/filter-popover.tsx`),
// so the menuitem's accessible name is e.g. "live-repo 2", not "live-repo".
// Match the label anchored at the start with a trailing word boundary so the
// count suffix is tolerated and a sibling repo (stored-/stale-repo) can't match
// — mirroring the Status facet options above, which are also count-suffixed and
// matched by (non-exact) name.
const REPO_FACET_LIVE_OPTION_NAME = /^live-repo\b/;
const REPO_FACET_STORED_OPTION_NAME = /^stored-repo\b/;
const REPO_FACET_STALE_OPTION_NAME = /^stale-repo\b/;

type RepoFacetPaths = {
  liveRepoCwd: string;
  deletedWorktreeCwd: string;
  staleWorktreeCwd: string;
};

function createRepoFacetSessions(
  paths: RepoFacetPaths
): NamedSessionListSeed[] {
  const now = Date.now();
  const at = (index: number): string =>
    new Date(now - index * SEED_TIME_STEP_MS).toISOString();
  // resolved: no stored value, live remote resolves → option "live-repo".
  // stale-stored: a non-existent cwd with a stored value that WOULD disagree
  //   with the cwd's live remote if the cwd existed; ISS-5271 stored-first
  //   means the STORED name is the identity ("stale-repo"). The cwd is
  //   deliberately non-existent so the live-first SYNC write-back
  //   (`resolveSyncAttributions` → `persistResolvedRepoFullNames`) cannot
  //   supersede the stored name during the initial list hydration — keeping
  //   the scenario deterministic in the e2e.
  // stored-only: a deleted worktree with a durable stored value → option
  //   "stored-repo" (FEA-3555 projection; no live lookup is attempted).
  // unknown: no cwd and no stored value → no facet option; the row still renders.
  return [
    {
      sessionId: "fea-4299-repo-resolved",
      name: "fea-4299 repo resolved",
      status: SESSION_STATUS.INACTIVE,
      cwd: paths.liveRepoCwd,
      repoFullName: null,
      at: at(0),
      lastActivityAt: at(0),
    },
    {
      sessionId: "fea-4299-repo-stale-stored",
      name: "fea-4299 repo stale stored",
      status: SESSION_STATUS.INACTIVE,
      cwd: paths.staleWorktreeCwd,
      repoFullName: REPO_FACET_STALE_FULL_NAME,
      at: at(1),
      lastActivityAt: at(1),
    },
    {
      sessionId: "fea-4299-repo-stored-only",
      name: "fea-4299 repo stored only",
      status: SESSION_STATUS.ACTIVE,
      cwd: paths.deletedWorktreeCwd,
      repoFullName: REPO_FACET_STORED_FULL_NAME,
      at: at(2),
      lastActivityAt: at(2),
    },
    {
      sessionId: "fea-4299-repo-unknown",
      name: "fea-4299 repo unknown",
      status: SESSION_STATUS.INACTIVE,
      cwd: null,
      repoFullName: null,
      at: at(3),
      lastActivityAt: at(3),
    },
  ];
}

/**
 * Create a real git worktree whose `origin` remote is `originUrl`, so the
 * desktop's live repo resolver (`git remote get-url origin`) returns the parsed
 * `owner/repo`. No commits/branches are needed — only the remote is read.
 */
function initGitRepoWithOrigin(repoPath: string, originUrl: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: repoPath, stdio: "pipe" });
  };
  git(["init"]);
  git(["remote", "add", "origin", originUrl]);
}

async function assertRepositoryFacetOptions(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await openFilterFacet(page, REPO_FACET_MENUITEM_NAME);
  // ISS-5271 stored-first: the resolved row live-resolves to acme/live-repo,
  // and BOTH stored names are offered as-is — the deleted-worktree row's
  // acme/stored-repo and the stale-stored row's acme/stale-repo (its stored
  // name outranks its cwd's live remote until the sync lane heals it). Only
  // the Unknown-identity row is dropped.
  await expect(
    page.getByRole("menuitem", { name: REPO_FACET_LIVE_OPTION_NAME })
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: REPO_FACET_STORED_OPTION_NAME })
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: REPO_FACET_STALE_OPTION_NAME })
  ).toBeVisible();
  await page.keyboard.press("Escape");
}

async function assertRepositoryFacetFilters(
  page: Page,
  sessions: NamedSessionListSeed[]
): Promise<void> {
  const [resolved, staleStored, storedOnly, unknown] = sessions;

  // Select "live-repo": ISS-5271 stored-first — only the resolved row (no
  // stored name, cwd live-resolves) matches; the stale-stored row belongs to
  // its STORED name now, and the stored-only and Unknown rows are out too.
  await selectRepositoryOption(page, REPO_FACET_LIVE_OPTION_NAME);
  await expect(
    page.getByRole("link", { name: resolved?.name ?? "" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: staleStored?.name ?? "" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: storedOnly?.name ?? "" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: unknown?.name ?? "" })
  ).toHaveCount(0);

  // Swap to "stale-repo": the offered stale-stored option must select exactly
  // its row — the facet's option identity and the filter's row identity come
  // from one stored-first helper, so an offered option can never match zero
  // rows (the ISS-5271 facet ≡ filter pin, at the real UI).
  await selectRepositoryOption(page, REPO_FACET_LIVE_OPTION_NAME);
  await selectRepositoryOption(page, REPO_FACET_STALE_OPTION_NAME);
  await expect(
    page.getByRole("link", { name: staleStored?.name ?? "" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: resolved?.name ?? "" })
  ).toHaveCount(0);

  // Swap to "stored-repo": only the deleted-worktree row (stored projection)
  // remains.
  await selectRepositoryOption(page, REPO_FACET_STALE_OPTION_NAME);
  await selectRepositoryOption(page, REPO_FACET_STORED_OPTION_NAME);
  await expect(
    page.getByRole("link", { name: storedOnly?.name ?? "" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: resolved?.name ?? "" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: staleStored?.name ?? "" })
  ).toHaveCount(0);

  // No-match: AND the Repository facet with a non-overlapping Status. The
  // stored-only row is ACTIVE, so Status=Inactive + Repository=stored-repo
  // matches nothing and the honest empty state renders (ISS-4586).
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await openFilterFacet(page, STATUS_FACET_MENUITEM_NAME);
  await page.getByRole("menuitem", { name: "Inactive" }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByText("No matching sessions", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText(
      "No sessions match the current filters. Try clearing or widening a filter."
    )
  ).toBeVisible();
}

/**
 * Open the Repository facet and toggle one option by its shortened label. The
 * `optionName` regex is anchored at the label and tolerates the trailing session
 * count the FilterPopover appends (e.g. "live-repo 2").
 */
async function selectRepositoryOption(
  page: Page,
  optionName: RegExp
): Promise<void> {
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await openFilterFacet(page, REPO_FACET_MENUITEM_NAME);
  await page.getByRole("menuitem", { name: optionName }).click();
  await page.keyboard.press("Escape");
}
