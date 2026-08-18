/**
 * E2E smoke test (ISS-4527): every top-level nav view mounts and renders WITH a
 * seeded local corpus — the data-backed companion to all-views-smoke.spec.ts.
 *
 * The empty-DB smoke (all-views-smoke.spec.ts) proves each view renders cleanly
 * from an EMPTY store — i.e. its "correct empty state" path. It cannot catch a
 * regression that only fires once real rows are present: a data-driven view that
 * crashes, mis-projects, or silently stays in its empty state when the store is
 * populated passes the empty smoke but is broken for every real user. This spec
 * closes that gap: it seeds the store while the app is DOWN (no cross-process WAL
 * contention — the same DB-direct path the Branches/Sessions specs use), boots
 * the app once against the seeded store, and for each view asserts BOTH:
 *   - the view's data-backed content is visible (its seeded rows/cards/values,
 *     NOT the empty state), where the view projects from the seeded corpus, and
 *   - no crash-fallback / uncaught error / chunk-load console error fired while
 *     that view's lazy chunk evaluated (the same health gate the empty smoke uses).
 *
 * Views the seeded corpus drives to a data-backed state:
 *   - dashboard  — SESSIONS KPI = "3", NOT the "No agent sessions yet" empty state
 *   - sessions   — each seeded session name renders as a row link
 *   - branches   — the seeded merged branch row + its GitHub PR chip render
 *   - insights   — after "Load insights", the seeded rows populate the table
 *   - approvals  — both seeded pending-approval cards render
 *   - plans      — the seeded plan rows render (NOT the "No plans captured yet"
 *                  empty state); PlansView reads db.getPlansList() from SQLite
 *
 * Views that are config/local-driven (agents, packs, requests, diagnostics,
 * settings) have no DB corpus to seed here, so they keep the render-shell +
 * no-crash health gate from the empty smoke — but now also assert each view's
 * OWN body heading (the empty smoke's per-view marker), which is rendered from
 * the deferred nav state and so waits for the lazy chunk to actually mount
 * (the Topbar breadcrumb alone follows the immediate nav state and can advance
 * before a broken body chunk has mounted). Their data-backed flows live in
 * their own focused specs (settings-*, approvals-*, etc.).
 *
 * Uses ONE app launch and soft assertions so a single broken view is reported
 * without masking the rest.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { encodeBranchId } from "@repo/api/src/types/branch.ts";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import {
  dismissDesktopOnboardingOverlay,
  gotoHash,
  gotoNav,
  launchDesktopApp,
  widenToAllTime,
} from "./helpers/desktop-app";
import { startFakeGitHubAuthorityServer } from "./helpers/fake-github-authority-server";
import { type SeedApproval, seedPendingApprovals } from "./helpers/seed";
import {
  type MergedUnenrichedBranchSeed,
  type PlanListSeed,
  type SessionListSeed,
  seedMergedUnenrichedSinglePrBranch,
  seedPlansList,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

// ─── Seed corpus ────────────────────────────────────────────────────────────

// A MERGED, single-PR branch (drives the Branches row + PR chip and the
// Dashboard SESSIONS KPI). Its session is substantive by default (the seed adds
// a synthetic PreToolUse event), so it counts toward the Dashboard/Sessions
// reads rather than being hidden as an idle phantom row.
const BRANCH_SEED: MergedUnenrichedBranchSeed = {
  repoFullName: "acme/web",
  branchName: "iss-4527-seeded-smoke-branch",
  sessionId: "iss-4527-seeded-smoke-branch-session",
  prNumber: 4527,
  mergedAt: "2026-05-20T12:00:00.000Z",
};

// The seed inserts pr_url = https://github.com/<repo>/pull/<n>; the Branches PR
// chip renders as an anchor to that canonical URL (branch-pr-badge.tsx).
const BRANCH_PR_URL = `https://github.com/${BRANCH_SEED.repoFullName}/pull/${BRANCH_SEED.prNumber}`;

// Sessions rows (drive the Sessions list and, after Load, the Insights table).
const SESSION_SEEDS: SessionListSeed[] = [
  { sessionId: "iss-4527-sessions-alpha", name: "iss-4527 sessions alpha" },
  { sessionId: "iss-4527-sessions-bravo", name: "iss-4527 sessions bravo" },
];

// Total substantive sessions in the seeded corpus: the one merged-branch
// session plus each sessions-list row. The Dashboard SESSIONS KPI counts all of
// them, so this drives its expected value.
const SEEDED_SESSION_TOTAL = 1 + SESSION_SEEDS.length;

// The Insights bounded table's "<from>-<to> of <total>" count footer for the
// seeded corpus. Because every harness home is isolated, the ONLY sessions are
// the seeded ones, so this is deterministic ("1-3 of 3") and non-zero — the
// robust populated-data signal that Insights left its empty state (the seeded
// row links alone are not: the Sessions view stays mounted-hidden and renders
// the same `#/sessions/<id>` hrefs, so a hidden-node match could pass on an
// empty Insights table).
const INSIGHTS_POPULATED_COUNT_FOOTER = `1-${SEEDED_SESSION_TOTAL} of ${SEEDED_SESSION_TOTAL}`;

// Plans (drive the Plans list — PlansView reads db.getPlansList() from the
// SQLite plans/plan_versions tables, so it is data-backed, NOT config-only).
const PLAN_SEEDS: PlanListSeed[] = [
  { id: "iss-4527-plan-1", title: "ISS-4527 seeded plan alpha" },
  { id: "iss-4527-plan-2", title: "ISS-4527 seeded plan bravo" },
];

// Pending approvals (drive the Approvals panel queue).
const APPROVAL_SEEDS: SeedApproval[] = [
  {
    id: "iss-4527-approval-1",
    reason: "ISS-4527 seeded approval: write workspace file",
    riskTier: "medium",
  },
  {
    id: "iss-4527-approval-2",
    reason: "ISS-4527 seeded approval: run shell command",
    riskTier: "high",
  },
];

/**
 * Pinned as literals rather than imported: `branches-list-body.tsx` and
 * `branches-empty-state.tsx` are `"use client"` React modules that transitively
 * pull in extension-less `@repo/*` TypeScript subpaths, and one such import
 * aborts the WHOLE Electron e2e run at load time (`apps/desktop/test/AGENTS.md`).
 */
