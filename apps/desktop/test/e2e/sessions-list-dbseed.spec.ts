/**
 * E2E deep flow (FEA-2939): the Sessions view — list → detail → back — proven
 * against a DB-direct seed.
 *
 * `sessions-flow.spec.ts` drives the transcript importer and is entirely
 * quarantined (`test.fixme`) by the FEA-2187 read-your-writes WAL race: the
 * imported rows intermittently do not surface in the list. As a result the
 * Sessions view — the primary desktop surface — had NO passing spec asserting
 * that rows appear at all.
 *
 * This spec closes that gap the same way the Branches specs did: it seeds the
 * rows straight into the app's SQLite store while the app is DOWN (no
 * cross-process WAL contention) and reads them on the NEXT boot, so there is no
 * importer race to flake on. The Sessions read path projects the `sessions`
 * table directly (no artifact/link join), so a bare seeded row is enough.
 *
 * Flow, the way a user would drive it:
 *   1. the seeded sessions appear in the Sessions list,
 *   2. clicking a row opens the session detail, and
 *   3. the Topbar breadcrumb's "Sessions" parent link returns to the list.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

test.describe("Sessions list (DB-direct seed, FEA-2939)", () => {
  test("seeded sessions list, open detail, and navigate back", async () => {
    test.setTimeout(180_000);
    const seededSessions = createSeededSessions();
    const targetSession = seededSessions[TARGET_SESSION_INDEX];

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-dbseed-claude-")
    );
    // Isolate CODEX_HOME too: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts into the store,
    // polluting the seeded corpus this spec asserts on.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-dbseed-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-dbseed-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      // EMPTY CLAUDE_HOME/CODEX_HOME so the collectors ingest nothing: the only
      // rows are the ones we seed, so the list is a deterministic corpus.
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

      // Seed the sessions straight into the store while the app is DOWN.
      await seedSessionsList(userDataDir, seededSessions);

      // Launch 2 — the real Sessions IPC source reads the seeded corpus at boot.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "sessions");

        // The seed stamps `last_activity_at` to now, so the rows are in-window on
        // every range; widen to "All time" anyway to be independent of the run
        // clock. `:visible` scopes to the Sessions toolbar (keep-alive views stay
        // mounted-but-hidden and also render this control).
        await page.locator('[aria-label="All time"]:visible').click();

        // The Sessions view is a full-width, table-led page: its title shows only
        // in the Topbar breadcrumb, with no in-body <h1>. Assert the seeded rows
        // themselves render (the coverage the quarantined spec cannot provide).
        for (const session of seededSessions) {
          await expect(
            page.getByRole("link", { name: session.name })
          ).toBeVisible({ timeout: 30_000 });
        }

        const visibleSessionLinkNames = await visibleSeededSessionLinkNames(
          page,
          seededSessions
        );
        expect(visibleSessionLinkNames).toContain(targetSession.name);
        expect(visibleSessionLinkNames[0]).toBeDefined();
        expect(visibleSessionLinkNames[0]).not.toBe(targetSession.name);

        // Open a non-first session's detail by clicking its session-name link.
        await page.getByRole("link", { name: targetSession.name }).click();

        // On the detail page the Topbar breadcrumb gains a "Sessions" parent
        // *link* (on the list page "Sessions" is the current-page span, not a
        // link) — a reliable "detail mounted" signal and the back affordance.
        // Scope to the Breadcrumb nav so the sidebar's Sessions link can't
        // satisfy it.
        const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
        const backLink = breadcrumb.getByRole("link", { name: "Sessions" });
        await expect(backLink).toBeVisible({ timeout: 30_000 });
        await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(
          targetSession.name
        );

        // The hash navigated to the detail route for the clicked session id.
        await expect
          .poll(() => page.evaluate(() => window.location.hash), {
            timeout: 15_000,
          })
          .toContain(`/sessions/${targetSession.sessionId}`);

        // Clicking the parent link returns to the list: the breadcrumb's
        // "Sessions" link reverts to the current-page span (so the link is gone)
        // and the list rows are visible again.
        await backLink.click();
        await expect(backLink).toHaveCount(0, { timeout: 15_000 });
        await expect(
          page.getByRole("link", { name: targetSession.name })
        ).toBeVisible();

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

type NamedSessionListSeed = SessionListSeed & { name: string };

const SESSION_SEED_DEFINITIONS = [
  { sessionId: "fea-2939-sessions-alpha", name: "fea-2939 sessions alpha" },
  { sessionId: "fea-2939-sessions-bravo", name: "fea-2939 sessions bravo" },
  { sessionId: "fea-2939-sessions-charlie", name: "fea-2939 sessions charlie" },
] as const satisfies readonly Pick<
  NamedSessionListSeed,
  "name" | "sessionId"
>[];
const TARGET_SESSION_INDEX = 1;
const SEED_TIME_STEP_MS = 60_000;

function createSeededSessions(): NamedSessionListSeed[] {
  const now = Date.now();

  return SESSION_SEED_DEFINITIONS.map((session, index) => {
    const timestamp = new Date(now - index * SEED_TIME_STEP_MS).toISOString();
    return {
      ...session,
      at: timestamp,
      lastActivityAt: timestamp,
    };
  });
}

function visibleSeededSessionLinkNames(
  page: Page,
  sessions: NamedSessionListSeed[]
): Promise<string[]> {
  return page.locator("a:visible").evaluateAll(
    (links, names: string[]) =>
      links
        .map((link) => link.textContent?.trim() ?? "")
        .filter((name) => names.includes(name)),
    sessions.map((session) => session.name)
  );
}
