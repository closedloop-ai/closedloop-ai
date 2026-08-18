import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import {
  BranchDeliveredIdentityScenario,
  COMPATIBILITY_PR_BODY,
  COMPATIBILITY_PR_NUMBER,
  COMPATIBILITY_PR_TITLE,
  COMPATIBILITY_PR_URL,
  deliveredIdentityDetail,
  SELECTED_PR_BODY,
  SELECTED_PR_NUMBER,
  SELECTED_PR_TITLE,
  SELECTED_PR_URL,
} from "../../../../e2e/helpers/branch-delivered-identity-data";
import { BRANCH_ID } from "../../../../e2e/helpers/branch-details-comprehensive-data";
import {
  type DesktopAuthState,
  DesktopAuthStatus,
} from "../../src/shared/contracts.js";
import {
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  isAuthenticatedBranchRequest,
  launchAuthenticatedDesktopApp,
  seedAuthenticatedDesktopSession,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoHash,
  seedDesktopSettings,
} from "./helpers/desktop-app";

const CASES = Object.values(BranchDeliveredIdentityScenario);

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Global DOM Window must be interface-merged; a type alias cannot augment it.
  interface Window {
    desktopApi: {
      getDesktopAuthState: () => Promise<DesktopAuthState>;
    };
  }
}

test("keeps selected PR identity and body compatibility atomic in authenticated Desktop", async () => {
  test.setTimeout(180_000);

  let scenario: BranchDeliveredIdentityScenario =
    BranchDeliveredIdentityScenario.SelectedIdentity;
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-5729-desktop-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-5729-desktop-codex-")
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-5729-desktop-udd-")
  );
  const server = await startAuthenticatedBranchCloudServer({
    detailFactory: () => deliveredIdentityDetail(scenario),
  });

  try {
    const sessionSeedLaunch = await launchAuthenticatedDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      userDataDir,
    });
    try {
      await seedAuthenticatedDesktopSession(sessionSeedLaunch.app, userDataDir);
    } finally {
      await sessionSeedLaunch.cleanup();
    }

    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      cloudReadReadiness: drainedCloudReadReadiness(),
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          activeConfigId: "iss-5729-cloud-profile",
          apiOrigin: server.origin,
          cloudConnectionEnabled: true,
          savedConfigs: [
            {
              apiOrigin: server.origin,
              gatewayId: AUTHENTICATED_GATEWAY_ID,
              id: "iss-5729-cloud-profile",
              name: "ISS-5729 Cloud E2E",
              relayOrigin: "http://127.0.0.1:9",
              webAppOrigin: "http://127.0.0.1:3000",
            },
          ],
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

      for (const nextScenario of CASES) {
        const priorDetailRequestCount = authenticatedDetailRequestCount(
          server.requests
        );
        scenario = nextScenario;
        await page.reload();
        await gotoHash(page, `/branches/${BRANCH_ID}?case=${scenario}`);
        const panel = page.locator(".bq-ctx-pr");
        await expect(panel).toBeVisible({ timeout: 30_000 });
        await expect
          .poll(() => authenticatedDetailRequestCount(server.requests))
          .toBeGreaterThan(priorDetailRequestCount);
        await expectScenario(panel, scenario);
      }
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

async function expectScenario(
  panel: Locator,
  scenario: BranchDeliveredIdentityScenario
): Promise<void> {
  if (scenario === BranchDeliveredIdentityScenario.NoSelected) {
    await expectCompatibilityProjection(panel);
    return;
  }
  await expect(
    panel.getByText(`#${SELECTED_PR_NUMBER}`, { exact: true })
  ).toBeVisible();
  await expect(panel.getByText("Open", { exact: true })).toBeVisible();
  await expect(
    panel.getByText(`#${COMPATIBILITY_PR_NUMBER}`, { exact: true })
  ).toHaveCount(0);
  await expect(
    panel.getByText(COMPATIBILITY_PR_TITLE, { exact: true })
  ).toHaveCount(0);
  await expect(panel.getByText("Merged", { exact: true })).toHaveCount(0);
  await expect(panel.locator(`a[href="${COMPATIBILITY_PR_URL}"]`)).toHaveCount(
    0
  );

  if (scenario === BranchDeliveredIdentityScenario.NullableIdentity) {
    await expect(
      panel.getByText(SELECTED_PR_TITLE, { exact: true })
    ).toHaveCount(0);
    await expect(panel.getByRole("link")).toHaveCount(0);
  } else {
    await expect(panel.getByText(SELECTED_PR_TITLE)).toBeVisible();
    await expect(panel.getByRole("link")).toHaveAttribute(
      "href",
      SELECTED_PR_URL
    );
  }

  if (scenario === BranchDeliveredIdentityScenario.NullBody) {
    await expect(panel.getByText(SELECTED_PR_BODY)).toHaveCount(0);
    await expect(panel.getByText(COMPATIBILITY_PR_BODY)).toBeVisible();
    return;
  }
  if (scenario === BranchDeliveredIdentityScenario.WhitespaceBody) {
    await expect(panel.getByText(COMPATIBILITY_PR_BODY)).toHaveCount(0);
    await expect(
      panel.getByText(
        `Pull request #${SELECTED_PR_NUMBER} has no description captured yet.`
      )
    ).toBeVisible();
    return;
  }
  await expect(panel.getByText(COMPATIBILITY_PR_BODY)).toHaveCount(0);
  await expect(panel.getByText(SELECTED_PR_BODY)).toBeVisible();
}

async function expectCompatibilityProjection(panel: Locator): Promise<void> {
  await expect(
    panel.getByText(`#${COMPATIBILITY_PR_NUMBER}`, { exact: true })
  ).toBeVisible();
  await expect(panel.getByText(COMPATIBILITY_PR_TITLE)).toBeVisible();
  await expect(panel.getByText("Merged", { exact: true })).toBeVisible();
  await expect(panel.getByText(COMPATIBILITY_PR_BODY)).toBeVisible();
  await expect(panel.getByRole("link")).toHaveAttribute(
    "href",
    COMPATIBILITY_PR_URL
  );
  await expect(
    panel.getByText(`#${SELECTED_PR_NUMBER}`, { exact: true })
  ).toHaveCount(0);
  await expect(panel.getByText(SELECTED_PR_TITLE)).toHaveCount(0);
  await expect(panel.getByText("Open", { exact: true })).toHaveCount(0);
  await expect(panel.getByText(SELECTED_PR_BODY)).toHaveCount(0);
  await expect(panel.locator(`a[href="${SELECTED_PR_URL}"]`)).toHaveCount(0);
}

function authenticatedDetailRequestCount(
  requests: readonly {
    authorization: string | null;
    method: string;
    pathname: string;
  }[]
): number {
  return requests.filter(
    (request) =>
      request.pathname === `/branches/${BRANCH_ID}` &&
      isAuthenticatedBranchRequest(request)
  ).length;
}
