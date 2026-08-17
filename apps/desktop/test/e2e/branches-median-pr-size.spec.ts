/**
 * Desktop E2E for PRD-601 LIST-013. A known merged PR with unknown LOC is
 * Unavailable, while exact LOC already returned by cloud hydration must feed
 * the canonical median without a new provider read.
 */

import fs from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { GitHubPRState } from "../../../../packages/api/src/types/github";
import { RepositoryDefaultSource } from "../../../../packages/api/src/types/repository-default-identity";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { completeFakeGitHubAuthority } from "./helpers/fake-github-authority-server";
import {
  seedMergedUnenrichedSinglePrBranch,
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

// A distinctive, non-default branch name (default branches — main/master/… — are
// hidden by the Branches PR read). The merge instant is a stable past date; the
// test widens the window to "All time" so this is in range regardless of clock.
const SEED = {
  repoFullName: "acme/web",
  branchName: "fea-2159-median-pr-size-e2e",
  sessionId: "median-pr-size-e2e-session",
  prNumber: 2159,
  mergedAt: "2026-05-15T12:00:00.000Z",
} as const;

// The card value must be a plain integer string (e.g. "0"), not a placeholder.
const NUMERIC_CARD_VALUE = /^\d+$/;

// The muted no-data glyph MetricCard renders for a genuine no-data metric (a
// nullish `value`) since FEA-4236 — mirrors the component's `valueUnavailableLabel`
// default in metric-card.tsx. Kept as a local constant so the two can't silently
// drift the copy apart (the design-system default is not an exported symbol).
const METRIC_CARD_UNAVAILABLE_LABEL = "—";

test.describe("Branches Median PR size card (FEA-2949)", () => {
  test("un-enriched merged single-PR branch renders Unavailable, not 0", async () => {
    test.setTimeout(180_000);

    // An EMPTY CLAUDE_HOME so the importer ingests nothing — the corpus is
    // exactly the one merged branch we seed, so the median is unambiguously 0.
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-median-pr-size-claude-")
    );
    // A user-data dir we own across BOTH launches (seed between them).
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-median-pr-size-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      const first = await launchDesktopApp({
        userDataDir,
        keepUserDataDir: true,
        env: { CLAUDE_HOME: claudeHome },
      });
      await waitForBranchesSchema(userDataDir);
      await first.cleanup();

      // Seed the un-enriched merged single-PR branch while the app is DOWN.
      await seedMergedUnenrichedSinglePrBranch(userDataDir, SEED);

      // Launch 2 — the app reads the seeded corpus at boot.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        userDataDir,
        keepUserDataDir: true,
        env: { CLAUDE_HOME: claudeHome },
      });

      try {
        await gotoNav(page, "branches");
        // Confirm the Branches route mounted (title lives only in the Topbar
        // breadcrumb); scoped to <header> so it can't match the sidebar nav.
        await expect(
          page.locator("header").getByText("Branches", { exact: true })
        ).toBeVisible({ timeout: 30_000 });

        // Widen to "All time" so the seeded (past-dated) branch is in range and
        // the analytics cards reflect the whole corpus — the same control the
        // table uses. `:visible` scopes to the Branches toolbar (keep-alive views
        // stay mounted-but-hidden and also render this control).
        await page.locator('[aria-label="All time"]:visible').click();

        // The specific "Median PR size" card. MetricCard renders the label in a
        // `[data-slot="card-description"]` and the value in
        // `[data-slot="card-title"]` inside one `[data-slot="card"]`, so scope by
        // the label, then read the value. Scope to `:visible` cards: the Sessions
        // bar owns its OWN "Median PR size" card (FEA-3574 dual-home), and the
        // default Sessions view stays mounted-but-hidden under keep-alive, so a
        // page-wide `[data-slot="card"]` match would collide with that hidden
        // sibling. `:visible` keeps this on the active Branches surface (the same
        // reason the date-range control above is scoped `:visible`).
        const medianCard = page
          .locator('[data-slot="card"]:visible')
          .filter({ hasText: "Median PR size" });
        await expect(medianCard).toBeVisible({ timeout: 30_000 });
        const medianValue = medianCard.locator('[data-slot="card-title"]');

        // The merged PR exists, so this is unknown required evidence rather
        // than an empty eligible population. LIST-013 requires Unavailable.
        await expect(medianValue).toHaveText(METRIC_CARD_UNAVAILABLE_LABEL, {
          timeout: 30_000,
        });
        await expect(medianValue).not.toHaveText("0");
        // Belt-and-suspenders: the value is unavailable, not a number.
        await expect(medianValue).not.toHaveText(NUMERIC_CARD_VALUE);

        // Screenshot into Playwright's per-test output dir (portable across
        // machines/CI; CI uploads test-results-e2e/ on failure). Not a hardcoded
        // absolute path, which would break on other runners.
        await page.screenshot({
          path: test.info().outputPath("median-card-e2e.png"),
          fullPage: true,
        });

        // No uncaught renderer errors (a blanked chunk would also fail the above).
        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  test("cloud-hydrated prod PR LOC renders a numeric Median PR size when local LOC is missing", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-cloud-median-pr-size-claude-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-cloud-median-pr-size-udd-")
    );
    const cloudSeed = {
      repoFullName: "acme/web",
      branchName: "fea-2518-cloud-median-pr-size-e2e",
      sessionId: "cloud-median-pr-size-e2e-session",
      prNumber: 2518,
      mergedAt: "2026-06-20T12:00:00.000Z",
      additions: 140,
      deletions: 10,
    } as const;
    const serverRequests: string[] = [];
    const server = await startBranchesCloudApiServer(cloudSeed, serverRequests);

    try {
      const first = await launchDesktopApp({
        userDataDir,
        keepUserDataDir: true,
        env: { CLAUDE_HOME: claudeHome },
      });
      await waitForBranchesSchema(userDataDir);
      await first.cleanup();

      await seedNoPullRequestBranch(userDataDir, {
        repoFullName: cloudSeed.repoFullName,
        branchName: cloudSeed.branchName,
        sessionId: cloudSeed.sessionId,
        activityAt: cloudSeed.mergedAt,
      });

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        userDataDir,
        keepUserDataDir: true,
        env: {
          CLAUDE_HOME: claudeHome,
          CLOSEDLOOP_API_KEY: "sk_live_branches_cloud_e2e",
          CL_AUTH_API_ORIGIN: server.origin,
        },
        beforeLaunch: (launchUserDataDir) => {
          seedActiveProfileComputeTarget(launchUserDataDir, {
            apiOrigin: server.origin,
            cloudConnectionEnabled: true,
            computeTargetId: "branches-cloud-median-e2e-target",
          });
        },
      });

      try {
        await gotoNav(page, "branches");
        await expect(
          page.locator("header").getByText("Branches", { exact: true })
        ).toBeVisible({ timeout: 30_000 });
        await page.locator('[aria-label="All time"]:visible').click();

        // Scope to `:visible` cards so this stays on the active Branches surface
        // and never matches the keep-alive-hidden Sessions view's own (cloud-only)
        // "Median PR size" card (FEA-3574 dual-home) — a page-wide match resolves
        // to two card-titles and trips Playwright strict mode.
        const medianCard = page
          .locator('[data-slot="card"]:visible')
          .filter({ hasText: "Median PR size" });
        await expect(medianCard).toBeVisible({ timeout: 30_000 });
        const medianValue = medianCard.locator('[data-slot="card-title"]');

        // The cloud list overlay proves this selected PR's LOC, but not the
        // complete historical PR corpus, so the approved card must disclose a
        // partial numeric value rather than claim complete coverage.
        await expect(medianValue).toHaveText("150 LOC*", {
          timeout: 30_000,
        });

        await expect
          .poll(() =>
            serverRequests.some((url) => url.includes("/pull-requests"))
          )
          .toBe(true);

        await page.screenshot({
          path: test.info().outputPath("cloud-median-card-e2e.png"),
          fullPage: true,
        });
        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await server.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  /**
   * ISS-5714, through the Electron harness. `packages/app/AGENTS.md` wants this
   * shared summary row's regression in BOTH harnesses; the web half lives in
   * `e2e/branches-surface.spec.ts`.
   *
   * THE DEFECT: `MEDIAN PR SIZE` rendered a real, disclosed figure with the bare
   * word `Unavailable` in the delta slot directly beneath it — a number and a
   * denial of that number in one tile, with nothing on screen saying which to
   * believe. The figure was never in doubt; only the period-over-period
   * COMPARISON was missing, and the slot now names the thing it cannot draw.
   *
   * Run on the DEFAULT 30-day window, deliberately: the sibling cases above widen
   * to "All time", which has no prior window at all, so no comparison is promised
   * there and no explanation is owed. The defect only exists where a comparison
   * WAS promised and could not be computed.
   */
  test("renders No comparison, never a bare denial, under a value it did draw", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-no-comparison-claude-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-no-comparison-udd-")
    );
    // Inside the default 30-day window, computed from NOW rather than pinned: a
    // fixed date silently ages out of the window and empties the card, which
    // would make every assertion below pass or fail for the wrong reason.
    const mergedAt = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000
    ).toISOString();
    const cloudSeed = {
      repoFullName: "acme/web",
      branchName: "iss-5714-no-comparison-e2e",
      sessionId: "iss-5714-no-comparison-e2e-session",
      prNumber: 5715,
      mergedAt,
      additions: 140,
      deletions: 10,
    } as const;
    const serverRequests: string[] = [];
    const server = await startBranchesCloudApiServer(cloudSeed, serverRequests);

    try {
      const first = await launchDesktopApp({
        userDataDir,
        keepUserDataDir: true,
        env: { CLAUDE_HOME: claudeHome },
      });
      await waitForBranchesSchema(userDataDir);
      await first.cleanup();

      await seedNoPullRequestBranch(userDataDir, {
        repoFullName: cloudSeed.repoFullName,
        branchName: cloudSeed.branchName,
        sessionId: cloudSeed.sessionId,
        activityAt: cloudSeed.mergedAt,
      });

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        userDataDir,
        keepUserDataDir: true,
        env: {
          CLAUDE_HOME: claudeHome,
          CLOSEDLOOP_API_KEY: "sk_live_branches_no_comparison_e2e",
          CL_AUTH_API_ORIGIN: server.origin,
        },
        beforeLaunch: (launchUserDataDir) => {
          seedActiveProfileComputeTarget(launchUserDataDir, {
            apiOrigin: server.origin,
            cloudConnectionEnabled: true,
            computeTargetId: "branches-no-comparison-e2e-target",
          });
        },
      });

      try {
        await gotoNav(page, "branches");
        await expect(
          page.locator("header").getByText("Branches", { exact: true })
        ).toBeVisible({ timeout: 30_000 });

        // `:visible` scopes to the ACTIVE Branches surface — the Sessions view
        // stays mounted-but-hidden under keep-alive and owns its own
        // "Median PR size" card (FEA-3574 dual-home), so a page-wide match would
        // resolve to two and read the wrong one.
        const medianCard = page
          .locator('[data-slot="card"]:visible')
          .filter({ hasText: "Median PR size" });
        await expect(medianCard).toHaveCount(1, { timeout: 30_000 });

        // The VALUE is real and on screen. Asserted first and positively: every
        // absence below would pass vacuously against a card that never rendered.
        await expect(medianCard.locator('[data-slot="card-title"]')).toHaveText(
          "150 LOC*",
          { timeout: 30_000 }
        );

        // The delta slot names what it cannot draw, via the ONE shared
        // "No comparison" affordance (`KpiDeltaPlaceholder`).
        const noComparisonChip = medianCard.getByTestId(
          "kpi-delta-placeholder"
        );
        await expect(noComparisonChip).toHaveCount(1, { timeout: 30_000 });
        await expect(noComparisonChip).toContainText("No comparison");
        // And nothing on the tile is a bare, unscoped denial. `exact: true`
        // matches only a node whose WHOLE text is the word, so the `*`
        // disclosure sentence — which contains a lowercase "unavailable" — can
        // never satisfy this by accident.
        await expect(
          medianCard.getByText("Unavailable", { exact: true })
        ).toHaveCount(0);

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await server.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });
});

