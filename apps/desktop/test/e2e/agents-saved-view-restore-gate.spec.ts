/**
 * ISS-6141 (whitlockk review, PR #7306): the Electron twin of
 * `e2e/agents-saved-view-restore-gate.spec.ts`. The desktop Agents inventory's
 * FIRST bounded page-data read must go out under the viewer's SAVED sort, and
 * the window it waits in must render as loading, never as an empty inventory.
 *
 * `sortKey`/`sortDir` are restored from `localStorage` in a POST-MOUNT effect
 * and both sit in the page-data query key, so a surface that read on its first
 * commit asked the local producer for the DEFAULT view and then asked again for
 * the restored one. And because a query held closed by the gate reports
 * `isLoading: false` with no rows, an ungated derivation falls through to the
 * zero-row branch and shows "No components yet." over a seeded inventory.
 *
 * WHY THE HOOK TEST IS NOT ENOUGH, and why this adapter earns its own spec.
 * `use-agents-inventory-view-restore-gate.test.tsx` supplies `isViewReady`
 * itself and counts calls on a doubled data source. Here the real Electron
 * shell, the real `AgentsView` host and its `agents:desktop` persist key, the
 * real persisted-view restore, the real preload bridge and the real local
 * page-data reader over a migrated SQLite store all run — and the request
 * crosses a real process boundary, which is where a change to this same read
 * has broken before (ISS-6409: a fold that Electron's structured clone
 * rejected, invisible to every unit suite). Driven through the LAUNCHED app per
 * `apps/desktop/AGENTS.md` ("UI bug fix ⇒ regression e2e", "cross-surface work
 * covers both adapters").
 *
 * WHAT THE GATE PRELOAD SUPPLIES is only what a spec cannot otherwise reach on
 * this path: the RESPONSE TIMING, and a record of the request itself, since
 * there is no HTTP here for `page.route` to observe.
 *
 * WHAT THIS DISCRIMINATES — each half kills a DIFFERENT mutation, exactly as on
 * the web twin, and neither is redundant.
 *
 *  - Drop `isViewReady` from the query's `enabled` and the REQUEST assertions go
 *    red: two reads are recorded, `name`/`asc` then `sessions`/`desc`. Unlike
 *    the Sessions twin, this surface has no second probe (`canReadSessions`)
 *    already sequencing the read after the restore, so the pre-restore read
 *    really is issued here.
 *  - Keep `enabled` but drop `gateRestoredRead` and the EMPTY-STATE assertion
 *    goes red instead: the held-closed query reports `isLoading: false` with no
 *    rows, so "No components yet." is committed over the seeded inventory for
 *    the length of the restore. The request count is still one, so nothing else
 *    in this file sees it.
 *
 * Neither mutation is caught by a sampled `toHaveCount(0)` — the empty commit is
 * one React commit wide — which is why that half reads MUTATION RECORDS from an
 * observer installed before the Agents view mounts, rather than the live DOM.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  AgentComponentKind,
  AgentComponentSortDir,
  AgentComponentSortKey,
  Harness,
} from "@repo/api/src/types/agent-component.ts";
import { AGENTS_BOUNDED_PAGE_DATA_FLAG_KEY } from "@repo/api/src/types/agents-bounded-page-data-flag.ts";
import {
  readAgentsPageDataRequests,
  resumeAgentsPageDataReads,
} from "./helpers/agents-page-data-gate";
import {
  gotoNavSettled,
  launchDesktopApp,
  seedDesktopFeatureFlags,
  waitForLocalAgentComponentList,
} from "./helpers/desktop-app";
import {
  type AgentComponentProvenanceSeed,
  seedAgentComponents,
  waitForAgentComponentsSchema,
} from "./helpers/seed-agent-components-db";

/** Wide enough that `GridTable` renders the grid, not the sub-`md` card list. */
const WIDE_VIEWPORT = { height: 900, width: 1380 };

const MOUNT_TIMEOUT_MS = 60_000;
const AGENTS_NAV_ID = "agents";

/**
 * This surface's saved-view key: `keyPrefix` (`"agents:saved-view:"`, from
 * `use-agent-components-view-state.ts`) plus the desktop persist key
 * (`"agents:desktop"`, from `agents-view.tsx`). Un-namespaced because every E2E
 * profile is SIGNED OUT, which is exactly the case the shared hook resolves to
 * the legacy un-namespaced key (a signed-in profile would read `…:u:<userId>`
 * and fall back to this one).
 */
const SAVED_VIEW_STORAGE_KEY = "agents:saved-view:agents:desktop";

/**
 * Deliberately non-default on BOTH dimensions that reach the query key. The
 * catalog's default is Component ascending — `LEGACY_AGENTS_DEFAULT_SORT`
 * (`packages/app/agents/lib/agents-saved-view-migration.ts`), the pair in force
 * while `agents-default-sort-usage` is closed, which it is here because only the
 * key below is seeded. Spelled from the `@repo/api` enum rather than imported
 * from that `@repo/app` module: an extension-less `@repo/app/...` subpath does
 * not resolve under Playwright's ESM loader and a spec-level import failure
 * aborts the WHOLE desktop-e2e suite at load. The claim is asserted in the test
 * body rather than only stated here.
 *
 * `sessions` also differs from `USAGE_AGENTS_DEFAULT_SORT`'s key
 * (`invocations`), so the seed stays non-default even if that gate were open.
 */