const BRANCHES_UNAVAILABLE_TEXT = "Couldn't load branches";
const BRANCHES_NO_MATCHES_TITLE = "No matching branches";
const BRANCHES_NO_BRANCHES_TITLE = "No branches yet";

/**
 * Two budgets, because "the read is still in flight" and "the view settled
 * without the seeded content" are different failures. The post-settle budget is
 * the tighter one: once the read has settled the content is either rendered or
 * the view is broken, so waiting longer cannot turn a real failure green.
 */
const BRANCHES_READ_SETTLE_TIMEOUT_MS = 60_000;
const BRANCHES_SEEDED_CONTENT_TIMEOUT_MS = 15_000;

// ─── Health gate (mirrors all-views-smoke.spec.ts) ───────────────────────────

const CRASH_FALLBACK_TEXT = "Something went wrong";
const FATAL_CONSOLE_PATTERNS = [
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
  "loading chunk",
  "error boundary caught",
];

function fatalConsoleErrors(consoleErrors: string[]): string[] {
  return consoleErrors.filter((text) => {
    const lowered = text.toLowerCase();
    return FATAL_CONSOLE_PATTERNS.some((pattern) => lowered.includes(pattern));
  });
}

/**
 * Assert a just-navigated surface is healthy: the boundary crash fallback is NOT
 * shown, no uncaught renderer error fired, and no chunk-load / error-boundary
 * console error was logged since `errorsBefore`/`consoleBefore`. Soft so one
 * broken surface is reported without masking the rest.
 */
async function expectSurfaceHealthy(
  page: Page,
  label: string,
  captured: {
    pageErrors: Error[];
    errorsBefore: number;
    consoleErrors: string[];
    consoleBefore: number;
  }
): Promise<void> {
  await expect
    .soft(
      page.getByText(CRASH_FALLBACK_TEXT, { exact: true }),
      `${label}: RootErrorBoundary crash fallback must not be shown`
    )
    .toHaveCount(0);

  expect
    .soft(
      captured.pageErrors.slice(captured.errorsBefore),
      `${label}: navigation should not throw uncaught renderer errors`
    )
    .toEqual([]);

  expect
    .soft(
      fatalConsoleErrors(captured.consoleErrors.slice(captured.consoleBefore)),
      `${label}: no chunk-load / error-boundary console errors`
    )
    .toEqual([]);
}

