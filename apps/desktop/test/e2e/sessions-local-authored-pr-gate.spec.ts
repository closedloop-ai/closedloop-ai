/**
 * ISS-4922 (wongk review on PR #4274): the Labs wiring for
 * `localSessionAuthoredPrGate`, proven through the LAUNCHED Electron app.
 *
 * The unit tests cover `localSessionPullRequests` with the boolean passed
 * explicitly, which proves the PREDICATE but not the WIRING — that a persisted
 * `SettingsStore` flag reaches the pure leaf through the composition root's
 * `setLocalSessionAuthoredPrGateResolver` registration, the main-process
 * `mapListItem`, the IPC boundary, and the renderer's session-detail
 * "Pull requests" row. Every one of those hops is a place the flag could fail to
 * arrive while every unit test stayed green.
 *
 * So this drives the SAME seeded corpus twice against the same store:
 *   1. flag OFF (the registry default) — the REFERENCED-only PR still renders a
 *      pill, today's behavior, which is why the flag is closed-by-default.
 *   2. flag ON — that pill is gone and the row reads its "None" empty state.
 *
 * Both halves matter. Without (1) a spec that only asserted the ON state could
 * pass against a renderer that never showed any pill at all; and the ON half
 * asserts the row's EMPTY-STATE text rather than merely the pill's absence, so
 * it cannot pass by the pane failing to render.
 *
 * Only a REFERENCED link is seeded. A CREATED ref would additionally have to
 * clear the FEA-4188 orphaned-authored-write rule (which needs a resolved branch
 * write in the same repository), so pairing one in as a positive control would
 * make the spec depend on branch seeding for a fact the empty-state text already
 * establishes.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  gotoHash,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  seedSessionPullRequestLinks,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

/**
 * ISS-4922: the gate's Labs flag key, pinned as a LITERAL rather than imported
 * from `src/shared/feature-flags`.
 *
 * That module is main-process code whose transitive imports include
 * extension-less TypeScript subpaths of workspace packages. Vite/vitest resolve
 * them; Playwright's Node loader does not, and importing the registry from a
 * spec aborts the WHOLE Electron e2e run at load time before any test executes.
 * Sibling specs (`sessions-status-pill-sync-fold`, `db-ahead-banner`,
 * `sessions-quarantine-caveat`) pin their keys the same way for the same reason.
 *
 * Drift is caught elsewhere: `test/feature-flags.test.ts` asserts the registry
 * defines this exact key, so a rename fails there rather than silently making
 * this spec seed a flag nothing reads.
 */
const LOCAL_SESSION_AUTHORED_PR_GATE_FLAG_KEY = "localSessionAuthoredPrGate";

const SESSION_ID = "iss-4922-mixed-pr-session";
const SESSION_NAME = "iss-4922 mixed pr session";
const REPO = "closedloop-ai/symphony-alpha";
const REFERENCED_PR_NUMBER = 4275;
/**
 * `SESSION_EMPTY_PULL_REQUESTS_LABEL` (`@repo/app`'s `detail-content`) — the
 * session-detail empty PR-row copy, which ISS-5366 shipped unconditionally when
 * the `session-loc-pr-attribution` gate retired to its enabled state. Pinned as
 * a LITERAL for the same module-resolution reason as the flag key above:
 * `detail-content` reaches extension-less `@repo/api`/`@repo/app` subpaths that
 * Playwright's Node loader cannot resolve. Drift is caught by
 * `packages/app/agents/components/detail/__tests__/session-pull-requests-row.test.tsx`,
 * which pins the constant's value against the rendered row.
 */
const EMPTY_PULL_REQUESTS_LABEL = "None authored";
/** The session-detail heading, the per-session barrier after a hash navigation. */
const SESSION_TITLE_SELECTOR = ".sd3-head h1";
/**
 * The collapsed Properties pane's summary button (`SessionPropertiesPreview`).
 * Clicking it expands the pane that mounts `SessionPullRequestsRow`.
 */
const PROPERTIES_PREVIEW_SELECTOR = ".sd3-props-preview";
const MOUNT_TIMEOUT_MS = 45_000;

