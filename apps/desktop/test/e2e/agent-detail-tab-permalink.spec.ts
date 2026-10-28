/**
 * ISS-6647: the Agent detail's `?tab=` permalink round-trips through the REAL
 * router at the DESKTOP host. The web twin is
 * `e2e/agent-detail-tab-permalink.spec.ts`.
 *
 * The detail's Invocations tabs are driven by `useTabParam`
 * (`packages/app/shared/hooks/use-tab-param.ts`) through the
 * `packages/navigation` port. `agent-detail-evidence-session-links.test.tsx`
 * deep-links a tab in jsdom over a MOCKED adapter, which is neither shipping
 * router. Web resolves `?tab=` out of Next.js `useSearchParams`; this shell
 * resolves it out of `location.hash` through `createDesktopNavigation`, which
 * validates the PATH ONLY via `matchRoute(parsePath(href))` — the query never
 * participates in route matching — and republishes it as the search-params
 * snapshot the shared hook reads. None of that exists on web, and this is also
 * where the permalink has to survive a reload off the persisted hash rather
 * than off a server-resolved URL.
 *
 * BOTH DIRECTIONS, NOT JUST THE READ
 * ----------------------------------
 * `gotoHash` seeds `location.hash` directly, so a spec built only from deep
 * links proves the READ direction and nothing else. The spec therefore also
 * clicks a NON-DEFAULT tab and reads the param back off the hash, then reloads
 * on that click-produced hash. Without it, a `createDesktopNavigation` whose
 * `replace` stripped the query (handing the store `parsePath(href)` rather than
 * the full `href`) would leave every other assertion green while making a
 * clicked tab unshareable — the exact capability this ticket names.
 *
 * EVERY CASE ASSERTS PANEL CONTENT, NEVER TAB STATE
 * -------------------------------------------------
 * All three `TabsTrigger`s are always in the DOM, so `aria-selected` on a
 * trigger is satisfied by a screen rendering the WRONG `TabsContent` beneath it.
 * The trigger assertions appear only as an awaited proof-of-render gate, never
 * as the substantive one, and each phase also asserts the other tab's content is
 * ABSENT.
 *
 * WHICH TWO TABS, AND WHY
 * -----------------------
 * Sessions (the default) and Evidence. Both are populated from THIS spec's own
 * seeded corpus through the real local read path, so each panel has content that
 * demonstrably exists — which is what an absence assertion needs to mean
 * anything. Branches is not used here: the local detail read has no branch rows
 * for this corpus, so a "Branches panel rendered" claim would be asserting an
 * empty state that any tab could produce. The web twin covers Branches, where
 * the payload can be seeded directly.
 *
 * Expectations are derived from this spec's own corpus, not a shared
 * cross-surface module: an extension-less `@repo/...` specifier does not resolve
 * under the desktop Playwright ESM loader, and a spec-level import failure
 * aborts the whole desktop suite at load time.
 *
 * NOT COVERED HERE, DELIBERATELY: browser Back/Forward. `useTabParam` writes
 * with `navigation.replace` (`use-tab-param.ts:71`), so a tab switch creates no
 * history entry. Changing that is a production change to every `useTabParam`
 * adopter, not a test-only one, so this spec neither asserts the current
 * behaviour nor pretends the capability exists.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { AgentComponentKind } from "@repo/api/src/types/agent-component.ts";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics.ts";
import {
  gotoHash,
  launchDesktopApp,
  waitForLocalAgentComponentList,
} from "./helpers/desktop-app";
import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
import {
  type AgentComponentUsageCorpus,
  seedAgentComponentUsage,
} from "./helpers/seed-agent-component-usage-db";

const DESKTOP_VIEWPORT = { height: 1000, width: 1380 };
const MOUNT_TIMEOUT_MS = 30_000;

const COMPONENT_KEY = "iss-6647-desktop-tab-permalink";
const COMPONENT_NAME = "ISS-6647 Desktop Tab Permalink";
const COMPONENT_SLUG = encodeComponentSlug(
  AgentComponentKind.Subagent,
  COMPONENT_KEY
);

/** The one seeded session, and the only text the Sessions panel can be located by. */
const SESSION_ROW_NAME = "ISS-6647 desktop sessions-panel row";
const SESSION_ID = "iss-6647-desktop-session";

