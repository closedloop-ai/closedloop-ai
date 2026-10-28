/**
 * ISS-6645: a column hidden from the Agents catalog's View menu survives a full
 * renderer reload, under the REAL localStorage key the DESKTOP surface persists
 * to. The web twin is `e2e/agents-column-visibility-persistence.spec.ts`.
 *
 * `use-agent-components-view-state.test.tsx` covers the hook's hide/restore
 * round-trip in jsdom, but it supplies its own `persistKey` and then asserts
 * against the key it just passed in. What no test reaches is the divergence the
 * two shipping shells rely on: the desktop renderer passes
 * `persistKey="agents:desktop"` (`src/renderer/components/agents/
 * agents-view.tsx:51`) where web passes `"agents:web"`, and
 * `usePersistedTableViewState` composes that with `keyPrefix:
 * "agents:saved-view:"`. A wrong key on this shell is invisible until a user
 * loses their layout.
 *
 * WHY THIS ADAPTER, SPECIFICALLY
 * ------------------------------
 * The reload here is not the web reload. There is no server round-trip and no
 * server-rendered markup to restore from: the renderer boots from a `file://`
 * document, so `localStorage` IS the entire memory of the view, and the restore
 * additionally has to survive the desktop's own async Labs-flag hydration (the
 * `parse`/defaults swap `usePersistedTableViewState` re-runs its restore for).
 * A profile here is also SIGNED OUT, so it exercises the un-namespaced key arm
 * of `storageKey` that a signed-in web profile never takes.
 *
 * TWO FALSE GREENS THIS SPEC IS SHAPED AROUND
 * -------------------------------------------
 * 1. A column absent for a reason OTHER than the saved view. Every case asserts
 *    the column is PRESENT at this viewport before hiding it.
 * 2. `collapseConstantColumns` (`agents-table.tsx`) DROPS a categorical column
 *    whose value repeats down every visible row — header, cells and grid track
 *    together — which would satisfy "hidden after reload" with persistence
 *    removed. The column under test is exempt (`NEVER_COLLAPSE_COLUMN_IDS`) AND
 *    the seeded rows carry distinct sources, so neither arm can stand in.
 *
 * ISS-9447 adds a second case on the same key discipline: an id this build has
 * no column for, spliced into the surface's own stored record, is still there
 * after the renderer has restored it and written the record back. Only the
 * stored bytes can see that id — it is deliberately absent from the DOM — so
 * this spec, which already reads storage at the real key, is where it belongs.
 *
 * Expectations are derived from THIS spec's own seeded corpus, not from a shared
 * cross-surface module: an extension-less `@repo/...` import does not resolve
 * under the desktop Playwright ESM loader, and a spec-level import failure
 * aborts the whole desktop suite at load time.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import {
  type AgentComponent,
  AgentComponentKind,
  type AgentComponentListResponse,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component.ts";
import { orgScopedViewStateKey } from "../../../../packages/app/shared/lib/org-scoped-view-state-key.ts";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  rejectUnauthorized,
  seedAuthenticatedDesktopSession,
  startAuthenticatedBranchCloudServer,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoHash,
  launchDesktopApp,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
  waitForLocalAgentComponentList,
} from "./helpers/desktop-app";
import {
  E2E_DESKTOP_FEATURE_FLAG_SEED,
  E2E_DESKTOP_SETTINGS_SEED,
} from "./helpers/e2e-desktop-settings-seed";
import {
  type AgentComponentProvenanceSeed,
  seedAgentComponents,
} from "./helpers/seed-agent-components-db";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";

/** Wide enough that `GridTable` renders the grid, not the sub-`md` card list. */
const DESKTOP_VIEWPORT = { height: 900, width: 1380 };

const MOUNT_TIMEOUT_MS = 30_000;

/**
 * The column under test, and the two asserted to survive beside it. All three
 * are in `NEVER_COLLAPSE_COLUMN_IDS`, so none can leave the DOM because its
 * values repeated — the one way a column vanishes without the saved view saying
 * so. `versions` (gated on a multi-version family) and the collapsible count
 * columns are deliberately unused.
 */
