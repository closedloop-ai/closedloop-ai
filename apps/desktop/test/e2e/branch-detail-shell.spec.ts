import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { BranchPageDetail } from "@repo/api/src/types/branch.ts";
import { CommentSurface } from "@repo/api/src/types/comment.ts";
import { CommentPolicyKey } from "@repo/api/src/types/comment-capabilities.ts";
import type { ArtifactCommentsResponse } from "@repo/api/src/types/comment-thread-dto.ts";
import { BRANCH_DETAIL_TAB_PARAM } from "@repo/api/src/types/notification-routes.ts";
import {
  BRANCH_ARTIFACT_TAB_ALIASES,
  BRANCH_ARTIFACT_TABS,
} from "@repo/app/branches/components/branch-artifact-routing.ts";
import { BRANCH_UNAVAILABLE_LABEL } from "@repo/app/branches/components/branch-unavailable-value.tsx";
import {
  capabilitiesFor,
  makeComment,
  makeThread,
} from "@repo/app/shared/components/comments/comments-pane.fixtures.ts";
import {
  ARTIFACT_DETAIL_TAB_LABELS,
  ArtifactDetailTab,
} from "@repo/app/shared/lib/artifact-detail-tab.ts";
import {
  ARTIFACT_COMMENT_PARAM,
  DEFAULT_TAB_PARAM,
} from "@repo/app/shared/lib/detail-route-params.ts";
import { ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags.ts";
import { expectArtifactCanvasCardAtPanelEdge } from "../../../../e2e/helpers/branch-artifact-canvas-card";
import { BRANCH_ACTIVITY_THREAD_ID } from "../../../../e2e/helpers/branch-details-comprehensive-activity";
import {
  BRANCH_ID,
  detailFor,
} from "../../../../e2e/helpers/branch-details-comprehensive-data";
import {
  BranchDetailsProjectRow,
  expectBranchDetailsOrder,
} from "../../../../e2e/helpers/branch-details-order";
import {
  type DesktopAuthState,
  DesktopAuthStatus,
} from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  type AuthenticatedBranchCloudServer,
  createAuthenticatedDesktopSessionRecord,
  startAuthenticatedBranchCloudServer,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoHash,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./helpers/desktop-app";

/** The desktop adapter renders every port Link as a same-document hash href. */
const LEADING_HASH = /^#/;

const PROFILE_ID = "iss-10797-branch-detail-shell-profile";
const NARROW_VIEWPORT = { height: 800, width: 480 };
const WIDE_VIEWPORT = { height: 900, width: 1440 };
const ACTIVITY_THREAD_BODY = "The comment the Activity row links to";
const UNIFIED_COMMENTS_PATH = /^\/artifacts\/([^/]+)\/comments$/;
const COMMENTS_TOGGLE = /^(Show|Hide) comments rail$/;

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Global DOM Window must be interface-merged; a type alias cannot augment it.
  interface Window {
    desktopApi: {
      getDesktopAuthState: () => Promise<DesktopAuthState>;
    };
  }
}

test("Branch shared shell routes desktop tabs through renderer history", async () => {
  test.setTimeout(240_000);

  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-10797-claude-")
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-10797-codex-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-10797-udd-"));
  // `detailFactory` is fixed at server start but runs PER REQUEST, so a
  // reassignable override serves a second detail shape without a relaunch
  // (the idiom `details-person-row-photo.spec.ts` established).
  let lineCounts: Pick<BranchPageDetail, "additions" | "deletions"> | null =
    null;
  // The cloud detail names its artifact, which the comments pane reads by.
  const server = await startAuthenticatedBranchCloudServer({
    detailFactory: (pullRequestNumber) => ({
      ...detailFor(pullRequestNumber),
      artifactId: BRANCH_ID,
      ...(lineCounts ?? {}),
    }),
    extraRoutes: routeUnifiedComments,
  });

  try {
    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
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
              name: "ISS-10797 Branch Detail Shell E2E",
              relayOrigin: "http://127.0.0.1:9",
              webAppOrigin: "http://127.0.0.1:3000",
            },
          ],
        });
        seedDesktopFeatureFlags(launchUserDataDir, {
          [ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY]: true,
        });
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
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

      await expectBranchDetailRequestBudget(page, server);
      await expectShellTabHistory(page);
      await expectLegacyTabAliases(page);
      await expectActivityCommentOpensItsThread(page);
      // Last: it reloads the renderer to drop the cached detail read, so every
      // block above still sees the populated fixture.
      await expectChangesRowWithoutLineCounts(page, () => {
        lineCounts = { additions: null, deletions: null };
      });

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
});

