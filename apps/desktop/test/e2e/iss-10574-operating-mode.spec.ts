import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { expect, test } from "@playwright/test";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level.ts";
import { z } from "zod";
import type { DesktopApi } from "../../src/renderer/types/desktop-api";
import { CloudSocketState } from "../../src/shared/cloud-socket-error.js";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app.js";
import {
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  seedAuthenticatedDesktopSession,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud.js";
import {
  type ClaudeTelemetryUpload,
  ClaudeTelemetryUploadKind,
  readClaudeTelemetryWatermarks,
  routeClaudeTelemetrySync,
  seedClaudeDropCounter,
  seedClaudeSessionSignal,
} from "./helpers/claude-code-telemetry-sync-fixture.js";
import {
  gotoNavSettled,
  launchDesktopApp,
  seedDesktopSettings,
} from "./helpers/desktop-app.js";
import {
  branchesDbPath,
  waitForMigrationsApplied,
} from "./helpers/desktop-seed-core.js";
import { evaluateElectronSynchronously } from "./helpers/evaluate-electron-synchronously.js";
import { startAuthenticatedCloudRelay } from "./helpers/fake-cloud-relay.js";
import {
  installOpenExternalSpy,
  openedUrls,
} from "./helpers/open-external-spy.js";
import {
  seedNoPullRequestBranch,
  seedSessionsList,
} from "./helpers/seed-branches-db.js";
import { telemetryClockTest } from "./helpers/telemetry-clock-receipt.js";
import {
  advanceTelemetryCadence,
  launchClockedAuthenticatedDesktopApp,
  requestFirstTelemetryCadenceWhenReady,
  verifyTelemetryClockCompleted,
} from "./helpers/telemetry-private-clock.js";

const PROFILE_ID = "iss-10574-e2e-profile";
const SESSION_ID = "iss-10574-isolated-local-row";
const BRANCH_NAME = "feature/iss-10574-local";
const COLLATED_BRANCH_NAME_PATTERN = /^(alpha|Beta)$/;
// The launched-app assertion pins the rendered copy without importing a TS package subpath.
const LOG_OUT_MENU_LABEL = "Log out";
// The renderer test imports the canonical reason map; this pins its shipping host.
const OFFLINE_INDICATOR_LABEL = "You're offline.";

telemetryClockTest(
  "accountless mode stops cloud work, deletes keys, and keeps the local Sessions row",
  async () => {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss-10574-operating-mode-")
    );
    let releaseRevoke = (): void => undefined;
    let revokePending = false;
    const claudeUploads: ClaudeTelemetryUpload[] = [];
    const bff = await startAuthenticatedBranchCloudServer({
      extraRoutes: (request, response) => {
        const pathname = new URL(request.url ?? "/", "http://127.0.0.1")
          .pathname;
        if (request.method === "GET" && pathname === "/me") {
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              id: AUTHENTICATED_USER_ID,
              organizationId: AUTHENTICATED_ORGANIZATION_ID,
            })
          );
          return true;
        }
        if (request.method === "GET" && pathname === "/desktop/identity") {
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              userId: AUTHENTICATED_USER_ID,
              organizationId: AUTHENTICATED_ORGANIZATION_ID,
              email: "fixture@closedloop.test",
              firstName: "Synthetic",
              lastName: "User",
              organizationName: "Synthetic fixture",
            })
          );
          return true;
        }
        if (routeClaudeTelemetrySync(request, response, claudeUploads)) {
          return true;
        }
        if (
          request.method !== "POST" ||
          pathname !== "/desktop/session/revoke"
        ) {
          return false;
        }
        revokePending = true;
        releaseRevoke = () => {
          if (!response.writableEnded) {
            response.statusCode = 204;
            response.end();
          }
        };
        return true;
      },
    });
    const relay = await startAuthenticatedCloudRelay({
      agentSessionSync: true,
    });
    let launched: Awaited<
      ReturnType<typeof launchAuthenticatedDesktopApp>
    > | null = null;
    try {
      const bootstrap =
        await test.step("launch original credential bootstrap", () =>
          launchAuthenticatedDesktopApp({
            userDataDir,
            env: { CLOSEDLOOP_API_KEY: "" },
          }));
      await installOpenExternalSpy(bootstrap.app);
      let encryptedKey: string;
      try {
        const db = createClient({ url: `file:${branchesDbPath(userDataDir)}` });
        try {
          await test.step("await original migration completion", () =>
            waitForMigrationsApplied(db, 30_000));
        } finally {
          db.close();
        }
        await test.step("seed original authenticated session", () =>
          seedAuthenticatedDesktopSession(bootstrap.app, userDataDir));
        encryptedKey = await bootstrap.app.evaluate(({ safeStorage }) =>
          safeStorage.encryptString("sk_live_iss_10574_e2e").toString("base64")
        );
      } finally {
        try {
          expect((await openedUrls(bootstrap.app)).length).toBe(0);
        } finally {
          await bootstrap.cleanup();
        }
      }
      seedCredentialsAndProfile(
        userDataDir,
        encryptedKey,
        bff.origin,
        relay.origin
      );
      await test.step("seed original local Sessions rows", () =>
        seedSessionsList(userDataDir, [
          {
            sessionId: SESSION_ID,
            name: "ISS-10574 isolated local row",
            status: "inactive",
          },
        ]));
      await test.step("seed original telemetry signal", () =>
        seedClaudeSessionSignal(userDataDir, SESSION_ID));
      await test.step("seed original local branch", () =>
        seedNoPullRequestBranch(userDataDir, {
          sessionId: "iss-10574-local-branch-session",
          repoFullName: "closedloop/iss-10574-fixture",
          branchName: BRANCH_NAME,
          activityAt: "2026-09-21T11:20:00.000Z",
        }));

      for (const [index, branchName] of ["Beta", "alpha"].entries()) {
        await test.step("seed original local branch", () =>
          seedNoPullRequestBranch(
            userDataDir,
            {
              sessionId: `iss-10574-collated-branch-${index}`,
              repoFullName: "closedloop/iss-10574-fixture",
              branchName,
              activityAt: "2026-09-21T11:20:00.000Z",
            },
            { sessionLastActivityAt: "2026-09-21T11:20:00.000Z" }
          ));
      }

      launched =
        await test.step("launch the genuine clocked authenticated subject", () =>
          launchClockedAuthenticatedDesktopApp({
            userDataDir,
            returningInstall: true,
            env: { CLOSEDLOOP_API_KEY: "" },
            beforeLaunch: (profile) =>
              seedDesktopSettings(profile, {
                cloudConnectionEnabled: true,
                cloudCommandsPaused: false,
                dataSyncLevel: DataSyncLevel.Full,
              }),
          }));
      const activeLaunch = launched;
      await installOpenExternalSpy(launched.app);
      const revealSuppressed = await evaluateElectronSynchronously(
        launched.app,
        () => process.argv.includes("--e2e-no-reveal"),
        undefined,
        z.boolean()
      );
      expect(revealSuppressed).toBe(true);
      await test.step("assert the original authenticated or signed-out state", () =>
        expect
          .poll(
            async () =>
              (
                await activeLaunch?.page.evaluate(() =>
                  window.desktopApi.getDesktopAuthState()
                )
              )?.status
          )
          .toBe(DesktopAuthStatus.Authenticated));
      await test.step("assert original relay lifecycle", () =>
        expect
          .poll(() => relay.helloCount(), { timeout: 15_000 })
          .toBeGreaterThan(0));
      const clockedLaunch = launched;
      let firstCadenceRequested = false;
      await test.step("assert original telemetry upload count", () =>
        expect
          .poll(
            async () => {
              if (!firstCadenceRequested) {
                firstCadenceRequested =
                  await requestFirstTelemetryCadenceWhenReady(
                    clockedLaunch.page,
                    clockedLaunch.app
                  );
              }
              return claudeUploads.filter(
                (upload) => upload.kind === ClaudeTelemetryUploadKind.Session
              ).length;
            },
            { timeout: 30_000 }
          )
          .toBe(1));
      await test.step("assert original telemetry watermarks", () =>
        expect
          .poll(
            async () =>
              (await readClaudeTelemetryWatermarks(userDataDir, SESSION_ID))
                .sessionDelivered
          )
          .toBe(true));
      await seedClaudeDropCounter(userDataDir);
      await test.step("advance the owned telemetry cadence", () =>
        advanceTelemetryCadence(activeLaunch.app));
      await test.step("assert original telemetry upload count", () =>
        expect
          .poll(
            () =>
              claudeUploads.filter(
                (upload) =>
                  upload.kind === ClaudeTelemetryUploadKind.CountersOnly
              ).length,
            { timeout: 30_000 }
          )
          .toBe(1));
      await test.step("assert original telemetry watermarks", () =>
        expect
          .poll(
            async () =>
              (await readClaudeTelemetryWatermarks(userDataDir, SESSION_ID))
                .syncedCount
          )
          .toBe(1));
      const offlineStatus = launched.page.locator(
        'header [aria-live="polite"]'
      );
      await test.step("assert original offline indicator", () =>
        expect(offlineStatus).toHaveCount(1));
      await test.step("assert original offline indicator", () =>
        expect(offlineStatus).toBeEmpty());
      await test.step("assert original offline indicator", () =>
        expect(offlineStatus).not.toHaveAttribute("role", "status"));
      await launched.page.context().setOffline(true);
      expect(await launched.page.evaluate(() => navigator.onLine)).toBe(false);
      await test.step("navigate to the original Sessions or Branches surface", () =>
        gotoNavSettled(activeLaunch.page, "sessions"));
      await test.step("assert original local Sessions or Branches UI", () =>
        expect(
          activeLaunch.page.getByRole("link", {
            name: "ISS-10574 isolated local row",
          })
        ).toBeVisible());
      await test.step("navigate to the original Sessions or Branches surface", () =>
        gotoNavSettled(activeLaunch.page, "branches"));
      await launched.page.getByRole("radio", { name: "All time" }).click();
      await test.step("assert original local Sessions or Branches UI", () =>
        expect(
          activeLaunch.page.getByRole("link", {
            name: BRANCH_NAME,
            exact: true,
          })
        ).toBeVisible());
      await test.step("assert original offline indicator", () =>
        expect(offlineStatus).toHaveText(OFFLINE_INDICATOR_LABEL));
      await test.step("assert original offline indicator", () =>
        expect(offlineStatus).toHaveAttribute("role", "status"));
      await test.step("assert original local Sessions or Branches UI", () =>
        expect(
          activeLaunch.page
            .locator(
              '[data-nav-panel="branches"][data-nav-panel-state="active"]'
            )
            .getByRole("link", { name: COLLATED_BRANCH_NAME_PATTERN })
        ).toHaveText(["alpha", "Beta"]));
      await launched.page.context().setOffline(false);
      await test.step("assert original offline indicator", () =>
        expect(offlineStatus).toBeEmpty());
      await test.step("assert original offline indicator", () =>
        expect(offlineStatus).not.toHaveAttribute("role", "status"));
      const beforeSignOutClaudeUploads = claudeUploads.length;
      const beforeRelayConnections = relay.connectionCount();
      const beforeRelayTraffic = relayTraffic(relay);
      const beforeSignOutRequests = bff.requests.length;

      await launched.page
        .getByRole("button", { name: "Open account menu" })
        .click();
      await launched.page
        .getByRole("menuitem", {
          name: LOG_OUT_MENU_LABEL,
        })
        .click();
      await test.step("assert the original authenticated or signed-out state", () =>
        expect
          .poll(
            async () =>
              (
                await activeLaunch?.page.evaluate(() =>
                  window.desktopApi.getDesktopAuthState()
                )
              )?.status
          )
          .toBe(DesktopAuthStatus.SignedOut));
      await test.step("assert original revoke request", () =>
        expect.poll(() => revokePending).toBe(true));
      await test.step("assert original relay lifecycle", () =>
        expect.poll(() => relay.activeConnectionCount()).toBe(0));
      await test.step("assert original idle cloud transport", () =>
        expect
          .poll(() =>
            activeLaunch?.page.evaluate(async () => {
              const status = await (
                window.desktopApi as unknown as DesktopApi
              ).getRuntimeStatus();
              const cloudStatus =
                status && typeof status === "object"
                  ? Reflect.get(status, "cloudStatus")
                  : null;
              return cloudStatus && typeof cloudStatus === "object"
                ? Reflect.get(cloudStatus, "state")
                : null;
            })
          )
          .toBe(CloudSocketState.Idle));

      await test.step("navigate to the original Sessions or Branches surface", () =>
        gotoNavSettled(activeLaunch.page, "sessions"));
      await test.step("assert original local Sessions or Branches UI", () =>
        expect(
          activeLaunch.page.getByRole("link", {
            name: "ISS-10574 isolated local row",
          })
        ).toBeVisible());
      const localList = await launched.page.evaluate(() =>
        (window.desktopApi as unknown as DesktopApi).agentSessionsApi.list({
          quality: "all",
          limit: 25,
        })
      );
      expect(Object.hasOwn(localList, "pendingOutboxAvailable")).toBe(false);
      await test.step("navigate to the original Sessions or Branches surface", () =>
        gotoNavSettled(activeLaunch.page, "branches"));
      await launched.page.getByRole("radio", { name: "All time" }).click();
      await test.step("assert original local Sessions or Branches UI", () =>
        expect(
          activeLaunch.page.getByRole("link", {
            name: BRANCH_NAME,
            exact: true,
          })
        ).toBeVisible());
      await test.step("assert original local Sessions or Branches UI", () =>
        expect(
          activeLaunch.page
            .locator(
              '[data-nav-panel="branches"][data-nav-panel-state="active"]'
            )
            .getByRole("link", { name: COLLATED_BRANCH_NAME_PATTERN })
        ).toHaveText(["alpha", "Beta"]));
      await test.step("assert original relay lifecycle", () =>
        expect
          .poll(() => relay.connectionCount())
          .toBe(beforeRelayConnections));
      relay.offerCommand({
        commandId: "post-sign-out-command",
        path: "/health",
      });
      expect(relayTraffic(relay)).toEqual({
        ...beforeRelayTraffic,
        disconnects: beforeRelayTraffic.disconnects + 1,
      });

      const secretsPath = path.join(userDataDir, "desktop-secrets.json");
      await test.step("assert original credential removal", () =>
        expect
          .poll(() =>
            Object.keys(readJson(secretsPath)).filter(
              (key) => key === "encryptedApiKey" || key.startsWith("profile:")
            )
          )
          .toEqual([]));
      const settings = readJson(
        path.join(userDataDir, "desktop-settings.json")
      );
      expect(settings.cloudConnectionEnabled).toBe(true);
      const savedConfigs = settings.savedConfigs as Record<string, unknown>[];
      expect(savedConfigs[0]?.apiKeySource).toBeUndefined();
      expect(savedConfigs[0]?.gatewayPublicKeyPem).toBeUndefined();

      const revokeIndex = bff.requests.findIndex(
        (request, index) =>
          index >= beforeSignOutRequests &&
          request.method === "POST" &&
          request.pathname === "/desktop/session/revoke"
      );
      expect(revokeIndex).toBeGreaterThanOrEqual(beforeSignOutRequests);
      const postBoundaryRequests = bff.requests.slice(revokeIndex);
      expect(postBoundaryRequests).toEqual([
        expect.objectContaining({
          method: "POST",
          pathname: "/desktop/session/revoke",
        }),
      ]);
      expect(claudeUploads).toHaveLength(beforeSignOutClaudeUploads);
      expect((await openedUrls(launched.app)).length).toBe(0);
      expect(launched.pageErrors).toEqual([]);
      await verifyTelemetryClockCompleted(launched.app);
    } finally {
      releaseRevoke();
      if (launched) {
        await launched.cleanup().catch(() => undefined);
      }
      await Promise.allSettled([bff.close(), relay.close()]);
      const mainLog = path.join(userDataDir, "logs", "main.log");
      if (test.info().status !== "passed" && fs.existsSync(mainLog)) {
        await test.info().attach("desktop-main-log", {
          body: fs.readFileSync(mainLog, "utf8").slice(-20_000),
          contentType: "text/plain",
        });
      }
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }
);

