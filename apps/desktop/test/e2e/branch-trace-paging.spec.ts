import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { BRANCH_ID } from "../../../../e2e/helpers/branch-details-comprehensive-data";
import {
  createPagedTraceFixture,
  lastPagedTraceText,
  tracePageCursor,
} from "../../../../e2e/helpers/branch-trace-paging-fixture";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  seedAuthenticatedDesktopSession,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoHash,
  seedDesktopSettings,
} from "./helpers/desktop-app";

for (const failsLaterPage of [false, true]) {
  test(
    failsLaterPage
      ? "retries a failed Desktop branch trace cursor without passive retry loops"
      : "pages the authenticated branch trace through the Desktop transport",
    async () => {
      test.setTimeout(180_000);
      const userDataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "branch-trace-paging-")
      );
      const fixture = createPagedTraceFixture();
      let unavailable = failsLaterPage;
      const server = await startAuthenticatedBranchCloudServer({
        traceFactory: fixture.next,
        extraRoutes: (request, response) => {
          const url = new URL(request.url ?? "/", "http://localhost");
          if (
            unavailable &&
            url.pathname === `/branches/${BRANCH_ID}/trace` &&
            url.searchParams.has("cursor")
          ) {
            response.statusCode = 500;
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({ error: "Failed to fetch branch trace" })
            );
            return true;
          }
          return false;
        },
      });
      try {
        const seed = await launchAuthenticatedDesktopApp({ userDataDir });
        try {
          await seedAuthenticatedDesktopSession(seed.app, userDataDir);
        } finally {
          await seed.cleanup();
        }
        const { page, cleanup } = await launchAuthenticatedDesktopApp({
          userDataDir,
          cloudReadReadiness: drainedCloudReadReadiness(),
          env: { CL_AUTH_API_ORIGIN: server.origin },
          beforeLaunch: (directory) =>
            seedDesktopSettings(directory, {
              activeConfigId: "branch-trace-paging",
              apiOrigin: server.origin,
              cloudConnectionEnabled: true,
              savedConfigs: [
                {
                  id: "branch-trace-paging",
                  name: "Branch trace paging",
                  apiOrigin: server.origin,
                  gatewayId: AUTHENTICATED_GATEWAY_ID,
                  relayOrigin: "http://127.0.0.1:9",
                  webAppOrigin: "http://127.0.0.1:3000",
                },
              ],
            }),
        });
        try {
          await expect
            .poll(() =>
              page.evaluate(() => window.desktopApi.getDesktopAuthState())
            )
            .toMatchObject({
              status: DesktopAuthStatus.Authenticated,
              organizationId: AUTHENTICATED_ORGANIZATION_ID,
            });
          await gotoHash(page, `/branches/${BRANCH_ID}`);
          await page.getByRole("tab", { name: "Sessions & timeline" }).click();
          await expect(
            page.getByText("Paged trace row 1", { exact: true })
          ).toBeVisible();
          const traceReads = () =>
            server.requests.filter(
              (request) => request.pathname === `/branches/${BRANCH_ID}/trace`
            );
          expect(traceReads().map((request) => request.search)).toEqual([
            "?pageMode=cursor&limit=100",
          ]);
          const scroller = page.locator(".sd3-scroll.bq-page-scroll");
          await scroller.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          if (failsLaterPage) {
            const retry = page.getByRole("button", {
              name: "Retry",
              exact: true,
            });
            await expect(retry).toBeVisible();
            expect(
              await retry.evaluate(
                (button) => button.scrollWidth <= button.clientWidth
              )
            ).toBe(true);
            const failedReads = traceReads().length;
            await scroller.evaluate(async (element) => {
              element.dispatchEvent(new Event("scroll"));
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve())
                )
              );
            });
            expect(traceReads().length).toBe(failedReads);
            await retry.scrollIntoViewIfNeeded();
            await expect(retry).toBeInViewport();
            await page.screenshot({
              path: path.resolve(
                "../../.local/implement/ISS-12281/cursor-retry-desktop-error.png"
              ),
            });
            unavailable = false;
            await retry.click();
            await expect(retry).not.toBeVisible();
            expect(traceReads().length).toBe(failedReads + 1);
          } else {
            await expect.poll(() => traceReads().length).toBe(2);
          }
          expect(
            new URLSearchParams(traceReads()[1]?.search).get("cursor")
          ).toBe(tracePageCursor);
          await scroller.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          await expect(
            page.getByText(lastPagedTraceText, { exact: true })
          ).toBeVisible();
        } finally {
          await cleanup();
        }
      } finally {
        await server.close();
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
    }
  );
}