async function expectShellTabHistory(page: Page): Promise<void> {
  await gotoHash(page, `/branches/${BRANCH_ID}`);
  const artifact = shellPanel(page, ArtifactDetailTab.Artifact);
  const selector = artifact.getByRole("combobox", { name: "Pull request" });
  await expect(selector).toBeVisible({ timeout: 30_000 });
  const mountedCanvas = await selector.elementHandle();
  await expectPerTabCommentsToggle(page);

  // Before any tab change, while Artifact is the drawn panel. Leaves the window
  // wide; the narrow-viewport block at the end of this function resets it.
  await expectArtifactCanvasCardAtPanelEdge(page, artifact, "Branch");

  await shellTab(page, ArtifactDetailTab.Details).click();
  // "Branch details" is Branch's own Details section, so this fails if the
  // shell mounts without the Branch Details host behind it.
  await expect(
    shellPanel(page, ArtifactDetailTab.Details).getByRole("heading", {
      name: "Branch details",
    })
  ).toBeVisible();
  // Desktop single-user mode carries no project field, so no Project row —
  // the one row the two hosts disagree on (ISS-10995).
  await expectBranchDetailsOrder(
    shellPanel(page, ArtifactDetailTab.Details),
    BranchDetailsProjectRow.AbsentFromProducer
  );

  await shellTab(page, ArtifactDetailTab.Sessions).click();
  await expect(shellPanel(page, ArtifactDetailTab.Sessions)).toBeVisible();

  await shellTab(page, ArtifactDetailTab.Activity).click();
  // ISS-10980 gave the tab its feed, so the panel's old `unsupported`
  // "Unavailable" claim is obsoleted by that change rather than regressed:
  // the rows below are what replaced it. Reached over real HTTP, which is the
  // half no unit fixture covers — `createdAt` crosses the wire as a string.
  const activity = shellPanel(page, ArtifactDetailTab.Activity);
  await expect(
    activity.getByRole("list", { name: "Activity" }).getByRole("listitem")
  ).toHaveCount(2);
  await expect(
    activity.locator('[data-artifact-tab-state="unsupported"]')
  ).toHaveCount(0);
  // The comment row addresses its thread on THIS route, through the desktop
  // adapter's own hash href. Read apart rather than pinned as one string, so
  // the case is about the parts and not about param order.
  const addressed = new URL(
    (
      await activity
        .getByRole("link", { name: "View comment" })
        .getAttribute("href")
    )?.replace(LEADING_HASH, "") ?? "",
    "https://desktop.invalid"
  );
  expect(addressed.pathname).toBe(`/branches/${BRANCH_ID}`);
  expect(addressed.searchParams.get(ARTIFACT_COMMENT_PARAM)).toBe(
    BRANCH_ACTIVITY_THREAD_ID
  );
  // The comment row addresses its thread on THIS route.
  // ISS-10963 puts the comments rail beside Artifact and Sessions and no
  // others, so the address leaves Activity; WHICH of the two is the thread's
  // own surface (operator, 2026-10-08). The fixture's thread is
  // `branch_timeline`, so Sessions — and that is NOT the fallback, so this
  // fails if the surface stops being read.
  expect(addressed.searchParams.get(DEFAULT_TAB_PARAM)).toBe(
    ArtifactDetailTab.Sessions
  );

  // The renderer's own history, not the browser's: each tab change pushed an
  // entry the desktop Back gesture must walk.
  await page.goBack();
  await expect(shellTab(page, ArtifactDetailTab.Sessions)).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.goBack();
  await expect(shellTab(page, ArtifactDetailTab.Details)).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.goBack();
  await expect(artifact).toBeVisible();
  // keepMountedTabs=[Artifact]: the canvas was hidden, never remounted, so the
  // selected pull request survives the round trip.
  expect(await mountedCanvas?.evaluate((node) => node.isConnected)).toBe(true);

  await page.setViewportSize(NARROW_VIEWPORT);
  for (const tab of BRANCH_ARTIFACT_TABS) {
    await expect(shellTab(page, tab)).toBeVisible();
  }
  await shellTab(page, ArtifactDetailTab.Details).click();
  await expect(shellTab(page, ArtifactDetailTab.Details)).toBeFocused();
  await shellTab(page, ArtifactDetailTab.Details).press("ArrowRight");
  await expect(
    shellTab(page, tabAfter(ArtifactDetailTab.Details))
  ).toBeFocused();
}

