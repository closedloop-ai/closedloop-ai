/**
 * ISS-11273 — the auth status LEAVING the pending set, through the launched app.
 *
 * The operator-facing bug was a sidebar workspace menu stuck on the literal word
 * "Loading" for the life of the process after a web sign-in. Nothing in the
 * renderer was wrong: `desktop-workspace-menu-host-adapter.ts` maps every pending
 * `DesktopAuthStatus` to `WorkspaceMenuProjectionStatus.Pending` and the trigger
 * renders that word. The main process simply never settled the status, because
 * `app.ts` fires `restore()` and only LOGS a rejection.
 *
 * The manager suite (`test/desktop-session-manager-settlement.test.ts`) pins the
 * settlement at the authority. What only a booted Electron app can prove is the
 * rest of the chain — `DesktopSessionManager` → `publishDesktopAuthState` →
 * `sendToRenderer` → preload → the auth provider → the menu — surviving, which is
 * what `apps/desktop/test/AGENTS.md` requires of a UI bug fix.
 *
 * The throw is PRODUCTION-SHAPED, not injected: a persisted `apiOrigin` that
 * fails `normalizeAndValidateOrigin`. `desktop-services.ts` resolves the session
 * manager's origin through that validator on every call, so the seeded profile
 * below makes `baseClientArgs()` throw inside the refresh the restore awaits —
 * exactly the first of the two reachable causes the fix names. No stand-in cloud
 * is needed: the throw happens before any request is built.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { WORKSPACE_MENU_TRIGGER_LABEL } from "@repo/api/src/types/workspace-menu.ts";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import { createAuthenticatedDesktopSessionRecord } from "./helpers/branch-details-authenticated-cloud";
import { gotoHash, seedDesktopSettings } from "./helpers/desktop-app";

const SPEC_TIMEOUT_MS = 180_000;
const STEP_BUDGET_MS = 30_000;
const HEADER_REGION = '[data-sidebar="header"]';

/**
 * A persisted origin `new URL()` cannot parse, so `normalizeAndValidateOrigin`
 * throws its "Origin must be a valid URL" arm — the configuration failure a user
 * reaches by editing a profile, not a network condition.
 */
const UNPARSEABLE_API_ORIGIN = "closedloop";

/**
 * The words the trigger renders for the two projections this spec separates.
 * Held as literals on purpose: they are what the OPERATOR saw, so a rename must
 * fail here loudly rather than move the assertion somewhere it matches nothing.
 */
const PENDING_TRIGGER_WORD = "Loading";
const ERROR_TRIGGER_WORD = "Account unavailable";

test("a restore that cannot resolve its origin settles the workspace menu instead of stranding Loading", async () => {
  test.setTimeout(SPEC_TIMEOUT_MS);
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-auth-settlement-e2e-")
  );
  try {
    const { page, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          apiOrigin: UNPARSEABLE_API_ORIGIN,
          cloudConnectionEnabled: true,
        });
      },
      userDataDir,
    });
    try {
      await gotoHash(page, "/dashboard");

      const trigger = page
        .locator(HEADER_REGION)
        .getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL });
      await expect(trigger).toBeVisible({ timeout: STEP_BUDGET_MS });

      // THE REGRESSION. `toContainText` rather than `toHaveText`, because the
      // trigger's text content is the avatar initial CONCATENATED with the word
      // ("AAccount unavailable") — an exact match would fail on a correct
      // render. It retries to the budget, so a status that never settles fails
      // here on the word the operator reported rather than on a timeout with no
      // subject, and it cannot pass on the guest arm either, which reads
      // "Guest".
      await expect(trigger).toContainText(ERROR_TRIGGER_WORD, {
        timeout: STEP_BUDGET_MS,
      });
      await expect(trigger).not.toContainText(PENDING_TRIGGER_WORD);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
});