// ─── Data-backed view cases ──────────────────────────────────────────────────

/**
 * A view whose data-backed content the seeded corpus drives. `assertData` runs
 * AFTER the shell health gate and asserts the view left its empty state — the
 * signal the empty smoke cannot provide.
 */
type SeededViewCase = {
  navId: string;
  /** Topbar breadcrumb label — present on every view regardless of data. */
  label: string;
  /** Assert the seeded, data-backed content of this view. */
  assertData: (page: Page) => Promise<void>;
};

/** The Dashboard SESSIONS KPI value span (label in card-description). */
function dashboardKpiValue(page: Page, label: string): Locator {
  return page
    .locator('[data-tour="stats"] [data-slot="card"]')
    .filter({ hasText: label })
    .locator('[data-slot="card-title"] span')
    .first();
}

const SEEDED_VIEWS: SeededViewCase[] = [
  {
    navId: "dashboard",
    label: "Dashboard",
    assertData: async (page) => {
      // Data present → NOT the empty state, and the SESSIONS KPI counts every
      // seeded (substantive) session: the one merged-branch session plus the two
      // sessions-list rows = 3. This is the load-bearing, non-empty/non-zero
      // assertion — it fails closed against both the empty state and a zeroed or
      // mis-wired projection. The onboarding overlay + date range are handled by
      // the caller before this runs.
      await expect(page.getByText("No agent sessions yet")).toHaveCount(0);
      await expect(dashboardKpiValue(page, "Sessions")).toHaveText(
        String(SEEDED_SESSION_TOTAL),
        { timeout: 45_000 }
      );
    },
  },
  {
    navId: "sessions",
    label: "Sessions",
    assertData: async (page) => {
      // Each seeded session renders as a row link — the data-backed signal the
      // full-width, no-in-body-<h1> Sessions view otherwise can't provide.
      for (const session of SESSION_SEEDS) {
        await expect(
          page.getByRole("link", { name: session.name })
        ).toBeVisible({ timeout: 30_000 });
      }
    },
  },
  {
    navId: "branches",
    label: "Branches",
    assertData: async (page) => {
      // ISS-6024 — settle the read BEFORE asserting its output.
      //
      // `BranchesListBody` renders one of four terminal states — the table,
      // "Couldn't load branches", "No matching branches", or "No branches yet" —
      // or, while the read is in flight, "Loading branches…" instead of any of
      // them. Only the table contains a row link, so the row assertion alone
      // cannot tell an unsettled read apart from a view that rendered nothing.
      //
      // Waiting for a terminal state to APPEAR, rather than for the pending one
      // to DISAPPEAR, is load-bearing: an absence assertion against a pinned
      // literal starts passing the moment that literal drifts, silently
      // restoring the race, where a presence assertion times out and names it.
      //
      // Scoped to this view's own scroll region so a mounted-but-hidden sibling
      // view's table (Sessions keeps one) can never satisfy the wait.
      const branchesRegion = page.locator('section[aria-label="Branches"]');
      const branchesReadSettled = branchesRegion
        .getByRole("table")
        .or(
          branchesRegion.getByText(BRANCHES_UNAVAILABLE_TEXT, { exact: true })
        )
        .or(
          branchesRegion.getByText(BRANCHES_NO_MATCHES_TITLE, { exact: true })
        )
        .or(
          branchesRegion.getByText(BRANCHES_NO_BRANCHES_TITLE, { exact: true })
        );
      await expect(
        branchesReadSettled.first(),
        "branches: the list read should settle into one of its terminal states"
      ).toBeVisible({ timeout: BRANCHES_READ_SETTLE_TIMEOUT_MS });
      // A settled-but-FAILED read has no row link either. Name it, so that
      // failure can never be read as "the view rendered no seeded content".
      await expect(
        branchesRegion.getByText(BRANCHES_UNAVAILABLE_TEXT, { exact: true }),
        "branches: the list read should not have failed"
      ).toHaveCount(0);

      const branchLink = page
        .locator('a[href^="#/branches/"]')
        .filter({ hasText: BRANCH_SEED.branchName });
      await expect(branchLink.first()).toBeVisible({
        timeout: BRANCHES_SEEDED_CONTENT_TIMEOUT_MS,
      });
      // The merged branch's PR chip is a working external link to its GitHub PR.
      await expect(
        page.locator(`a[href="${BRANCH_PR_URL}"]`).first()
      ).toBeVisible({ timeout: BRANCHES_SEEDED_CONTENT_TIMEOUT_MS });
    },
  },
  {
    navId: "insights",
    label: "Insights",
    assertData: async (page) => {
      // Insights mounts behind a "Load insights" gate; click it, then assert the
      // bounded table populated with the seeded corpus.
      //
      // Scoping (wongk review): the Sessions view ran earlier in this single-
      // launch loop and stays mounted-but-hidden. It renders the SAME
      // `#/sessions/<id>` row links, so a bare `toBeAttached` on that href can
      // match the hidden Sessions copy — Insights could stay EMPTY and still
      // pass. So the load-bearing assertion is the numeric count footer, which
      // is unique to the Insights bounded view: because EVERY harness home is
      // isolated (createIsolatedHarnessHomes), the ONLY rows are the seeded
      // corpus, making the footer deterministic and non-zero. That fails closed
      // against both the empty state and a stale hidden-Sessions match. (The
      // table's name cell is `truncate min-w-0` and can collapse to zero width
      // in this bounded Card, so its text can read as hidden even when present —
      // the footer is the robust populated-data signal, per
      // insights-load-and-verify.spec.ts.)
      const loadButton = page.getByRole("button", { name: "Load insights" });
      await expect(loadButton).toBeVisible({ timeout: 15_000 });
      await loadButton.click();
      // `exact`, because ISS-5315 gave the Sessions table inside this Card a
      // second range readout ("Showing 1-3 of 3 sessions", `role="status"`).
      // Both state the same true count, so this is a locator that stopped being
      // unique, not a contradiction — pin the bounded view's own chip, whose
      // whole text IS the range, rather than matching either by substring.
      await expect(
        page.getByText(INSIGHTS_POPULATED_COUNT_FOOTER, { exact: true })
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("No synced sessions found.")).toHaveCount(0);
    },
  },
  {
    navId: "approvals",
    label: "Approvals",
    assertData: async (page) => {
      // Both seeded pending requests render (each card shows its reason), and the
      // queue is NOT in its empty state.
      for (const approval of APPROVAL_SEEDS) {
        await expect(page.getByText(approval.reason)).toBeVisible({
          timeout: 30_000,
        });
      }
      await expect(page.getByText("No pending approvals")).toHaveCount(0);
    },
  },
  {
    navId: "plans",
    label: "Plans",
    assertData: async (page) => {
      // PlansView reads db.getPlansList() from the SQLite plans/plan_versions
      // tables (shafty023 review), so the seeded plans render as list rows (each
      // a PlanListButton labelled with its title), and the queue is NOT the "No
      // plans captured yet" empty state. listPlans applies no substantive/date
      // filter, so the seeded rows always project.
      for (const plan of PLAN_SEEDS) {
        // Each plan's title renders as the PlanListButton label text. The full-
        // width Plans list (unlike the bounded Insights card) does not collapse
        // the title cell, so assert it is visible.
        await expect(page.getByText(plan.title)).toBeVisible({
          timeout: 30_000,
        });
      }
      await expect(page.getByText("No plans captured yet")).toHaveCount(0);
    },
  },
];

