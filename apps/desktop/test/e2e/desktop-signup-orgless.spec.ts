import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  DESKTOP_AUTHORIZE_QUERY_PARAMS,
  DESKTOP_BOOTSTRAP_QUERY_PARAM,
  DESKTOP_BOOTSTRAP_TRUE,
} from "@repo/api/src/types/desktop-authorize-url.ts";
import { serializeOnboardingState } from "@repo/api/src/types/onboarding-persistence.ts";
import {
  createInitialOnboardingState,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase.ts";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
  desktopGuestGuidedOnboardingStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import { gotoNav, seedDesktopSettings } from "./helpers/desktop-app";
import {
  installOpenExternalSpy,
  openedUrls,
} from "./helpers/open-external-spy";
import {
  CREATED_ORGANIZATION_ID,
  ORGLESS_USER_ID,
  startOrglessBootstrapCloud,
} from "./helpers/orgless-bootstrap-cloud";

test("orgless callback resumes organization setup across reload and persists an org-bound session", async ({
  playwright: _playwright,
}, testInfo) => {
  test.setTimeout(180_000);
  const cloud = await startOrglessBootstrapCloud();
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss11826-orgless-")
  );
  const launched = await launchAuthenticatedDesktopApp({
    userDataDir,
    beforeLaunch: (directory) =>
      seedDesktopSettings(directory, {
        apiOrigin: cloud.origin,
        relayOrigin: "http://127.0.0.1:9",
        webAppOrigin: "http://localhost:3000",
        cloudConnectionEnabled: true,
        activeConfigId: "orgless-e2e",
        savedConfigs: [
          {
            id: "orgless-e2e",
            name: "Orgless E2E",
            apiOrigin: cloud.origin,
            webAppOrigin: "http://localhost:3000",
            relayOrigin: "http://127.0.0.1:9",
          },
        ],
      }),
  });
  let diagnostics = "";
  launched.app.process().stdout?.on("data", (chunk) => {
    diagnostics += String(chunk);
  });
  launched.app.process().stderr?.on("data", (chunk) => {
    diagnostics += String(chunk);
  });
  try {
    expect(
      JSON.parse(
        fs.readFileSync(path.join(userDataDir, "desktop-settings.json"), "utf8")
      ).apiOrigin
    ).toBe(cloud.origin);
    await gotoNav(launched.page, "dashboard");
    await launched.page.evaluate(
      ({ keys, state }) => {
        localStorage.setItem(keys.tour, "1");
        localStorage.removeItem(keys.onboarded);
        localStorage.setItem(keys.run, JSON.stringify({ revision: 2, state }));
      },
      {
        keys: {
          tour: dashboardTourSeenStorageKey,
          onboarded: dashboardOnboardedStorageKey,
          run: desktopGuestGuidedOnboardingStorageKey,
        },
        state: serializeOnboardingState({
          ...createInitialOnboardingState(),
          phase: OnboardingPhase.Account,
          history: [OnboardingPhase.Welcome, OnboardingPhase.SessionDiscovery],
        }),
      }
    );
    await launched.page.reload();
    await installOpenExternalSpy(launched.app);
    await launched.page
      .getByPlaceholder("you@company.com")
      .fill("orgless+clerk_test@closedloop.ai");
    await launched.page
      .getByRole("button", { name: "Create account with email", exact: true })
      .click();
    await expect.poll(() => openedUrls(launched.app)).toHaveLength(1);
    const authorize = new URL((await openedUrls(launched.app))[0]);
    const callback = new URL(
      authorize.searchParams.get(DESKTOP_AUTHORIZE_QUERY_PARAMS.redirectUri)!
    );
    callback.searchParams.set(
      "state",
      authorize.searchParams.get(DESKTOP_AUTHORIZE_QUERY_PARAMS.state)!
    );
    callback.searchParams.set("code", "orgless-e2e-code");
    callback.searchParams.set(
      DESKTOP_BOOTSTRAP_QUERY_PARAM,
      DESKTOP_BOOTSTRAP_TRUE
    );
    const response = await fetch(callback);
    expect(response.ok).toBe(true);
    const create = launched.page.getByRole("button", {
      name: "Create organization",
      exact: true,
    });
    await expect(create).toBeVisible({ timeout: 30_000 });
    await launched.page.reload();
    await expect(create).toBeVisible({ timeout: 30_000 });
    const record = await launched.page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      desktopGuestGuidedOnboardingStorageKey
    );
    expect(record.state.phase).toBe(OnboardingPhase.CreateOrganization);
    await launched.page.getByLabel("Name", { exact: true }).fill("Orgless E2E");
    await launched.page.getByLabel("Slug", { exact: true }).fill("orgless-e2e");
    const logoData =
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAJklEQVR4nGN4hgTkkAAucYZBqIEYRcjig1ED7UOJ9hpoH0o01wAAVguGEIh6FC8AAAAASUVORK5CYII=";
    await launched.page.getByLabel("Organization logo file").setInputFiles({
      name: "logo.png",
      mimeType: "image/png",
      buffer: Buffer.from(logoData, "base64"),
    });
    const preview = launched.page.getByRole("img", {
      name: "Organization logo",
      exact: true,
    });
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute(
      "src",
      `data:image/png;base64,${logoData}`
    );
    expect(cloud.organizationRequests).toHaveLength(0);
    await launched.page.screenshot({
      path: testInfo.outputPath("logo-before-creation.png"),
    });
    await launched.page.getByLabel("Organization logo file").setInputFiles({
      name: "invalid.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("invalid"),
    });
    await expect(preview).toHaveCount(0);
    await create.click();
    await expect
      .poll(() => cloud.organizationRequests)
      .toEqual([
        {
          authorization: "Bearer orgless-e2e-bootstrap",
          body: { name: "Orgless E2E", slug: "orgless-e2e" },
        },
      ]);
    await expect
      .poll(() => ({
        phase: cloud.snapshot().state.phase,
        errors: launched.pageErrors.map((error) => error.message),
        requests: cloud.requests.filter((request) =>
          request.includes("onboarding")
        ),
      }))
      .toMatchObject({ phase: OnboardingPhase.SyncPolicy, errors: [] });
    const encrypted = JSON.parse(
      fs.readFileSync(path.join(userDataDir, "desktop-session.json"), "utf8")
    ).encryptedSession;
    const stored = await launched.app.evaluate(
      ({ safeStorage }, value) =>
        JSON.parse(safeStorage.decryptString(Buffer.from(value, "base64"))),
      encrypted
    );
    expect(stored).toMatchObject({
      userId: ORGLESS_USER_ID,
      organizationId: CREATED_ORGANIZATION_ID,
      refreshToken: "orgless-e2e-refresh",
    });
    await launched.page.reload();
    await expect(create).toBeHidden();
    expect(cloud.snapshot().state.phase).toBe(OnboardingPhase.SyncPolicy);
  } finally {
    await testInfo.attach("bootstrap-diagnostics", {
      body: diagnostics,
      contentType: "text/plain",
    });
    await testInfo.attach("cloud-requests", {
      body: JSON.stringify(cloud.requests),
      contentType: "application/json",
    });
    await launched.cleanup();
    await cloud.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
