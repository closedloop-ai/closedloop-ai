import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import { PROJECTS_PORTABLE_SURFACE_FLAG_KEY } from "@repo/api/src/types/projects-portable-surface-flag.ts";
import { SHELL_SIDEBAR_V2_FLAG_KEY } from "@repo/api/src/types/shell-sidebar-v2-flag.ts";
import { TeamRole } from "@repo/api/src/types/teams.ts";
import { z } from "zod";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  createAuthenticatedDesktopSessionRecord,
  rejectUnauthorized,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import { drainedCloudReadReadiness } from "./helpers/desktop-app";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
} from "./helpers/seeded-sessions-list";
import {
  seedCloudSessionDetailProfile,
  startAuthenticatedSessionDetailCloudServer,
} from "./helpers/session-detail-authenticated-cloud";

for (const shellSidebarV2 of [false, true]) {
  test(`Teams shared dialog creates a team in the ${shellSidebarV2 ? "v2" : "legacy"} Desktop sidebar`, async () => {
    test.setTimeout(180_000);
    const fixture = teamsCloudRoutes();
    const server = await startAuthenticatedSessionDetailCloudServer({
      extraRoutes: fixture.route,
    });
    const dirs = makeSeededSessionsDirs("teams-dialog");
    try {
      const { page, cleanup } = await launchAuthenticatedDesktopApp({
        sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
        cloudReadReadiness: drainedCloudReadReadiness(),
        beforeLaunch: (profile) =>
          seedCloudSessionDetailProfile(profile, server.origin, {
            labsNav: true,
            [PROJECTS_PORTABLE_SURFACE_FLAG_KEY]: true,
            [SHELL_SIDEBAR_V2_FLAG_KEY]: shellSidebarV2,
          }),
        userDataDir: dirs.userDataDir,
        harnessHomesRoot: dirs.harnessHomesRoot,
        env: {
          CLAUDE_HOME: dirs.claudeHome,
          CODEX_HOME: dirs.codexHome,
          CL_AUTH_API_ORIGIN: server.origin,
        },
      });
      try {
        const labs = page.getByRole("button", { name: "Labs", exact: true });
        await expect(labs).toBeVisible({ timeout: 30_000 });
        if ((await labs.getAttribute("aria-expanded")) === "false") {
          await labs.click();
        }
        await page
          .getByRole("button", { name: "Add Team", exact: true })
          .click();
        const dialog = page.getByRole("dialog", { name: "Create Team" });
        await expect(dialog.getByText("Ada Lovelace")).toBeVisible();
        await dialog.getByLabel("Team Name").fill("Platform");
        await dialog
          .getByRole("button", { name: "Create Team", exact: true })
          .click();
        await expect.poll(() => fixture.writes).toEqual([{ name: "Platform" }]);
        await expect(dialog).not.toBeVisible();
        await expect(page).toHaveURL(createdTeamUrl);
        await expect(
          page.getByRole("link", { name: "Platform", exact: true })
        ).toBeVisible();
        expect(fixture.unauthorizedCount()).toBe(0);
        await page.screenshot({
          path: test.info().outputPath("teams-created.png"),
        });
      } finally {
        await cleanup();
      }
    } finally {
      await server.close();
      cleanupSeededSessionsDirs(dirs);
    }
  });
}