// Config/local-driven views the seeded DB corpus does not populate. They keep
// the render-shell + no-crash health gate the empty smoke applies — but, where
// the view has one, also assert its OWN body <h1> heading (rendered from the
// DEFERRED nav state), not only the Topbar breadcrumb (which follows the
// IMMEDIATE nav state and can advance before a broken body chunk has mounted —
// wongk review). Heading names mirror the empty smoke's per-view markers (every
// top-level view with a body heading routes its title through PageShell as a
// single <h1>, FEA-3990). `agents` is the deliberate exception: its unified
// workspace hosts a tabbed inventory with NO standalone <h1> (see the empty
// smoke), so it keeps the label-only marker there.
const HEALTH_ONLY_VIEWS: {
  navId: string;
  label: string;
  /** Body <h1> the view renders (omitted only for the headingless Agents workspace). */
  heading?: string;
}[] = [
  { navId: "packs", label: "Packs", heading: "Packs" },
  { navId: "agents", label: "Agents" },
  { navId: "requests", label: "Requests", heading: "Requests" },
  { navId: "diagnostics", label: "Diagnostics", heading: "Diagnostics" },
  { navId: "settings", label: "Settings", heading: "Settings" },
];

// Detail surfaces mount their OWN lazy chunk — distinct from the list view's —
// so the smoke drives each directly. Session and branch detail point at the REAL
// seeded corpus and assert their data-backed content; agent detail has no seed
// corpus and stays a render-shell + no-crash health gate (its empty/not-found
// path, the same guard the empty smoke applies). `assertData`, when present,
// runs after the breadcrumb + health gate and asserts the populated detail.
type DetailCase = {
  name: string;
  hash: string;
  parentLabel: string;
  /** Assert the seeded, data-backed content of this detail surface, if any. */
  assertData?: (page: Page) => Promise<void>;
};

