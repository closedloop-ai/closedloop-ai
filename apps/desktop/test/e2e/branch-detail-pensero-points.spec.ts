/**
 * ISS-9930 AC5 on the DESKTOP surface (davetho review on PR #7539).
 *
 * The web twin (`e2e/branch-detail-pensero-points.spec.ts`) and the component
 * suite (`branch-headline-cards-pensero-points.test.tsx`) both prove this
 * rendering, but neither walks the desktop seam: the flag assignment has to
 * reach `DesktopFeatureFlagProvider`, and the Partial result with its disclosure
 * has to survive the authenticated cloud read into the Electron renderer. With
 * only those two, the shared component test was doing all the cross-surface
 * lifting for a card that ships to both shells.
 *
 * ONE PostHog key gates both shells (root `AGENTS.md`), so this seeds the same
 * `pensero-points-per-dollar` assignment `apps/app` reads — there is no second
 * desktop-only key.
 *
 * Built on the harness `branch-detail-metric-honesty.spec.ts` already uses
 * (`startAuthenticatedBranchCloudServer` + `launchAuthenticatedDesktopApp`),
 * and a sibling file rather than a third launch inside that spec: its two tests
 * already budget 180s each, and the Pensero card REPLACES the LOC card, so
 * seeding this flag into either of them would retire the assertions they exist
 * for.
 *
 * Prerequisite: `pnpm -C apps/desktop build`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  BRANCH_METRIC_DICTIONARY,
  BranchMetricAvailability,
  BranchMetricDisclosure,
  BranchMetricId,
} from "@repo/api/src/types/branch-metrics.ts";
import {
  NumeratorProvider,
  perDollarLabelFor,
  perDollarUnitLabelFor,
} from "@repo/api/src/types/numerator-provider.ts";
import { PENSERO_POINTS_PER_DOLLAR_FLAG_KEY } from "@repo/api/src/types/pensero-points-per-dollar-flag.ts";
import {
  ACTIVE_PR,
  BRANCH_ID,
  detailFor,
} from "../../../../e2e/helpers/branch-details-comprehensive-data";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_GATEWAY_ID,
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

const PENSERO_LABEL = perDollarLabelFor(NumeratorProvider.Pensero);
const PENSERO_UNIT_LABEL = perDollarUnitLabelFor(NumeratorProvider.Pensero);
const LOC_LABEL =
  BRANCH_METRIC_DICTIONARY[BranchMetricId.DetailLocPerDollar].label;
/** Tenths on purpose: `formatPenseroPointsPerDollar` keeps them verbatim. */
const PENSERO_POINTS_PER_DOLLAR_VALUE = 2.5;
/** The Partial `*` travels with the number — ISS-9930's only published state. */
const PENSERO_RENDERED_VALUE = "2.5*";
/**
 * Read from the canonical constant the producer and the card share, never
 * re-typed: a literal copy here would stop matching the moment the sentence is
 * reworded, which is the regression the assertion exists to catch.
 */
const PENSERO_DISCLOSURE = BranchMetricDisclosure.PenseroAcquisitionIncomplete;
/** The card's info trigger and popover: `MetricCard` names both `About <label>`. */
const ABOUT_INFO_LABEL = /^About /;

test("ISS-9930 AC5: desktop publishes the Pensero ratio as Partial, with its disclosure", async () => {
  test.setTimeout(180_000);

  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-9930-claude-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-9930-codex-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-9930-udd-"));
  const server = await startAuthenticatedBranchCloudServer({
    detailFactory: penseroDetailFor,
  });

  try {
    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      cloudReadReadiness: drainedCloudReadReadiness(),
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          activeConfigId: "iss-9930-pensero-points-cloud-profile",
          apiOrigin: server.origin,
          cloudConnectionEnabled: true,
          savedConfigs: [
            {
              apiOrigin: server.origin,
              gatewayId: AUTHENTICATED_GATEWAY_ID,
              id: "iss-9930-pensero-points-cloud-profile",
              name: "ISS-9930 Pensero Points Cloud E2E",
              relayOrigin: "http://127.0.0.1:9",
              webAppOrigin: "http://127.0.0.1:3000",
            },
          ],
        });
        seedDesktopFeatureFlags(launchUserDataDir, {
          [PENSERO_POINTS_PER_DOLLAR_FLAG_KEY]: true,
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
      const priorDetailRequestCount = authenticatedDetailRequestCount(
        server.requests
      );
      await gotoHash(page, `/branches/${BRANCH_ID}`);
      await expect(
        page.getByRole("combobox", { name: "Pull request" })
      ).toBeVisible({ timeout: 30_000 });
      // The payload under test really came from the authenticated cloud read,
      // not a local projection that happens to render the same words.
      await expect
        .poll(() => authenticatedDetailRequestCount(server.requests))
        .toBeGreaterThan(priorDetailRequestCount);

      const activeRegion = page.getByRole("region", {
        name: `Branch and pull request #${ACTIVE_PR} evidence`,
      });
      await expect(activeRegion).toBeVisible();

      const penseroCard = metricCard(activeRegion, PENSERO_LABEL);
      await expect(penseroCard).toHaveCount(1);
      await expect(
        penseroCard.getByText(PENSERO_RENDERED_VALUE, { exact: true })
      ).toBeVisible();
      await expect(penseroCard.getByText(PENSERO_UNIT_LABEL)).toBeVisible();
      // AC5: the `*` promises an explanation, so the disclosure travels with the
      // number on this surface too. Since ISS-10540 (product ruling 2026-09-22)
      // it is carried in the card's info popover, not on the face. Its whole
      // sentence separates it from the three siblings, so resolving to the
      // wrong copy fails here.
      await expect(penseroCard.getByText(PENSERO_DISCLOSURE)).toHaveCount(0);
      await penseroCard.getByRole("button", { name: ABOUT_INFO_LABEL }).click();
      await expect(
        page.getByRole("dialog", { name: ABOUT_INFO_LABEL })
      ).toContainText(PENSERO_DISCLOSURE);
      await page.keyboard.press("Escape");

      // One branch renders under ONE numerator: the renamed card must have
      // replaced the LOC card, not joined it.
      await expect(metricCard(activeRegion, LOC_LABEL)).toHaveCount(0);

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

/** The comprehensive fixture's detail with a published Pensero companion added. */
function penseroDetailFor(pullRequestNumber: number): BranchPageDetail {
  const detail = detailFor(pullRequestNumber);
  const metrics = detail.canonicalMetrics;
  if (!metrics) {
    return detail;
  }
  return {
    ...detail,
    canonicalMetrics: {
      ...metrics,
      penseroPointsPerDollar: {
        state: BranchMetricAvailability.Partial,
        value: PENSERO_POINTS_PER_DOLLAR_VALUE,
        disclosure: PENSERO_DISCLOSURE,
      },
    },
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
