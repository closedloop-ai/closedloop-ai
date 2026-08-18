/**
 * ISS-5555: authenticated Desktop coverage for unavailable Branch trace reads.
 *
 * Prerequisite: `pnpm -C apps/desktop build`. Run only through the repository's
 * displayless Electron E2E harness.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import axe from "axe-core";
import { unavailableTraceResponse } from "../../../../e2e/helpers/branch-details-comprehensive-comments-trace";
import { BRANCH_ID } from "../../../../e2e/helpers/branch-details-comprehensive-data";
import { expectWcagAaClean } from "../../../../e2e/helpers/critical-wcag-aa";
import {
  AUTHENTICATED_GATEWAY_ID,
  launchAuthenticatedDesktopApp,
  seedAuthenticatedDesktopSession,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoHash,
  seedDesktopSettings,
} from "./helpers/desktop-app";

const TIMELINE_AXE_SCOPE = "section.bq-act";

test("renders an authenticated failed trace read without an empty-state lie", async () => {
  test.setTimeout(180_000);

  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "branch-trace-unavailable-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "branch-trace-unavailable-codex-")
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "branch-trace-unavailable-udd-")
  );
  const server = await startAuthenticatedBranchCloudServer({
    traceFactory: unavailableTraceResponse,
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
          activeConfigId: "branch-trace-unavailable-profile",
          apiOrigin: server.origin,
          cloudConnectionEnabled: true,
          savedConfigs: [
            {
              apiOrigin: server.origin,
              gatewayId: AUTHENTICATED_GATEWAY_ID,
              id: "branch-trace-unavailable-profile",
              name: "Branch Trace Unavailable E2E",
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
      await gotoHash(page, `/branches/${BRANCH_ID}`);
      await expect(
        page.getByRole("combobox", { name: "Pull request" })
      ).toBeVisible({ timeout: 30_000 });
      await page.getByRole("tab", { name: "Sessions & timeline" }).click();

      await expect(
        page.getByText("· 0 of 3 sessions rendered", { exact: true })
      ).toBeVisible();
      await expect(
        page.getByText("Session trace unavailable", { exact: true })
      ).toBeVisible();
      await expect(
        page.getByText(
          "Linked Sessions remain part of this Branch. Trace activity could not be loaded for: Build session, Review session, Rework session.",
          { exact: true }
        )
      ).toBeVisible();
      await expect(
        page.getByText("No merged trace", { exact: true })
      ).toHaveCount(0);
      await expectWcagAaClean(page, axe.source, {
        scope: TIMELINE_AXE_SCOPE,
      });
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(claudeHome, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
