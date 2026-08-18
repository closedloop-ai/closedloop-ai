/**
 * E2E regression (ISS-4836, closing the gap left by ISS-4772 / PR #4194): the
 * desktop Sessions renderer, proven through the LAUNCHED Electron app.
 *
 * ISS-4772 fixed two renderer latches; it shipped render tests but no
 * launched-app regression, which `apps/desktop/AGENTS.md` ("E2E Coverage for UI
 * Surfaces") requires for a renderer UI bug fix. This spec drives the sharper of
 * the two — the detail A → B switch — through a real Electron window, a real
 * SQLite store, and the real lazy detail chunk:
 *
 *   1. Launch once to create + migrate the store, then close.
 *   2. Seed TWO sessions with distinct names while the app is down.
 *   3. Relaunch and open session B FIRST, so B's detail query is WARM — a
 *      populated cache entry under `staleTime: Infinity`.
 *   4. Return to the list and open session A.
 *   5. Navigate straight to session B's route — a detail → detail switch with no
 *      intervening list — and assert the view actually became B.
 *
 * Warming B in step 3 removes a real confound (wongk review on PR #4266): an
 * UNCACHED query key fetches normally whether or not the component remounted,
 * so with B cold the switch exercises a plain first fetch rather than the
 * cache-hit path the ISS-4772 `key={detailSessionId}` guarantee is about.
 *
 * What this spec does NOT do is attribute the outcome to that remount, and the
 * docstring previously claimed it did — that claim was wrong and is withdrawn.
 * Verified by removing `key={detailSessionId}` and re-running against a real
 * build: the spec still passes. The reason is
 * `applyDesktopSessionsListPollDefaults`, which gives `agentSessionKeys.details()`
 * a 5s `refetchInterval` with `refetchIntervalInBackground: true` — so a reused
 * instance is healed by the background poll (~7s later, well inside any honest
 * assertion timeout) and reaches the same end state as a remount. Separating the
 * two here would mean asserting B's name arrives BEFORE the poll fires, i.e. a
 * timing assertion, which `scripts/lint/rules/no-timing-assertions.ts` bans.
 *
 * So the remount is pinned where component identity is unambiguous instead:
 * `app-shell-live-route-switch.test.tsx` → "REMOUNTS the detail view on a detail
 * A -> B switch", which counts MOUNTS of the detail view and fails
 * (`["s-a"]` vs `["s-a", "s-b"]`) the moment the key is removed. What THIS spec
 * pins is the end-to-end user-visible outcome through a real Electron window, a
 * real SQLite store, and the real lazy detail chunk: a detail → detail switch
 * with no intervening list ends up showing B's own name and not A's.
 *
 * It also pins the ISS-4839 behavior in the launched app, on BOTH ends of the
 * hold: the breadcrumb's trailing segment is observed in its PENDING state on
 * the cold open (recorded by a MutationObserver armed before navigation, so a
 * short-lived state cannot be missed the way a polled locator can), and it ends
 * up carrying the session's REAL name rather than a placeholder noun. Asserting
 * only the settled name would prove nothing, since a trail that parked
 * "Sessions / Session" for the whole load converges on the same end state.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  breadcrumbNav,
  breadcrumbParentLink,
  gotoHash,
  gotoNav,
  launchDesktopApp,
  openDetailFromList,
} from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

// `satisfies` rather than a type annotation: `SessionListSeed.name` is optional,
// and the breadcrumb assertions below pass `.name` to `getByText`, which takes
// `string | RegExp`. An annotation would widen these literals to
// `string | undefined` and the assertions would silently accept an absent name.
const SESSION_A = {
  sessionId: "iss-4836-session-a",
  name: "iss-4836 alpha session",
} satisfies SessionListSeed;
const SESSION_B = {
  sessionId: "iss-4836-session-b",
  name: "iss-4836 bravo session",
} satisfies SessionListSeed;

const SESSIONS_CRUMB = "Sessions";
/**
 * The accessible name the ISS-4839 PENDING breadcrumb segment carries while a
 * session name is still resolving. Distinguishing: a slot holding the static
 * noun "Session" carries no such name, so observing this is what proves the
 * trail held rather than parking a placeholder.
 *
 * Mirrors `DETAIL_FALLBACK_LABELS.session`, pinned as a LITERAL rather than
 * imported. `src/renderer/components/route-fallbacks` pulls in
 * `@closedloop-ai/design-system` and `@repo/api/src/types/...` — extension-less
 * TypeScript subpaths of workspace packages. Vite/vitest resolve them;
 * Playwright's Node loader does not, and importing one from a spec aborts the
 * WHOLE Electron e2e run at load time before any test executes. Sibling specs
 * (`db-ahead-banner`, `sessions-local-authored-pr-gate`) pin their constants the
 * same way for the same reason.
 */
