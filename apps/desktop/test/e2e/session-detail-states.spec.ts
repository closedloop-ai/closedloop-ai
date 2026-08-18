/**
 * Session DETAIL not-found state on the ELECTRON adapter (ISS-5593).
 *
 * The ISS-5579 inventory of the 46 pre-existing Sessions specs found detail
 * error and detail empty uncovered on BOTH surfaces. On desktop the gap was
 * total: a grep for "Session not found" across `apps/desktop/test/e2e/` before
 * this file returned zero hits, so nothing proved that asking the renderer for
 * a session it does not have produces an honest empty state rather than a blank
 * screen, a crash, or a permanent skeleton.
 *
 * It is not a cosmetic state. The desktop detail read is a LOCAL SQLite read
 * over IPC (`local-agent-sessions-data-source.ts`): a `null` result is turned
 * into a 404 `ApiError`, which `classifySessionDetailError` routes to
 * `NotPresent`. Everything else routes to `ProviderError`. A user who follows a
 * stale deep link, or opens a session that has not synced to this machine yet,
 * lands exactly here.
 *
 * ## What this file deliberately does NOT cover, and why
 *
 * **`SessionDetailProviderError` is not reachable from this harness.** Driving
 * it needs `desktopApi.agentSessionsApi.detail(id)` to throw a NON-transient
 * error, and there is no fault-injection seam: no env var, no `beforeLaunch`
 * hook, no helper. The levers that do exist land elsewhere on purpose — killing
 * or corrupting the db host raises `isTransientDbHostError`, which `runSource`
 * converts to a `TransientSourceError` routed to the quiet reconnecting surface
 * rather than the hard error card, and corrupting `agent-dashboard.sqlite`
 * between launches fails at migration long before any detail read.
 *
 * So the provider-error branch is covered where it CAN be driven honestly: the
 * web twin `e2e/session-detail-states.spec.ts` fulfils a real 500 through the
 * same shared `AgentSessionDetailView`, which owns the branch for both
 * adapters. This spec pins the desktop half and states the limitation instead
 * of faking it — the same pattern `session-detail-properties.spec.ts` uses for
 * the absent `linkedArtifacts`.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { SESSION_DETAIL_LOADING_SLOT } from "@repo/app/agents/lib/session-detail-slots.ts";
import { gotoHash, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

// A session that IS present, so the not-found assertions below are proven to be
// about the missing id and not about the renderer failing to mount at all.
const PRESENT_SESSION = {
  name: "ISS-5593 present session",
  sessionId: "iss-5593-desktop-states-present",
} as const;
// An id no seed ever wrote. The local read resolves `null` for it.
const ABSENT_SESSION_ID = "iss-5593-desktop-states-absent";

// Copy owned by the shared `agent-session-detail-states.tsx`, pinned as
// literals because that module is a `"use client"` React component: importing
// it from here would abort the whole Electron suite at load
// (apps/desktop/test/AGENTS.md, "Import hazard"). The slot constant above is
// NOT pinned, precisely because it was moved to a React-free lib module that
// carries an explicit `.ts` extension — the sanctioned form.
const NOT_FOUND_TITLE = "Session not found";
const NOT_FOUND_DESCRIPTION =
  "This session isn't in your history. It may have been deleted, or it hasn't synced yet.";
const BACK_TO_SESSIONS_LABEL = "Back to Sessions";
// The heading every non-loaded state carries so the route is never headless
// (ISS-5008); it is `sr-only`, which Playwright still resolves.
const SESSION_PAGE_HEADING = "Session";
const SESSION_TITLE_SELECTOR = ".sd3-head h1";
const LOADING_SLOT_SELECTOR = `[data-slot="${SESSION_DETAIL_LOADING_SLOT}"]`;
/** Where "Back to Sessions" must land — the desktop shell's list route. */
const SESSIONS_LIST_HASH_PATTERN = /#\/sessions$/;
/**
 * The Sessions list toolbar's date-range control — the barrier for "the list
 * mounted", chosen for what it does NOT depend on.
 *
 * Not a grid header (`[role="columnheader"][data-column-id="cost"]`): the first
 * version of this assertion used one and went red on Linux CI with
 * `element(s) not found`, because the runner's narrower window renders the
 * Sessions list in its CARD layout, which has no column headers at all. It
 * passed locally purely because the mac window was wide enough.
 *
 * Not a seeded ROW either: that would make "did the list mount" hostage to
 * which sessions the boot collectors ingested and to whatever the default
 * facets hide, neither of which is this test's subject. (Locally the collectors
 * pulled in an unrelated real session and the seed did not appear in the list at
 * all, which a row-keyed barrier would have reported as a navigation failure.)
 *
 * The `DateRangeFilter` is in the toolbar above the results in BOTH layouts,
 * renders regardless of how many rows the read returns, and is addressed the
 * same way by several green desktop specs (`all-views-smoke-seeded`,
 * `branch-details`). Nothing on the session-detail route renders one.
 */
const SESSIONS_RANGE_CONTROL_SELECTOR = '[aria-label="All time"]';
const MOUNT_TIMEOUT_MS = 30_000;
const LOADING_SLOT_SEEN_KEY = "__iss5593LoadingSlotSeen";

