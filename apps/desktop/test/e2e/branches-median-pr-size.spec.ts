/**
 * E2E proof (FEA-2159): a MERGED, single-PR branch with NO LOC enrichment makes
 * the REAL "Median PR size" KPI card render a NUMBER ("0"), not the "—" dash.
 *
 * This is the end-to-end stitch the unit tests only cover in pieces: it seeds the
 * exact un-enriched merged single-PR corpus into the launched app's real SQLite
 * store, boots the real desktop app, navigates to the real Branches view, and
 * asserts the real `MetricCard` for "Median PR size" (fed by the real
 * `getSharedBranchAnalytics` → `projectBranchAnalytics` path over IPC) shows "0".
 *
 * Why "0" is the meaningful assertion: FEA-2159 makes the projection median over
 * ALL merged single-PR branches, folding a missing line total in as
 * `(additions ?? 0) + (deletions ?? 0)`. For a fully un-enriched merged branch
 * that is `0`, so the KPI is `available`/`0` and the card gate
 * (`state === Available && value != null`) renders "0". BEFORE the fix, the same
 * corpus produced `medianPrSize.state = "unavailable"` → the card showed "—".
 * Asserting the card reads exactly "0" (and NOT "—") therefore fails closed
 * against the old behavior.
 *
 * Seeding mechanism (see helpers/seed-branches-db.ts): the desktop store is a
 * single libSQL/SQLite file the db-host opens at boot. Because a running app does
 * not observe another process's writes to that file (and its boot maintenance
 * would otherwise not have run against them), the corpus is seeded with the app
 * DOWN and read on the NEXT boot:
 *   1. Launch the app once so it creates + migrates the schema, then close it.
 *   2. Seed the four real rows (`sessions`, `artifacts` kind='branch',
 *      `session_artifact_links`, `pull_requests` merged) straight into the file.
 *   3. Relaunch — the app reads the seeded corpus at boot and its REAL projection
 *      runs over it (no test-only code path in the app).
 * The seeded session stamps a recent `last_activity_at` so the boot retention
 * sweep (which keys on that column) does not purge it and cascade its rows.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
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
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
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

test.describe("Branches Median PR size card (FEA-2159)", () => {
  test("un-enriched merged single-PR branch renders a numeric Median PR size (0), not —", async () => {
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
        // the label, then read the value.
        const medianCard = page
          .locator('[data-slot="card"]')
          .filter({ hasText: "Median PR size" });
        await expect(medianCard).toBeVisible({ timeout: 30_000 });
        const medianValue = medianCard.locator('[data-slot="card-title"]');

        // The real card shows the numeric median (0), NOT the "—" dash the old
        // (pre-FEA-2159) projection produced for an un-enriched merged corpus.
        await expect(medianValue).toHaveText("0", { timeout: 30_000 });
        await expect(medianValue).not.toHaveText("—");
        // Belt-and-suspenders: the value is a plain number, not a placeholder.
        await expect(medianValue).toHaveText(NUMERIC_CARD_VALUE);

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

        const medianCard = page
          .locator('[data-slot="card"]')
          .filter({ hasText: "Median PR size" });
        await expect(medianCard).toBeVisible({ timeout: 30_000 });
        const medianValue = medianCard.locator('[data-slot="card-title"]');

        await expect(medianValue).toHaveText("150", { timeout: 30_000 });
        await expect(medianValue).toHaveText(NUMERIC_CARD_VALUE);
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
