import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY } from "@repo/api/src/types/branch-detail-metric-honesty-flag.ts";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics.ts";
import {
  ACTIVE_PR,
  BRANCH_ID,
  detailFor,
  HISTORICAL_PR,
} from "../../../../e2e/helpers/branch-details-comprehensive-data";
import {
  type DesktopAuthState,
  DesktopAuthStatus,
} from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  type AuthenticatedCloudRequest,
  createAuthenticatedDesktopSessionRecord,
  isAuthenticatedBranchRequest,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoHash,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./helpers/desktop-app";

const HISTORICAL_PULL_REQUEST_OPTION = new RegExp(`#${HISTORICAL_PR}.*Merged`);

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Global DOM Window must be interface-merged; a type alias cannot augment it.
  interface Window {
    desktopApi: {
      getDesktopAuthState: () => Promise<DesktopAuthState>;
    };
  }
}

test("renders partial and invalid canonical metrics through authenticated cloud mode", async () => {
  test.setTimeout(180_000);

  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-8511-claude-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-8511-codex-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-8511-udd-"));
  const server = await startAuthenticatedBranchCloudServer({
    detailFactory: iss8511MetricDetailFor,
  });

  try {
    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      cloudReadReadiness: drainedCloudReadReadiness(),
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          activeConfigId: "iss-8511-branch-detail-metric-cloud-profile",
          apiOrigin: server.origin,
          cloudConnectionEnabled: true,
          savedConfigs: [
            {
              apiOrigin: server.origin,
              gatewayId: AUTHENTICATED_GATEWAY_ID,
              id: "iss-8511-branch-detail-metric-cloud-profile",
              name: "ISS-8511 Branch Detail Metric Cloud E2E",
              relayOrigin: "http://127.0.0.1:9",
              webAppOrigin: "http://127.0.0.1:3000",
            },
          ],
        });
        seedDesktopFeatureFlags(launchUserDataDir, {
          [BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY]: true,
        });
      },
      env: {
        CLAUDE_HOME: claudeHome,
        CL_AUTH_API_ORIGIN: server.origin,
        CODEX_HOME: codexHome,
      },
      userDataDir,
    });

    try {
      await expect
        .poll(() =>
          page.evaluate(() => window.desktopApi.getDesktopAuthState())
        )
        .toMatchObject({
          organizationId: AUTHENTICATED_ORGANIZATION_ID,
          status: DesktopAuthStatus.Authenticated,
          userId: AUTHENTICATED_USER_ID,
        });

      const priorDetailRequestCount = authenticatedDetailRequestCount(
        server.requests
      );
      await gotoHash(page, `/branches/${BRANCH_ID}`);
      await expect(
        page.getByRole("combobox", { name: "Pull request" })
      ).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(() => authenticatedDetailRequestCount(server.requests))
        .toBeGreaterThan(priorDetailRequestCount);
      await expectIss8511MetricStates(page, server.requests);

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
});

async function expectIss8511MetricStates(
  page: Page,
  requests: readonly AuthenticatedCloudRequest[]
): Promise<void> {
  const activeRegion = page.getByRole("region", {
    name: `Branch and pull request #${ACTIVE_PR} evidence`,
  });
  await expect(activeRegion).toBeVisible();

  const locCard = metricCard(activeRegion, "LOC per $");
  await expect(locCard.getByText("6.67*", { exact: true })).toBeVisible();
  // ISS-10540 (product ruling 2026-09-22): the `*` footnote is not on the card
  // face; it is carried in the card's info popover with the metric definition.
  await expect(
    locCard.getByText(BranchMetricDisclosure.LocIncomplete)
  ).toHaveCount(0);
  await locCard.getByRole("button", { name: "About LOC per $" }).click();
  await expect(
    page.getByRole("dialog", { name: "About LOC per $" })
  ).toContainText(BranchMetricDisclosure.LocIncomplete);
  await page.keyboard.press("Escape");

  const activeCycleCard = metricCard(activeRegion, "Cycle Time");
  await expect(
    activeCycleCard.getByText("Unavailable", { exact: true })
  ).toBeVisible();
  await expect(
    activeCycleCard.getByText("Evidence is unavailable.", { exact: true })
  ).toBeVisible();
  await expect(activeRegion.getByText("-1")).toHaveCount(0);

  const activeDetailRequestCount = authenticatedDetailRequestCount(requests);
  await page.getByRole("combobox", { name: "Pull request" }).click();
  await page
    .getByRole("option", { name: HISTORICAL_PULL_REQUEST_OPTION })
    .click();
  await expect
    .poll(() => authenticatedDetailRequestCount(requests))
    .toBeGreaterThan(activeDetailRequestCount);

  const historicalRegion = page.getByRole("region", {
    name: `Branch and pull request #${HISTORICAL_PR} evidence`,
  });
  await expect(historicalRegion).toBeVisible();
  await expect(
    metricCard(historicalRegion, "Cycle Time").getByText("3d 20h*", {
      exact: true,
    })
  ).toBeVisible();
  await expect(
    historicalRegion
      .locator("section.bq-lead")
      .getByText("3d 20h* · idle unavailable", { exact: true })
  ).toBeVisible();
  await expect(
    historicalRegion.getByText("Idle evidence is unavailable.", {
      exact: true,
    })
  ).toBeVisible();
}

function iss8511MetricDetailFor(pullRequestNumber: number): BranchPageDetail {
  const detail = detailFor(pullRequestNumber);
  const metrics = detail.canonicalMetrics;
  if (!metrics) {
    return detail;
  }

  return {
    ...detail,
    canonicalMetrics: {
      ...metrics,
      locPerDollar: partialMetric(
        metrics.locPerDollar.value ?? 0,
        BranchMetricDisclosure.LocIncomplete
      ),
      leadTimeMs:
        pullRequestNumber === HISTORICAL_PR
          ? partialMetric(metrics.leadTimeMs.value ?? 0)
          : { state: BranchMetricAvailability.Complete, value: -1 },
      idleTimeMs:
        pullRequestNumber === HISTORICAL_PR
          ? { state: BranchMetricAvailability.Complete, value: -1 }
          : partialMetric(metrics.idleTimeMs.value ?? 0),
    },
  };
}

function partialMetric(
  value: number,
  disclosure: BranchMetricDisclosure = BranchMetricDisclosure.DefaultIncomplete
): BranchMetricResult<number> {
  return {
    disclosure,
    state: BranchMetricAvailability.Partial,
    value,
  };
}

function metricCard(region: Locator, label: string): Locator {
  return region.locator('[data-slot="card"]', { hasText: label });
}

function authenticatedDetailRequestCount(
  requests: readonly AuthenticatedCloudRequest[]
): number {
  return requests.filter(
    (request) =>
      request.method === "GET" &&
      request.pathname === `/branches/${BRANCH_ID}` &&
      isAuthenticatedBranchRequest(request)
  ).length;
}
