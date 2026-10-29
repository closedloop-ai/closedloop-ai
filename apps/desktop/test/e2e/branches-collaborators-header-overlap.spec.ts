/**
 * ISS-12307, the Electron half of the pair; the web half is
 * `e2e/branches-collaborators-header-overlap.spec.ts`. Both assert through
 * `expectCollaboratorsCellUnderTableHeader`, which carries the stacking
 * contract and why a green run on one shell says nothing about the other.
 *
 * What is this shell's alone: desktop mounts the list through
 * `src/renderer/components/branches/branches-view.tsx` and its own
 * `branches-scroll-container`, against a live authenticated cloud server, so
 * the ancestors that decide the paint-order tie here are not the browser
 * shell's. Covering both is what the root `AGENTS.md` rule for `packages/app`
 * surfaces requires.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
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
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity.ts";
import { ReadSource } from "@repo/api/src/types/read-source.ts";
import { BRANCH_PAGE_SIZE } from "@repo/app/branches/lib/branch-filter-params.ts";
import { REPOSITORY } from "../../../../e2e/helpers/branch-details-comprehensive-data";
import { makeAnalytics } from "../../../../e2e/helpers/branches-surface-fixtures";
import { expectCollaboratorsCellUnderTableHeader } from "../../../../e2e/helpers/collaborators-header-paint-order";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  seedAuthenticatedDesktopSession,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud";
import { branchListRowFixture } from "./helpers/branch-list-row-fixture";
import {
  drainedCloudReadReadiness,
  gotoHash,
  seedDesktopSettings,
} from "./helpers/desktop-app";

const PROFILE_ID = "iss-12307-collaborators-header-overlap-profile";
/** Five people against a visible cap of three, so the `+N` chip must render. */
const CROWD = [
  "Ada Lovelace",
  "Grace Hopper",
  "Alan Turing",
  "Edsger Dijkstra",
  "Barbara Liskov",
];
const HIDDEN_COUNT = CROWD.length - 3;
/** A full page of rows, so the list scrolls without a pager in the way. */
const ROW_COUNT = BRANCH_PAGE_SIZE;
/** Short enough that rows must travel under the header to be reached at all. */
const VIEWPORT = { height: 520, width: 1280 };
/**
 * `steps: null` walks the scroller's whole range rather than a tuned window,
 * because the Electron window's own chrome sets the band this surface has to
 * travel and it is not the browser shell's.
 */
const PROBE_SCAN = { firstScrollTop: 2, stepPx: 2, steps: null };
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_ACTIVITY_AT = new Date(Date.now() - ONE_DAY_MS).toISOString();

test("Desktop Branches keeps the Collaborators cell under the table header", async () => {
  test.setTimeout(240_000);
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-12307-claude-")
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-12307-codex-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-12307-udd-"));
  const server = await startAuthenticatedBranchCloudServer({
    analyticsFactory: makeAnalytics,
    listFactory: crowdedListResponse,
    repositoryFullNames: [REPOSITORY],
  });

  try {
    const seed = await launchAuthenticatedDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      userDataDir,
    });
    try {
      await seedAuthenticatedDesktopSession(seed.app, userDataDir);
    } finally {
      await seed.cleanup();
    }

    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
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
              name: "ISS-12307 Collaborators Header Overlap E2E",
              relayOrigin: "http://127.0.0.1:9",
              webAppOrigin: "http://127.0.0.1:3000",
            },
          ],
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
      await page.setViewportSize(VIEWPORT);
      await gotoHash(page, "/branches");

      await expectCollaboratorsCellUnderTableHeader(page, {
        // The list arrives over the cloud read, not from a route mock.
        cellTimeoutMs: 30_000,
        chipLabel: `+${HIDDEN_COUNT}`,
        scan: PROBE_SCAN,
      });
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
  }
});

function crowdedListResponse(): BranchListResponse {
  return {
    hasMore: false,
    items: Array.from({ length: ROW_COUNT }, (_, index) =>
      crowdedRow(`iss-12307-crowded-${index}`)
    ),
    readSource: ReadSource.Cloud,
    total: ROW_COUNT,
    viewerScope: BranchViewerScope.Organization,
  };
}

/**
 * Both the flat `collaborators` and the canonical projection's copy, because
 * the shared row adapter prefers the projection and falls back to the flat
 * field — a row that set only one would stop proving which it read.
 */
function crowdedRow(id: string): BranchRow {
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
  const collaborators = crowdedCollaborators();
  return {
    ...base,
    canonicalProjection: {
      ...projection,
      common: {
        ...projection.common,
        people: { ...projection.common.people, collaborators },
      },
    },
    collaborators,
  };
}

/** The wire shape: a `BranchCollaborators` object, not a flat person array. */
function crowdedCollaborators(): BranchCollaborators {
  return {
    availability: BranchIdentityAvailability.Complete,
    people: CROWD.map((name, index) => ({
      displayName: name,
      id: `github-user-${index}`,
      provider: BranchPersonProvider.GitHub,
    })),
    sources: {
      [BranchCollaboratorSource.BranchComments]:
        BranchIdentityAvailability.Complete,
      [BranchCollaboratorSource.PullRequestAuthors]:
        BranchIdentityAvailability.Complete,
      [BranchCollaboratorSource.PullRequestComments]:
        BranchIdentityAvailability.Complete,
      [BranchCollaboratorSource.Pushes]: BranchIdentityAvailability.Complete,
      [BranchCollaboratorSource.SessionComments]:
        BranchIdentityAvailability.Complete,
    },
  };
}