type BranchesCloudApiServer = {
  origin: string;
  close: () => Promise<void>;
};

type BranchesCloudSeed = {
  repoFullName: string;
  branchName: string;
  prNumber: number;
  mergedAt: string;
  additions: number;
  deletions: number;
};

async function startBranchesCloudApiServer(
  seed: BranchesCloudSeed,
  requests: string[]
): Promise<BranchesCloudApiServer> {
  const server = createServer((request, response) => {
    requests.push(request.url ?? "/");
    routeBranchesCloudApiRequest(request, response, seed);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Branches cloud API server did not bind to a TCP port.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

function routeBranchesCloudApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  seed: BranchesCloudSeed
): void {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (
    request.method === "GET" &&
    requestUrl.pathname === "/integrations/github/repositories"
  ) {
    writeJson(response, [
      {
        id: "repo-cloud-median",
        fullName: seed.repoFullName,
        name: seed.repoFullName.split("/").at(-1) ?? seed.repoFullName,
        owner: seed.repoFullName.split("/").at(0) ?? "acme",
        private: true,
        githubRepoId: "repo-cloud-median-github-id",
        source: "installation",
        repositoryDefaultAuthority: completeFakeGitHubAuthority(
          seed.repoFullName,
          "repo-cloud-median-github-id"
        ),
        pushedAt: seed.mergedAt,
        updatedAt: seed.mergedAt,
      },
    ]);
    return;
  }

  if (
    request.method === "GET" &&
    requestUrl.pathname ===
      "/integrations/github/repositories/repo-cloud-median/branches"
  ) {
    writeJson(response, {
      branches: [
        {
          name: seed.branchName,
          committedDate: seed.mergedAt,
          isDefault: false,
        },
      ],
    });
    return;
  }

  if (
    request.method === "GET" &&
    requestUrl.pathname ===
      "/integrations/github/repositories/repo-cloud-median/pull-requests"
  ) {
    writeJson(response, {
      pullRequests: [
        {
          githubId: "pr-cloud-median",
          number: seed.prNumber,
          title: "Cloud median PR",
          htmlUrl: `https://github.com/${seed.repoFullName}/pull/${seed.prNumber}`,
          headBranch: seed.branchName,
          baseBranch: "main",
          headSha: "cloud-median-head-sha",
          state: GitHubPRState.Merged,
          isDraft: false,
          additions: seed.additions,
          deletions: seed.deletions,
          changedFiles: 4,
          closedAt: seed.mergedAt,
          mergedAt: seed.mergedAt,
          mergeCommitSha: "cloud-median-merge-sha",
          updatedAt: seed.mergedAt,
          author: "octocat",
          checksStatus: null,
          reviewDecision: null,
          headRepository: completeFakeGitHubAuthority(
            seed.repoFullName,
            "repo-cloud-median-github-id",
            RepositoryDefaultSource.PullRequestRest
          ),
        },
      ],
    });
    return;
  }

  response.statusCode = 404;
  writeJson(response, { error: "not found" });
}

function seedActiveProfileComputeTarget(
  userDataDir: string,
  options: {
    apiOrigin: string;
    cloudConnectionEnabled: boolean;
    computeTargetId: string;
  }
): void {
  const settingsPath = path.join(userDataDir, "desktop-settings.json");
  const raw = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    : {};
  const relayOrigin = "http://127.0.0.1:9";
  const webAppOrigin = "http://127.0.0.1:3000";
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        ...raw,
        cloudConnectionEnabled: options.cloudConnectionEnabled,
        apiOrigin: options.apiOrigin,
        relayOrigin,
        webAppOrigin,
        activeConfigId: "branches-cloud-e2e-profile",
        savedConfigs: [
          {
            id: "branches-cloud-e2e-profile",
            name: "Branches Cloud E2E",
            relayOrigin,
            apiOrigin: options.apiOrigin,
            webAppOrigin,
            lastComputeTargetId: options.computeTargetId,
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
}

function writeJson(response: ServerResponse, data: unknown): void {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ success: true, data }));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
