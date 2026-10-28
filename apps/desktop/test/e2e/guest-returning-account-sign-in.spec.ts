import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { expect, test } from "@playwright/test";
import {
  DESKTOP_AUTHORIZE_QUERY_PARAMS,
  DesktopSignInFraming,
  DesktopSignInMethod,
} from "@repo/api/src/types/desktop-authorize-url.ts";
import { SESSION_STATUS } from "@repo/api/src/types/session-status.ts";
import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WORKSPACE_MENU_TRIGGER_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu.ts";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  createAuthenticatedDesktopSessionRecord,
  startAuthenticatedBranchCloudServer,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import { gotoHash, seedDesktopSettings } from "./helpers/desktop-app";
import { branchesDbPath } from "./helpers/desktop-seed-core";
import { seedSessionsList } from "./helpers/seed-branches-db";

const signInLabel = WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.SignIn];
const createAccountLabel =
  WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.CreateAccount];
const sessionId = "iss-12475-local-session";
const capturedUrlKey = "__iss12475AuthorizeUrl";

// Real renderer, IPC, logout, loopback and token exchange. Only browser auth
// and cloud responses are fixtures; no external browser or account is changed.
test("ISS-12475: both guest entries sign back in and retain local sessions", async () => {
  test.setTimeout(180_000);
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-12475-sign-in-")
  );
  const session = createAuthenticatedDesktopSessionRecord();
  const server = await startAuthenticatedBranchCloudServer({
    extraRoutes: (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/desktop/identity") {
        writeApiResult(response, {
          userId: AUTHENTICATED_USER_ID,
          organizationId: AUTHENTICATED_ORGANIZATION_ID,
          email: "returning@example.test",
          firstName: "Returning",
          lastName: null,
          organizationName: "Existing workspace",
        });
        return true;
      }
      if (pathname === "/desktop/authorize/token") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            ...session,
            accessToken: AUTHENTICATED_ACCESS_TOKEN,
            accessTokenExpiresAt: session.refreshTokenExpiresAt,
          })
        );
        return true;
      }
      return false;
    },
  });

  try {
    const launched = await launchAuthenticatedDesktopApp({
      userDataDir,
      returningInstall: true,
      sameProcessSessionSeed: session,
      env: { CL_AUTH_API_ORIGIN: server.origin },
      beforeLaunch: (profile) =>
        seedDesktopSettings(profile, {
          activeConfigId: "iss-12475",
          apiOrigin: server.origin,
          cloudConnectionEnabled: true,
          savedConfigs: [
            {
              id: "iss-12475",
              name: "ISS-12475",
              apiOrigin: server.origin,
              gatewayId: AUTHENTICATED_GATEWAY_ID,
              relayOrigin: "http://127.0.0.1:9",
              webAppOrigin: "http://127.0.0.1:3000",
            },
          ],
        }),
    });
    const db = createClient({ url: `file:${branchesDbPath(userDataDir)}` });
    try {
      const { app, page } = launched;
      await gotoHash(page, "/dashboard");
      await seedSessionsList(userDataDir, [
        { sessionId, status: SESSION_STATUS.INACTIVE },
      ]);
      await app.evaluate(({ shell }, key) => {
        shell.openExternal = (url) => {
          Reflect.set(globalThis, key, url);
          return Promise.resolve();
        };
      }, capturedUrlKey);

      for (const entry of ["menu", "getting-started"]) {
        const trigger = page.getByRole("button", {
          name: WORKSPACE_MENU_TRIGGER_LABEL,
        });
        await expect(trigger).toContainText("Existing workspace", {
          timeout: 30_000,
        });
        await trigger.click();
        await page
          .getByRole("menuitem", {
            name: WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.LogOut],
            exact: true,
          })
          .click();
        await expect(trigger).toContainText("Guest");
        await page.keyboard.press("Escape");

        if (entry === "menu") {
          await trigger.click();
          const menu = page.getByRole("menu");
          await expect(
            menu.getByRole("menuitem", {
              name: createAccountLabel,
              exact: true,
            })
          ).toBeVisible();
          await menu
            .getByRole("menuitem", { name: signInLabel, exact: true })
            .click();
        } else {
          const card = page.locator("[data-guided-getting-started]");
          await expect(
            card.getByRole("button", { name: createAccountLabel, exact: true })
          ).toBeVisible();
          await card
            .getByRole("button", { name: signInLabel, exact: true })
            .click();
        }
        // No Create account takeover is entered by either returning-user action.
        await expect(page.getByRole("dialog")).toHaveCount(0);
        const openedUrl = () =>
          app.evaluate(
            (_electron, key) =>
              Reflect.get(globalThis, key) as string | undefined,
            capturedUrlKey
          );
        await expect.poll(openedUrl).toBeTruthy();
        const authorize = new URL((await openedUrl())!);
        expect(
          authorize.searchParams.get(DESKTOP_AUTHORIZE_QUERY_PARAMS.provider)
        ).toBe(DesktopSignInMethod.Email);
        expect(
          authorize.searchParams.get(DESKTOP_AUTHORIZE_QUERY_PARAMS.framing)
        ).toBe(DesktopSignInFraming.SignIn);
        const callback = new URL(
          authorize.searchParams.get(
            DESKTOP_AUTHORIZE_QUERY_PARAMS.redirectUri
          )!
        );
        callback.searchParams.set(
          "state",
          authorize.searchParams.get(DESKTOP_AUTHORIZE_QUERY_PARAMS.state)!
        );
        callback.searchParams.set("code", "existing-email-account-code");
        await fetch(callback);
        await expect
          .poll(() =>
            page.evaluate(() => window.desktopApi.getDesktopAuthState())
          )
          .toMatchObject({
            status: DesktopAuthStatus.Authenticated,
            userId: AUTHENTICATED_USER_ID,
          });
        const retained = await db.execute({
          sql: "SELECT id FROM sessions WHERE id = ?",
          args: [sessionId],
        });
        expect(retained.rows.map((row) => row.id)).toEqual([sessionId]);
        await app.evaluate(
          (_electron, key) => Reflect.deleteProperty(globalThis, key),
          capturedUrlKey
        );
      }
    } finally {
      db.close();
      await launched.cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