test("Teams cold offline roster and reconnected edit preserve membership on a name-only save", async () => {
  test.setTimeout(180_000);
  const fixture = teamsCloudRoutes({
    seedExistingTeam: true,
    holdRoster: true,
  });
  const server = await startAuthenticatedSessionDetailCloudServer({
    extraRoutes: fixture.route,
  });
  const dirs = makeSeededSessionsDirs("teams-offline-roster");
  try {
    const { page, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      cloudReadReadiness: drainedCloudReadReadiness(),
      beforeLaunch: (profile) =>
        seedCloudSessionDetailProfile(profile, server.origin, {
          labsNav: true,
          [PROJECTS_PORTABLE_SURFACE_FLAG_KEY]: true,
          [SHELL_SIDEBAR_V2_FLAG_KEY]: true,
        }),
      userDataDir: dirs.userDataDir,
      harnessHomesRoot: dirs.harnessHomesRoot,
      env: {
        CLAUDE_HOME: dirs.claudeHome,
        CODEX_HOME: dirs.codexHome,
        CL_AUTH_API_ORIGIN: server.origin,
      },
    });
    try {
      const labs = page.getByRole("button", { name: "Labs", exact: true });
      await expect(labs).toBeVisible({ timeout: 30_000 });
      if ((await labs.getAttribute("aria-expanded")) === "false") {
        await labs.click();
      }
      await expect(
        page.getByRole("link", { name: "Platform", exact: true })
      ).toBeVisible();
      expect(fixture.memberReads()).toBe(0);
      await page.context().setOffline(true);
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
      // Electron network emulation does not consistently dispatch browser events.
      // Drive the same event the real query client subscribes to, without replacing it.
      await page.evaluate(() => globalThis.dispatchEvent(new Event("offline")));
      await page
        .getByRole("button", { name: "Team options", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Settings", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Edit Team" });
      await expect(dialog).toBeVisible();
      // Local-mode IPC stays available offline. Hold its first uncached roster
      // response so offline/reconnect cannot hydrate an empty membership baseline.
      await expect(
        dialog.getByText("No members yet. Add members above.")
      ).toHaveCount(0);
      await expect.poll(() => fixture.memberReads()).toBeGreaterThan(0);
      await expect(
        dialog.getByRole("button", { name: "Save Changes" })
      ).toBeDisabled();
      await page.context().setOffline(false);
      await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
      fixture.releaseRoster();
      // Reconnect replaces the local core with the cloud core and remounts its
      // sidebar. Reopen the existing team through that real host transition.
      await expect(dialog).not.toBeVisible();
      await page
        .getByRole("button", { name: "Team options", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Settings", exact: true })
        .click();
      await expect(dialog.getByText("Ada Lovelace")).toBeVisible();
      await expect(
        dialog.getByText("Grace Hopper", { exact: true })
      ).toBeVisible();
      await expect.poll(() => fixture.memberReads()).toBeGreaterThan(0);
      await dialog.getByLabel("Team Name").fill("Platform renamed");
      await dialog
        .getByRole("button", { name: "Save Changes", exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      await expect(
        page.getByRole("link", { name: "Platform renamed", exact: true })
      ).toBeVisible();
      expect(fixture.mutations).toEqual([
        {
          method: "PUT",
          path: `/teams/${createdTeam.id}`,
          body: { name: "Platform renamed" },
        },
      ]);
      expect(fixture.members).toHaveLength(2);
      expect(fixture.unauthorizedCount()).toBe(0);
      await page.screenshot({
        path: test.info().outputPath("teams-roster-reconnected.png"),
      });
    } finally {
      fixture.releaseRoster();
      await page.context().setOffline(false);
      await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
      await cleanup();
    }
  } finally {
    await server.close();
    cleanupSeededSessionsDirs(dirs);
  }
});

function teamsCloudRoutes({
  seedExistingTeam = false,
  holdRoster = false,
} = {}) {
  const pendingRosterResponses: ServerResponse[] = [];
  const releaseRoster = () => {
    holdRoster = false;
    for (const response of pendingRosterResponses.splice(0)) {
      if (!response.destroyed) {
        writeApiResult(response, members);
      }
    }
  };
  const teams: (typeof createdTeam)[] = seedExistingTeam
    ? [{ ...createdTeam, memberCount: 2 }]
    : [];
  const members = seededMembers.map((member) => ({ ...member }));
  const mutations: { method: string; path: string; body?: unknown }[] = [];
  let memberReads = 0;
  const writes: unknown[] = [];
  let unauthorized = 0;
  const readPaths = new Set([
    "/teams",
    "/me",
    "/users",
    "/projects",
    "/projects/favorites",
    `/teams/${createdTeam.id}`,
    `/teams/${createdTeam.id}/members`,
  ]);
  const route = (request: IncomingMessage, response: ServerResponse) => {
    const pathname = URL.parse(
      `http://127.0.0.1${request.url ?? "/"}`
    )?.pathname;
    const create = request.method === "POST" && pathname === "/teams";
    const update =
      request.method === "PUT" && pathname === `/teams/${createdTeam.id}`;
    const removeMember =
      request.method === "DELETE" &&
      new RegExp(`^/teams/${createdTeam.id}/members/[^/]+$`).test(
        pathname ?? ""
      );
    if (
      !(
        create ||
        update ||
        removeMember ||
        (request.method === "GET" && pathname && readPaths.has(pathname))
      )
    ) {
      return false;
    }
    if (
      request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
    ) {
      unauthorized += 1;
      rejectUnauthorized(response);
      return true;
    }
    if (create || update) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = createBody.safeParse(raw);
        if (!result.success) {
          response.writeHead(400).end();
          return;
        }
        writes.push(result.data);
        mutations.push({
          method: request.method ?? "",
          path: pathname ?? "",
          body: result.data,
        });
        if (create) {
          teams.push({ ...createdTeam, name: result.data.name });
        } else {
          teams[0] = {
            ...createdTeam,
            memberCount: members.length,
            name: result.data.name,
          };
        }
        writeApiResult(response, teams[0]);
      });
    } else if (removeMember) {
      mutations.push({ method: "DELETE", path: pathname ?? "" });
      const userId = pathname?.split("/").at(-1);
      const index = members.findIndex((member) => member.userId === userId);
      if (index >= 0) {
        members.splice(index, 1);
      }
      writeApiResult(response, { deleted: true });
    } else if (pathname === `/teams/${createdTeam.id}/members`) {
      memberReads += 1;
      if (holdRoster) {
        pendingRosterResponses.push(response);
      } else {
        writeApiResult(response, members);
      }
    } else if (pathname === "/teams") {
      writeApiResult(response, teams);
    } else if (pathname === "/me") {
      writeApiResult(response, currentUser);
    } else if (pathname === "/users") {
      writeApiResult(response, [currentUser, otherUser]);
    } else if (pathname === `/teams/${createdTeam.id}`) {
      writeApiResult(response, teams[0]);
    } else {
      writeApiResult(response, []);
    }
    return true;
  };
  return {
    route,
    writes,
    mutations,
    members,
    memberReads: () => memberReads,
    releaseRoster,
    unauthorizedCount: () => unauthorized,
  };
}

const createBody = z.object({ name: z.string().min(1) }).strict();
const createdTeam = {
  id: "019c24dc-9445-75ec-8136-c4e6d83147fa",
  organizationId: AUTHENTICATED_ORGANIZATION_ID,
  name: "Platform",
  slug: "platform",
  memberCount: 1,
  projectCount: 0,
  createdAt: "2026-10-19T00:00:00Z",
  updatedAt: "2026-10-19T00:00:00Z",
};
const currentUser = {
  id: AUTHENTICATED_USER_ID,
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  avatarUrl: null,
};
const createdTeamUrl =
  /#\/teams\/019c24dc-9445-75ec-8136-c4e6d83147fa\/projects(?:\?|$)/;

const otherUser = {
  id: "019c24dc-9445-75ec-8136-c4e6d83147fb",
  firstName: "Grace",
  lastName: "Hopper",
  email: "grace@example.com",
  avatarUrl: null,
};
const seededMembers = [
  {
    id: "member-ada",
    teamId: createdTeam.id,
    userId: currentUser.id,
    role: TeamRole.Owner,
    user: currentUser,
  },
  {
    id: "member-grace",
    teamId: createdTeam.id,
    userId: otherUser.id,
    role: TeamRole.Member,
    user: otherUser,
  },
];