/**
 * Invocations seeded on that session. The Evidence panel's stats strip states
 * this population, and that strip is the Evidence panel's locator — the seeded
 * invocation ROWS all render the component key (the local seeder writes
 * `normalized_name = key`), which is not text unique to this panel.
 */
const SEEDED_INVOCATIONS = 3;
/** `invocation-evidence-list.tsx`'s stats strip for the population above. */
const EVIDENCE_STATS_STRIP = `${SEEDED_INVOCATIONS} recorded`;

/**
 * `?tab=` values that must NOT select a tab.
 *
 * The empty string is its own case, not padding: this shell resolves the param
 * by splitting `location.hash` on `?` and reading it back through
 * `URLSearchParams`, so `#/agents/<slug>?tab=` yields `""` — a value distinct
 * from the `null` an absent param yields, and one `resolveActiveTab`
 * (`use-tab-param.ts`) handles on a different branch.
 */
const UNSELECTABLE_TAB_PARAMS = ["nonsense", "properties", ""] as const;

/**
 * A marker set on the pre-reload document. A reload discards the global object,
 * so its ABSENCE proves the assertions after it read a NEW document rather than
 * the pre-reload DOM.
 */
const PRE_RELOAD_MARKER = "__iss6647PreReload";

const SEEDED_CORPUS: AgentComponentUsageCorpus = {
  components: [
    {
      id: "iss-6647-desktop-component",
      key: COMPONENT_KEY,
      name: COMPONENT_NAME,
      usage: [{ invocations: SEEDED_INVOCATIONS, sessionId: SESSION_ID }],
    },
  ],
  sessions: [
    {
      costUsd: 1,
      name: SESSION_ROW_NAME,
      sessionId: SESSION_ID,
    },
  ],
};

