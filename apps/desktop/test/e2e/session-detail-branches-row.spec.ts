/**
 * ISS-8427 (desktop adapter): the session-detail Properties pane must list EVERY
 * branch the session touched — through a LAUNCHED Electron app reading
 * cloud-mode session detail.
 *
 * The Electron twin of `e2e/session-detail-branches-row.spec.ts`. Both shells
 * mount the same `SessionPropertiesPanel` from `packages/app`, and
 * `apps/desktop/AGENTS.md` requires both adapters be covered for exactly the
 * divergence this closes: the web spec drives an HTTP detail read through the
 * browser shell, while desktop reaches the same panel through its own cloud
 * source, hash router, and referrer adapter. A regression in any of those would
 * leave desktop on the scalar row with the web spec and the mounted component
 * tests all green (davetho, PR #6245).
 *
 * WHY CLOUD MODE IS STRUCTURAL HERE. `branches` has one producer,
 * `deriveTouchedBranches` in `apps/api/app/agent-sessions/service.ts`. The
 * desktop LOCAL SQLite read never emits the field, so a local-path spec
 * asserting the plural row CANNOT FAIL — it would grade the omitted-set
 * fallback and call it a pass. `helpers/session-detail-authenticated-cloud.ts`
 * carries that warning in full.
 *
 * TWO ARMS. Gate ON serves six branches and asserts six destinations; gate OFF
 * serves the SAME response and asserts the single-branch row, which is what
 * proves the desktop LABS TOGGLE is wired rather than the row being
 * unconditional (ISS-4779 closed-by-default).
 *
 * Build before running: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { SessionBranch } from "@repo/api/src/types/agent-session";
// `.ts` is load-bearing on this VALUE import: extensionless specifiers do not
// resolve under the spec loader, and a spec-level import failure aborts the
// WHOLE desktop-e2e suite at load.
import { NavReferrerSurface } from "@repo/app/shared/lib/nav-referrer.ts";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  createAuthenticatedDesktopSessionRecord,
} from "./helpers/branch-details-authenticated-cloud";
import { drainedCloudReadReadiness, gotoHash } from "./helpers/desktop-app";
import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";
import {
  CLOUD_SESSION_DETAIL_ID,
  isAuthenticatedCloudSessionDetailRead,
  seedCloudSessionDetailProfile,
  startAuthenticatedSessionDetailCloudServer,
} from "./helpers/session-detail-authenticated-cloud";

/**
 * The reported session's six eligible branches (ISS-8427), in the wire's
 * `createdAt asc` order. The LAST is the one the single-branch row shows on its
 * own, so an assertion that only found that name would be satisfied by the
 * unfixed build — and by the gate-OFF arm below.
 */
const BRANCH_NAMES = [
  "worktree-pln-1775-m3-m5",
  "worktree-iss-5517-facet-counts",
  "worktree-iss-5551-cost-rollup",
  "worktree-iss-5705-status-fold",
  "worktree-iss-5871-timeline-bands",
  "worktree-iss-bundled-pr-page-size",
] as const;

/** The one the scalar row names, and the only one visible with the gate shut. */
const ATTRIBUTED_BRANCH_NAME = "worktree-iss-bundled-pr-page-size";

/**
 * The ISS-8427 Labs toggle, spelled as a LITERAL for the loader reason above.
 * Pinned against the registry by `feature-flags-cross-surface.test.ts`, so a
 * rename fails there rather than silently leaving this spec seeding a key
 * nothing reads.
 */
const TOUCHED_BRANCHES_FLAG_KEY = "session-touched-branches";

/**
 * A SECOND desktop Labs flag, seeded ON in both arms as the gate barrier rather
 * than as a variable — see its assertion below.
 */
const READ_SOURCE_BADGE_FLAG_KEY = "session-detail-read-source";

const MOUNT_TIMEOUT_MS = 30_000;
/** The original subject retains its existing load budget. */
const ARM_TIMEOUT_MS = 240_000;

test.describe("Session detail Branches row, desktop cloud read (ISS-8427)", () => {
  test("every branch the session touched renders, each addressing its own branch detail", async () => {
    test.setTimeout(ARM_TIMEOUT_MS);

    await withCloudSessionDetail(async (page) => {
      const row = propertyRow(page, "Branches");
      await expect(row).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

      for (const name of BRANCH_NAMES) {
        await expect(
          row.getByRole("link", { exact: true, name })
        ).toBeVisible();
      }

      // Each pill is its OWN destination, through the desktop's hash router and
      // referrer adapter. `?from=session` is what makes the branch detail's Back
      // return to Sessions rather than to the static Branches list (FEA-4262).
      for (const name of BRANCH_NAMES) {
        await expect(
          row.getByRole("link", { exact: true, name })
        ).toHaveAttribute("href", branchDestination(name));
      }
    });
  });
});

