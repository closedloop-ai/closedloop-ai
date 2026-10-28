/**
 * E2E test: Branches page loads and renders.
 *
 * Guards the lazy BranchesView chunk: the renderer bundles `@repo/app`
 * branches modules whose self-referencing `@repo/app/…` imports only resolve
 * through the alias in vite.renderer.config.ts. A resolution regression
 * surfaces as an uncaught chunk-evaluation page error and a blank screen —
 * something typecheck and the build cannot catch (Rollup externalizes
 * unresolved specifiers with only a warning).
 *
 * Branches is always available in the desktop app (no longer feature-flag-gated):
 * the nav entry and the page render regardless of build type, so this test also
 * guards that the page body mounts and its chunk evaluates cleanly.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  LIST_TOOLBAR_FILTER_LABEL,
  LIST_TOOLBAR_SEARCH_LABEL,
} from "@repo/app/shared/components/list-toolbar-copy.ts";
import { expectFixtureInsideDefaultDateWindow } from "./helpers/date-window-fixture-guard";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SERVER_PAGE_REPOSITORY = "closedloop-e2e/server-page";
const DAY_MS = 24 * 60 * 60 * 1000;

test.describe("Branches page", () => {
  test("navigating to Branches renders without page errors", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-branches-e2e-",
    });

    try {
      // Navigate via hash routing — same mechanism as the sidebar.
      await gotoNav(page, "branches");

      // Assert a BranchesView-owned element — the summary cards render for
      // every branches state (data, empty, or error). NOT the Topbar
      // breadcrumb: App.tsx renders the Topbar from the route's navId regardless
      // of whether the page body mounted, so a breadcrumb check would pass on a
      // blank body and miss the chunk-evaluation regression this spec guards.
      // "Active branches" is a GitHub-free card that always renders (FEA-2051
      // removed the GitHub-gated "Active PRs" card this guard previously keyed
      // on; ISS-9970 retired the "AI spend" card it keyed on after that). It
      // reads the stored Branch status, so no live GitHub request gates it.
      await expect(
        page.getByText("Active branches", { exact: true })
      ).toBeVisible({
        timeout: 15_000,
      });

      // The table is now wired to the local IPC branches source (A4), so the
      // removed BRANCH_SAMPLE_ROWS no longer render. A fresh launch has no local
      // branches, so assert the sample rows are absent. (The visible empty/
      // degraded state is "No branches yet." when the local source resolves, or a
      // load-failure message if capture is off — both are acceptable here; the
      // chunk-evaluation guard below is this spec's real purpose.)
      await expect(
        page.getByText("agent/repo-overrides-workspace-config")
      ).toHaveCount(0);

      // The lazy chunk loaded and evaluated cleanly. An unresolved bare
      // specifier (the regression this spec guards) throws an uncaught
      // error during chunk evaluation and blanks the renderer.
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("server pagination renders by default with 25 rows then the exact final page", async () => {
    test.setTimeout(180_000);
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branches-page-server-udd-")
    );
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branches-page-server-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branches-page-server-codex-")
    );
    const env = {
      CLAUDE_HOME: claudeHome,
      CODEX_HOME: codexHome,
    };
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
      const activityAt = recentActivityAt();
      expectSeedInsideDefaultWindow(activityAt);
      // ISS-8909: the default Branches page is the shared 25-row ladder rung now
      // that the v1 surface (a fixed `APPROVED_BRANCH_PAGE_SIZE` of 20) is
      // retired, so the corpus is one row past a full page rather than one past
      // 20. Every assertion below is the same claim re-based onto that size: a
      // bookmarked out-of-range page clamps to the exact final page, and a sort
      // and a Status facet each re-page the whole cohort.
      for (let index = 0; index < 26; index += 1) {
        const suffix = String(index).padStart(2, "0");
        await seedNoPullRequestBranch(
          userDataDir,
          {
            repoFullName: SERVER_PAGE_REPOSITORY,
            branchName: `iss-4656-page-${suffix}`,
            sessionId: `iss-4656-page-session-${suffix}`,
            activityAt,
          },
          { sessionLastActivityAt: activityAt }
        );
      }
      const second = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await second.page.evaluate(() => {
          globalThis.location.hash = "#/branches?page=99";
        });
        const finalPageReadout = second.page.getByText("26–26 of 26");
        const fatalError = second.page.getByRole("heading", {
          name: "Something went wrong",
        });
        await expect(finalPageReadout.or(fatalError)).toBeVisible({
          timeout: 30_000,
        });
        if (await fatalError.isVisible()) {
          throw new Error(
            second.pageErrors.map((error) => error.stack).join("\n") ||
              "Desktop Branches reached the fatal error boundary"
          );
        }
        await expect(
          second.page.getByRole("link", {
            name: "iss-4656-page-25",
            exact: true,
          })
        ).toBeVisible();
        await second.page.getByRole("button", { name: "Name" }).click();
        await expect(second.page.getByText("1–25 of 26")).toBeVisible({
          timeout: 30_000,
        });
        await second.page.getByLabel("Go to next page").click();
        await expect(second.page.getByText("26–26 of 26")).toBeVisible({
          timeout: 30_000,
        });
        // ISS-13035: gridview-adoption is not seeded here, so the toolbar keeps
        // its "Filter" button and has neither a search box nor "Filters".
        await expect(
          second.page.getByRole("button", {
            name: LIST_TOOLBAR_FILTER_LABEL,
            exact: true,
          })
        ).toHaveCount(0);
        await expect(
          second.page.getByRole("textbox", {
            name: LIST_TOOLBAR_SEARCH_LABEL,
            exact: true,
          })
        ).toHaveCount(0);
        await second.page
          .getByRole("button", { name: "Filter", exact: true })
          .click();
        await second.page.getByRole("menuitem", { name: "Status" }).click();
        // ISS-9664: every row here is seeded by `seedNoPullRequestBranch`, and a
        // PR-less branch now derives Open rather than desktop's old fall-through
        // to Draft (see branches-no-pr-artifact.spec.ts). Filtering by Draft
        // would match none of the 26, so the facet that keeps the whole cohort
        // is Open. The assertion below is unchanged: the point of this step is
        // that a Status facet retains all 26 rows and re-pages them.
        await second.page.getByRole("menuitem", { name: "Open" }).click();
        await second.page.keyboard.press("Escape");
        await expect(second.page.getByText("1–25 of 26")).toBeVisible({
          timeout: 30_000,
        });
        expect(second.pageErrors).toEqual([]);
      } finally {
        await second.cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

function recentActivityAt(): string {
  return new Date(Date.now() - DAY_MS).toISOString();
}

/**
 * ISS-8066: keep the seeded corpus inside the default Branches window.
 *
 * ISS-11915: Session-only branches use `sessions.last_activity_at` when no
 * commit, PR, or monitored activity timestamp exists. Seed the same Session
 * activity timestamp for every row to preserve the name-order tie.
 *
 * A precondition only — the pagination readouts ("26–26 of 26", "1–25 of 26")
 * stay independently-written literals in this file.
 */
function expectSeedInsideDefaultWindow(activityAt: string): void {
  expectFixtureInsideDefaultDateWindow(activityAt, "Seeded branch activityAt");
}