test.describe("Local session Authored PR gate (ISS-4922)", () => {
  test("an enabled Labs flag removes the referenced-only PR pill on the default Local session path", async () => {
    test.setTimeout(240_000);

    // Isolate both harness homes: unset, the boot collectors read a developer's
    // real ~/.claude and ~/.codex corpora and pollute the seeded store.
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss-4922-claude-")
    );
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-4922-codex-"));
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-4922-udd-"));
    const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      const first = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      // Seed while the app is DOWN (no cross-process WAL contention): one
      // session whose ONLY PR evidence is a REFERENCED mention — the exact shape
      // the gate is about.
      await seedSessionsList(userDataDir, [
        { sessionId: SESSION_ID, name: SESSION_NAME, status: "completed" },
      ]);
      await seedSessionPullRequestLinks(userDataDir, [
        {
          sessionId: SESSION_ID,
          repoFullName: REPO,
          prNumber: REFERENCED_PR_NUMBER,
          relation: "referenced",
        },
      ]);

      // Launch 2 — flag at its registry DEFAULT (off). The pill renders, which
      // is exactly why suppressing it is a user-perceivable removal that has to
      // ship closed-by-default.
      const off = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await openSessionDetail(off.page);
        await expect(
          pullRequestPill(off.page, REFERENCED_PR_NUMBER)
        ).toBeVisible({ timeout: 30_000 });
        expect(off.pageErrors).toEqual([]);
      } finally {
        await off.cleanup();
      }

      // Launch 3 — the SAME store, the SAME corpus, flag persisted ON.
      const on = await launchDesktopApp({
        beforeLaunch: () =>
          seedDesktopFeatureFlags(userDataDir, {
            [LOCAL_SESSION_AUTHORED_PR_GATE_FLAG_KEY]: true,
          }),
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await openSessionDetail(on.page);
        // The empty-state text is the positive control: it proves the row
        // rendered and computed an EMPTY PR set, so the pill assertion below
        // cannot pass vacuously against a pane that never mounted.
        await expect(
          pullRequestsValueCell(on.page).getByText(EMPTY_PULL_REQUESTS_LABEL, {
            exact: true,
          })
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          pullRequestPill(on.page, REFERENCED_PR_NUMBER)
        ).toHaveCount(0);
        expect(on.pageErrors).toEqual([]);
      } finally {
        await on.cleanup();
      }
    } finally {
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });
});

/**
 * Navigate straight to the seeded session's detail route, wait for THAT
 * session's panel, and expand the Properties pane the "Pull requests" row lives
 * in.
 *
 * The expansion is not optional. `SessionPropertiesPanel` initialises its `open`
 * state to `false` and persists nothing, so a freshly-opened session detail
 * renders `SessionPropertiesPreview` — a summary button carrying a PR COUNT and
 * no row, no label, and no pills. `SessionPullRequestsRow` mounts only inside
 * `SessionPropertiesExpanded`, so without the click the row's markup never
 * exists at all and every assertion against it times out on an absent locator
 * rather than on the gate's behavior.
 *
 * The preview button is the control to click rather than the section header:
 * the header TOGGLES, so it would close an already-open pane, whereas the
 * preview only exists while the pane is collapsed and only ever opens it.
 *
 * The title wait comes first as the per-session barrier — the Properties pane
 * renders on EVERY session, so waiting on it alone could be satisfied by a
 * previous screen (the same rule the sibling `session-timeline-axis-window`
 * spec follows).
 */
async function openSessionDetail(page: Page): Promise<void> {
  await gotoHash(page, `/sessions/${SESSION_ID}`);
  await expect(page.locator(SESSION_TITLE_SELECTOR)).toHaveText(SESSION_NAME, {
    timeout: MOUNT_TIMEOUT_MS,
  });
  await page.locator(PROPERTIES_PREVIEW_SELECTOR).click();
  // The row's value cell, not its label text: the cell is the unique anchor
  // every assertion below scopes into, and its presence is what proves the row
  // itself mounted.
  await expect(pullRequestsValueCell(page)).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
}

/**
 * The session-detail "Pull requests" pill for one PR number. `PullRequestPill`
 * renders the bare number in a `.mono` span inside the `.sd3-prs-value` cell, so
 * scope to that cell — the same number appears in the page's other rows (linked
 * artifacts, trace) and a page-wide text query would match those instead.
 */
function pullRequestPill(page: Page, prNumber: number) {
  return pullRequestsValueCell(page).getByText(String(prNumber), {
    exact: true,
  });
}

/** The "Pull requests" row's value cell (`SessionPullRequestsRow`). */
function pullRequestsValueCell(page: Page): Locator {
  return page.locator(".sd3-prs-value");
}
