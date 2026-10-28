/**
 * ISS-12341 regression on the ELECTRON shell: the Details tab's Owner and
 * Created by rows draw the person's photo, and fall back to initials when the
 * URL fails.
 *
 * The Electron twin of `e2e/details-person-row-photo.spec.ts` (whitlockk, PR
 * #8668). Both shells mount `details-design-cells.tsx` through
 * `session-shell-details.tsx` and `branch-shell-details.tsx` — desktop at
 * `src/renderer/components/sessions/SessionDetailView.tsx` and
 * `.../branches/branch-detail-view.tsx` — so `packages/app/AGENTS.md` owes a
 * browser regression on each (operator ruling, PR #8668: checked on
 * `origin/main`, both shells mount it).
 *
 * WHY CLOUD MODE IS STRUCTURAL HERE. The desktop LOCAL SQLite read emits
 * neither `createdBy` nor a person photo, so a local-path spec asserting these
 * rows CANNOT FAIL — `session-detail-shell.spec.ts` asserts Created by is
 * ABSENT on that path. Both arms below therefore reach the authenticated cloud
 * stand-ins, where the payload names the person and the URL.
 *
 * The jsdom cases for this fix mock Radix's `AvatarImage`, which commits only
 * on a real image LOAD; they can claim the `src` reached the DOM and nothing
 * further. `naturalWidth`, polled out of this launched browser, is the half
 * they cannot reach.
 *
 * ISS-12494 adds the Session arm's avatar SIZE (whitlockk, PR #8806): the Owner
 * avatar and the Collaborators avatars below it paint one box, as the web
 * `e2e/details-person-avatar-size.spec.ts` asserts.
 *
 * Outside `DESKTOP_SMOKE_SPECS`: this gates the Details person rows, not every
 * change that runs `desktop-e2e`.
 *
 * Build before running: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import type { BranchPageDetail } from "@repo/api/src/types/branch";
// `.ts` is load-bearing on these VALUE imports: extensionless specifiers do not
// resolve under the spec loader, and a spec-level import failure aborts the
// WHOLE desktop-e2e suite at load.
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab.ts";
import { ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags.ts";
import {
  BRANCH_ID,
  detailFor,
} from "../../../../e2e/helpers/branch-details-comprehensive-data";
import {
  AVATAR_SIZE_COLLABORATOR_SETS,
  AVATAR_SIZE_OWNER,
  avatarSizeCollaboratorBatch,
  expectOwnerAndCollaboratorAvatarsShareOneSize,
} from "../../../../e2e/helpers/details-person-avatar-size";
import {
  DETAILS_SESSION_UPLOADER,
  DetailsPhotoState,
  detailsCreatorFixture,
  detailsOwnerFixture,
  expectDetailsPersonPhotosFellBack,
  expectDetailsPersonPhotosLoaded,
  installDetailsPersonPhotoRoutes,
} from "../../../../e2e/helpers/details-person-row-photo-fixture";
import type { PhotoRouteCounts } from "../../../../e2e/helpers/person-photo-evidence";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  seedAuthenticatedDesktopSession,
  startAuthenticatedBranchCloudServer,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoHash,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";
import {
  CLOUD_SESSION_DETAIL_ID,
  seedCloudSessionDetailProfile,
  startAuthenticatedSessionDetailCloudServer,
} from "./helpers/session-detail-authenticated-cloud";

const BRANCH_PROFILE_ID = "iss-12341-details-person-photo-profile";
const MOUNT_TIMEOUT_MS = 30_000;
/** Two Electron launches per arm, on a machine that may be under load. */
const ARM_TIMEOUT_MS = 300_000;
const WIDE_VIEWPORT = { height: 900, width: 1440 };

