/**
 * ISS-8361 (PRD-690) — the desktop half of the cross-surface route matrix for
 * the shell the `shell-sidebar-v2` rollout mounts. The web half is
 * `e2e/shell-sidebar-v2-route-matrix.spec.ts`.
 *
 * Through the REAL desktop flag adapter: the seeded assignment reaches the
 * renderer over the E2E seam and is read by `DesktopFeatureFlagProvider`
 * through the same boundary a PostHog reply takes.
 *
 * 1. DEFAULT-OFF. With every desktop gate open and no answer for the rollout
 *    key — PostHog has no such flag yet — the legacy sidebar renders.
 * 2. REACHABILITY. Every destination the v2 desktop tree offers, default and
 *    Labs, is clicked from the v2 sidebar and lands on its own view. The launch
 *    first proves it is in the v2 tree, because the legacy sidebar offers the
 *    same rows and would satisfy a matrix that never checked.
 * 3. ACCESSIBILITY. The v2 sidebar, Labs expanded, passes the WCAG A/AA axe
 *    rules, and Labs opens from the keyboard.
 *
 * The destinations and their landmarks are `helpers/shell-route-matrix.ts`,
 * pinned to the navigation contract by `test/shell-route-matrix-coverage.test.ts`
 * because this file cannot import the contract.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import axe from "axe-core";
import { WCAG_AA_TAGS } from "../../../../packages/app/test/a11y/axe.ts";
import {
  closeServer,
  createAuthenticatedDesktopSessionRecord,
} from "./helpers/branch-details-authenticated-cloud";
import { activeNavPanel, gotoHash } from "./helpers/desktop-app";
import {
  currentHashRoute,
  launchShellSidebarApp,
  startNavigationCloudServer,
} from "./helpers/shell-navigation-cloud";
import {
  DESKTOP_OPEN_NAV_GATES,
  DESKTOP_ROUTE_MATRIX,
  SHELL_SIDEBAR_V2_WIRE_KEY,
} from "./helpers/shell-route-matrix";

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Window augmentation types the axe runtime injected into Electron.
  interface Window {
    axe: typeof axe;
  }
}

const OPEN_GATES: Record<string, boolean> = Object.fromEntries(
  DESKTOP_OPEN_NAV_GATES.map((key) => [key, true])
);
const V2_FLAGS: Record<string, boolean> = {
  ...OPEN_GATES,
  [SHELL_SIDEBAR_V2_WIRE_KEY]: true,
};
/** The rollout key is ABSENT, which is what a key PostHog never created reads as. */
const UNASSIGNED_FLAGS: Record<string, boolean> = OPEN_GATES;

const PROFILE_ID = "iss-8361-shell-route-matrix-profile";
const PROFILE_NAME = "ISS-8361 Shell Route Matrix E2E";
const SHELL_TIMEOUT_MS = 120_000;
const NAV_READY_TIMEOUT_MS = 30_000;
const DESTINATION_TIMEOUT_MS = 15_000;
/** The route poll and the landmark — the two waits each step declares. */
const DESTINATION_WAITS = 2;
/**
 * Thirteen destinations in one launch: the launch allowance plus every wait the
 * walk declares, so a slow destination fails on its OWN timeout and names its
 * step. A flat cap below that sum leaves the per-step timeouts unreachable once
 * the walk is far enough in, and one slow destination then reports as a
 * whole-test timeout naming nothing (review, #7756).
 */
const MATRIX_TIMEOUT_MS =
  SHELL_TIMEOUT_MS +
  DESKTOP_ROUTE_MATRIX.length * DESTINATION_WAITS * DESTINATION_TIMEOUT_MS;
const SIDEBAR_SELECTOR = '[data-sidebar="sidebar"]';
const LABS_SECTION_NAME = "Labs";
/** Only the v2 tree nests a second Artifacts disclosure, inside Labs (PLN-2016 D2). */
const ARTIFACTS_SECTION_NAME = "Artifacts";
const V2_ARTIFACTS_SECTION_COUNT = 2;
const LEGACY_ARTIFACTS_SECTION_COUNT = 1;