/**
 * Driven off the alias map rather than a hand-listed pair set: a dropped alias
 * dead-ends every existing desktop link built with that param.
 */
async function expectLegacyTabAliases(page: Page): Promise<void> {
  for (const [param, expected] of Object.entries(BRANCH_ARTIFACT_TAB_ALIASES)) {
    await gotoHash(
      page,
      `/branches/${BRANCH_ID}?${BRANCH_DETAIL_TAB_PARAM}=${param}`
    );
    await expect(shellTab(page, expected)).toHaveAttribute(
      "aria-selected",
      "true"
    );
  }
}

/**
 * ISS-12300 D1/D3: the Topbar's comments button follows the tab on screen.
 * Flipping it on Artifact leaves Sessions as it was, and Details has none.
 * Read off `aria-pressed` so the default (viewport-dependent) does not matter.
 */
async function expectPerTabCommentsToggle(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: COMMENTS_TOGGLE });
  await expect(toggle).toHaveCount(1);
  const before = await toggle.getAttribute("aria-pressed");
  await toggle.click();
  await expect(toggle).not.toHaveAttribute("aria-pressed", before ?? "");

  await shellTab(page, ArtifactDetailTab.Sessions).click();
  await expect(toggle).toHaveAttribute("aria-pressed", before ?? "");
  await shellTab(page, ArtifactDetailTab.Details).click();
  await expect(toggle).toHaveCount(0);
  await shellTab(page, ArtifactDetailTab.Artifact).click();
  await expect(toggle).not.toHaveAttribute("aria-pressed", before ?? "");
}

/**
 * ISS-10980 (whitlockk, #8619): following the Activity comment row lands on the
 * thread's tab with the comments pane open and that thread marked, through the
 * desktop adapter's own navigation — not merely an href that names it.
 */
async function expectActivityCommentOpensItsThread(page: Page): Promise<void> {
  // Wide, so the pane opens beside the tabs rather than as the narrow modal
  // Sheet the history step leaves the window at, which hides the tab strip.
  await page.setViewportSize(WIDE_VIEWPORT);
  await gotoHash(
    page,
    `/branches/${BRANCH_ID}?${BRANCH_DETAIL_TAB_PARAM}=${ArtifactDetailTab.Activity}`
  );
  await shellPanel(page, ArtifactDetailTab.Activity)
    .getByRole("link", { name: "View comment" })
    .click();

  await expect(shellTab(page, ArtifactDetailTab.Sessions)).toHaveAttribute(
    "aria-selected",
    "true"
  );
  const card = page.locator(`[data-thread-id="${BRANCH_ACTIVITY_THREAD_ID}"]`);
  await expect(card.getByText(ACTIVITY_THREAD_BODY)).toBeVisible();
  await expect(card.locator('[aria-current="true"]')).toHaveCount(1);
}

/**
 * The unified comments read the shell's pane makes: the Branch serves the
 * thread the Activity row addresses, and every rendered Session serves none.
 * The thread has no trace anchor, so the Sessions scope lists it whichever
 * Sessions the timeline renders.
 */