const DEFAULT_SORT = {
  sortDir: AgentComponentSortDir.Asc,
  sortKey: AgentComponentSortKey.Name,
} as const;

const SAVED_VIEW = {
  columnOrder: [],
  hiddenColumns: [],
  sortDir: AgentComponentSortDir.Desc,
  sortKey: AgentComponentSortKey.Sessions,
} as const;

/**
 * `renderContent`'s pending copy in `agents-grouped-list.tsx`, and the empty
 * sentence `emptyStateMessage` returns for the All tab over the default
 * all-time window. Pinned as literals because neither is exported — unlike
 * Sessions, which has `sessions-list-loading-labels.ts` for exactly this. The
 * web twin pins the same two strings, so a copy change fails both rather than
 * silently passing on one.
 */
const LOADING_TEXT = "Loading components…";
const EMPTY_TEXT = "No components yet.";

const MARKER_NAME = "iss-6141-restore-gate-marker";
const SECOND_NAME = "iss-6141-restore-gate-filler";

/**
 * The flag {@link observeEmptyState}'s recorder sets the moment {@link EMPTY_TEXT}
 * is committed to the document.
 *
 * A "the empty state never showed" claim cannot be made by sampling — the flash
 * it is about lasts one React commit — and a fixed wait to prove non-occurrence
 * is banned outright (root `AGENTS.md`, Test Practices). An observer installed
 * before the Agents view mounts and read after its rows are on screen covers the
 * WHOLE window instead.
 */
const EMPTY_SEEN_MARKER = "__iss6141AgentsEmptySeen";

test("the desktop Agents list's first bounded read uses the saved view, and the wait renders as loading, not empty", async () => {
  // Two full Electron launches (migrate + plant, seed with the app down,
  // relaunch) plus a schema wait, against a 60s config default. The house value
  // for this shape; ~18 sibling call sites use it.
  test.setTimeout(300_000);

  // The seed is genuinely non-default on both dimensions, executed rather than
  // asserted in prose: without this, a future move of the catalog default onto
  // this pair would leave every assertion below passing on a read that never
  // had to wait for the restore.
  expect(SAVED_VIEW.sortKey).not.toBe(DEFAULT_SORT.sortKey);
  expect(SAVED_VIEW.sortDir).not.toBe(DEFAULT_SORT.sortDir);

  const dirs = makeProfileDirs("iss-6141-restore-gate");
  const env = { CLAUDE_HOME: dirs.claudeHome, CODEX_HOME: dirs.codexHome };
  const seedGate = (dir: string) => {
    seedDesktopFeatureFlags(dir, {
      [AGENTS_BOUNDED_PAGE_DATA_FLAG_KEY]: true,
    });
  };

  try {
    // Launch 1 — create + migrate the SQLite schema AND plant the saved view,
    // then close. The app must be DOWN to seed the store: a running app does not
    // observe another process's writes.
    const first = await launchDesktopApp({
      beforeLaunch: seedGate,
      env,
      keepUserDataDir: true,
      userDataDir: dirs.userDataDir,
    });
    try {
      await waitForAgentComponentsSchema(dirs.userDataDir);
      // Planted HERE, in the launch that is about to close, and not in the
      // asserting launch below — the ISS-8262 lesson the Sessions twin records.
      // A plant made after a surface has already run its restore against this
      // key lands on a view that will not re-restore, so the spec would only
      // ever pass on a second restore pass it does not control.
      //
      // `--user-data-dir` is kept across both launches, so Local Storage written
      // here is on disk before the asserting launch's renderer runs a single
      // script. If the write did not survive, the assertion below fails loudly
      // on the default sort rather than passing for the wrong reason.
      await first.page.evaluate(
        ({ key, value }) => {
          globalThis.localStorage.setItem(key, JSON.stringify(value));
        },
        { key: SAVED_VIEW_STORAGE_KEY, value: SAVED_VIEW }
      );
    } finally {
      await first.cleanup();
    }

    await seedAgentComponents(dirs.userDataDir, seededComponents());

    // The gate holds every `pageData` response from launch, so the window this
    // spec asserts on is a stable blocking state rather than a race against a
    // fast local read. It holds the RESPONSE only — the request is dispatched
    // and recorded, which is what the saved-view assertion below reads.
    const app = await launchDesktopApp({
      agentsPageDataGate: true,
      beforeLaunch: seedGate,
      env,
      keepUserDataDir: true,
      userDataDir: dirs.userDataDir,
    });
    try {
      await app.page.setViewportSize(WIDE_VIEWPORT);
      // The boot gate must settle BEFORE navigating, or the disabled-DB
      // responder's empty list is cached and the workspace pins empty. It reads
      // the `list` channel, which this gate does not hold.
      await waitForLocalAgentComponentList(app.page, MOUNT_TIMEOUT_MS);
      // Installed HERE, not through `addInitScript`: the renderer document is
      // already loaded by the time a launch returns, and the navigation below is
      // hash routing with no reload, so an init script would never run. The
      // Agents view has not mounted yet at this point, which is what makes the
      // observer's window cover every commit the surface makes.
      await observeEmptyState(app.page);
      const panel = await gotoNavSettled(
        app.page,
        AGENTS_NAV_ID,
        MOUNT_TIMEOUT_MS
      );

      // What the surface shows while the read is in flight. The empty sentence
      // is what an ungated derivation renders here, because a query with nothing
      // in flight reports `isLoading: false` with no rows — over an inventory
      // that has two.
      await expect(panel.getByText(LOADING_TEXT, { exact: true })).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });
      await expect(panel.getByText(EMPTY_TEXT, { exact: true })).toHaveCount(0);

      await resumeAgentsPageDataReads(app.app);
      await expect(catalogRow(panel, MARKER_NAME)).toHaveCount(1, {
        timeout: MOUNT_TIMEOUT_MS,
      });

      // …and it was never empty at any point on the way there. The assertion
      // above can only see the instant it samples, and the state this is about
      // is a single commit wide.
      expect(await emptyStateEverRendered(app.page)).toBe(false);

      // The heart of it: ONE read reached the producer, and it was the restored
      // viewer's. A pre-restore read carries the default pair, so an un-gated
      // build fails here twice over — on the count, and on the first entry's
      // sort.
      const requests = await readAgentsPageDataRequests(app.app);
      expect(requests).toHaveLength(1);
      for (const request of requests) {
        expect(request.sortBy).toBe(SAVED_VIEW.sortKey);
        expect(request.sortDir).toBe(SAVED_VIEW.sortDir);
      }
      expect(app.pageErrors).toEqual([]);
    } finally {
      await app.cleanup();
    }
  } finally {
    removeProfileDirs(dirs);
  }
});