test.describe("shell-sidebar-v2 — the desktop route matrix (ISS-8361)", () => {
  test("renders the legacy sidebar while the assignment carries no rollout key", async () => {
    test.setTimeout(SHELL_TIMEOUT_MS);
    await withShell(
      UNASSIGNED_FLAGS,
      "desktop-shell-matrix-off-",
      async (page) => {
        // This wait IS the renderer-applied assignment signal. The legacy Labs
        // section exists only while the PostHog `labsNav` gate reads open
        // (`navigation/use-nav-gates.ts` hides every Labs id otherwise, and
        // `Sidebar.tsx` drops the section once it is empty), and that answer can
        // only come from an assignment the renderer has applied. So the count
        // below cannot be satisfied by the pending, fail-closed render — which
        // shows Dashboard but no Labs at all.
        await openLabs(page);
        // The same count the matrix below asserts as 2: the legacy tree has one
        // Artifacts disclosure, and a shell that failed to render has none.
        await expect(artifactsSections(page)).toHaveCount(
          LEGACY_ARTIFACTS_SECTION_COUNT
        );
      }
    );
  });

  test("reaches every default and Labs destination from the v2 sidebar", async () => {
    test.setTimeout(MATRIX_TIMEOUT_MS);
    await withShell(V2_FLAGS, "desktop-shell-matrix-on-", async (page) => {
      await openLabs(page);
      await expect(artifactsSections(page)).toHaveCount(
        V2_ARTIFACTS_SECTION_COUNT
      );

      // The launch lands on Dashboard, so the walk starts one row down and
      // comes back to it last.
      const walk = DESKTOP_ROUTE_MATRIX.slice(1).concat(
        DESKTOP_ROUTE_MATRIX.slice(0, 1)
      );
      for (const destination of walk) {
        await test.step(`reaches ${destination.label}`, async () => {
          // Labs persists open across navigation, but a view can re-render the
          // sidebar, so each step re-checks rather than assumes.
          await openLabs(page);
          await sidebarRow(page, destination.label).click();

          await expect
            .poll(() => currentHashRoute(page), {
              timeout: DESTINATION_TIMEOUT_MS,
            })
            .toBe(`/${destination.navId}`);
          await expect(
            destination.landmark(activeNavPanel(page, destination.navId))
          ).toBeVisible({ timeout: DESTINATION_TIMEOUT_MS });
          // The shell recognises where it is standing (PLN-2016 D8).
          await expect(sidebarRow(page, destination.label)).toHaveAttribute(
            "data-active",
            "true"
          );
        });
      }
    });
  });

  test("passes the WCAG A/AA rules with Labs expanded, and opens Labs from the keyboard", async () => {
    test.setTimeout(SHELL_TIMEOUT_MS);
    await withShell(V2_FLAGS, "desktop-shell-matrix-a11y-", async (page) => {
      const labs = labsTrigger(page);
      await expect(labs).toHaveAttribute("aria-expanded", "false", {
        timeout: NAV_READY_TIMEOUT_MS,
      });

      await labs.focus();
      await page.keyboard.press("Enter");

      await expect(labs).toHaveAttribute("aria-expanded", "true");
      await expect(artifactsSections(page)).toHaveCount(
        V2_ARTIFACTS_SECTION_COUNT
      );
      await page.evaluate((source) => {
        Function(source)();
      }, axe.source);
      // The WHOLE sidebar, footer included. Unlike the web half, this scan does
      // NOT paint `GuidedGettingStartedCard`: `startNavigationCloudServer` 404s
      // `/onboarding/guided/snapshot`, so the card renders null and goes
      // unswept here (follow-up: ISS-11549). The two footers are different
      // components (`DesktopSidebarFooterItems` here,
      // `use-web-shell-navigation.tsx`'s slot there), so neither host sweeps the
      // other's.
      const results = await page.locator(SIDEBAR_SELECTOR).evaluate(
        (sidebar, tags) =>
          window.axe.run(sidebar, {
            resultTypes: ["violations"],
            runOnly: { type: "tag", values: [...tags] },
          }),
        WCAG_AA_TAGS
      );
      expect(
        results.violations.flatMap((violation) =>
          violation.nodes.map((node) => `${violation.id}: ${node.target}`)
        )
      ).toEqual([]);
    });
  });
});

/**
 * One authenticated launch on Dashboard with `flags` as the account's
 * assignment, torn down whatever `body` does. Fails the case on any renderer
 * page error.
 */
async function withShell(
  flags: Record<string, boolean>,
  prefix: string,
  body: (page: Page) => Promise<void>
): Promise<void> {
  const server = await startNavigationCloudServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    const { page, pageErrors, cleanup } = await launchShellSidebarApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      apiOrigin: server.origin,
      flags,
      profileId: PROFILE_ID,
      profileName: PROFILE_NAME,
      userDataDir,
    });
    try {
      await gotoHash(page, "/dashboard");
      await expect(sidebarRow(page, "Dashboard")).toBeVisible({
        timeout: NAV_READY_TIMEOUT_MS,
      });
      await body(page);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await closeServer(server.server);
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
}

function labsTrigger(page: Page): Locator {
  return page
    .locator(SIDEBAR_SELECTOR)
    .getByRole("button", { name: LABS_SECTION_NAME });
}

/** Expand Labs if it is closed; both desktop trees ship it closed. */
async function openLabs(page: Page): Promise<void> {
  const labs = labsTrigger(page);
  if ((await labs.getAttribute("aria-expanded")) !== "true") {
    await labs.click();
  }
  await expect(labs).toHaveAttribute("aria-expanded", "true");
}

function sidebarRow(page: Page, label: string): Locator {
  return page
    .locator(SIDEBAR_SELECTOR)
    .getByRole("link", { exact: true, name: label });
}

function artifactsSections(page: Page): Locator {
  return page
    .locator(SIDEBAR_SELECTOR)
    .getByRole("button", { exact: true, name: ARTIFACTS_SECTION_NAME });
}