const HIDDEN_COLUMN_ID = "source";
/** The View-menu switch for {@link HIDDEN_COLUMN_ID}. */
const HIDDEN_COLUMN_SWITCH_LABEL = "Source";
const SURVIVING_COLUMN_IDS = ["type", "harness"] as const;

/**
 * Declared in `packages/app/shared/lib/feature-flags.ts`, but kept literal in
 * desktop E2E for the same loader reason as the Agents feature-flag specs: that
 * module imports extensionless `@repo/api` specifiers, which do not resolve under
 * Playwright's desktop ESM loader.
 */
const ORG_SCOPED_TABLE_VIEW_STATE_FLAG_KEY = "org-scoped-table-view-state";

/**
 * This surface's saved-view key: `keyPrefix` from
 * `use-agent-components-view-state.ts` + the renderer's `persistKey`. An E2E
 * profile here is signed OUT, so the composition resolves to the un-namespaced
 * arm and this is the whole key, not a prefix of it — which is why the spec can
 * assert it by equality below. Matched at the documented boundary regardless;
 * see {@link savedViewKeys}.
 */
const DESKTOP_SAVED_VIEW_KEY = "agents:saved-view:agents:desktop";
const ORG_SCOPED_DESKTOP_SAVED_VIEW_KEY = orgScopedViewStateKey(
  DESKTOP_SAVED_VIEW_KEY,
  AUTHENTICATED_USER_ID,
  AUTHENTICATED_ORGANIZATION_ID
);
/**
 * The WEB surface's key, asserted ABSENT here as a secondary cross-check.
 *
 * Not the load-bearing divergence assertion — the positive read under this
 * surface's own key is, and a shell collapsed onto the wrong key fails there
 * first. What this adds is the narrower case the positive read cannot see: a
 * write mirrored to BOTH surfaces' keys, which would make one shell silently
 * clobber the other's layout.
 */
const WEB_SAVED_VIEW_KEY = "agents:saved-view:agents:web";

/**
 * A marker set on the pre-reload document. A reload discards the global object,
 * so its ABSENCE is direct evidence the assertions after it read a NEW document
 * rather than the pre-reload DOM — the one failure mode a reload test cannot
 * afford.
 */
const PRE_RELOAD_MARKER = "__iss6645PreReload";

/**
 * An id no build of this surface has a column for (ISS-9447).
 *
 * Stands in for the arrangement a reader made on a NEWER build: this one has no
 * column to apply it to, and the contract is that it is CARRIED rather than
 * quietly dropped from storage on the way through. Prefixed so it can never
 * collide with a real `AGENT_COMPONENT_TOGGLEABLE_COLUMNS` id.
 */
const UNRECOGNIZED_COLUMN_ID = "iss-9447-column-from-a-newer-build";

/**
 * Three rows with distinct kinds, names and SOURCE URLs. Distinct sources are
 * load-bearing: they keep the collapse pass from dropping the column under test
 * for a data reason.
 */
const ANCHOR_COMPONENT_NAME = "acme/iss-6645-ship-it";

const SEEDED_COMPONENTS: AgentComponentProvenanceSeed[] = [
  {
    componentKind: AgentComponentKind.Command,
    externalId: ANCHOR_COMPONENT_NAME,
    harness: "claude",
    id: "iss-6645-command",
    sourceUrl: "https://github.com/acme/deploy-tools",
  },
  {
    componentKind: AgentComponentKind.Tool,
    externalId: "acme/iss-6645-grep-runner",
    harness: "codex",
    id: "iss-6645-tool",
    sourceUrl: "https://github.com/acme/search-tools",
  },
  {
    componentKind: AgentComponentKind.Skill,
    externalId: "acme/iss-6645-release-notes",
    harness: "opencode",
    id: "iss-6645-skill",
    sourceUrl: "https://github.com/acme/release-tools",
  },
];

