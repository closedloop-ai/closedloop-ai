/**
 * ISS-10362 — the invite entry's move, through the LAUNCHED app.
 *
 * SIGNED IN, and that is the load-bearing part. `settings-v2-modal.spec.ts`
 * walks this same menu but every profile it launches is signed out, so it can
 * only ever see the GUEST arm — and a guest is precisely the case this change
 * leaves alone (no organization to invite into, so the menu withholds the row
 * and the footer keeps the signup door). The entry under test exists only for
 * an identity, so proving the move needs a session: this spec stands up the same
 * first-party one the authenticated Branch specs use, plus a stand-in cloud that
 * answers `GET /desktop/identity` so the menu resolves its READY arm instead of
 * the guest one.
 *
 * What only a booted Electron app can prove is the chain assignment file → main
 * → IPC → renderer flag provider → menu, and that with the key on the invite
 * affordance is in the menu and NOT also in the sidebar footer. The renderer
 * suites either side of it (`sidebar-workspace-experience.test.tsx`,
 * `workspace-menu.test.tsx`) fake both the identity and the assignment.
 *
 * The seeded assignment stands in for the PostHog assignment
 * `DesktopFeatureFlagProvider` resolves. There is no desktop registry entry to
 * add beside it and no desktop Labs toggle to pair with the key.
 *
 * ISS-11247 added the SECOND case below, and the two are a pair: the first pins
 * where the entry goes when the menu can hold it, the second where it stays when
 * the menu cannot. Splitting them across files is how the footer and the menu
 * came to disagree about the same question in the first place, so they share one
 * launcher and one flag seed and differ only in what the stand-in cloud answers
 * for `GET /desktop/identity`.
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
import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WORKSPACE_MENU_TRIGGER_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu.ts";
import { WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY } from "@repo/api/src/types/workspace-menu-invite-entry-flag.ts";
import { DESKTOP_SIDEBAR_INVITE_LABEL } from "../../src/shared/invite-copy";
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
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./helpers/desktop-app";

const SPEC_TIMEOUT_MS = 180_000;
const STEP_BUDGET_MS = 30_000;
const PROFILE_ID = "iss-10362-invite-entry-profile";
const HEADER_REGION = '[data-sidebar="header"]';
const FOOTER_REGION = '[data-sidebar="footer"]';
/**
 * The arrival nudge's anchor wrapper and its pop-up, by STRUCTURE rather than by
 * copy: the nudge's primary action reads the same words as the footer row it
 * points at, so a text locator cannot tell "the row" from "the nudge's button
 * for the row" — and the invariant under test is about how many HOSTS claim the
 * anchor, which no wording states.
 */
const ANCHOR_SELECTOR = '[data-slot="popover-anchor"]';
const NUDGE_SELECTOR = '[data-slot="popover-content"]';
/**
 * The dialog's OWN title (ISS-5489), held here as a literal on purpose: this is
 * a PRESENCE assertion, which fails loudly when the words move, so a copy of
 * them cannot go quietly stale. The footer row's label is NOT this string — it
 * is {@link DESKTOP_SIDEBAR_INVITE_LABEL}, imported so the absence assertion
 * follows the footer button when it is reworded rather than matching nothing
 * and passing.
 */
const INVITE_DIALOG_TITLE = "Invite your team";
const IDENTITY_EMAIL = "ada@closedloop.ai";