const DETAIL_SURFACES: DetailCase[] = [
  {
    name: "session-detail",
    // A REAL seeded session id → the populated session detail mounts.
    hash: `/sessions/${BRANCH_SEED.sessionId}`,
    parentLabel: "Sessions",
  },
  {
    name: "branch-detail",
    // Branch detail is keyed by the ENCODED branch id — `encodeBranchId({repoFullName,
    // branchName})` (`acme%2Fweb::iss-4527-seeded-smoke-branch`), the same id the
    // Branches list row link carries and the desktop detail read (`branchesApi.detail`)
    // decodes — NOT the artifact id (`artifact-branch-<sessionId>`). An artifact-id
    // hash decodes to a repo-less branch identity that matches no seeded row, so the
    // detail read returns nothing and the view falls to its "Branch not found" state.
    //
    // The hash SEGMENT must be `encodeURIComponent`-escaped exactly as the real
    // route builder does (`branchDetailHref` → `/branches/${encodeURIComponent(branchId)}`,
    // route-table.ts): the router's `matchPattern` runs `decodeURIComponent` on the
    // `:id` segment, so it expects one URL-encoding layer over the raw branch id.
    // The raw `encodeBranchId` output contains a `%2F` (the escaped `/` in
    // `acme/web`); passing it WITHOUT the outer `encodeURIComponent` makes the
    // router decode `%2F` → `/`, yielding `acme/web::…` which no longer equals the
    // list projection's `encodeBranchId` id (`acme%2Fweb::…`), so the detail read's
    // `.find(item.id === id)` misses and the view falls to "Branch not found".
    // (session-detail above needs no wrap only because its id has no reserved
    // chars, making `encodeURIComponent` a no-op there.)
    hash: `/branches/${encodeURIComponent(encodeBranchId({ repoFullName: BRANCH_SEED.repoFullName, branchName: BRANCH_SEED.branchName }))}`,
    parentLabel: "Branches",
    assertData: async (page) => {
      // The loaded branch detail renders its page `<h1>` through the shared
      // `PageHeading` (`branch-detail-page.tsx`), and is NOT the "Branch not
      // found" empty state. Since ISS-5008 that heading is the BARE branch name,
      // not a `Branch <name>` label: `PageHeading` exists so the sr-only `<h1>`
      // and the breadcrumb spell the page subject identically, and the crumb
      // carries the branch name verbatim.
      await expect(
        page.getByRole("heading", {
          name: BRANCH_SEED.branchName,
          level: 1,
        })
      ).toBeAttached({ timeout: 30_000 });
      await expect(page.getByText("Branch not found")).toHaveCount(0);
    },
  },
  {
    name: "agent-detail",
    hash: "/agents/iss-4527-smoke-missing-slug",
    parentLabel: "Agents",
  },
];

async function assertTopbarLabel(
  page: Page,
  navId: string,
  label: string
): Promise<void> {
  await expect
    .soft(
      page.locator("header").getByText(label, { exact: true }),
      `${navId}: Topbar label "${label}" should be visible`
    )
    .toBeVisible({ timeout: 15_000 });
}

/**
 * Assert a view's OWN body <h1> — a view-owned marker rendered from the deferred
 * nav state, so it waits for the lazy chunk to mount (unlike the Topbar
 * breadcrumb, which follows the immediate nav state). Soft so one broken view is
 * reported without masking the rest.
 */
async function assertViewHeading(
  page: Page,
  navId: string,
  heading: string
): Promise<void> {
  await expect
    .soft(
      page.getByRole("heading", { name: heading, level: 1, exact: true }),
      `${navId}: body heading "${heading}" should be visible`
    )
    .toBeVisible({ timeout: 15_000 });
}