test.describe("Agent detail ?tab= permalink at the desktop host (ISS-6647)", () => {
  test("resolves out of the hash, renders that PANEL, is WRITTEN back to the hash on a tab click, survives a reload, and falls back for an unknown value", async () => {
    test.setTimeout(240_000);

    await withSeededDesktop(async (app, page) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      // NOT optional: during boot the renderer is served by a DISABLED db
      // responder whose empty answer the query client caches FOREVER, so
      // navigating to the detail hash early pins a permanent "Component not
      // found" — a page on which every absence assertion below would pass
      // vacuously (ISS-5364).
      await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);

      await gotoDetail(page, "evidence");

      // Proof-of-render gate only. NOT the contract — all three triggers exist
      // in every state.
      await expect(tabTrigger(page, "Evidence")).toHaveAttribute(
        "aria-selected",
        "true",
        { timeout: MOUNT_TIMEOUT_MS }
      );

      // The contract: the panel BELOW the strip is the Evidence panel, and the
      // DEFAULT tab's content is not on screen.
      await expect(panelText(page, EVIDENCE_STATS_STRIP)).toHaveCount(1);
      await expect(panelText(page, SESSION_ROW_NAME)).toHaveCount(0);

      // The desktop-specific half. There is no server round-trip to restore the
      // tab here: the navigation store is re-seeded from `location.hash` on
      // boot, so a reload that lost the query would drop the user back onto
      // Sessions — which is exactly what the absence below would catch.
      await reloadProvingNewDocument(app, page);
      await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);
      await expectDetailResolved(page);

      await expect(tabTrigger(page, "Evidence")).toHaveAttribute(
        "aria-selected",
        "true",
        { timeout: MOUNT_TIMEOUT_MS }
      );
      await expect(panelText(page, EVIDENCE_STATS_STRIP)).toHaveCount(1);
      await expect(panelText(page, SESSION_ROW_NAME)).toHaveCount(0);

      // #8980 (ISS-12644/ISS-12645) split the location: the shell's
      // Artifact/Details/Sessions tabs own `tab`, the Invocations strip owns
      // `view`, and a legacy `?tab=evidence` still selects Evidence (the read
      // direction above). The write direction is therefore driven from the
      // canonical Sessions-tab location, where `view` defaults to Sessions.
      await gotoDetail(page, "sessions");
      await expect(panelText(page, SESSION_ROW_NAME)).toHaveCount(1);
      await expect(panelText(page, EVIDENCE_STATS_STRIP)).toHaveCount(0);

      // The other half of "round-trips", and the half every case above misses:
      // `gotoHash` seeds `location.hash` directly, so the deep-link, reload and
      // fallback cases only exercise the READ direction (hash → search-params
      // snapshot → `useTabParam`). Concretely:
      // `createDesktopNavigation`'s `replace` handing
      // `parsePath(href)` (which strips the query) to the href store instead of
      // the full `href` would leave every other assertion in this file green
      // while making a clicked tab unshareable and unable to survive a reload.
      await tabTrigger(page, "Evidence").click();

      // Awaited on CONTENT first: the Evidence strip did not exist in the DOM a
      // moment ago, so this is the proof the new render landed rather than
      // something the pre-click DOM already satisfied. Polled rather than read
      // once: the write reaches `location.hash` asynchronously, so a single
      // synchronous read can catch the pre-write hash and pass for the wrong
      // reason.
      await expect(panelText(page, EVIDENCE_STATS_STRIP)).toHaveCount(1);
      await expect(panelText(page, SESSION_ROW_NAME)).toHaveCount(0);
      await expect.poll(() => paramFromHash(page, "view")).toBe("evidence");
      expect(await paramFromHash(page, "tab")).toBe("sessions");

      // …and a CLICK-produced hash survives the reload, not merely a
      // test-seeded one. Phase 2 proved the seeded hash restores; this proves
      // the location the app wrote for itself is equally durable, which is what
      // a shareable permalink actually means.
      await reloadProvingNewDocument(app, page);
      await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);
      await expectDetailResolved(page);
      await expect(panelText(page, EVIDENCE_STATS_STRIP)).toHaveCount(1);
      await expect(panelText(page, SESSION_ROW_NAME)).toHaveCount(0);

      await tabTrigger(page, "Sessions").click();

      // Awaited FIRST, and awaited on CONTENT: the session row did not exist in
      // the DOM a moment ago, so this cannot be satisfied by the pre-click
      // render. It is the proof the new render landed, which the hash assertion
      // below then reads against.
      await expect(panelText(page, SESSION_ROW_NAME)).toHaveCount(1);
      await expect(panelText(page, EVIDENCE_STATS_STRIP)).toHaveCount(0);

      // The DEFAULT view is OMITTED from the persisted location, keeping the
      // shareable hash canonical.
      await expect.poll(() => paramFromHash(page, "view")).toBeNull();

      for (const tabParam of UNSELECTABLE_TAB_PARAMS) {
        await gotoDetail(page, "evidence");
        await expect(panelText(page, EVIDENCE_STATS_STRIP)).toHaveCount(1);

        // Arriving FROM Evidence is deliberate: it makes the fallback a real
        // transition the assertion can observe, instead of a page that was
        // already on Sessions before the unknown value was ever resolved.
        await gotoDetail(page, tabParam);

        await expect(tabTrigger(page, "Sessions")).toHaveAttribute(
          "aria-selected",
          "true",
          { timeout: MOUNT_TIMEOUT_MS }
        );
        // The load-bearing half: the fallback renders the default tab's
        // CONTENT. Without it, a build that selected no tab at all — an empty
        // panel under a correctly-highlighted trigger — passes.
        await expect(panelText(page, SESSION_ROW_NAME)).toHaveCount(1);
        await expect(panelText(page, EVIDENCE_STATS_STRIP)).toHaveCount(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to the detail hash with an explicit `?tab=`, then wait for the detail
 * to actually resolve, so no assertion can pass against a loading state or a
 * "Component not found".
 */
async function gotoDetail(page: Page, tabParam: string): Promise<void> {
  await gotoHash(
    page,
    `/agents/${COMPONENT_SLUG}?tab=${encodeURIComponent(tabParam)}`
  );
  await expectDetailResolved(page);
}

/**
 * Pinned to the PAGE heading, and pinned three ways.
 *
 * `agent-detail.tsx` renders the component name as the detail's `<h1>`, but this
 * shell ALSO renders `optimization-analytics-panel.tsx`'s
 * `<h2>Optimization · {target.name}</h2>` for the same component. Playwright
 * matches an accessible name as a case-insensitive SUBSTRING unless told
 * otherwise, so an unqualified `{ name }` matches both and throws a strict-mode
 * violation before any permalink assertion runs. `level: 1` selects the page
 * heading and `exact: true` stops the `Optimization · …` name from matching on
 * substring — either alone would do it today, together they survive whichever
 * one a future heading change invalidates.
 */
async function expectDetailResolved(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { exact: true, level: 1, name: COMPONENT_NAME })
  ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
}

/**
 * The full renderer reload a user triggers with Cmd+R, with PROOF that the
 * document answering the next assertions is a new one.
 *
 * `webContents.reload()` (rather than `page.reload()`) is the primitive
 * `labs-nav-reload.spec.ts` established for this shell — the same path the
 * accelerator takes.
 */
async function reloadProvingNewDocument(
  app: ElectronApplication,
  page: Page
): Promise<void> {
  await page.evaluate((marker) => {
    (globalThis as unknown as Record<string, boolean>)[marker] = true;
  }, PRE_RELOAD_MARKER);

  await Promise.all([
    page.waitForEvent("framenavigated"),
    app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.reload();
    }),
  ]);
  await page.waitForLoadState("domcontentloaded");

  await expect
    .poll(() =>
      page.evaluate(
        (marker) =>
          (globalThis as unknown as Record<string, boolean>)[marker] === true,
        PRE_RELOAD_MARKER
      )
    )
    .toBe(false);
}

/**
 * The named query param currently persisted in `location.hash`, or null.
 *
 * Read from the hash rather than from `page.url()`: the renderer is loaded from
 * a `file://` document whose URL carries no app route at all, so the hash IS the
 * desktop location.
 */
async function paramFromHash(page: Page, name: string): Promise<string | null> {
  return await page.evaluate((param) => {
    const raw = globalThis.location.hash;
    const hash = raw.startsWith("#") ? raw.slice(1) : raw;
    const queryStart = hash.indexOf("?");
    if (queryStart === -1) {
      return null;
    }
    return new URLSearchParams(hash.slice(queryStart + 1)).get(param);
  }, name);
}

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

/**
 * A trigger in the Invocations tab strip. Scoped because #8980 put the strip
 * inside the shell's Sessions tab, so "Sessions" names a trigger in both.
 */
function tabTrigger(page: Page, name: string): Locator {
  return page
    .getByRole("tablist", { exact: true, name: "Invocations" })
    .getByRole("tab", { exact: true, name });
}

/**
 * Text inside the ACTIVE tab panel.
 *
 * Scoped to `role="tabpanel"` so text rendered anywhere else on the detail (the
 * header, the properties panel, a metric card) could never stand in for a tab
 * body — the substitution that would make "the Evidence tab rendered" true of a
 * page whose panel is blank.
 */
function panelText(page: Page, text: string): Locator {
  return page.getByRole("tabpanel").getByText(text, { exact: true });
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * Initialize through the production migration adapter and close its writer,
 * seed with the app DOWN, then launch the real subject and run. Mirrors `agent-detail-sessions-truncation.spec.ts` — a running app does
 * not reliably observe a test-process write, while reading the committed schema
 * across processes is fine.
 */
async function withSeededDesktop(
  run: (app: ElectronApplication, page: Page) => Promise<void>
): Promise<void> {
  const prefix = "iss-6647-desktop";
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };

  try {
    await initializeDesktopProfileSchema(userDataDir);

    await seedAgentComponentUsage(userDataDir, SEEDED_CORPUS);

    const { app, page, cleanup } = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await run(app, page);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
}