test("moves the invite entry into the workspace menu on a signed-in desktop", async () => {
  test.setTimeout(SPEC_TIMEOUT_MS);
  const server = await startIdentityCloudServer();
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-invite-entry-e2e-")
  );
  try {
    const { page, pageErrors, cleanup } = await launchWithInviteEntry({
      apiOrigin: server.origin,
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      userDataDir,
    });
    try {
      await gotoHash(page, "/dashboard");

      // The REGION half of the absence assertion below is pinned live first, so
      // a selector that matches nothing anywhere cannot masquerade as a pass.
      // The LABEL half is pinned by construction: it is the same constant the
      // footer button renders, so rewording that button moves this assertion
      // with it instead of leaving it matching nothing.
      const footer = page.locator(FOOTER_REGION);
      await expect(footer).toBeVisible({ timeout: STEP_BUDGET_MS });

      // The premise: the footer no longer carries an invite affordance. Asserted
      // BEFORE the menu is opened, so this cannot pass on a dialog that happens
      // to be mounted elsewhere.
      await expect(
        footer.getByRole("button", { name: DESKTOP_SIDEBAR_INVITE_LABEL })
      ).toHaveCount(0);

      const trigger = page
        .locator(HEADER_REGION)
        .getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL });
      await expect(trigger).toBeVisible({ timeout: STEP_BUDGET_MS });
      await trigger.click();

      // ISS-10362: the arrival nudge is up on this profile and points AT this
      // trigger, so the click that opens the menu is also the outside-click that
      // answers the nudge. While `InviteSpotlightPopover` swapped its own tree
      // on that answer, the menu remounted and closed in the same tick it
      // opened — the first click did nothing at all. That is what this step
      // pins, not merely that a dropdown can be opened.
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible({ timeout: STEP_BUDGET_MS });
      // The READY arm, not the guest one — the guest menu projects no invite
      // entry at all, so a guest render would satisfy the footer assertion above
      // for entirely the wrong reason.
      await expect(menu.getByText(IDENTITY_EMAIL)).toBeVisible();
      const inviteItem = menu.getByRole("menuitem", {
        exact: true,
        name: WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Invite],
      });
      await expect(inviteItem).toBeVisible();
      // Invite, NOT manage: Members is unreachable on this host and must not
      // arrive with the row.
      await expect(
        menu.getByText(WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Members])
      ).toHaveCount(0);

      await inviteItem.click();

      // Selecting the row closes the menu, which unmounts that subtree — so the
      // dialog surviving is the whole reason it is a sibling of the row rather
      // than a child of it.
      await expect(
        page.getByRole("dialog", { name: INVITE_DIALOG_TITLE })
      ).toBeVisible({ timeout: STEP_BUDGET_MS });
      await expect(menu).toHaveCount(0);

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await closeServer(server.server);
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
});

test("keeps a reachable footer invite row when the workspace menu cannot hold the entry", async () => {
  test.setTimeout(SPEC_TIMEOUT_MS);
  // ISS-11247 — the standing the operator actually landed in: "invite friends on
  // desktop fucks up after I sign-in to an existing account". Same key, same
  // launcher, same profile shape as the case above; the ONLY difference is that
  // this stand-in cloud refuses the identity read. `useDesktopIdentity` settles
  // any failed read to `{identity: null, isResolved: true}` for the rest of the
  // session, which the host adapter reads as `Error/ReadFailed` — so
  // `ReadyWorkspaceMenu`, the only thing that has ever held an invite row, never
  // mounts. Pre-fix the footer had already surrendered its own row on the KEY
  // alone, so the shell carried no invite control anywhere.
  const server = await startIdentityRefusingCloudServer();
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-invite-standing-e2e-")
  );
  try {
    const { page, pageErrors, cleanup } = await launchWithInviteEntry({
      apiOrigin: server.origin,
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      userDataDir,
    });
    try {
      await gotoHash(page, "/dashboard");

      const footer = page.locator(FOOTER_REGION);
      await expect(footer).toBeVisible({ timeout: STEP_BUDGET_MS });

      // THE REGRESSION, and the same locator the case above asserts to be
      // ABSENT — so neither of them can be a selector that matches nothing.
      const footerInvite = footer.getByRole("button", {
        name: DESKTOP_SIDEBAR_INVITE_LABEL,
      });
      await expect(footerInvite).toBeVisible({ timeout: STEP_BUDGET_MS });

      const trigger = page
        .locator(HEADER_REGION)
        .getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL });
      await expect(trigger).toBeVisible({ timeout: STEP_BUDGET_MS });
      // The REASON the footer keeps the row is asserted at the END of this
      // test, not here: opening the menu is also the outside-click that answers
      // the arrival nudge, and the steps below need that nudge still up.

      // EXACTLY ONE host claims the arrival nudge's anchor, and it is the footer
      // row. That is the mirror defect this fix has to avoid: the footer row and
      // `DesktopWorkspaceHeaderSlot` wrap the SAME
      // `InviteSpotlightAnchor.Sidebar`, so a header slot still deciding on the
      // key alone would put two Popovers on one `onOpenChange` in this exact
      // standing. `invite-spotlight.tsx` states one-at-a-time as an invariant and
      // enforces it with nothing; the mounted suite pins it in jsdom and this
      // pins it in the launched app.
      const anchors = page.locator(ANCHOR_SELECTOR);
      await expect(anchors).toHaveCount(1);
      await expect(footer.locator(ANCHOR_SELECTOR)).toHaveCount(1);

      // The nudge itself, up and pointing at that row. Pinned live so the
      // post-answer absence below cannot be a selector that matches nothing.
      const nudge = page.locator(NUDGE_SELECTOR);
      await expect(nudge).toBeVisible({ timeout: STEP_BUDGET_MS });

      // Answering it reaches the ticket's measured WORST case — the nudge spent,
      // its own "Invite your team" CTA gone with it, and the footer row the only
      // invite affordance left anywhere in the shell. That row is what was
      // missing entirely before this fix.
      await page.keyboard.press("Escape");
      await expect(nudge).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: DESKTOP_SIDEBAR_INVITE_LABEL })
      ).toHaveCount(1);

      // Reachable, not merely present: the acceptance criterion is an affordance
      // a signed-in user can OPEN.
      await footerInvite.click();
      await expect(
        page.getByRole("dialog", { name: INVITE_DIALOG_TITLE })
      ).toBeVisible({ timeout: STEP_BUDGET_MS });
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("dialog", { name: INVITE_DIALOG_TITLE })
      ).toHaveCount(0);

      // ...and the REASON the footer keeps that row, asserted rather than
      // assumed. A bare "row present" also passes when the standing is Ready,
      // which is the case above.
      //
      // BEHAVIOR CHANGE (ISS-11400): this read the reason off a DISABLED
      // trigger. Error and Pending deliberately open a real menu now — Settings,
      // Diagnostics, the theme and Log out need no settled identity and are a
      // failed read's only way out — so the proxy stopped being true while the
      // contract it stood for did not. `ReadyWorkspaceMenu` is still the only
      // body that has ever held an invite row, and it still does not mount here,
      // so the menu opens with no invite entry in it. That is the claim this
      // test's own title makes, and it is now checked directly.
      await trigger.click();
      const standingMenu = page.getByRole("menu");
      await expect(standingMenu).toBeVisible({ timeout: STEP_BUDGET_MS });
      // Same locator, positive, BEFORE the absence: `toHaveCount(0)` on a menu
      // that never opened would pass for entirely the wrong reason.
      await expect(
        standingMenu.getByRole("menuitem", {
          exact: true,
          name: WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings],
        })
      ).toBeVisible();
      await expect(
        standingMenu.getByRole("menuitem", {
          exact: true,
          name: WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Invite],
        })
      ).toHaveCount(0);
      // Not the Ready arm wearing a different hat: that arm states the signed-in
      // address, and this standing has no identity to state.
      await expect(standingMenu.getByText(IDENTITY_EMAIL)).toHaveCount(0);

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await closeServer(server.server);
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
});