test("Session Details Owner and Created by draw a loaded photo, then initials when it fails (ISS-12341)", async () => {
  test.setTimeout(ARM_TIMEOUT_MS);

  // Mutated between the two phases and re-spread on every detail read, so the
  // second phase serves the failing pair to the same launched app. Distinct
  // URLs per state, so no phase can be answered out of the other's HTTP cache.
  // ISS-12251 D-1: the Owner row reads `assignee`; `user` is a third person,
  // so a row still on it fails the Owner assertions.
  const detailOverrides: Partial<AgentSessionDetail> = {
    assignee: detailsOwnerFixture(DetailsPhotoState.Loadable),
    createdBy: detailsCreatorFixture(DetailsPhotoState.Loadable),
    user: DETAILS_SESSION_UPLOADER,
  };
  const server = await startAuthenticatedSessionDetailCloudServer({
    detailOverrides,
  });
  const dirs = makeHarnessDirs();

  try {
    await seedRestorableSession(dirs);
    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      beforeLaunch: (launchUserDataDir) => {
        seedCloudSessionDetailProfile(launchUserDataDir, server.origin, {
          [ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY]: true,
        });
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
      env: {
        CLAUDE_HOME: dirs.claudeHome,
        CL_AUTH_API_ORIGIN: server.origin,
        CODEX_HOME: dirs.codexHome,
      },
      userDataDir: dirs.userDataDir,
    });

    try {
      const counts = await installDetailsPersonPhotoRoutes(page);
      await expectAuthenticated(page);
      await page.setViewportSize(WIDE_VIEWPORT);
      await gotoHash(
        page,
        `/sessions/${CLOUD_SESSION_DETAIL_ID}?tab=${ArtifactDetailTab.Details}`
      );

      const details = await detailsPanel(page);
      await expectDetailsPersonPhotosLoaded(details);
      expect(counts.loadable).toBeGreaterThanOrEqual(2);

      await servePhotoState(page, counts, () => {
        detailOverrides.createdBy = detailsCreatorFixture(
          DetailsPhotoState.Failed
        );
        detailOverrides.assignee = detailsOwnerFixture(
          DetailsPhotoState.Failed
        );
      });
      await expectDetailsPersonPhotosFellBack(await detailsPanel(page), counts);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    cleanupHarnessDirs(dirs);
  }
});

test("Branch Details Owner and Created by draw a loaded photo, then initials when it fails (ISS-12341)", async () => {
  test.setTimeout(ARM_TIMEOUT_MS);

  let photoState: DetailsPhotoState = DetailsPhotoState.Loadable;
  const server = await startAuthenticatedBranchCloudServer({
    // `detailFor` carries neither person, so both rows are undrawn without
    // this: the empty-row rule leaves a blank person out entirely.
    detailFactory: (pullRequestNumber): BranchPageDetail => ({
      ...detailFor(pullRequestNumber),
      assignee: detailsOwnerFixture(photoState),
      createdBy: detailsCreatorFixture(photoState),
    }),
  });
  const dirs = makeHarnessDirs();

  try {
    await seedRestorableSession(dirs);
    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          activeConfigId: BRANCH_PROFILE_ID,
          apiOrigin: server.origin,
          cloudConnectionEnabled: true,
          savedConfigs: [
            {
              apiOrigin: server.origin,
              gatewayId: AUTHENTICATED_GATEWAY_ID,
              id: BRANCH_PROFILE_ID,
              name: "ISS-12341 Details Person Photo E2E",
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
        CLAUDE_HOME: dirs.claudeHome,
        CL_AUTH_API_ORIGIN: server.origin,
        CODEX_HOME: dirs.codexHome,
      },
      userDataDir: dirs.userDataDir,
    });

    try {
      const counts = await installDetailsPersonPhotoRoutes(page);
      await expectAuthenticated(page);
      await page.setViewportSize(WIDE_VIEWPORT);
      await gotoHash(
        page,
        `/branches/${BRANCH_ID}?tab=${ArtifactDetailTab.Details}`
      );

      const details = await detailsPanel(page);
      // The Branch host's own section, so a panel that mounted without the
      // Branch Details config behind it fails HERE rather than on a missing
      // photo.
      await expect(
        details.getByRole("heading", { name: "Branch details" })
      ).toBeVisible();
      await expectDetailsPersonPhotosLoaded(details);
      expect(counts.loadable).toBeGreaterThanOrEqual(2);

      await servePhotoState(page, counts, () => {
        photoState = DetailsPhotoState.Failed;
      });
      await expectDetailsPersonPhotosFellBack(await detailsPanel(page), counts);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    cleanupHarnessDirs(dirs);
  }
});