test("a never-signed-in paired guest keeps local Sessions and Branches without cloud commands", async () => {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-10574-never-signed-in-")
  );
  const bff = await startAuthenticatedBranchCloudServer();
  const relay = await startAuthenticatedCloudRelay({ agentSessionSync: true });
  let launched: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    const bootstrap =
      await test.step("launch original credential bootstrap", () =>
        launchAuthenticatedDesktopApp({
          userDataDir,
          env: { CLOSEDLOOP_API_KEY: "" },
        }));
    await installOpenExternalSpy(bootstrap.app);
    let encryptedKey: string;
    try {
      const db = createClient({ url: `file:${branchesDbPath(userDataDir)}` });
      try {
        await test.step("await original migration completion", () =>
          waitForMigrationsApplied(db, 30_000));
      } finally {
        db.close();
      }
      encryptedKey = await bootstrap.app.evaluate(({ safeStorage }) =>
        safeStorage
          .encryptString("sk_live_iss_10574_guest_fixture")
          .toString("base64")
      );
    } finally {
      try {
        expect((await openedUrls(bootstrap.app)).length).toBe(0);
      } finally {
        await bootstrap.cleanup();
      }
    }
    seedCredentialsAndProfile(
      userDataDir,
      encryptedKey,
      bff.origin,
      relay.origin
    );
    await test.step("seed original local Sessions rows", () =>
      seedSessionsList(userDataDir, [
        {
          sessionId: SESSION_ID,
          name: "ISS-10574 isolated local row",
          status: "inactive",
        },
      ]));
    await test.step("seed original local branch", () =>
      seedNoPullRequestBranch(userDataDir, {
        sessionId: "iss-10574-local-branch-session",
        repoFullName: "closedloop/iss-10574-fixture",
        branchName: BRANCH_NAME,
        activityAt: "2026-09-21T11:20:00.000Z",
      }));

    launched = await test.step("launch the genuine paired guest subject", () =>
      launchDesktopApp({
        userDataDir,
        keepUserDataDir: true,
        env: { CLOSEDLOOP_API_KEY: "" },
        beforeLaunch: (profile) =>
          seedDesktopSettings(profile, {
            cloudConnectionEnabled: true,
            cloudCommandsPaused: false,
            dataSyncLevel: DataSyncLevel.Full,
          }),
      }));
    const activeLaunch = launched;
    await installOpenExternalSpy(launched.app);
    expect(
      await launched.app.evaluate(() =>
        process.argv.includes("--e2e-no-reveal")
      )
    ).toBe(true);
    await test.step("assert the original authenticated or signed-out state", () =>
      expect
        .poll(
          async () =>
            (
              await activeLaunch?.page.evaluate(() =>
                window.desktopApi.getDesktopAuthState()
              )
            )?.status
        )
        .toBe(DesktopAuthStatus.SignedOut));
    await test.step("assert original idle cloud transport", () =>
      expect
        .poll(async () =>
          activeLaunch?.page.evaluate(async () => {
            const status = await (
              window.desktopApi as unknown as DesktopApi
            ).getRuntimeStatus();
            const cloudStatus =
              status && typeof status === "object"
                ? Reflect.get(status, "cloudStatus")
                : null;
            return cloudStatus && typeof cloudStatus === "object"
              ? Reflect.get(cloudStatus, "state")
              : null;
          })
        )
        .toBe(CloudSocketState.Idle));
    await test.step("navigate to the original Sessions or Branches surface", () =>
      gotoNavSettled(activeLaunch.page, "sessions"));
    await test.step("assert original local Sessions or Branches UI", () =>
      expect(
        activeLaunch.page.getByRole("link", {
          name: "ISS-10574 isolated local row",
        })
      ).toBeVisible());
    await test.step("navigate to the original Sessions or Branches surface", () =>
      gotoNavSettled(activeLaunch.page, "branches"));
    await launched.page.getByRole("radio", { name: "All time" }).click();
    await test.step("assert original local Sessions or Branches UI", () =>
      expect(
        activeLaunch.page.getByRole("link", { name: BRANCH_NAME, exact: true })
      ).toBeVisible());
    await test.step("assert original offline indicator", () =>
      expect(
        activeLaunch.page.getByRole("status").filter({
          hasText: OFFLINE_INDICATOR_LABEL,
        })
      ).toHaveCount(0));
    expect(relay.connectionCount()).toBe(0);
    expect(relay.helloCount()).toBe(0);
    expect(
      bff.requests.filter(
        (request) =>
          request.pathname === "/users" ||
          request.pathname === "/repositories" ||
          request.pathname.startsWith("/branches") ||
          request.pathname === "/desktop/claude-code-telemetry/sync"
      )
    ).toEqual([]);
    expect(launched.pageErrors).toEqual([]);
    expect((await openedUrls(launched.app)).length).toBe(0);
  } finally {
    if (launched) {
      await launched.cleanup().catch(() => undefined);
    }
    await Promise.allSettled([bff.close(), relay.close()]);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

function seedCredentialsAndProfile(
  userDataDir: string,
  encryptedKey: string,
  apiOrigin: string,
  relayOrigin: string
): void {
  fs.writeFileSync(
    path.join(userDataDir, "desktop-secrets.json"),
    JSON.stringify({
      encryptedApiKey: encryptedKey,
      apiKeyProvenance: "DESKTOP_MANAGED",
      [`profile:${PROFILE_ID}`]: encryptedKey,
      [`profile:${PROFILE_ID}:provenance`]: "DESKTOP_MANAGED",
      "profile:orphan": encryptedKey,
      "profile:orphan:provenance": "USER_CREATED",
    }),
    "utf8"
  );
  const settingsPath = path.join(userDataDir, "desktop-settings.json");
  const settings = readJson(settingsPath);
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      ...settings,
      apiOrigin,
      relayOrigin,
      cloudConnectionEnabled: true,
      activeConfigId: PROFILE_ID,
      savedConfigs: [
        {
          id: PROFILE_ID,
          name: "ISS-10574 E2E",
          apiOrigin,
          relayOrigin,
          webAppOrigin: "http://127.0.0.1:3000",
          apiKeySource: "DESKTOP_MANAGED",
          gatewayId: AUTHENTICATED_GATEWAY_ID,
          gatewayPublicKeyPem: "fixture",
          desktopSecurityUpgradeProtocolVersion: 1,
        },
      ],
    }),
    "utf8"
  );
}

function relayTraffic(
  relay: Awaited<ReturnType<typeof startAuthenticatedCloudRelay>>
) {
  return {
    acknowledgements: relay.ackCount(),
    commands: relay.commandCount(),
    disconnects: relay.disconnectCount(),
    hellos: relay.helloCount(),
    presence: relay.presenceCount(),
  };
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
    string,
    unknown
  >;
}