const SEEDED_CLOUD_COMPONENTS: readonly AgentComponent[] = [
  makeComponent({
    harness: Harness.Claude,
    invocations: 31,
    kind: AgentComponentKind.Command,
    name: ANCHOR_COMPONENT_NAME,
    source: "acme/deploy-tools",
  }),
  makeComponent({
    harness: Harness.Codex,
    invocations: 17,
    kind: AgentComponentKind.Tool,
    name: "acme/iss-6645-grep-runner",
    source: "acme/search-tools",
  }),
  makeComponent({
    harness: Harness.Opencode,
    invocations: 8,
    kind: AgentComponentKind.Skill,
    name: "acme/iss-6645-release-notes",
    source: "acme/release-tools",
  }),
];

test.describe("Agents column visibility persistence at the desktop host (ISS-6645)", () => {
  test("a hidden column stays hidden across a reload, and returns when this surface's saved view is deleted", async () => {
    test.setTimeout(240_000);

    await withSeededDesktopProfile("iss-6645-columns", async (app, page) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      // Must precede the first navigation: during boot the renderer is served by
      // a DISABLED db responder whose empty list the query client caches
      // forever, which would pin a permanently empty catalog and make every
      // assertion below pass or fail for that reason instead of the contract
      // (ISS-5364).
      await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);

      await gotoHash(page, "/agents");
      await expect(catalogRow(page, ANCHOR_COMPONENT_NAME)).toHaveCount(1, {
        timeout: MOUNT_TIMEOUT_MS,
      });

      // Without this, "absent after reload" is satisfied by a column the layout
      // or the collapse pass never rendered in the first place.
      await expect(columnHeader(page, HIDDEN_COLUMN_ID)).toHaveCount(1);

      await openViewMenu(page);
      await expect(columnSwitch(page)).toBeChecked();
      await columnSwitch(page).click();
      await page.keyboard.press("Escape");

      // The hide took effect, and took effect SURGICALLY — the other two columns
      // are still there, so a table that failed to render cannot pass.
      await expect(columnHeader(page, HIDDEN_COLUMN_ID)).toHaveCount(0);
      await expectSurvivingColumnsPresent(page);

      // The contract no jsdom test can reach, because there the key is whatever
      // the test passed in. Polled: the persist effect runs after the commit.
      await expect
        .poll(() =>
          readSavedViewIds(page, DESKTOP_SAVED_VIEW_KEY, "hiddenColumns")
        )
        .toContain(HIDDEN_COLUMN_ID);
      // Spelled WHOLE, by equality, which only this shell can do: a desktop E2E
      // profile is signed out, so `storageKey` takes the un-namespaced arm and
      // there is no `userId` that could legitimately vary the result. Any other
      // key — an identity-scoped variant that should not exist here, a
      // neighbouring `agents:desktop-v2` — fails on the exact bytes rather than
      // being absorbed by a tolerant match.
      expect(await savedViewKeys(page, DESKTOP_SAVED_VIEW_KEY)).toEqual([
        DESKTOP_SAVED_VIEW_KEY,
      ]);
      // …and not ALSO under the web key. A secondary cross-check, not the
      // load-bearing one — the poll above already pins the key. What it adds is
      // the case that poll cannot see: a write mirrored to BOTH surfaces' keys,
      // which would make one shell silently clobber the other's layout.
      expect(await savedViewKeys(page, WEB_SAVED_VIEW_KEY)).toEqual([]);

      await reloadProvingNewDocument(app, page);
      await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);
      await expect(catalogRow(page, ANCHOR_COMPONENT_NAME)).toHaveCount(1, {
        timeout: MOUNT_TIMEOUT_MS,
      });

      // Restored from storage alone: no client state crossed the reload, and on
      // this shell there is no server-rendered markup to have carried it.
      await expect(columnHeader(page, HIDDEN_COLUMN_ID)).toHaveCount(0);
      await expectSurvivingColumnsPresent(page);

      // The CONTROL agrees with the table. A restored view that hid the column
      // but left its switch reading "on" would be the UI contradicting itself.
      await openViewMenu(page);
      await expect(columnSwitch(page)).not.toBeChecked();
      await page.keyboard.press("Escape");

      // The negative half. Scoped to this surface's key rather than
      // `localStorage.clear()` on purpose: clear() passes whatever key the
      // write actually landed on, whereas a boundary-scoped delete fails
      // outright if the surface persisted elsewhere. It also spares the
      // desktop's own seeded Labs/onboarding keys.
      const deletedKeys = await deleteSavedViewKeys(
        page,
        DESKTOP_SAVED_VIEW_KEY
      );
      expect(deletedKeys.length).toBeGreaterThan(0);

      await reloadProvingNewDocument(app, page);
      await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);
      await expect(catalogRow(page, ANCHOR_COMPONENT_NAME)).toHaveCount(1, {
        timeout: MOUNT_TIMEOUT_MS,
      });

      // The column is BACK. This is what makes Phase 4 mean "persisted" rather
      // than "the default render happens to be stable".
      await expect(columnHeader(page, HIDDEN_COLUMN_ID)).toHaveCount(1);
      await expectSurvivingColumnsPresent(page);

      await openViewMenu(page);
      await expect(columnSwitch(page)).toBeChecked();
    });
  });

  test("a signed-in flag-on profile persists under the org-scoped key", async () => {
    test.setTimeout(240_000);

    await withSeededAuthenticatedDesktopProfile(
      "iss-10091-org-scoped-columns",
      async (app, page) => {
        await page.setViewportSize(DESKTOP_VIEWPORT);
        await expect
          .poll(() =>
            page.evaluate(() => window.desktopApi.getDesktopAuthState())
          )
          .toMatchObject({
            organizationId: AUTHENTICATED_ORGANIZATION_ID,
            status: DesktopAuthStatus.Authenticated,
            userId: AUTHENTICATED_USER_ID,
          });
        await gotoHash(page, "/agents");
        await expect(catalogRow(page, ANCHOR_COMPONENT_NAME)).toHaveCount(1, {
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(columnHeader(page, HIDDEN_COLUMN_ID)).toHaveCount(1);

        await openViewMenu(page);
        await expect(columnSwitch(page)).toBeChecked();
        await columnSwitch(page).click();
        await page.keyboard.press("Escape");
        await expect(columnHeader(page, HIDDEN_COLUMN_ID)).toHaveCount(0);

        await expect
          .poll(() => savedViewKeys(page, DESKTOP_SAVED_VIEW_KEY))
          .toEqual([requireOrgScopedDesktopSavedViewKey()]);
        await expect
          .poll(() =>
            readSavedViewIds(page, DESKTOP_SAVED_VIEW_KEY, "hiddenColumns")
          )
          .toContain(HIDDEN_COLUMN_ID);
        expect(await savedViewKeys(page, WEB_SAVED_VIEW_KEY)).toEqual([]);

        await reloadProvingNewDocument(app, page);
        await expect(catalogRow(page, ANCHOR_COMPONENT_NAME)).toHaveCount(1, {
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(columnHeader(page, HIDDEN_COLUMN_ID)).toHaveCount(0);
        await expectSurvivingColumnsPresent(page);
      }
    );
  });

  test("a stored column id this build has no column for is carried, not dropped", async () => {
    test.setTimeout(240_000);

    await withSeededDesktopProfile(
      "iss-9447-carried-ids",
      async (app, page) => {
        await page.setViewportSize(DESKTOP_VIEWPORT);
        await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);

        await gotoHash(page, "/agents");
        await expect(catalogRow(page, ANCHOR_COMPONENT_NAME)).toHaveCount(1, {
          timeout: MOUNT_TIMEOUT_MS,
        });

        // Hiding a real column is what makes the renderer WRITE, so the seed
        // below edits the record under the key this build actually restores from
        // rather than one the spec composed for itself.
        await openViewMenu(page);
        await expect(columnSwitch(page)).toBeChecked();
        await columnSwitch(page).click();
        await page.keyboard.press("Escape");
        await expect
          .poll(() =>
            readSavedViewIds(page, DESKTOP_SAVED_VIEW_KEY, "hiddenColumns")
          )
          .toContain(HIDDEN_COLUMN_ID);

        await seedUnrecognizedColumnId(page, DESKTOP_SAVED_VIEW_KEY);

        await reloadProvingNewDocument(app, page);
        await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);
        await expect(catalogRow(page, ANCHOR_COMPONENT_NAME)).toHaveCount(1, {
          timeout: MOUNT_TIMEOUT_MS,
        });

        // Carried is not applied: an id the table cannot draw never reaches the
        // render path, which is the half of the contract the DOM can speak to.
        await expect(columnHeader(page, UNRECOGNIZED_COLUMN_ID)).toHaveCount(0);
        await expectSurvivingColumnsPresent(page);

        // Show the hidden column again. An EDIT, so the arrangement is rewritten
        // for a reason of its own — without it the reads below would be satisfied
        // by seeded bytes nothing ever touched, which is a test that cannot fail.
        // The rewrite is observable in `hiddenColumns`: Source is out of it, so
        // those are post-write bytes.
        await openViewMenu(page);
        await expect(columnSwitch(page)).not.toBeChecked();
        await columnSwitch(page).click();
        await page.keyboard.press("Escape");
        await expect(columnHeader(page, HIDDEN_COLUMN_ID)).toHaveCount(1);

        // The contract, on the shell where `localStorage` is the ENTIRE memory of
        // the view: the reader's own edit rewrote the record, and the id this
        // build has no column for survived that write on both axes. Before
        // ISS-9447 D1 the restore filtered it out of state and the write put the
        // filtered arrangement back, so opening the surface here was enough to
        // cost a reader a newer build's layout.
        await expect
          .poll(() =>
            readSavedViewIds(page, DESKTOP_SAVED_VIEW_KEY, "hiddenColumns")
          )
          .toEqual([UNRECOGNIZED_COLUMN_ID]);
        await expect
          .poll(() =>
            readSavedViewIds(page, DESKTOP_SAVED_VIEW_KEY, "columnOrder")
          )
          .toContain(UNRECOGNIZED_COLUMN_ID);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Surface helpers
// ---------------------------------------------------------------------------

async function openViewMenu(page: Page): Promise<void> {
  await page.getByRole("button", { exact: true, name: "View" }).click();
  await expect(columnSwitch(page)).toBeVisible();
}

async function expectSurvivingColumnsPresent(page: Page): Promise<void> {
  for (const columnId of SURVIVING_COLUMN_IDS) {
    await expect(columnHeader(page, columnId)).toHaveCount(1);
  }
}

/**
 * The full renderer reload a user triggers with Cmd+R, with PROOF that the
 * document answering the next assertions is a new one.
 *
 * The marker is set on the outgoing document and read back after: a reload
 * discards the global object, so seeing it gone is direct evidence the DOM being
 * asserted against is not the pre-reload DOM. `webContents.reload()` (rather
 * than `page.reload()`) is the primitive `labs-nav-reload.spec.ts` established
 * for this shell — it is the same path the accelerator takes.
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

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/**
 * Every `localStorage` key that `usePersistedTableViewState` can legitimately
 * compose for `baseKey`, and no others.
 *
 * The composition has three arms: signed-out writes the un-namespaced
 * `baseKey`, flag-off signed-in writes `${baseKey}:u:${userId}`, and flag-on
 * signed-in writes `${baseKey}::id:${userId}:${orgId}`.
 * Matching that boundary — rather than a bare `startsWith(baseKey)` — is what
 * makes this spec able to see the drift it exists for: a regression that
 * repointed the renderer at `agents:desktop-v2` composes
 * `agents:saved-view:agents:desktop-v2`, which a bare prefix test accepts, so
 * the stored-byte read, the reload and the scoped delete would all still pass
 * while every existing user silently lost their layout.
 *
 * This is the ONLY key predicate in the file: the read and the delete below
 * both route through it, so they cannot disagree about what counts as this
 * surface's key. Kept identical to the web twin's.
 */
async function savedViewKeys(page: Page, baseKey: string): Promise<string[]> {
  return await page.evaluate((base) => {
    const userScopedPrefix = `${base}:u:`;
    const orgScopedPrefix = `${base}::id:`;
    return Object.keys(globalThis.localStorage).filter(
      (key) =>
        key === base ||
        key.startsWith(userScopedPrefix) ||
        key.startsWith(orgScopedPrefix)
    );
  }, baseKey);
}

/**
 * The column ids recorded on one axis of the saved view stored under `baseKey`,
 * or an empty list when no such view exists. Reading the STORED bytes (rather
 * than inferring from the DOM) is what pins the key itself — and, for the
 * ISS-9447 case, the only way to see an id that is deliberately absent from the
 * DOM. Kept identical to the web twin's.
 */
async function readSavedViewIds(
  page: Page,
  baseKey: string,
  axis: "hiddenColumns" | "columnOrder"
): Promise<string[]> {
  const [key] = await savedViewKeys(page, baseKey);
  if (key === undefined) {
    return [];
  }
  const raw = await page.evaluate(
    (storageKey) => globalThis.localStorage.getItem(storageKey),
    key
  );
  if (raw === null) {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  const ids =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)[axis]
      : undefined;
  return Array.isArray(ids)
    ? ids.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Splice {@link UNRECOGNIZED_COLUMN_ID} into the arrangement already stored
 * under this surface's own key, on both axes the Agents saved view persists.
 *
 * Written INTO the surface's real record rather than composed from scratch, so
 * the seed cannot pass on a build that stores under some other key: the key it
 * edits is the one the running renderer just wrote. Kept identical to the web
 * twin's.
 */
async function seedUnrecognizedColumnId(
  page: Page,
  baseKey: string
): Promise<void> {
  const [key] = await savedViewKeys(page, baseKey);
  if (key === undefined) {
    throw new Error(`No saved view stored under ${baseKey}`);
  }
  await page.evaluate(
    ({ columnId, storageKey }) => {
      const raw = globalThis.localStorage.getItem(storageKey);
      const stored = (raw === null ? {} : JSON.parse(raw)) as {
        columnOrder?: string[];
        hiddenColumns?: string[];
      };
      globalThis.localStorage.setItem(
        storageKey,
        JSON.stringify({
          ...stored,
          columnOrder: [columnId, ...(stored.columnOrder ?? [])],
          hiddenColumns: [...(stored.hiddenColumns ?? []), columnId],
        })
      );
    },
    { columnId: UNRECOGNIZED_COLUMN_ID, storageKey: key }
  );
}

/** Remove this surface's saved-view keys; returns what it removed. */
async function deleteSavedViewKeys(
  page: Page,
  baseKey: string
): Promise<string[]> {
  const keys = await savedViewKeys(page, baseKey);
  await page.evaluate((toRemove) => {
    for (const key of toRemove) {
      globalThis.localStorage.removeItem(key);
    }
  }, keys);
  return keys;
}

// ---------------------------------------------------------------------------
// Locators and profile
// ---------------------------------------------------------------------------

/**
 * A grid column header addressed by its COLUMN ID, never its label. The label
 * words ("Source", "Type") also appear in the View menu and in cells, so a
 * text-based locator would be answering a different question.
 */
function columnHeader(page: Page, columnId: string): Locator {
  return page.locator(`[role="columnheader"][data-column-id="${columnId}"]`);
}

function columnSwitch(page: Page): Locator {
  return page.getByRole("switch", {
    exact: true,
    name: HIDDEN_COLUMN_SWITCH_LABEL,
  });
}

/** The catalog grid row that owns `componentName`. */
function catalogRow(page: Page, componentName: string): Locator {
  return page.getByRole("row").filter({ hasText: componentName });
}

async function withSeededAuthenticatedDesktopProfile(
  prefix: string,
  run: (app: ElectronApplication, page: Page) => Promise<void>
): Promise<void> {
  const server = await startAuthenticatedBranchCloudServer({
    extraRoutes: routeAuthenticatedAgentComponents,
  });
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const env = {
    CLAUDE_HOME: claudeHome,
    CL_AUTH_API_ORIGIN: server.origin,
    CODEX_HOME: codexHome,
  };

  try {
    const sessionSeedLaunch = await launchAuthenticatedDesktopApp({
      env,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
      await seedAuthenticatedDesktopSession(sessionSeedLaunch.app, userDataDir);
    } finally {
      await sessionSeedLaunch.cleanup();
    }

    await seedAgentComponents(userDataDir, SEEDED_COMPONENTS);

    const { app, page, cleanup } = await launchAuthenticatedDesktopApp({
      beforeLaunch: (launchUserDataDir) => {
        const configId = "iss-10091-local-auth-profile";
        seedDesktopSettings(launchUserDataDir, {
          ...E2E_DESKTOP_SETTINGS_SEED,
          activeConfigId: configId,
          apiOrigin: server.origin,
          cloudConnectionEnabled: true,
          savedConfigs: [
            {
              apiOrigin: server.origin,
              gatewayId: AUTHENTICATED_GATEWAY_ID,
              id: configId,
              name: "ISS-10091 Local Auth E2E",
              relayOrigin: "http://127.0.0.1:9",
              webAppOrigin: "http://127.0.0.1:3000",
            },
          ],
        });
        seedDesktopFeatureFlags(launchUserDataDir, {
          ...E2E_DESKTOP_FEATURE_FLAG_SEED,
          [ORG_SCOPED_TABLE_VIEW_STATE_FLAG_KEY]: true,
        });
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
      env,
      userDataDir,
    });
    try {
      await run(app, page);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
}

/**
 * Launch the built app twice against ONE temp profile — once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real Agents IPC source reads
 * the seeded inventory at boot. Mirrors `agents-source-provenance.spec.ts`, the
 * nearest spec on `main` that seeds this table.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only inventory rows are the seeded ones — which is what lets
 * the distinct-source claim above mean what it says.
 */
async function withSeededDesktopProfile(
  prefix: string,
  run: (app: ElectronApplication, page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };

  try {
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

    await seedAgentComponents(userDataDir, SEEDED_COMPONENTS);

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

function requireOrgScopedDesktopSavedViewKey(): string {
  if (!ORG_SCOPED_DESKTOP_SAVED_VIEW_KEY) {
    throw new Error(
      "Desktop e2e authenticated fixture must include an organization."
    );
  }
  return ORG_SCOPED_DESKTOP_SAVED_VIEW_KEY;
}

function routeAuthenticatedAgentComponents(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (
    request.method !== "GET" ||
    agentComponentsPath(requestUrl.pathname) !== "/agent-components"
  ) {
    return false;
  }
  if (
    request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
  ) {
    rejectUnauthorized(response);
    return true;
  }
  writeApiResult(response, makeListResponse([...SEEDED_CLOUD_COMPONENTS]));
  return true;
}

function agentComponentsPath(pathname: string): string {
  return pathname.startsWith("/api/agent-components")
    ? pathname.slice("/api".length)
    : pathname;
}

function makeComponent({
  harness,
  invocations,
  kind,
  name,
  source,
}: {
  harness: Harness;
  invocations: number;
  kind: AgentComponentKind;
  name: string;
  source: string;
}): AgentComponent {
  return {
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    harness,
    honestSource: {
      hasProvenance: false,
      source: null,
      sourceType: SourceType.Local,
    },
    id: name,
    invocations,
    kind,
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    locPerDollar: null,
    name,
    sessions: invocations,
    slug: `${kind}::${name}`,
    source,
    sourceType: SourceType.Repo,
    trend: [],
  };
}

function makeListResponse(items: AgentComponent[]): AgentComponentListResponse {
  return { hasMore: false, items, total: items.length };
}