function branches(): SessionBranch[] {
  return BRANCH_NAMES.map((name) => ({
    branchArtifactId: `artifact-${name}`,
    name,
  }));
}

/**
 * The hash destination the desktop shell composes for one branch pill.
 *
 * Written out rather than composed through `branchDetailHref` on purpose: an
 * expectation built by the same helper the shell builds with would agree with a
 * broken helper. This is the shape `session-detail-branch-link.spec.ts` already
 * asserts for the SINGULAR row.
 */
function branchDestination(branchName: string): string {
  return `#/branches/${encodeURIComponent(`artifact-${branchName}`)}?from=${NavReferrerSurface.Session}`;
}

/**
 * Addresses a Properties row by its LABEL, scoped to the visible pane.
 *
 * A page-wide text probe is not this row: the shell renders "Branches" in its
 * primary nav as well, and a keep-alive-hidden view can hold a second copy of
 * the pane — the same reason and the same selector the web twin uses.
 */
function propertyRow(page: Page, label: string): Locator {
  return page
    .locator(`.prd-props .prd-prop:has(.prd-prop-label:text-is("${label}"))`)
    .locator("visible=true");
}

/** The read-source badge: proof the renderer APPLIED the seeded flag payload. */
function readSourceBadge(page: Page): Locator {
  return page.getByTestId("read-source-badge");
}

/** Initializes the schema before the real subject seals and restores its session. */
async function withCloudSessionDetail(
  assertOn: (page: Page) => Promise<void>
): Promise<void> {
  // Server first: it is the only step here that can throw before the `try`, so
  // creating the temp dirs after it keeps every dir inside the `finally`.
  const server = await startAuthenticatedSessionDetailCloudServer({
    detailOverrides: {
      branch: ATTRIBUTED_BRANCH_NAME,
      branchArtifactId: `artifact-${ATTRIBUTED_BRANCH_NAME}`,
      branches: branches(),
    },
  });
  // Empty harness homes: a local row for this session id would let the LOCAL
  // read answer, and that read emits no `branches` at all — the gate-ON arm
  // would then grade the omitted-set fallback and call it a pass.
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-8427-claude-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-8427-codex-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-8427-udd-"));

  try {
    await initializeDesktopProfileSchema(userDataDir);
    await waitForBranchesSchema(userDataDir);

    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      beforeLaunch: (launchUserDataDir) => {
        seedCloudSessionDetailProfile(launchUserDataDir, server.origin, {
          // ON in BOTH arms, including the gate-OFF one: this is the barrier,
          // not a variable. See its assertion below.
          [READ_SOURCE_BADGE_FLAG_KEY]: true,
          [TOUCHED_BRANCHES_FLAG_KEY]: true,
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

      await gotoHash(page, `/sessions/${CLOUD_SESSION_DETAIL_ID}`);

      /*
       * The gate as the RENDERER APPLIED it, which is not what the profile was
       * seeded with and not what the `getE2eSeededFeatureFlags` IPC answers.
       *
       * `DesktopFeatureFlagProvider` starts every desktop flag CLOSED and
       * unresolved (OFF for both keys here) and replaces the whole set when its
       * OWN seeded assignment settles. Probing that IPC from the spec reads the
       * MAIN process, which has held the seeded value since before launch, so it
       * answers `true` on the first poll whether or not React has applied
       * anything — a barrier that cannot fail (whitlockk cid 3843327378).
       *
       * It is the gate-OFF arm this protects: flag-unresolved and
       * flag-resolved-OFF both render the scalar row, so no assertion on the row
       * itself can tell them apart and `toHaveCount(0)` resolves on its first
       * poll. `READ_SOURCE_BADGE_FLAG_KEY` rides the SAME assignment payload
       * and is applied by the SAME provider update, so its rendered badge
       * proves the payload landed. The badge also withholds itself until the
       * detail read has produced a row, which is exactly the state in which the
       * pane below is worth reading.
       */
      await expect(readSourceBadge(page)).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });

      await openPropertiesPane(page);
      await assertOn(page);

      // The arm graded the CLOUD read. Without this a silent fall back to the
      // local path — which emits no `branches` at all — would satisfy the
      // gate-OFF arm and look like a working toggle.
      expect(
        server.requests.filter(isAuthenticatedCloudSessionDetailRead).length,
        "the desktop shell never issued the cloud session-detail read"
      ).toBeGreaterThanOrEqual(1);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
}

/**
 * `SessionPropertiesPanel` initialises its `open` state to `false`, so no
 * Properties row is in the DOM until the pane is opened. `visible=true` scopes
 * past any keep-alive-hidden view.
 */
async function openPropertiesPane(page: Page): Promise<void> {
  await page
    .getByRole("button", { exact: true, name: "Properties" })
    .locator("visible=true")
    .first()
    .click();
}