const PENDING_SESSION_CRUMB_LABEL = "Loading session";

test.describe("Sessions detail route switch (ISS-4836 / ISS-4772)", () => {
  test("switching detail A → B lands on B and resolves B's own name, not A's", async () => {
    test.setTimeout(180_000);

    // Isolate BOTH tool homes: unset, the boot collectors read the developer's
    // real ~/.claude and ~/.codex and would ingest sessions beyond the two
    // seeded here, muddying the row lookups below.
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-detail-switch-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-detail-switch-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-detail-switch-udd-")
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

      // Two distinctly-named sessions, seeded while the app is DOWN.
      await seedSessionsList(userDataDir, [SESSION_A, SESSION_B]);

      // Launch 2 — against the seeded store. The ISS-4839 detail-route loading
      // presentation ships unconditionally (ISS-5366 retired its Labs gate to
      // the enabled state), so a default profile is the state under test.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "sessions");
        // Widen to "All time" so the seeded corpus is in range regardless of the
        // run clock. `:visible` scopes to the Sessions toolbar (keep-alive views
        // stay mounted-but-hidden and render the same control).
        await page.locator('[aria-label="All time"]:visible').click();

        // ── The list rendered both seeded rows ───────────────────────────────
        // Positive, blocking assertions first: everything below is meaningless
        // on a list that never rendered.
        const rowA = page.getByRole("link", { name: SESSION_A.name });
        await expect(rowA).toBeVisible({ timeout: 30_000 });
        await expect(
          page.getByRole("link", { name: SESSION_B.name })
        ).toBeVisible({ timeout: 30_000 });

        // ── Warm B's detail query ────────────────────────────────────────────
        // Open B first so its detail query key holds a populated cache entry
        // under `staleTime: Infinity`, making the switch below exercise the
        // cache-hit path rather than a plain first fetch on a cold key. (This
        // does not by itself pin the remount — see the header for why, and for
        // where that IS pinned.)
        //
        // This cold open is also where the ISS-4839 PENDING crumb is observable,
        // so arm the recorder BEFORE navigating. A MutationObserver sees every
        // DOM mutation, so a state that exists for a single frame is still
        // caught — a polled locator can walk right past it.
        await armPendingCrumbRecorder(page);
        await openDetailFromList(
          page,
          page.getByRole("link", { name: SESSION_B.name }),
          SESSIONS_CRUMB
        );
        await expect(
          breadcrumbNav(page).getByText(SESSION_B.name, { exact: true })
        ).toBeVisible({ timeout: 30_000 });

        // The loading state actually happened, and it was distinguishable from
        // a settled one: while B's name was resolving, the trailing crumb was a
        // PENDING segment carrying "Loading session" as its accessible name.
        // Regressing to the placeholder noun "Session" means nothing ever
        // carries this name and this goes red — which is the point, since the
        // loading and settled paths converge once the title lands.
        expect(await readPendingCrumbSeen(page)).toBe(true);

        // ── Back to the list, then open detail A ─────────────────────────────
        await gotoNav(page, "sessions");
        await expect(rowA).toBeVisible({ timeout: 30_000 });
        await rowA.first().click();
        await expect(breadcrumbParentLink(page, SESSIONS_CRUMB)).toBeVisible({
          timeout: 30_000,
        });
        // A's OWN name reached the breadcrumb: the detail read resolved, and the
        // ISS-4839 hold released into the real name rather than parking a noun.
        await expect(
          breadcrumbNav(page).getByText(SESSION_A.name, { exact: true })
        ).toBeVisible({ timeout: 30_000 });

        // ── Switch straight to detail B (no intervening list) ─────────────────
        // The end-to-end outcome: after a detail → detail switch the view shows
        // B, from B's own read, with B's warm cache entry sitting behind a
        // `staleTime: Infinity`. (Whether that is the remount or the 5s detail
        // poll is not separable here — see the header.)
        await gotoHash(page, `/sessions/${SESSION_B.sessionId}`);

        await expect(
          breadcrumbNav(page).getByText(SESSION_B.name, { exact: true })
        ).toBeVisible({ timeout: 30_000 });
        // …and A's name is gone from the trail, so this is a real switch and not
        // B's name appearing alongside a stale A.
        await expect(
          breadcrumbNav(page).getByText(SESSION_A.name, { exact: true })
        ).toHaveCount(0);
        // The detail route is genuinely mounted (the parent crumb is a LINK only
        // on a detail page; on the list it is the current-page span).
        await expect(breadcrumbParentLink(page, SESSIONS_CRUMB)).toBeVisible();

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

/** Window key the pending-crumb recorder writes its observation to. */
const PENDING_CRUMB_SEEN_KEY = "__iss4836PendingCrumbSeen";

/**
 * Arms a MutationObserver in the renderer that records whether the breadcrumb
 * ever contained an element accessibly named "Loading session" — the ISS-4839
 * pending segment.
 *
 * A MutationObserver is used rather than a Playwright locator wait because the
 * pending state is transient by design: it exists only between "the URL says a
 * detail" and "the detail's name resolved". A polled locator can miss a state
 * that short and would make this assertion flaky; the observer sees every
 * mutation, so a single-frame appearance is still recorded. It also catches the
 * state if it is already present when the observer is installed.
 *
 * The selector goes through `data-slot`, NOT `nav[aria-label="Breadcrumb"]`.
 * The design-system `Breadcrumb` renders `aria-label="breadcrumb"` in LOWERCASE,
 * and a CSS attribute selector is case-SENSITIVE — so the capitalized spelling
 * (which reads fine in the sibling `getByRole("navigation", { name: "Breadcrumb" })`
 * helper, because Playwright's accessible-name matching is case-INsensitive)
 * silently matched nothing and made this recorder report `false` no matter what
 * rendered. `data-slot` is the design-system's own stable hook and has no
 * casing trap.
 */
async function armPendingCrumbRecorder(page: Page): Promise<void> {
  await page.evaluate(
    ({ key, label }) => {
      const hasPendingCrumb = () =>
        document.querySelector(
          `[data-slot="breadcrumb"] [data-slot="breadcrumb-page"][aria-label="${label}"]`
        ) !== null;
      const globalScope = globalThis as unknown as Record<string, unknown>;
      globalScope[key] = hasPendingCrumb();
      const observer = new MutationObserver(() => {
        if (hasPendingCrumb()) {
          globalScope[key] = true;
        }
      });
      observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
      });
    },
    { key: PENDING_CRUMB_SEEN_KEY, label: PENDING_SESSION_CRUMB_LABEL }
  );
}

/** Reads back what {@link armPendingCrumbRecorder} observed. */
function readPendingCrumbSeen(page: Page): Promise<boolean> {
  return page.evaluate(
    (key) => (globalThis as unknown as Record<string, unknown>)[key] === true,
    PENDING_CRUMB_SEEN_KEY
  );
}
