/**
 * ISS-9582 — the DESKTOP Branches list honours a link that states a grouping
 * axis and a collapsed band: `#/branches?group=repo:asc&collapsed=<owner/repo>`
 * opens grouped by Repository with that band collapsed and the other band open.
 *
 * Why a desktop spec beside `e2e/branches-group-collapse-deep-link.spec.ts`: the
 * list params live after the `#` on the hash router, and the desktop host wires
 * its own `useUrlSyncedBranchServerState` call in `branches-view.tsx`. A host
 * that dropped the `groupView` source, or a hash-query read that never reached
 * the hook, leaves the web spec green.
 *
 * Initialize the schema through the production migration adapter, close its
 * writer, then seed with the app down. Both real subject launches remain:
 * expanded bands first, then the same-profile collapsed deep link with
 * positive anchors before its absence assertions.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY } from "@repo/api/src/types/branches-list-column-controls-flag.ts";
import { expectFixtureInsideDefaultDateWindow } from "./helpers/date-window-fixture-guard";
import {
  activeNavPanel,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
import { seedBranchWithUnobservedPullRequest } from "./helpers/seed-branch-unobserved-pr-fixture";

/**
 * The link's param names, spelled as literals. Their owners are
 * `packages/app/shared/lib/table-group-view-params.ts` (`TABLE_GROUP_PARAM`)
 * and `packages/app/shared/lib/table-collapsed-groups.ts`
 * (`TABLE_COLLAPSED_GROUP_PARAM`), but those modules import extension-less `@repo/*`
 * subpaths, which abort the whole desktop-e2e suite at load time
 * (`apps/desktop/test/AGENTS.md`). The web twin imports the constants, so a
 * rename there reddens that spec.
 */
const GROUP_PARAM = "group";
const COLLAPSED_PARAM = "collapsed";

const COLLAPSED_REPO = "acme-e2e/alpha-service";
const OPEN_REPO = "acme-e2e/beta-service";
// `repositoryDisplayLabels` shows the short name when no other repository
// shares it. Anchored at the start because a band header may append a count.
const COLLAPSED_BAND_LABEL = /^alpha-service/;
const OPEN_BAND_LABEL = /^beta-service/;

const COLLAPSED_BRANCHES = [
  "iss-9582-alpha-first",
  "iss-9582-alpha-second",
] as const;
const OPEN_BRANCH = "iss-9582-beta-only";

// Wide enough for the grid rather than the narrow-viewport card list.
const DESKTOP_VIEWPORT = { height: 900, width: 1440 };
const DAY_MS = 24 * 60 * 60 * 1000;

test.describe("Branches group + collapsed deep link (ISS-9582)", () => {
  test("a hash link opens grouped by Repository with only the named band collapsed", async () => {
    test.setTimeout(300_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-group-link-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-group-link-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-group-link-udd-")
    );
    const env = {
      CLAUDE_HOME: claudeHome,
      CODEX_HOME: codexHome,
    };
    const seedFlags = (dir: string) =>
      seedDesktopFeatureFlags(dir, {
        [BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY]: true,
      });

    try {
      await initializeDesktopProfileSchema(userDataDir);

      const activityAt = new Date(Date.now() - DAY_MS).toISOString();
      expectFixtureInsideDefaultDateWindow(
        activityAt,
        "Seeded branch activityAt"
      );
      const seeds = [
        {
          branchName: COLLAPSED_BRANCHES[0],
          prNumber: 958_201,
          repoFullName: COLLAPSED_REPO,
        },
        {
          branchName: OPEN_BRANCH,
          prNumber: 958_202,
          repoFullName: OPEN_REPO,
        },
        {
          branchName: COLLAPSED_BRANCHES[1],
          prNumber: 958_203,
          repoFullName: COLLAPSED_REPO,
        },
      ];
      for (const seed of seeds) {
        await seedBranchWithUnobservedPullRequest(userDataDir, {
          ...seed,
          activityAt,
          sessionId: `${seed.branchName}-session`,
        });
      }

      // First real subject — the counterfactual: grouped, nothing collapsed.
      const open = await launchDesktopApp({
        beforeLaunch: seedFlags,
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        const panel = await openBranchesLink(open.page, {});
        const collapsedBand = bandHeader(panel, COLLAPSED_BAND_LABEL);
        await expect(collapsedBand).toBeVisible({ timeout: 30_000 });
        await expect(collapsedBand).toHaveAttribute("aria-expanded", "true");
        await expect(bandHeader(panel, OPEN_BAND_LABEL)).toHaveAttribute(
          "aria-expanded",
          "true"
        );
        for (const branchName of [...COLLAPSED_BRANCHES, OPEN_BRANCH]) {
          await expect(branchLink(panel, branchName)).toBeVisible();
        }

        expect(open.pageErrors).toEqual([]);
      } finally {
        await open.cleanup();
      }

      // Second real subject — the claim: the named band is collapsed, the other is open.
      const linked = await launchDesktopApp({
        beforeLaunch: seedFlags,
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        const panel = await openBranchesLink(linked.page, {
          collapsed: COLLAPSED_REPO,
        });
        const collapsedBand = bandHeader(panel, COLLAPSED_BAND_LABEL);
        const openBand = bandHeader(panel, OPEN_BAND_LABEL);
        // Positive anchors before the absences, so an empty list cannot pass.
        await expect(collapsedBand).toBeVisible({ timeout: 30_000 });
        await expect(openBand).toBeVisible();
        await expect(branchLink(panel, OPEN_BRANCH)).toBeVisible();

        await expect(collapsedBand).toHaveAttribute("aria-expanded", "false");
        await expect(openBand).toHaveAttribute("aria-expanded", "true");
        for (const branchName of COLLAPSED_BRANCHES) {
          await expect(branchLink(panel, branchName)).toHaveCount(0);
        }
        expect(linked.pageErrors).toEqual([]);
      } finally {
        await linked.cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
    }
  });
});

/**
 * Open Branches straight on the link, so the list mounts reading its params.
 * Keep-alive holds a view's first mount, so the hash must carry the params the
 * first time Branches is visited in this launch.
 */
async function openBranchesLink(
  page: Page,
  { collapsed }: { collapsed?: string }
): Promise<Locator> {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const params = new URLSearchParams();
  params.append(GROUP_PARAM, "repo:asc");
  if (collapsed !== undefined) {
    params.append(COLLAPSED_PARAM, collapsed);
  }
  await page.evaluate((hash) => {
    globalThis.location.hash = hash;
  }, `#/branches?${params.toString()}`);
  const panel = activeNavPanel(page, "branches");
  const fatalError = page.getByRole("heading", {
    name: "Something went wrong",
  });
  await expect(panel.or(fatalError)).toBeVisible({ timeout: 30_000 });
  if (await fatalError.isVisible()) {
    throw new Error("Desktop Branches reached the fatal error boundary");
  }
  return panel;
}

/** A band's collapse toggle: the grid button with `aria-expanded` and that label. */
function bandHeader(panel: Locator, label: RegExp): Locator {
  return panel
    .getByRole("grid")
    .getByRole("button", { name: label })
    .and(panel.page().locator("[aria-expanded]"));
}

function branchLink(panel: Locator, branchName: string): Locator {
  return panel.getByRole("link", { exact: true, name: branchName });
}