/**
 * Run a data-backed view's `assertData` so that a HARD assertion failure inside
 * it (e.g. a wrong Dashboard KPI) does NOT throw out of the per-view loop and
 * skip every later view — the all-views contract is that one broken surface must
 * not mask the rest (codex review). `assertData` uses hard `expect` internally
 * (each needs its own first-paint retry/timeout, which `expect.soft` also
 * honors, but the surrounding awaits would still reject on failure); catching
 * here converts that rejection into a single soft failure carrying the view id,
 * so the loop continues and Playwright reports every view's outcome at the end.
 */
async function runViewDataAssertionSoftly(
  view: SeededViewCase,
  page: Page
): Promise<void> {
  try {
    await view.assertData(page);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect
      .soft(
        message,
        `${view.navId}: seeded data-backed content assertion failed`
      )
      .toBe("");
  }
}

/**
 * Detail-surface counterpart of `runViewDataAssertionSoftly`: run a detail's
 * `assertData` so a hard failure inside it does not throw out of the detail loop
 * and skip later surfaces (codex all-views contract). Only called when the
 * detail declares `assertData`.
 */
async function runDetailDataAssertionSoftly(
  detail: DetailCase,
  page: Page
): Promise<void> {
  try {
    await detail.assertData?.(page);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect
      .soft(
        message,
        `${detail.name}: seeded data-backed content assertion failed`
      )
      .toBe("");
  }
}

test.describe("All views smoke (seeded corpus, ISS-4527)", () => {
  test("every view mounts and renders its seeded, data-backed content without JS errors", async () => {
    // One launch drives every view. Data-backed assertions add first-paint waits
    // on top of the empty smoke's per-view budget, so give the loop generous
    // runway (the empty smoke uses 240s; the seed multi-launch adds boot time).
    test.setTimeout(300_000);

    // Point EVERY harness collector home at a fresh empty temp dir so they
    // ingest nothing and the only rows are the ones we seed — the corpus stays
    // deterministic. The desktop AGENTS "isolate CODEX_HOME" rule calls this out
    // for Codex, but the same contamination exists for Claude AND the OpenCode /
    // Cursor / Copilot collectors: on a developer machine those import the
    // operator's real sessions, inflating the Dashboard SESSIONS KPI and the
    // Insights count and pushing seeded rows off the first page. CI runners are
    // clean, but pinning every home makes the spec deterministic locally too.
    const harnessHomes = createIsolatedHarnessHomes();
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-smoke-seeded-udd-")
    );
    const authorityServer = await startFakeGitHubAuthorityServer([
      BRANCH_SEED.repoFullName,
    ]);
    const seedEnv = { ...harnessHomes.env, ...authorityServer.env };

    try {
      // Launch 1 — create + migrate the SQLite schema, set the onboarding flags
      // so the relaunch skips the first-launch reveal/tour, then close so the
      // seed writes without cross-process WAL contention.
      const first = await launchDesktopApp({
        env: seedEnv,
        keepUserDataDir: true,
        userDataDir,
        beforeLaunch: (dir) => {
          seedPendingApprovals(dir, APPROVAL_SEEDS);
        },
      });
      try {
        await waitForBranchesSchema(userDataDir);
        await first.page.evaluate(
          ([onboardedKey, tourSeenKey]) => {
            localStorage.setItem(onboardedKey, "1");
            localStorage.setItem(tourSeenKey, "1");
          },
          [dashboardOnboardedStorageKey, dashboardTourSeenStorageKey]
        );
      } finally {
        await first.cleanup();
      }

      // Seed the DB corpus while the app is DOWN.
      await seedMergedUnenrichedSinglePrBranch(userDataDir, BRANCH_SEED);
      await seedSessionsList(userDataDir, SESSION_SEEDS);
      // PlansView projects from the SQLite plans/plan_versions tables, so the
      // Plans data-backed assertion needs its rows seeded like the others.
      await seedPlansList(userDataDir, PLAN_SEEDS);

      // Launch 2 — the real IPC/read paths project the seeded corpus at boot.
      const { page, pageErrors, consoleErrors, cleanup } =
        await launchDesktopApp({
          env: seedEnv,
          keepUserDataDir: true,
          userDataDir,
        });

      try {
        for (const view of SEEDED_VIEWS) {
          const errorsBefore = pageErrors.length;
          const consoleBefore = consoleErrors.length;

          await gotoNav(page, view.navId);
          await assertTopbarLabel(page, view.navId, view.label);

          // The signed-out first-launch onboarding overlay layers over the
          // Dashboard and intercepts pointer events; clear it and widen the date
          // range so the past-dated seed is in range before asserting KPIs.
          if (view.navId === "dashboard") {
            await dismissDesktopOnboardingOverlay(page);
            await widenToAllTime(page);
          }
          // Widen Sessions/Branches to All time so the seeded rows are in range
          // independent of the run clock (the seed stamps last_activity_at to
          // now, but this keeps the assertion clock-independent).
          if (view.navId === "sessions" || view.navId === "branches") {
            await widenToAllTime(page);
          }

          await runViewDataAssertionSoftly(view, page);
          await expectSurfaceHealthy(page, view.navId, {
            pageErrors,
            errorsBefore,
            consoleErrors,
            consoleBefore,
          });
        }

        for (const view of HEALTH_ONLY_VIEWS) {
          const errorsBefore = pageErrors.length;
          const consoleBefore = consoleErrors.length;

          await gotoNav(page, view.navId);
          await assertTopbarLabel(page, view.navId, view.label);
          if (view.heading) {
            await assertViewHeading(page, view.navId, view.heading);
          }
          await expectSurfaceHealthy(page, view.navId, {
            pageErrors,
            errorsBefore,
            consoleErrors,
            consoleBefore,
          });
        }

        for (const detail of DETAIL_SURFACES) {
          const errorsBefore = pageErrors.length;
          const consoleBefore = consoleErrors.length;

          await gotoHash(page, detail.hash);

          await expect
            .soft(
              page
                .locator("header")
                .getByText(detail.parentLabel, { exact: true }),
              `${detail.name}: breadcrumb "${detail.parentLabel}" should be visible`
            )
            .toBeVisible({ timeout: 15_000 });

          if (detail.assertData) {
            await runDetailDataAssertionSoftly(detail, page);
          }

          await expectSurfaceHealthy(page, detail.name, {
            pageErrors,
            errorsBefore,
            consoleErrors,
            consoleBefore,
          });
        }
      } finally {
        await cleanup();
      }
    } finally {
      await authorityServer.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
      harnessHomes.cleanup();
    }
  });
});

