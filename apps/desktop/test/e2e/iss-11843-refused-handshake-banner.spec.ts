import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { expect, test } from "@playwright/test";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level.ts";
import type { DesktopApi } from "../../src/renderer/types/desktop-api";
import {
  CloudSocketDegradedReason,
  CloudSocketError,
} from "../../src/shared/cloud-socket-error.js";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app.js";
import {
  AUTHENTICATED_GATEWAY_ID,
  seedAuthenticatedDesktopSession,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud.js";
import { seedDesktopSettings } from "./helpers/desktop-app.js";
import {
  branchesDbPath,
  waitForMigrationsApplied,
} from "./helpers/desktop-seed-core.js";
import { startHelloMuteCloseRelay } from "./helpers/fake-cloud-relay.js";

const PROFILE_ID = "iss-11843-e2e-profile";
// The banner's button label; the renderer suite pins the component's copy.
const SIGN_IN_BUTTON_LABEL = "Sign in";
// `HELLO_REJECTED_WITHOUT_REASON_TERMINAL_THRESHOLD` in cloud-socket.ts; main
// modules cannot be imported into a spec (test/AGENTS.md, Import hazard).
const TERMINAL_MUTE_CLOSES = 3;

test("a handshake the relay closes without a nack reaches the session banner", async () => {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-11843-refused-handshake-")
  );
  const bff = await startAuthenticatedBranchCloudServer();
  const relay = await startHelloMuteCloseRelay();
  let launched: Awaited<
    ReturnType<typeof launchAuthenticatedDesktopApp>
  > | null = null;
  try {
    const bootstrap = await launchAuthenticatedDesktopApp({
      userDataDir,
      env: { CLOSEDLOOP_API_KEY: "" },
    });
    let encryptedKey: string;
    try {
      const db = createClient({ url: `file:${branchesDbPath(userDataDir)}` });
      try {
        await waitForMigrationsApplied(db, 30_000);
      } finally {
        db.close();
      }
      await seedAuthenticatedDesktopSession(bootstrap.app, userDataDir);
      encryptedKey = await bootstrap.app.evaluate(({ safeStorage }) =>
        safeStorage.encryptString("sk_live_iss_11843_e2e").toString("base64")
      );
    } finally {
      await bootstrap.cleanup();
    }
    expect(relay.helloCount()).toBe(0);
    seedCredentialsAndProfile(
      userDataDir,
      encryptedKey,
      bff.origin,
      relay.origin
    );

    launched = await launchAuthenticatedDesktopApp({
      userDataDir,
      env: { CLOSEDLOOP_API_KEY: "" },
      beforeLaunch: (profile) =>
        seedDesktopSettings(profile, {
          cloudConnectionEnabled: true,
          cloudCommandsPaused: false,
          dataSyncLevel: DataSyncLevel.Full,
        }),
    });
    const page = launched.page;
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.desktopApi.getDesktopAuthState()))
            .status
      )
      .toBe(DesktopAuthStatus.Authenticated);

    const banner = page
      .getByRole("status")
      .filter({ hasText: CloudSocketError.HandshakeRefused });
    await expect(banner).toBeVisible({ timeout: 30_000 });
    expect(relay.helloCount()).toBeGreaterThanOrEqual(TERMINAL_MUTE_CLOSES);
    await expect(
      banner.getByRole("button", { name: SIGN_IN_BUTTON_LABEL, exact: true })
    ).toBeVisible();

    // The status the banner rendered from is the one main published over
    // runtime-status IPC, and main stopped dialing when it published it.
    const cloudStatus = await page.evaluate(async () => {
      const status = await (
        window.desktopApi as unknown as DesktopApi
      ).getRuntimeStatus();
      return status && typeof status === "object"
        ? Reflect.get(status, "cloudStatus")
        : null;
    });
    expect(cloudStatus).toMatchObject({
      error: CloudSocketError.HandshakeRefused,
      reason: CloudSocketDegradedReason.HandshakeRefused,
    });
    await expect.poll(() => relay.activeConnectionCount()).toBe(0);
    expect(launched.pageErrors).toEqual([]);
  } finally {
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
    }),
    "utf8"
  );
  const settingsPath = path.join(userDataDir, "desktop-settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<
    string,
    unknown
  >;
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
          name: "ISS-11843 E2E",
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