function routeUnifiedComments(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const target = UNIFIED_COMMENTS_PATH.exec(pathname)?.[1];
  if (request.method !== "GET" || target === undefined) {
    return false;
  }
  const page: ArtifactCommentsResponse = {
    artifactId: target,
    capabilities: capabilitiesFor(CommentPolicyKey.NativeBranch),
    nextCursor: null,
    threads:
      target === BRANCH_ID
        ? [
            makeThread({
              anchor: null,
              artifactId: BRANCH_ID,
              comments: [
                makeComment({
                  body: ACTIVITY_THREAD_BODY,
                  threadId: BRANCH_ACTIVITY_THREAD_ID,
                }),
              ],
              id: BRANCH_ACTIVITY_THREAD_ID,
              surface: CommentSurface.BranchTimeline,
            }),
          ]
        : [],
  };
  writeApiResult(response, page);
  return true;
}

function shellTab(page: Page, tab: ArtifactDetailTab) {
  return page.getByRole("tab", {
    exact: true,
    name: ARTIFACT_DETAIL_TAB_LABELS[tab],
  });
}

function shellPanel(page: Page, tab: ArtifactDetailTab) {
  return page.getByRole("tabpanel", {
    exact: true,
    name: ARTIFACT_DETAIL_TAB_LABELS[tab],
  });
}

/**
 * The roving tabindex's next stop, read from the shared order (which wraps)
 * rather than named here, so an approved reorder does not look like a
 * keyboard-navigation regression.
 */
function tabAfter(tab: ArtifactDetailTab): ArtifactDetailTab {
  const index = BRANCH_ARTIFACT_TABS.indexOf(tab);
  return BRANCH_ARTIFACT_TABS[(index + 1) % BRANCH_ARTIFACT_TABS.length];
}

async function expectBranchDetailRequestBudget(
  page: Page,
  server: AuthenticatedBranchCloudServer
) {
  await page.clock.install();
  await gotoHash(page, `/branches/${BRANCH_ID}`);
  await expect(
    page.getByRole("combobox", { name: "Pull request" })
  ).toBeVisible({ timeout: 30_000 });
  const detailReads = () =>
    server.requests.filter(
      (request) => request.pathname === `/branches/${BRANCH_ID}`
    ).length;
  expect(detailReads()).toBe(1);
  await page.clock.runFor(120_001);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("visibilitychange"));
    window.setTimeout(() => {
      document.body.dataset.branchFreshnessBarrier = "settled";
    }, 0);
  });
  await page.clock.runFor(1);
  await expect(page.locator("body")).toHaveAttribute(
    "data-branch-freshness-barrier",
    "settled"
  );
  expect(detailReads()).toBe(1);
  await page.clock.resume();
}

/**
 * davetho on PR #8898: `artifact-detail-shell` must not change what a branch
 * with no line counts says. The flag-off `BranchPropertiesPanel` renders the
 * approved word, so the shell's Changes row has to stay drawn and render it
 * too — the empty-row rule otherwise removes the row on this side of the flag
 * only. Desktop and web resolve ONE PostHog key at their own mount, so each
 * host needs its own proof that the shared shell honours it.
 */
async function expectChangesRowWithoutLineCounts(
  page: Page,
  dropLineCounts: () => void
): Promise<void> {
  dropLineCounts();
  // A hash change alone would re-render off the cached detail read.
  await page.reload();
  await gotoHash(
    page,
    `/branches/${BRANCH_ID}?${BRANCH_DETAIL_TAB_PARAM}=${ArtifactDetailTab.Details}`
  );
  const details = shellPanel(page, ArtifactDetailTab.Details);
  await expect(
    details.getByRole("heading", { name: "Branch details" })
  ).toBeVisible();
  // Positive control on the same panel: the Pull Request row proves Details
  // re-rendered off the new read, so the Changes assertion cannot pass on an
  // empty panel.
  await expect(
    details.locator('[data-details-field="pull-requests"]')
  ).toHaveCount(1);
  const changes = details.locator('[data-details-field="changes"]');
  await expect(changes).toHaveCount(1);
  await expect(changes).toContainText(BRANCH_UNAVAILABLE_LABEL);
}
