/** A launched authenticated Desktop Branches list uses the linked Clerk photo. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session.ts";
import {
  BranchDataState,
  type BranchListResponse,
  type BranchRow,
  BranchViewerScope,
} from "@repo/api/src/types/branch.ts";
import {
  BranchCollaboratorSource,
  type BranchCollaborators,
  BranchIdentityAvailability,
  type BranchOwnerIdentity,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity.ts";
import { ReadSource } from "@repo/api/src/types/read-source.ts";
import { REPOSITORY } from "../../../../e2e/helpers/branch-details-comprehensive-data";
import {
  AVATAR_IMAGE_BODY,
  CLERK_AVATAR_URL,
  COLLABORATOR_NAME,
  FAILED_AVATAR_URL,
  GITHUB_AVATAR_URL,
  OWNER_FAILED_BRANCH_ID,
  OWNER_FAILED_PHOTO_NAME,
  OWNER_MISSING_BRANCH_ID,
  OWNER_PHOTO_BRANCH_ID,
  OWNER_WITH_PHOTO_NAME,
  OWNER_WITHOUT_PHOTO_NAME,
} from "../../../../e2e/helpers/branch-owner-avatar-fixture";
import {
  branchCardFieldValue,
  branchCardFor,
} from "../../../../e2e/helpers/branches-compact-card";
import { makeAnalytics } from "../../../../e2e/helpers/branches-surface-fixtures";
import {
  sessionListRow,
  sessionsUsageSummary,
} from "../../../../e2e/helpers/sessions-list-fixtures";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  createAuthenticatedDesktopSessionRecord,
  rejectUnauthorized,
  startAuthenticatedBranchCloudServer,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import { branchListRowFixture } from "./helpers/branch-list-row-fixture";
import {
  drainedCloudReadReadiness,
  gotoHash,
  seedDesktopSettings,
} from "./helpers/desktop-app";

const PROFILE_ID = "iss-7397-owner-avatar-e2e-profile";
const OWNER_CELL = '[data-column-id="owner"]';
const COLLABORATORS_CELL = '[data-column-id="collaborators"]';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_ACTIVITY_AT = new Date(Date.now() - ONE_DAY_MS).toISOString();

// One initial on every avatar (Nerys, 2026-10-22).
test("Branches Owner photo and initials agree with the web contract", async () => {
  test.setTimeout(180_000);
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-7397-claude-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-7397-codex-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-7397-udd-"));
  const server = await startAuthenticatedBranchCloudServer({
    analyticsFactory: makeAnalytics,
    extraRoutes: (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (
        request.method !== "GET" ||
        (pathname !== "/agent-sessions" && pathname !== "/agent-sessions/usage")
      ) {
        return false;
      }
      if (
        request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
      ) {
        rejectUnauthorized(response);
        return true;
      }
      if (pathname === "/agent-sessions/usage") {
        writeApiResult(response, sessionsUsageSummary({ totalSessions: 2 }));
        return true;
      }
      writeApiResult(response, {
        items: sessionOwnerRows(),
        total: 2,
        viewerScope: AgentSessionViewerScope.Organization,
      });
      return true;
    },
    listFactory: branchListResponse,
    repositoryFullNames: [REPOSITORY],
  });

  try {
    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      cloudReadReadiness: drainedCloudReadReadiness(),
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          activeConfigId: PROFILE_ID,
          apiOrigin: server.origin,
          cloudConnectionEnabled: true,
          savedConfigs: [
            {
              apiOrigin: server.origin,
              gatewayId: AUTHENTICATED_GATEWAY_ID,
              id: PROFILE_ID,
              name: "ISS-7397 Owner Avatar E2E",
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
      let clerkRequests = 0;
      let failedRequests = 0;
      await page.route(CLERK_AVATAR_URL, async (route) => {
        clerkRequests += 1;
        await route.fulfill({
          body: AVATAR_IMAGE_BODY,
          contentType: "image/svg+xml",
        });
      });
      await page.route(FAILED_AVATAR_URL, async (route) => {
        await route.fulfill({ status: 404, body: "" });
        failedRequests += 1;
      });
      await page.route(GITHUB_AVATAR_URL, async (route) => {
        await route.fulfill({
          body: AVATAR_IMAGE_BODY,
          contentType: "image/svg+xml",
        });
      });

      await expect
        .poll(() =>
          page.evaluate(() => window.desktopApi.getDesktopAuthState())
        )
        .toMatchObject({
          organizationId: AUTHENTICATED_ORGANIZATION_ID,
          status: DesktopAuthStatus.Authenticated,
          userId: AUTHENTICATED_USER_ID,
        });
      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoHash(page, "/branches");

      const photoOwner = rowFor(page, OWNER_PHOTO_BRANCH_ID).locator(
        OWNER_CELL
      );
      const photo = photoOwner.locator('img[data-slot="avatar-image"]');
      await expect(photoOwner.getByText(OWNER_WITH_PHOTO_NAME)).toBeVisible();
      await expect(photo).toHaveAttribute("src", CLERK_AVATAR_URL);
      await expect
        .poll(() =>
          photo.evaluate((image: HTMLImageElement) => image.naturalWidth)
        )
        .toBeGreaterThan(0);
      await expect(photoOwner.getByText("A", { exact: true })).toHaveCount(0);
      await expect(photoOwner.locator('[data-slot="avatar"]')).toHaveAttribute(
        "aria-hidden",
        "true"
      );
      await expect(photoOwner).toHaveAccessibleName(OWNER_WITH_PHOTO_NAME);
      await expect(photoOwner.getByRole("img")).toHaveCount(0);

      const missingOwner = rowFor(page, OWNER_MISSING_BRANCH_ID).locator(
        OWNER_CELL
      );
      await expect(
        missingOwner.getByText(OWNER_WITHOUT_PHOTO_NAME)
      ).toBeVisible();
      await expect(missingOwner.getByText("B", { exact: true })).toBeVisible();
      await expect(missingOwner.locator("img")).toHaveCount(0);
      await expect(missingOwner).toHaveAccessibleName(OWNER_WITHOUT_PHOTO_NAME);
      await expect(missingOwner.getByRole("img")).toHaveCount(0);

      const failedOwner = rowFor(page, OWNER_FAILED_BRANCH_ID).locator(
        OWNER_CELL
      );
      await expect.poll(() => failedRequests).toBeGreaterThan(0);
      await expect(
        failedOwner.getByText(OWNER_FAILED_PHOTO_NAME)
      ).toBeVisible();
      await expect(failedOwner.getByText("C", { exact: true })).toBeVisible();
      await expect(failedOwner.locator("img")).toHaveCount(0);
      await expect(failedOwner).toHaveAccessibleName(OWNER_FAILED_PHOTO_NAME);
      await expect(failedOwner.getByRole("img")).toHaveCount(0);

      const collaboratorGroup = rowFor(page, OWNER_PHOTO_BRANCH_ID)
        .locator(COLLABORATORS_CELL)
        .getByRole("img", { name: COLLABORATOR_NAME });
      await expect(collaboratorGroup).toBeVisible();
      await expect(
        collaboratorGroup.getByText("R", { exact: true })
      ).toBeVisible();
      const githubPhotoStatus = await page.evaluate(
        (url) =>
          new Promise<"loaded" | "error">((resolve) => {
            const image = new Image();
            image.onload = () => resolve("loaded");
            image.onerror = () => resolve("error");
            image.src = url;
          }),
        GITHUB_AVATAR_URL
      );
      expect(githubPhotoStatus).toBe("error");
      expect(clerkRequests).toBeGreaterThan(0);

      await page.setViewportSize({ width: 768, height: 800 });
      const card = branchCardFor(page, `#/branches/${OWNER_PHOTO_BRANCH_ID}`);
      const cardOwner = branchCardFieldValue(card, "Owner");
      await expect(cardOwner.getByText(OWNER_WITH_PHOTO_NAME)).toBeVisible();
      await expect(
        cardOwner.locator('img[data-slot="avatar-image"]')
      ).toHaveAttribute("src", CLERK_AVATAR_URL);

      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoHash(page, "/sessions");
      const sessionPhotoOwner = sessionOwnerCell(page, "Owner photo session");
      const sessionPhoto = sessionPhotoOwner.locator(
        'img[data-slot="avatar-image"]'
      );
      await expect(sessionPhoto).toHaveAttribute("src", CLERK_AVATAR_URL);
      await expect
        .poll(() =>
          sessionPhoto.evaluate((image: HTMLImageElement) => image.naturalWidth)
        )
        .toBeGreaterThan(0);
      await expect(sessionPhotoOwner).toHaveAccessibleName(
        OWNER_WITH_PHOTO_NAME
      );
      await expect(sessionPhotoOwner.getByRole("img")).toHaveCount(0);

      const sessionMissingOwner = sessionOwnerCell(
        page,
        "Owner missing photo session"
      );
      await expect(
        sessionMissingOwner.getByText("B", { exact: true })
      ).toBeVisible();
      await expect(sessionMissingOwner.locator("img")).toHaveCount(0);
      await expect(
        sessionMissingOwner.getByText(OWNER_WITHOUT_PHOTO_NAME, { exact: true })
      ).toHaveCount(1);
      await expect(sessionMissingOwner.getByRole("img")).toHaveCount(0);

      expect(
        server.requests.some(
          (request) =>
            request.pathname === "/branches" &&
            request.authorization === `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
        )
      ).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(claudeHome, { recursive: true, force: true });
  }
});

function rowFor(page: Page, id: string) {
  return page
    .getByTestId("branches-history-list")
    .getByRole("grid")
    .getByRole("row")
    .filter({ hasText: `feature/${id}` });
}

function sessionOwnerCell(page: Page, sessionName: string) {
  return page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: sessionName }) })
    .locator('[data-column-id="owner"]');
}

function sessionOwnerRows() {
  const timestamp = new Date(RECENT_ACTIVITY_AT);
  return [
    sessionListRow({
      index: 1,
      name: "Owner photo session",
      startedAt: timestamp,
      lastActivityAt: timestamp,
      updatedAt: timestamp,
      endedAt: timestamp,
      user: {
        avatarUrl: CLERK_AVATAR_URL,
        email: "avery@example.test",
        firstName: "Avery",
        id: "owner-avery",
        lastName: "Carter",
      },
    }),
    sessionListRow({
      index: 2,
      name: "Owner missing photo session",
      startedAt: timestamp,
      lastActivityAt: timestamp,
      updatedAt: timestamp,
      endedAt: timestamp,
      user: {
        avatarUrl: null,
        email: "blake@example.test",
        firstName: "Blake",
        id: "owner-blake",
        lastName: "Morgan",
      },
    }),
  ];
}

function branchListResponse(): BranchListResponse {
  return {
    hasMore: false,
    items: [
      ownerRow(
        OWNER_PHOTO_BRANCH_ID,
        OWNER_WITH_PHOTO_NAME,
        CLERK_AVATAR_URL,
        true
      ),
      ownerRow(OWNER_MISSING_BRANCH_ID, OWNER_WITHOUT_PHOTO_NAME),
      ownerRow(
        OWNER_FAILED_BRANCH_ID,
        OWNER_FAILED_PHOTO_NAME,
        FAILED_AVATAR_URL
      ),
    ],
    readSource: ReadSource.Cloud,
    total: 3,
    viewerScope: BranchViewerScope.Organization,
  };
}

function ownerRow(
  id: string,
  name: string,
  avatarUrl?: string,
  withCollaborator = false
): BranchRow {
  const base = branchListRowFixture({
    branchName: `feature/${id}`,
    canonicalDataState: BranchDataState.Ready,
    id,
    lastActivityAt: RECENT_ACTIVITY_AT,
    tagPermissions: { canApply: false, canRemove: false },
    topLevelDataState: BranchDataState.Ready,
  });
  const projection = base.canonicalProjection;
  if (!projection) {
    throw new Error("Branch list fixture requires a canonical projection");
  }
  const ownerIdentity: BranchOwnerIdentity = {
    availability: BranchIdentityAvailability.Complete,
    person: {
      provider: BranchPersonProvider.GitHub,
      id,
      userId: `user-${id}`,
      displayName: name,
      ...(avatarUrl ? { avatarUrl } : {}),
    },
  };
  const collaborators: BranchCollaborators = {
    availability: BranchIdentityAvailability.Complete,
    people: withCollaborator
      ? [
          {
            provider: BranchPersonProvider.GitHub,
            id: "github-riley",
            displayName: COLLABORATOR_NAME,
            avatarUrl: GITHUB_AVATAR_URL,
          },
        ]
      : [],
    sources: {
      [BranchCollaboratorSource.PullRequestAuthors]:
        BranchIdentityAvailability.Complete,
      [BranchCollaboratorSource.Pushes]: BranchIdentityAvailability.Complete,
      [BranchCollaboratorSource.PullRequestComments]:
        BranchIdentityAvailability.Complete,
      [BranchCollaboratorSource.BranchComments]:
        BranchIdentityAvailability.Complete,
      [BranchCollaboratorSource.SessionComments]:
        BranchIdentityAvailability.Complete,
    },
  };
  return {
    ...base,
    owner: name,
    ownerIdentity,
    collaborators,
    canonicalProjection: {
      ...projection,
      common: {
        ...projection.common,
        people: {
          ...projection.common.people,
          owner: ownerIdentity,
          collaborators,
        },
      },
    },
  };
}
