/**
 * ISS-5567 regression, on the ELECTRON adapter: the session detail's Branch row
 * is a LIVE link to that branch's detail page.
 *
 * The bug: the shared Properties pane
 * (`packages/app/agents/components/detail/agent-session-detail-view.tsx`) gates
 * the link on `session.branch && session.branchArtifactId && getBranchHref`. The
 * desktop renderer supplied the builder, but nothing on the desktop path ever
 * populated `branchArtifactId` — so the same session rendered a link on web and
 * inert mono text on desktop.
 *
 * Why this spec exists ALONGSIDE the mounted tests (codex review on #4650, and
 * the "UI bug fix ⇒ regression e2e" rule in `apps/desktop/AGENTS.md`): the
 * renderer tests stub `agentSessionsApi.detail` with an already-constructed route
 * id, so they prove the SHELL renders what it is handed and that the id parses.
 * They cannot fail if the production chain breaks. This one seeds a real branch
 * artifact into the real SQLite store and drives
 *   SQLite → db-host worker → IPC → renderer → Properties pane → click → route,
 * which is the whole path ISS-5567 actually changed. It fails without the fix:
 * before it, the Branch row had no anchor at all.
 *
 * The load-bearing assertion is the CLICK, not the href. An href is a string; the
 * branch detail mounting on the id this pane minted is what makes the row a
 * destination. That round trip also pins the two halves of the id agreeing —
 * `encodeBranchId` in the main-process resolver and `decodeBranchId` in the
 * branch detail read — through the real router rather than a unit-level
 * `matchRoute` call.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
// Explicit `.ts` extensions: the Playwright runner resolves these deep paths
// itself and neither `@repo/api` nor `@repo/app` ships an `exports` map, so an
// extensionless specifier does not resolve at run time (same note as
// `activity-phase-label-parity.spec.ts`). Importing the real encoders/constants
// rather than hand-writing the id keeps this spec honest: a change to either
// would move the expected href with it.
import { encodeBranchId } from "@repo/api/src/types/branch.ts";
import { NavReferrerSurface } from "@repo/app/shared/lib/nav-referrer.ts";
import {
  breadcrumbParentLink,
  gotoHash,
  launchDesktopApp,
} from "./helpers/desktop-app";
import { startFakeGitHubAuthorityServer } from "./helpers/fake-github-authority-server";
import {
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SEED = {
  activityAt: "2026-05-22T12:00:00.000Z",
  branchName: "iss-5567-session-detail-branch-link",
  repoFullName: "acme/web",
  sessionId: "iss-5567-session-detail-branch-link-session",
} as const;

/**
 * The route id the desktop main process resolves for this seed
 * (`session-branch-route.ts` → `encodeBranchId`), and the id the Branches list
 * mints for the same `(repo, branch)` pair. The desktop navigation adapter
 * renders it hash-prefixed, and `desktopBranchDetailHref` percent-encodes the
 * already-encoded composite once more (`acme%2Fweb::iss-5567-…`) — the exact
 * shape `branches-row-click.spec.ts` asserts on the list side.
 */
const BRANCH_ID = encodeBranchId({
  branchName: SEED.branchName,
  repoFullName: SEED.repoFullName,
});
// FEA-4262: the Branch link carries `?from=session` so the branch detail's Back
// returns to the sessions surface the user came from.
const BRANCH_LINK_HREF = `#/branches/${encodeURIComponent(BRANCH_ID)}?from=${NavReferrerSurface.Session}`;
const BRANCH_DETAIL_HASH = /^#\/branches\/.+/;

const SESSION_TITLE_SELECTOR = ".sd3-head h1";
const PROPERTIES_SECTION_SELECTOR = "section.prd-props-section";
const PROPERTIES_BUTTON_NAME = "Properties";
const BRANCH_ROW_LABEL = "Branch";
const MOUNT_TIMEOUT_MS = 30_000;

test.describe("Session detail Branch link (ISS-5567)", () => {
  test("the Branch row links to the branch detail, and the detail opens on it", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-session-branch-link-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts alongside the seed.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-session-branch-link-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-session-branch-link-udd-")
    );
    const authorityServer = await startFakeGitHubAuthorityServer([
      SEED.repoFullName,
    ]);

    try {
      // Launch 1 — create + migrate the SQLite schema, then close so the seed
      // writes with the app DOWN (a running app does not observe another
      // process's writes to its own store).
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      // A `kind='branch'` artifact plus the `git_push` write link the resolver
      // reads. This is the whole corpus ISS-5567 needs: the branch identity the
      // route id is built from lives on the ARTIFACT, not on the session.
      await seedNoPullRequestBranch(userDataDir, SEED);

      // Launch 2 — the real local detail read projects the seeded corpus.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: {
          CLAUDE_HOME: claudeHome,
          CODEX_HOME: codexHome,
          ...authorityServer.env,
        },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoHash(page, `/sessions/${SEED.sessionId}`);
        await expect(page.locator(SESSION_TITLE_SELECTOR)).toHaveText(
          SEED.sessionId,
          { timeout: MOUNT_TIMEOUT_MS }
        );

        // Open the pane. `visible=true` scopes past any keep-alive-hidden view.
        const propertiesSection = page
          .locator(PROPERTIES_SECTION_SELECTOR)
          .locator("visible=true")
          .first();
        await expect(propertiesSection).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await page
          .getByRole("button", { name: PROPERTIES_BUTTON_NAME })
          .locator("visible=true")
          .first()
          .click();
        await expect(propertiesSection).toHaveAttribute("data-open", "true");

        // ── the Branch row is an anchor, not the inert text it used to be ──
        const branchRow = propertiesSection.locator(
          `div.prd-prop:has(span.prd-prop-label:text-is("${BRANCH_ROW_LABEL}"))`
        );
        await expect(branchRow).toHaveCount(1);
        await expect(branchRow).toContainText(SEED.branchName);

        const branchLink = branchRow.locator("a");
        // The regression: pre-fix this count is 0 — the row rendered the branch
        // name as a `<span>`, because the desktop payload carried no
        // `branchArtifactId` for the shared gate to open on.
        await expect(branchLink).toHaveCount(1, {
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(branchLink).toHaveAttribute("href", BRANCH_LINK_HREF);

        // Focusable — a `<span>` styled to look identical would fail this
        // silently, the same half of the contract ISS-4793 settled for PR pills.
        await branchLink.focus();
        await expect(branchLink).toBeFocused();

        await page.screenshot({
          fullPage: true,
          path: test.info().outputPath("session-detail-branch-link.png"),
        });

        // ── and it is a destination: the branch detail opens on this id ──
        await branchLink.click();
        await expect
          .poll(() => page.evaluate(() => window.location.hash), {
            timeout: 15_000,
          })
          .toMatch(BRANCH_DETAIL_HASH);

        // Detail mounted ON THIS BRANCH, not the not-found state: the branch
        // detail's own title is the seeded branch name, and its "Branch details"
        // tab is present. That is what proves the id the session pane minted
        // decoded back to the same record — through the real store — rather than
        // merely matching a route that exists.
        await expect(
          page.getByRole("heading", { level: 1, name: SEED.branchName })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(
          page.getByRole("tab", { name: "Branch details" })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // FEA-4262: the `?from=session` the Branch link carries is honored — the
        // breadcrumb parent is the SESSIONS surface the user came from, not the
        // static "Branches" parent a directly-opened branch detail shows.
        await expect(breadcrumbParentLink(page, "Sessions")).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await authorityServer.close();
      fs.rmSync(userDataDir, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
    }
  });
});
