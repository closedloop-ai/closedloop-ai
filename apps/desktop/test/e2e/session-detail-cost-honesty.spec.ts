/**
 * ISS-5565 (Electron twin): the session-detail Properties panel does not
 * fabricate measurements it never took, through the LAUNCHED desktop renderer.
 *
 * PR #4642 review (chatgpt-codex-connector, P1): the fix shipped with
 * package-level render tests only, which mount the shared component against a
 * hand-built fixture and therefore cannot see the adapter that actually feeds it
 * here. That gap is real rather than theoretical — `SessionDetailView.tsx` mounts
 * the SAME `@repo/app` `AgentSessionDetailView` the web app does, so the markup
 * and CSS are byte-identical across surfaces, but the DATA behind it comes from
 * entirely different producers: the cloud detail projection on web, the local
 * SQLite read (`shared-agent-sessions-api.ts` `buildLocalSessionTraceFields`) here. The
 * honesty this spec pins lives in that producer — `autonomy: session.autonomy ??
 * null` and `steeringEpisodes: session.steeringEpisodes ?? null` — and a regression
 * that changed either `?? null` to `?? 0` would leave every web test green while
 * the desktop detail quietly reported a measured floor for something nobody
 * measured. Per `apps/desktop/AGENTS.md` a renderer UI fix needs a real-surface
 * regression on EACH adapter, not one plus an assumption; the sibling
 * `activity-phase-label-parity.spec.ts` exists for the same reason on the same
 * screen.
 *
 * WHAT THIS ADAPTER REACHES, AND WHAT IT DELIBERATELY DOES NOT
 * -----------------------------------------------------------
 * A freshly seeded session is exactly the state the fix is about: nothing has
 * derived an autonomy score for it and nothing has counted its steering
 * episodes, so both arrive at the renderer as SQL NULL. No seeder lever is
 * needed to provoke it — the absence IS the default, which is precisely why the
 * pre-fix coercion was so easy to miss.
 *
 * The ISS-5563 sub-cent bar-label and bucket-tooltip precision assertions stay
 * on their package-level tests and the new `activity-bucket-tooltip` stories:
 * reaching them here would require seeding a priced token-event corpus whose
 * per-bucket division lands under a cent, and the figure would then be produced
 * by the shared formatter this spec does not own. Likewise the ISS-5564
 * confidence-basis footer, which is Labs-gated and needs a seeded activity
 * tiling carrying a 0%-confidence phase with nonzero spend — that surface
 * already has its own desktop twin in `activity-phase-label-parity.spec.ts`.
 *
 * Every assertion is anchored on a POSITIVE precondition first — the session
 * title, then the named Properties row itself — so a panel that never mounted
 * fails rather than satisfying a "does not say 0" assertion vacuously.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 *     (an isolated CODEX_HOME keeps the operator's real Codex rollouts out of
 *     the seeded store)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { gotoHash, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const UNMEASURED_SESSION_ID = "iss-5565-unmeasured-session";
const UNMEASURED_SESSION_NAME = "ISS-5565 unmeasured session";

const SESSION_TITLE_SELECTOR = ".sd3-head h1";
const PROPERTY_ROW_SELECTOR = ".prd-prop";

const MOUNT_TIMEOUT_MS = 30_000;

/**
 * The pre-fix strings, kept as literals rather than derived from the component.
 * A constant imported from the source would follow the source if it regressed;
 * these have to be spelled out to stay a trip-wire.
 *
 * `0/100` was the Autonomy row's fabricated floor — rendered beside the word
 * "Unknown", so the row contradicted itself and a reader takes the number.
 * `0 steers` asserted a measured absence of human steering on a session where
 * steering was never counted at all, which reads identically to a genuinely
 * autonomous run.
 */
const FABRICATED_AUTONOMY_FLOOR = "0/100";
const FABRICATED_STEERING_FLOOR = "0 steers";

test.describe("session detail reports unmeasured properties honestly", () => {
  test("a session with no derived autonomy or steering count shows neither a floor score nor a zero steer count", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-cost-honesty-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts alongside the
    // seeded corpus.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-cost-honesty-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-cost-honesty-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
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
        { name: UNMEASURED_SESSION_NAME, sessionId: UNMEASURED_SESSION_ID },
      ]);

      // Launch 2 — the real local detail read projects the seeded row.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await openSessionDetail(
          page,
          UNMEASURED_SESSION_ID,
          UNMEASURED_SESSION_NAME
        );
        await expandProperties(page);

        const autonomyRow = propertyRow(page, "Autonomy");
        await expect(autonomyRow).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        // The defect itself: a tier word beside a floor number, on a score that
        // was never derived.
        await expect(autonomyRow).not.toContainText(FABRICATED_AUTONOMY_FLOOR);
        // …and the reason rides the row's accessible name (ISS-5581), so the
        // dash is reachable as an explanation rather than as a bare glyph.
        await expect(autonomyRow).toContainText(
          "Autonomy was not recorded for this session"
        );

        const workRow = propertyRow(page, "Work");
        await expect(workRow).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        // Positive precondition: the row really is the Work row and really did
        // render its steering counter, so the negative assertion below cannot
        // pass simply because the counter is absent.
        await expect(workRow).toContainText("steers");
        await expect(workRow).not.toContainText(FABRICATED_STEERING_FLOOR);

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });
});

/**
 * The Properties panel is a DISCLOSURE, collapsed on first paint, so every row
 * this spec reads is behind one click. Expanding it is also the load-bearing
 * precondition for the two "does not say 0" assertions: an unexpanded panel
 * renders no rows at all, and a spec that skipped this would report the fix
 * holding on a screen that never showed the values.
 *
 * `exact: true` because `getByRole` matches accessible names by substring —
 * without it the locator would also admit any future control whose name merely
 * contains the word.
 */
async function expandProperties(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Properties", exact: true });
  await expect(toggle).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await toggle.click();
}

/**
 * One Properties row, located by its own label rather than by position. The
 * panel's row order is not a contract and shifts as rows are added; the label is.
 */
function propertyRow(page: Page, label: string): Locator {
  return page
    .locator(PROPERTY_ROW_SELECTOR)
    .filter({ has: page.getByText(label, { exact: true }) });
}

/**
 * Drive the renderer to a session detail and wait until THAT session's panel is
 * on screen. The title is the first barrier because `gotoHash` only assigns
 * `window.location.hash` and returns, while the Properties panel is rendered by
 * every session and would already be satisfied by a previously-mounted screen.
 */
async function openSessionDetail(
  page: Page,
  sessionId: string,
  sessionName: string
): Promise<void> {
  await gotoHash(page, `/sessions/${sessionId}`);
  await expect(page.locator(SESSION_TITLE_SELECTOR)).toHaveText(sessionName, {
    timeout: MOUNT_TIMEOUT_MS,
  });
}
