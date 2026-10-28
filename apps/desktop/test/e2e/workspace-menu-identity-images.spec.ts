/**
 * ISS-11465 — the organization logo and the user avatar, through the LAUNCHED
 * app.
 *
 * WHY THIS EXISTS AND THE RENDERER SUITE DOES NOT COVER IT. The adapter and
 * provider suites call the projection directly: they prove the arithmetic and
 * they fake the identity. The defect was that two hardcoded `imageUrl: null`s
 * sat between a server that had the values and a menu that renders them, and
 * the chain in between — `GET /desktop/identity`, the main-process schema, the
 * IPC bridge, the renderer mount, and the packaged CSP that adjudicates an
 * `<img>` load — is exactly what a mounted render test cannot reach. Every one
 * of those links is live here.
 *
 * WHY `data:` IMAGES. `img-src` admits `data:` alongside the one Clerk host, so
 * a data URI paints in the packaged renderer with no network at all. A real
 * `https://img.clerk.com` source would make this spec depend on a live fetch,
 * which is flaky in CI and offline everywhere else; that the policy admits that
 * host is already pinned by `content-security-policy-avatar-origin.spec.ts`.
 *
 * TWO CASES, AND THE SECOND IS THE POSITIVE/NEGATIVE PAIR. The first pins both
 * images rendered. The second hands the SAME menu a user avatar on an origin
 * the policy refuses while the organization logo stays admitted: the logo must
 * still paint (so the absence below cannot be a locator that resolves to
 * nothing) and the avatar must fall back to its initial rather than to a
 * mounted `<img>` painting a hole.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
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
import { WORKSPACE_MENU_TRIGGER_LABEL } from "@repo/api/src/types/workspace-menu.ts";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  closeServer,
  createAuthenticatedDesktopSessionRecord,
  rejectNotFound,
  rejectUnauthorized,
  routeDesktopSessionRefresh,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoHash,
  seedDesktopSettings,
} from "./helpers/desktop-app";

const SPEC_TIMEOUT_MS = 180_000;
const STEP_BUDGET_MS = 30_000;
const PROFILE_ID = "iss-11465-identity-images-profile";
const HEADER_REGION = '[data-sidebar="header"]';
const IDENTITY_EMAIL = "ada@closedloop.ai";

/** An 8x8 blue square, and an 8x8 red disc — distinct so one cannot stand in for the other. */
const ORGANIZATION_LOGO_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPjxyZWN0IHdpZHRoPSI4IiBoZWlnaHQ9IjgiIGZpbGw9IiMxZDRlZDgiLz48L3N2Zz4=";
const USER_AVATAR_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPjxjaXJjbGUgY3g9IjQiIGN5PSI0IiByPSI0IiBmaWxsPSIjYjkxYzFjIi8+PC9zdmc+";
/**
 * An avatar origin `img-src` does NOT admit. `User.avatarUrl` is whatever
 * `PUT /users/:id` accepted, so this is a shape the real server can emit —
 * not a hypothetical.
 */
const REFUSED_AVATAR_URL = "https://avatars.iss-11465.invalid/ada.png";

test("renders the organization logo and the user avatar in the launched desktop menu", async () => {
  test.setTimeout(SPEC_TIMEOUT_MS);
  const server = await startIdentityCloudServer({
    organizationImageUrl: ORGANIZATION_LOGO_URL,
    userImageUrl: USER_AVATAR_URL,
  });
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-identity-images-e2e-")
  );
  try {
    const { page, pageErrors, cleanup } = await launchIdentityDesktop({
      apiOrigin: server.origin,
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      userDataDir,
    });
    try {
      await gotoHash(page, "/dashboard");

      const trigger = page
        .locator(HEADER_REGION)
        .getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL });
      await expect(trigger).toBeVisible({ timeout: STEP_BUDGET_MS });

      // THE REGRESSION, half one. The adapter hardcoded `imageUrl: null` here,
      // so the trigger showed a bare initial and no `<img>` existed at all.
      await expect(trigger.locator("img")).toHaveAttribute(
        "src",
        ORGANIZATION_LOGO_URL,
        { timeout: STEP_BUDGET_MS }
      );

      await trigger.click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible({ timeout: STEP_BUDGET_MS });
      // The READY arm, not the guest one.
      await expect(menu.getByText(IDENTITY_EMAIL)).toBeVisible();

      // THE REGRESSION, half two — and the half `actor.imageUrl` had no render
      // site for at all: the value reached the projection and the menu dropped
      // it, so the user avatar appeared nowhere.
      await expect(menu.locator("img")).toHaveAttribute(
        "src",
        USER_AVATAR_URL,
        { timeout: STEP_BUDGET_MS }
      );

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await closeServer(server.server);
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
});

