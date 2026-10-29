/**
 * ISS-12452: launched-app proof that applying and removing a tag from a Desktop
 * Branches row changes the row's chips without a reload.
 *
 * Desktop caches its Branch reads in a Branch-owned query client
 * (`useBranchesQueryContext`), distinct from the ambient one the tag mutations
 * default to. A write whose invalidation misses that client leaves the row
 * holding its pre-write chips: the POST succeeds and the screen never moves,
 * which is what a user reads as the tag click doing nothing. Only a launched
 * run exercises that — the provider, the shared cell, and the mutation's
 * invalidation in one tree (`apps/desktop/AGENTS.md`, UI bug fix ⇒ regression
 * e2e).
 *
 * The cloud stand-in's list factory reads the same mutable applied-tag set the
 * `/entity-tags` routes write, so a stale chip is a stale CACHE rather than a
 * stale fixture: the server already agrees with the click.
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  BranchDataState,
  type BranchListResponse,
  BranchViewerScope,
} from "@repo/api/src/types/branch.ts";
import { ReadSource } from "@repo/api/src/types/read-source.ts";
import { type Tag, TagColor } from "@repo/api/src/types/tag.ts";
import { REPOSITORY } from "../../../../e2e/helpers/branch-details-comprehensive-data";
import { makeAnalytics } from "../../../../e2e/helpers/branches-surface-fixtures";
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

const PROFILE_ID = "iss-12452-tag-apply-e2e-profile";
const TAGGED_BRANCH_ID = "iss-12452-tag-apply";
const TAGGED_BRANCH_NAME = `feature/${TAGGED_BRANCH_ID}`;
const EDIT_TAGS_LABEL = `Edit tags for ${TAGGED_BRANCH_NAME}`;
const TAGS_CELL = '[data-column-id="tags"]';
const POPOVER_CONTENT = '[data-slot="popover-content"]';
const APPLIED_SECTION_LABEL = "Applied";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_ACTIVITY_AT = new Date(Date.now() - ONE_DAY_MS).toISOString();

const CLOUD_TAG: Tag = {
  id: "iss-12452-tag",
  organizationId: AUTHENTICATED_ORGANIZATION_ID,
  name: "needs-triage",
  color: TagColor.Blue,
  createdById: AUTHENTICATED_USER_ID,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

test("applying and removing a tag from a Branches row changes the chips without a reload", async () => {
  test.setTimeout(240_000);

  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-12452-claude-")
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-12452-codex-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-12452-udd-"));
  const tagStore = createTagStore();
  const server = await startAuthenticatedBranchCloudServer({
    analyticsFactory: makeAnalytics,
    extraRoutes: tagStore.route,
    listFactory: () => taggedBranchListResponse(tagStore.applied()),
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
              name: "ISS-12452 Tag Apply E2E",
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

      const editTags = tagsCell(page).getByRole("button", {
        name: EDIT_TAGS_LABEL,
      });
      await expect(editTags).toBeVisible();
      await expect(editTags.getByText(CLOUD_TAG.name)).toHaveCount(0);

      await editTags.click();
      const picker = page.locator(POPOVER_CONTENT);
      await picker.getByRole("button", { name: CLOUD_TAG.name }).click();

      // The chip is drawn from the ROW, so it can only arrive by the Branch
      // list query refetching — no navigation and no reload in between.
      await expect(editTags.getByText(CLOUD_TAG.name)).toBeVisible();
      expect(tagStore.applied()).toEqual([CLOUD_TAG.id]);

      // The picker reads the same row, so the still-open list must move the
      // tag under Applied rather than keep offering it — otherwise the next
      // click re-applies instead of removing.
      await expect(picker.getByText(APPLIED_SECTION_LABEL)).toBeVisible();
      await picker.getByRole("button", { name: CLOUD_TAG.name }).click();

      await expect(editTags.getByText(CLOUD_TAG.name)).toHaveCount(0);
      expect(tagStore.applied()).toEqual([]);
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

function tagsCell(page: Page) {
  return page
    .getByTestId("branches-history-list")
    .getByRole("grid")
    .getByRole("row")
    .filter({ hasText: TAGGED_BRANCH_NAME })
    .locator(TAGS_CELL);
}

/**
 * The org's one tag, plus whether the branch row currently carries it.
 *
 * The apply and remove routes commit into the same set `listFactory` reads, so
 * the server's answer moves on the click and the row's chips are the only
 * thing that can still be stale.
 */
function createTagStore() {
  const applied = new Set<string>();
  return {
    applied: () => [...applied],
    route: (request: IncomingMessage, response: ServerResponse): boolean => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = requestUrl.pathname;
      if (pathname !== "/tags" && pathname !== "/entity-tags") {
        return false;
      }
      if (
        request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
      ) {
        rejectUnauthorized(response);
        return true;
      }
      if (pathname === "/tags" && request.method === "GET") {
        writeApiResult(response, [CLOUD_TAG]);
        return true;
      }
      if (pathname === "/entity-tags" && request.method === "POST") {
        applied.add(CLOUD_TAG.id);
        writeApiResult(response, { applied: true });
        return true;
      }
      if (pathname === "/entity-tags" && request.method === "DELETE") {
        applied.delete(requestUrl.searchParams.get("tagId") ?? "");
        writeApiResult(response, { removed: true });
        return true;
      }
      return false;
    },
  };
}

function taggedBranchListResponse(
  appliedTagIds: readonly string[]
): BranchListResponse {
  return {
    hasMore: false,
    items: [
      branchListRowFixture({
        branchName: TAGGED_BRANCH_NAME,
        canonicalDataState: BranchDataState.Ready,
        id: TAGGED_BRANCH_ID,
        lastActivityAt: RECENT_ACTIVITY_AT,
        tagPermissions: { canApply: true, canRemove: true },
        tags: appliedTagIds.map(() => ({
          color: CLOUD_TAG.color,
          id: CLOUD_TAG.id,
          name: CLOUD_TAG.name,
        })),
        topLevelDataState: BranchDataState.Ready,
      }),
    ],
    readSource: ReadSource.Cloud,
    total: 1,
    viewerScope: BranchViewerScope.Organization,
  };
}