/**
 * Create a fresh empty temp dir for every harness collector home and return the
 * env vars pointing each collector at it, plus a cleanup that removes them all.
 * Isolating ALL of them (not just Codex) keeps the seeded corpus deterministic
 * on a developer machine where the operator has real Claude/Codex/OpenCode/
 * Cursor/Copilot sessions the collectors would otherwise ingest.
 */
function createIsolatedHarnessHomes(): {
  env: Record<string, string>;
  cleanup: () => void;
} {
  const dirs: string[] = [];
  const makeHome = (label: string): string => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), `desktop-smoke-seeded-${label}-`)
    );
    dirs.push(dir);
    return dir;
  };
  const env = {
    CLAUDE_HOME: makeHome("claude"),
    CODEX_HOME: makeHome("codex"),
    // OpenCode has TWO homes the collector reads: OPENCODE_DATA_DIR relocates
    // `opencode.db`, but startup pack scanning resolves the config home
    // (agent/command definitions) separately — pin OPENCODE_CONFIG_DIR too so the
    // seeded corpus never imports the operator's real `~/.config/opencode`.
    OPENCODE_DATA_DIR: makeHome("opencode-data"),
    OPENCODE_CONFIG_DIR: makeHome("opencode-config"),
    CURSOR_HOME: makeHome("cursor"),
    // Copilot also has TWO homes the collector reads: COPILOT_HOME isolates the
    // CLI (`~/.copilot`), but Copilot Chat lives under the VS Code workspace
    // storage, which resolves under os.homedir() and COPILOT_HOME does NOT cover
    // (copilot-home.ts). Pin COPILOT_VSCODE_STORAGE_DIR too (ISS-4527 review) so
    // the default-enabled Copilot collector never scans the operator's real
    // VS Code Copilot Chat history and inflates the seeded corpus.
    COPILOT_HOME: makeHome("copilot"),
    COPILOT_VSCODE_STORAGE_DIR: makeHome("copilot-vscode"),
  };
  const cleanup = (): void => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  return { env, cleanup };
}