test("falls back to the initial for an avatar origin the packaged policy refuses", async () => {
  test.setTimeout(SPEC_TIMEOUT_MS);
  const server = await startIdentityCloudServer({
    organizationImageUrl: ORGANIZATION_LOGO_URL,
    userImageUrl: REFUSED_AVATAR_URL,
  });
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-identity-refused-avatar-e2e-")
  );
  try {
    const { page, cleanup } = await launchIdentityDesktop({
      apiOrigin: server.origin,
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      userDataDir,
    });
    try {
      await gotoHash(page, "/dashboard");

      const trigger = page
        .locator(HEADER_REGION)
        .getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL });
      await expect(trigger).toBeVisible({ timeout: STEP_BUDGET_MS });
      // THE PRESENCE HALF, on the same render: an admitted source still paints,
      // so the absence asserted below is about the refused origin and not about
      // a menu that renders no images at all.
      await expect(trigger.locator("img")).toHaveAttribute(
        "src",
        ORGANIZATION_LOGO_URL,
        { timeout: STEP_BUDGET_MS }
      );

      await trigger.click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible({ timeout: STEP_BUDGET_MS });
      await expect(menu.getByText(IDENTITY_EMAIL)).toBeVisible();

      // No mounted `<img>` pointing at a source the renderer may not load: a
      // refused source paints nothing and leaves no fallback behind it, which
      // is a blank where an initial belongs.
      await expect(
        menu.locator(`img[src="${REFUSED_AVATAR_URL}"]`)
      ).toHaveCount(0);
      await expect(menu.locator("img")).toHaveCount(0);
    } finally {
      await cleanup();
    }
  } finally {
    await closeServer(server.server);
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
});

async function launchIdentityDesktop({
  apiOrigin,
  sameProcessSessionSeed,
  userDataDir,
}: {
  apiOrigin: string;
  sameProcessSessionSeed?: ReturnType<
    typeof createAuthenticatedDesktopSessionRecord
  >;
  userDataDir: string;
}) {
  return await launchAuthenticatedDesktopApp({
    sameProcessSessionSeed,
    env: { CL_AUTH_API_ORIGIN: apiOrigin },
    beforeLaunch: (launchUserDataDir) => {
      seedDesktopSettings(launchUserDataDir, {
        activeConfigId: PROFILE_ID,
        apiOrigin,
        cloudConnectionEnabled: true,
        savedConfigs: [
          {
            apiOrigin,
            gatewayId: AUTHENTICATED_GATEWAY_ID,
            id: PROFILE_ID,
            name: "ISS-11465 Identity Images E2E",
            relayOrigin: "http://127.0.0.1:9",
            webAppOrigin: "http://127.0.0.1:3000",
          },
        ],
      });
    },
    cloudReadReadiness: drainedCloudReadReadiness(),
    userDataDir,
  });
}

/**
 * A stand-in cloud that mints the first-party session and answers the identity
 * read with the images this spec is about.
 */
async function startIdentityCloudServer(images: {
  organizationImageUrl: string;
  userImageUrl: string;
}): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    if (routeDesktopSessionRefresh(request, response)) {
      return;
    }
    if (!routeDesktopIdentity(request, response, images)) {
      rejectNotFound(response);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Desktop identity stand-in did not bind.");
  }
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

function routeDesktopIdentity(
  request: IncomingMessage,
  response: ServerResponse,
  images: { organizationImageUrl: string; userImageUrl: string }
): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "GET" || url.pathname !== "/desktop/identity") {
    return false;
  }
  if (
    request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
  ) {
    rejectUnauthorized(response);
    return true;
  }
  writeApiResult(response, {
    email: IDENTITY_EMAIL,
    firstName: "Ada",
    lastName: "Lovelace",
    organizationId: AUTHENTICATED_ORGANIZATION_ID,
    organizationImageUrl: images.organizationImageUrl,
    organizationName: "Closedloop",
    organizationSlug: "closedloop",
    userId: AUTHENTICATED_USER_ID,
    userImageUrl: images.userImageUrl,
  });
  return true;
}