test("Session Details Owner and Collaborators paint at one avatar size (ISS-12494)", async () => {
  test.setTimeout(ARM_TIMEOUT_MS);

  // One launch serves both sets: the reload between them mounts the second
  // from a cold query cache, the way a different session would arrive.
  let people = AVATAR_SIZE_COLLABORATOR_SETS[0][1];
  const server = await startAuthenticatedSessionDetailCloudServer({
    detailOverrides: {
      assignee: AVATAR_SIZE_OWNER,
      createdBy: DETAILS_SESSION_UPLOADER,
      user: DETAILS_SESSION_UPLOADER,
    },
    extraRoutes: (request, response) => {
      const url = URL.parse(`http://127.0.0.1${request.url ?? "/"}`);
      if (
        request.method !== "GET" ||
        url?.pathname !== "/artifacts/collaborators"
      ) {
        return false;
      }
      writeApiResult(
        response,
        avatarSizeCollaboratorBatch(
          url.searchParams.getAll("artifactIds"),
          people
        )
      );
      return true;
    },
  });
  const dirs = makeHarnessDirs();

  try {
    await seedRestorableSession(dirs);
    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      beforeLaunch: (launchUserDataDir) => {
        seedCloudSessionDetailProfile(launchUserDataDir, server.origin, {
          [ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY]: true,
        });
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
      env: {
        CLAUDE_HOME: dirs.claudeHome,
        CL_AUTH_API_ORIGIN: server.origin,
        CODEX_HOME: dirs.codexHome,
      },
      userDataDir: dirs.userDataDir,
    });

    try {
      await expectAuthenticated(page);
      await page.setViewportSize(WIDE_VIEWPORT);
      await gotoHash(
        page,
        `/sessions/${CLOUD_SESSION_DETAIL_ID}?tab=${ArtifactDetailTab.Details}`
      );
      await expectOwnerAndCollaboratorAvatarsShareOneSize(
        await detailsPanel(page),
        people
      );

      people = AVATAR_SIZE_COLLABORATOR_SETS[1][1];
      await page.reload();
      await expectAuthenticated(page);
      await expectOwnerAndCollaboratorAvatarsShareOneSize(
        await detailsPanel(page),
        people
      );
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    cleanupHarnessDirs(dirs);
  }
});

type HarnessDirs = {
  claudeHome: string;
  codexHome: string;
  userDataDir: string;
};

function makeHarnessDirs(): HarnessDirs {
  return {
    // Empty harness homes: a local row for this session id would let the LOCAL
    // read answer, and that read emits no person photo at all.
    claudeHome: fs.mkdtempSync(path.join(os.tmpdir(), "iss-12341-claude-")),
    codexHome: fs.mkdtempSync(path.join(os.tmpdir(), "iss-12341-codex-")),
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "iss-12341-udd-")),
  };
}

function cleanupHarnessDirs(dirs: HarnessDirs): void {
  for (const dir of [dirs.userDataDir, dirs.codexHome, dirs.claudeHome]) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

/**
 * The first launch exists to write the session: the seed encrypts through
 * Electron's own `safeStorage`, so it needs a live app, and the production
 * restore lane reads that file only at boot.
 */
async function seedRestorableSession(dirs: HarnessDirs): Promise<void> {
  const seedLaunch = await launchAuthenticatedDesktopApp({
    env: { CLAUDE_HOME: dirs.claudeHome, CODEX_HOME: dirs.codexHome },
    userDataDir: dirs.userDataDir,
  });
  try {
    // Schema first, THEN the safeStorage write: the seed uses `app.evaluate`,
    // which throws while the boot navigation is still in flight.
    await waitForBranchesSchema(dirs.userDataDir);
    await seedAuthenticatedDesktopSession(seedLaunch.app, dirs.userDataDir);
  } finally {
    await seedLaunch.cleanup();
  }
}

async function expectAuthenticated(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.desktopApi.getDesktopAuthState()))
    .toMatchObject({
      organizationId: AUTHENTICATED_ORGANIZATION_ID,
      status: DesktopAuthStatus.Authenticated,
      userId: AUTHENTICATED_USER_ID,
    });
}

async function detailsPanel(page: Page): Promise<Locator> {
  const panel = page.getByRole("tabpanel", { exact: true, name: "Details" });
  await expect(panel).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  return panel;
}

/**
 * Re-serves the detail read after `mutate` re-points the payload.
 *
 * A reload rather than a refetch: the renderer holds the first answer in its
 * query cache, and the point of the second phase is a payload the component
 * has never seen, mounted from cold the way a different session would arrive.
 * The route handlers are page-scoped and survive it.
 */
async function servePhotoState(
  page: Page,
  counts: PhotoRouteCounts,
  mutate: () => void
): Promise<void> {
  mutate();
  const servedBefore = counts.failed;
  await page.reload();
  await expectAuthenticated(page);
  await expect.poll(() => counts.failed).toBeGreaterThan(servedBefore);
}