test.describe("Session detail missing-session state (ISS-5593)", () => {
  test("an unknown session id renders the honest not-found state, not a blank screen", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5593-states-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts alongside the
    // seed.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5593-states-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5593-states-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, then close so the seed
      // writes with the app DOWN.
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

      await seedSessionsList(userDataDir, [
        { name: PRESENT_SESSION.name, sessionId: PRESENT_SESSION.sessionId },
      ]);

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        // Control: the seeded session DOES load through this same route, so a
        // green not-found below cannot be the renderer failing to reach detail.
        //
        // The recorder is armed FIRST because the pending state is a real but
        // short window on a warm local read — a polled locator would race it.
        // A MutationObserver records whether the loading state was ever in the
        // DOM, which is a fact about what rendered, not about how long it took,
        // so nothing here is a timing assertion. Same technique as the
        // breadcrumb recorder in `sessions-detail-route-switch.spec.ts`.
        await armLoadingSlotRecorder(page);
        await gotoHash(page, `/sessions/${PRESENT_SESSION.sessionId}`);
        await expect(
          page.locator(SESSION_TITLE_SELECTOR).locator("visible=true")
        ).toHaveText(PRESENT_SESSION.name, { timeout: MOUNT_TIMEOUT_MS });

        // The third state: the route showed its own pending surface on the way
        // in, rather than a blank frame or a stale previous screen. This is also
        // what proves the loading-slot locator used negatively below is a
        // locator that CAN match.
        expect(await readLoadingSlotSeen(page)).toBe(true);
        // …and it is gone once the session resolved.
        await expect(
          page.locator(LOADING_SLOT_SELECTOR).locator("visible=true")
        ).toHaveCount(0);

        // The case under test.
        await gotoHash(page, `/sessions/${ABSENT_SESSION_ID}`);

        const notFoundTitle = page
          .getByText(NOT_FOUND_TITLE)
          .locator("visible=true");
        await expect(notFoundTitle).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(
          page.getByText(NOT_FOUND_DESCRIPTION).locator("visible=true")
        ).toBeVisible();
        // The route still names its subject, so heading navigation lands
        // somewhere real even when the read found nothing.
        await expect(
          page
            .getByRole("heading", { name: SESSION_PAGE_HEADING, exact: true })
            .locator("visible=true")
        ).toBeVisible();

        // A real way out, pointing at the list this session would be in.
        const back = page
          .getByRole("link", { name: BACK_TO_SESSIONS_LABEL, exact: true })
          .locator("visible=true");
        await expect(back).toBeVisible();

        // Exclusivity. These two are not idle negatives: the previous session
        // rendered `.sd3-head h1` through this same locator moments ago, and the
        // recorder above proved the loading slot really does appear on this
        // route — so both are matchable, and their absence here is a real
        // statement about which state the route settled on.
        await expect(
          page.locator(SESSION_TITLE_SELECTOR).locator("visible=true")
        ).toHaveCount(0);
        await expect(
          page.locator(LOADING_SLOT_SELECTOR).locator("visible=true")
        ).toHaveCount(0);

        // PROBE
        // …and it is a way out that WORKS. A link that merely exists is not an
        // exit: this href could point back at the detail route the user is
        // already stuck on and every assertion above would still be green
        // (wongk, #4669). Click it, and prove the Sessions LIST is what mounted
        // on the other side — which also drives the desktop hash-navigation
        // adapter end to end, the one piece of this route no shared-component
        // assertion can reach.
        await back.click();
        await expect(page).toHaveURL(SESSIONS_LIST_HASH_PATTERN);
        await expect(
          page
            .locator(SESSIONS_RANGE_CONTROL_SELECTOR)
            .locator("visible=true")
            .first()
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        // The not-found surface is behind us rather than merely overlaid.
        await expect(
          page.getByText(NOT_FOUND_TITLE).locator("visible=true")
        ).toHaveCount(0);

        // NOT asserted here: that "Session unavailable" is absent. It reads
        // like the obvious third exclusion — a missing session must never be
        // reported as a provider outage — but on THIS adapter that assertion
        // could not fail. `SessionDetailProviderError` is unreachable from the
        // desktop harness (see the docstring), so the string never renders in
        // this suite at all, and a `toHaveCount(0)` on it would pass whether or
        // not the routing were correct. That is precisely the vacuous-assertion
        // defect this ticket exists to eliminate, so it is left out rather than
        // written for symmetry. The not-found-vs-provider-error exclusion IS
        // asserted, on the web twin (`e2e/session-detail-states.spec.ts`),
        // where a real 500 proves the string renders and a real 404 proves it
        // does not — both through the same shared component.

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
    }
  });
});

/**
 * Records whether the shared `SessionDetailLoading` surface ever entered the
 * DOM, from before the navigation that would produce it.
 *
 * Addressed by `data-slot`, not by a role or an accessible name: the pending
 * surface's only text is an `sr-only` heading shared with both error states, so
 * a name-based probe would report true for a route that went straight to
 * "Session not found" — the recorder would then be unfalsifiable, which is the
 * exact trap the sibling breadcrumb recorder documents.
 */
async function armLoadingSlotRecorder(page: Page): Promise<void> {
  await page.evaluate(
    ({ key, selector }) => {
      const hasLoadingSlot = () => document.querySelector(selector) !== null;
      const globalScope = globalThis as unknown as Record<string, unknown>;
      globalScope[key] = hasLoadingSlot();
      const observer = new MutationObserver(() => {
        if (hasLoadingSlot()) {
          globalScope[key] = true;
        }
      });
      observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
      });
    },
    { key: LOADING_SLOT_SEEN_KEY, selector: LOADING_SLOT_SELECTOR }
  );
}

/** Reads back what {@link armLoadingSlotRecorder} observed. */
function readLoadingSlotSeen(page: Page): Promise<boolean> {
  return page.evaluate(
    (key) => (globalThis as unknown as Record<string, unknown>)[key] === true,
    LOADING_SLOT_SEEN_KEY
  );
}