// ---------------------------------------------------------------------------
// Locators and observers
// ---------------------------------------------------------------------------

/** The catalog grid row that owns `componentName`, scoped to the active panel. */
function catalogRow(panel: Locator, componentName: string): Locator {
  return panel.getByRole("row").filter({ hasText: componentName });
}

/**
 * Record — side-effect only, read from the test body later — whether the empty
 * sentence is ever committed to the document.
 */
async function observeEmptyState(page: Page): Promise<void> {
  await page.evaluate(
    ({ emptyText, marker }) => {
      const seen = globalThis as unknown as Record<string, boolean>;
      seen[marker] = false;
      // The RECORDS, not the live DOM. Observer callbacks are delivered at the
      // end of a microtask checkpoint, so a node React inserts and replaces
      // within one task is already gone by the time the callback runs — reading
      // `document` there would report the settled state and never the flash.
      new globalThis.MutationObserver((records) => {
        for (const record of records) {
          const texts = [
            ...Array.from(record.addedNodes, (node) => node.textContent),
            record.oldValue,
            record.target.textContent,
          ];
          if (texts.some((text) => text?.includes(emptyText))) {
            seen[marker] = true;
          }
        }
      }).observe(globalThis.document, {
        characterData: true,
        characterDataOldValue: true,
        childList: true,
        subtree: true,
      });
    },
    { emptyText: EMPTY_TEXT, marker: EMPTY_SEEN_MARKER }
  );
}

function emptyStateEverRendered(page: Page): Promise<boolean> {
  return page.evaluate(
    (marker) =>
      (globalThis as unknown as Record<string, boolean>)[marker] === true,
    EMPTY_SEEN_MARKER
  );
}

// ---------------------------------------------------------------------------
// Corpus and profile
// ---------------------------------------------------------------------------

/**
 * Two rows, so the rendered list is unambiguously non-empty and the marker is
 * not the only thing a broken render could accidentally satisfy.
 */
function seededComponents(): AgentComponentProvenanceSeed[] {
  return [seedRow(MARKER_NAME), seedRow(SECOND_NAME)];
}

function seedRow(name: string): AgentComponentProvenanceSeed {
  return {
    componentKind: AgentComponentKind.Subagent,
    externalId: name,
    harness: Harness.Claude,
    id: name,
    sourceUrl: "https://github.com/acme/iss-6141-pack",
  };
}

type ProfileDirs = {
  claudeHome: string;
  codexHome: string;
  userDataDir: string;
};

/**
 * An isolated profile plus empty collector homes, so the boot collectors ingest
 * nothing and the only inventory rows are the seeded ones.
 */
function makeProfileDirs(prefix: string): ProfileDirs {
  return {
    claudeHome: fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-claude-`)),
    codexHome: fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`)),
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`)),
  };
}

function removeProfileDirs(dirs: ProfileDirs): void {
  fs.rmSync(dirs.userDataDir, { force: true, recursive: true });
  fs.rmSync(dirs.claudeHome, { force: true, recursive: true });
  fs.rmSync(dirs.codexHome, { force: true, recursive: true });
}