async function launchWithInviteEntry({
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
    // The session-refresh origin, which the seeded settings below do NOT carry.
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
            name: "ISS-10362 Invite Entry E2E",
            relayOrigin: "http://127.0.0.1:9",
            webAppOrigin: "http://127.0.0.1:3000",
          },
        ],
      });
      seedDesktopFeatureFlags(launchUserDataDir, {
        [WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY]: true,
      });
    },
    cloudReadReadiness: drainedCloudReadReadiness(),
    userDataDir,
  });
}

/**
 * A stand-in cloud that mints the first-party session and answers the identity
 * read the workspace menu's ready arm needs.
 */
async function startIdentityCloudServer(): Promise<{
  origin: string;
  server: Server;
}> {
  const server = createServer((request, response) => {
    if (routeDesktopSessionRefresh(request, response)) {
      return;
    }
    if (!routeDesktopIdentity(request, response)) {
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
  response: ServerResponse
): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "GET" || url.pathname !== "/desktop/identity") {
    return false;
  }
  // Answered only against the session's own bearer, so the identity this menu
  // renders is one it asked for as the signed-in user.
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
    organizationName: "Closedloop",
    organizationSlug: "closedloop",
    userId: AUTHENTICATED_USER_ID,
  });
  return true;
}

/**
 * The same stand-in cloud, minus the identity answer: it mints the first-party
 * session and then REFUSES `GET /desktop/identity`. The unreadable standing is
 * reached the way a real one is — a non-2xx from the peer, through
 * `fetchSessionJson` and the IPC bridge — rather than by stubbing the renderer's
 * hook, which is exactly what the mounted suite already does.
 */
async function startIdentityRefusingCloudServer(): Promise<{
  origin: string;
  server: Server;
}> {
  const server = createServer((request, response) => {
    if (routeDesktopSessionRefresh(request, response)) {
      return;
    }
    if (!refuseDesktopIdentity(request, response)) {
      rejectNotFound(response);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Desktop identity refusal stand-in did not bind.");
  }
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

function refuseDesktopIdentity(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "GET" || url.pathname !== "/desktop/identity") {
    return false;
  }
  // 500 rather than a dropped socket: a server-side failure is the shape the
  // report describes, and it exercises the non-2xx arm of `fetchSessionJson`.
  response.writeHead(500, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "identity unavailable" }));
  return true;
}
