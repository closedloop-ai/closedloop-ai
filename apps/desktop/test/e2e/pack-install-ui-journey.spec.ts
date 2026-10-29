/**
 * ISS-6684 / ISS-6686 — the pack install + uninstall journey, driven through the
 * RENDERED `PluginsPanel`, in the launched Electron app.
 *
 * This is the first test of any kind that drives a pack install through the DOM.
 * The one pre-existing launched-app spec, `pack-install-auto-harness.spec.ts`,
 * calls `window.desktopApi.db.catalogInstall` directly via `page.evaluate` and
 * never touches `PluginsPanel` — so the renderer half of the chain (the control
 * set, the pending label, the error paragraph, the Contents-tab markers, the run
 * history) had no coverage at all, on a path that SPAWNS A CHILD PROCESS and
 * writes into the user's `~/.claude`. Per the "UI surface ⇒ Electron e2e" rule in
 * `apps/desktop/AGENTS.md`, the boundary is the point: a renderer test injects
 * both ends and cannot prove that click → IPC → spawn → rescan → re-render
 * survives.
 *
 * WHY AN EXPLICIT HARNESS SPAWNS HERE AND `auto` COULD NOT. The existing spec had
 * to use *uninstall* to observe a real spawn, because `resolveAutoRunCommand`
 * gates install on a harness CLI being on PATH, which a CI runner does not have.
 * The header control sends an EXPLICIT harness (`resolveHarness` in
 * `plugins-panel.tsx`), and the explicit branch of `resolveRunCommand` is a plain
 * command-map lookup with no CLI probe — so the button under test really does
 * spawn on a bare runner. That is what makes this journey testable at all.
 *
 * ============================================================================
 * THE DEFECT THIS SPEC MEASURED, AND WHY IT RESTARTS THE APP
 * ============================================================================
 * Reported on ISS-6684 / ISS-6686 and in the PR body. NOT fixed here: the fix is
 * a renderer behavior change, which a test-only change must not decide.
 *
 * **After a successful install through the UI, the pack keeps showing
 * `Install <harness>` for the entire life of the app window.** Measured directly
 * (Playwright evaluate, same instant): `getCatalog()` — the very read the panel
 * uses — returns `installedHarnesses: ["claude"]` while the rendered detail
 * still offers `Install Claude`. It never self-corrects. Three things combine:
 *
 *  1. `install-orchestrator.ts` sends the `complete` install-output chunk from
 *     `child.on("close")` and only THEN calls `onComplete` →
 *     `invokeStoreOp("packScanner.run")`. So the panel's refresh is dispatched
 *     strictly BEFORE the rescan that changes the answer even begins.
 *  2. The rescan is a filesystem walk; the store settles ~5s later (measured).
 *  3. There is no post-scan notification to the renderer anywhere — the only
 *     renderer-bound pack channel is `desktop:pack:install-output`.
 *
 * And navigating away does not rescue it: the desktop shell keeps the Packs view
 * MOUNTED (measured — the pack card is still in the DOM while the Sessions route
 * is showing), so `useCatalogData`'s mount effect never runs a second time.
 * Restarting the app is therefore the only way a user sees their own install.
 * `relaunchApp` performs that restart explicitly and is named so it cannot be
 * mistaken for incidental setup.
 *
 * A second defect, also measured: **clicking Install or Uninstall throws the
 * user out of the pack detail back to the grid.** `runMutation`'s `finally` calls
 * `reload()`, which sets the panel's load state to `"loading"` — and that branch
 * returns `PacksWorkspaceSkeleton` INSTEAD of `PacksWorkspace`, unmounting it and
 * discarding its internal `selectedId`. The pack the user was reading closes
 * itself. That is why this spec never navigates back to the grid: it is already
 * there.
 *
 * Its corollary is why NO assertion here claims the inline error paragraph is
 * absent, even though ISS-6684 asks for one. `setError(...)` and the `finally`'s
 * `reload()` are both synchronous after the same `await`, so React batches them
 * into ONE render, and the skeleton wins: on a genuine preflight refusal the
 * message never reaches the DOM at all. An "error paragraph is absent" assertion
 * would therefore pass on exactly the refusal it exists to catch — a textbook
 * false green — so the "no error" claim is carried by the run row's exit-0
 * badge, which a refusal cannot produce.
 *
 * A third defect, which is why `waitForRuntimeServing` exists: the panel's
 * catalog read has NO RETRY. `useCatalogData` reads once on mount, and while the
 * Agent Dashboard runtime is still starting every catalog channel answers with a
 * neutral disabled response — `getCatalog()` resolves to an EMPTY LIST rather
 * than failing. A panel mounted in that window therefore settles into `"ready"`
 * with zero entries and stays empty for the life of the window, so a user who
 * opens Packs during startup sees a permanently empty catalog.
 *
 * A fourth, narrower defect: the `fetchPackDetail(packId)` in `runMutation`'s
 * `finally` is documented as refreshing the Contents tab after a mutation, but it
 * runs when the mutation promise RESOLVES — at SPAWN time, before the child has
 * changed anything on disk and long before the rescan. It re-caches the
 * PRE-mutation detail.
 *
 * ============================================================================
 * THE FALSE-GREENS THIS SPEC IS BUILT AGAINST
 * ============================================================================
 *  - `catalogInstall` RESOLVES `{ started: false, error }` for an ordinary
 *    preflight refusal (`plugins-panel.tsx` documents this in its own prose). A
 *    spec that clicks and asserts "no exception" passes on a TOTAL REFUSAL.
 *    Countered two ways, neither of which a refusal can satisfy: the install
 *    command's own on-disk artifacts must appear (only a spawned child writes
 *    them, and they are checked from the TEST process, not through any app API);
 *    and an install-run row must exist AND report exit 0 (a refusal writes no
 *    row at all — `recordPackInstallRunStart` is reached only after every
 *    preflight gate in `streamRun` has passed).
 *  - Asserting only the header on uninstall. The header reads
 *    `getInstalledPacks`; the Contents tab's per-component markers read
 *    `getPackDetail`, through a best-effort call that swallows its own rejection
 *    (`fetchPackDetail`'s `.catch(() => {})`). They are DIFFERENT reads and can
 *    disagree, so a header-only assertion stays green while the per-component
 *    state still claims the component is installed.
 *  - Asserting the per-component state through the IPC READ instead of the
 *    rendered marker. `getPackDetail` returning `null` after an uninstall proves
 *    the data is right; it says nothing about `applyContentInstallStates` or
 *    `InstallStateStatus`, which could keep drawing "Installed" forever and
 *    still leave that assertion green — the exact false green
 *    `apps/desktop/test/AGENTS.md` names ("a pure-mapper test passing does not
 *    prove the value reaches the user"). So the MARKER is asserted in the DOM,
 *    both ways (Installed before, Not installed after, and no surviving
 *    "Installed"), with the IPC read kept only as a corroborating companion.
 *    Rendering it at all needs `SKIP_CATALOG_CONTENTS_FETCH=1` — see
 *    `seedFixturePack` for the cache-wipe that otherwise empties the tab.
 *  - A stale-DOM anchor. Every settled assertion is paired with a negative one
 *    (`Install Claude` gone / `Update Claude` gone), so a previous screen left
 *    mounted across a re-render cannot satisfy it.
 */

import fs from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { HarnessName } from "@repo/api/src/types/harness-name.ts";
// Extension-ful `@repo/app/…` subpath: neither `@repo/app` nor `@repo/api`
// ships an `exports` map, so an extension-less specifier resolves in the app
// bundle but NOT under the spec loader — the load abort documented in
// `apps/desktop/test/AGENTS.md`. Same form the sibling specs already use.
import {
  INSTALL_STATE_LABEL,
  PackInstallState,
} from "@repo/app/packs/lib/install-state.ts";
import type {
  InstalledPack,
  InstalledPackDetail,
} from "../../src/shared/agent-db-contract";
import {
  gotoNav,
  type LaunchedApp,
  launchDesktopApp,
} from "./helpers/desktop-app";
import {
  createPackInstallFixture,
  fixtureArtifactsPresent,
  type HarnessHomes,
  makeHarnessHomes,
  type PackInstallFixture,
  removeHarnessHomes,
  waitForCatalogEntryServing,
} from "./helpers/pack-install-fixture";
import { seedPackCatalogEntry } from "./helpers/seed-pack-catalog-db";

/** Two Electron launches, a real spawn, and a filesystem rescan. */
const JOURNEY_TIMEOUT_MS = 360_000;
/** The uninstall journey adds a third launch (install, act, observe). */
const UNINSTALL_JOURNEY_TIMEOUT_MS = 480_000;
/** Ceiling for the asynchronous Agent Dashboard runtime to start serving. */
const CATALOG_READY_TIMEOUT_MS = 120_000;
/** Ceiling for a spawned run plus the pack rescan that follows it. */
const SETTLE_TIMEOUT_MS = 90_000;

const INSTALL_CLAUDE = "Install Claude";
const UPDATE_CLAUDE = "Update Claude";
const UNINSTALL = "Uninstall";
/** `pendingLabel.install` in `install-controls.tsx` — note the ellipsis. */
const INSTALLING_PENDING_LABEL = "Installing…";
const SKILL_NAME = "closedloop-e2e-skill";
/** `data-testid` the desktop `PluginsPanel` renders on its root. */
const PLUGINS_PANEL_SELECTOR = '[data-testid="plugins-panel"]';
/**
 * The two Contents-tab markers, read from the canonical `INSTALL_STATE_LABEL`
 * map rather than retyped — a relabelled state must fail here, not silently
 * assert a string the UI no longer renders.
 *
 * They are matched `{ exact: true }` EVERYWHERE: Playwright's string text
 * matching is a case-insensitive SUBSTRING match, and "Installed" is a substring
 * of "Not installed", so an inexact positive assertion passes on the very state
 * it is meant to exclude.
 */
const MARKER_INSTALLED = INSTALL_STATE_LABEL[PackInstallState.Installed];
const MARKER_NOT_INSTALLED = INSTALL_STATE_LABEL[PackInstallState.NotInstalled];

type PendingProbeWindow = Window & {
  __closedloopPendingLabelSeen?: boolean;
};

/**
 * The preload reads this spec drives, typed against the SHARED contract rather
 * than a hand-written shape — so a field this spec depends on cannot be renamed
 * or removed without failing `tsc` here.
 */
type PacksDesktopWindow = Window & {
  desktopApi?: {
    db?: {
      getInstalledPacks?: () => Promise<InstalledPack[]>;
      getPackDetail?: (packId: string) => Promise<InstalledPackDetail | null>;
    };
  };
};

test.describe("Packs: install + uninstall through the rendered PluginsPanel", () => {
  test("ISS-6684: installing a seeded pack through the UI spawns a real run and reaches the Installed control set", async () => {
    test.setTimeout(JOURNEY_TIMEOUT_MS);
    const homes = makeHarnessHomes();
    const fixture = createPackInstallFixture({
      claudeHome: homes.claudeHome,
      displayName: "ClosedLoop E2E Install Pack",
      packId: "closedloop-e2e-ui-install",
      skillName: SKILL_NAME,
    });
    let launched = await launchDesktopApp({
      env: packLaunchEnv(homes),
      keepUserDataDir: true,
      userDataPrefix: "desktop-pack-install-ui-e2e-",
    });
    const userDataDir = launched.userDataDir;

    try {
      await seedFixturePack(userDataDir, fixture);
      await openPackDetail(launched.page, fixture);

      const installButton = launched.page.getByRole("button", {
        name: INSTALL_CLAUDE,
      });
      await expect(installButton).toBeVisible();
      // Nothing is installed yet, so the installed-state controls must be absent
      // BEFORE the click — otherwise the post-click assertion could be satisfied
      // by a control that was already on screen.
      await expect(
        launched.page.getByRole("button", { name: UPDATE_CLAUDE })
      ).toHaveCount(0);
      expect(fixtureArtifactsPresent(fixture)).toBe(false);

      await armPendingLabelProbe(launched.page);
      await installButton.click();

      // (a) The pending label. `runMutation` clears `pending` in its `finally`,
      // which runs as soon as `streamRun` returns at SPAWN time — a window of
      // tens of milliseconds a poll can legitimately miss. A MutationObserver
      // armed BEFORE the click records the label if it is ever rendered, so this
      // is deterministic rather than a race: it fails only if the pending state
      // never reaches the DOM at all.
      await expect
        .poll(() => readPendingLabelProbe(launched.page), {
          timeout: SETTLE_TIMEOUT_MS,
        })
        .toBe(true);

      // The install command's own artifacts. Only a spawned child process
      // creates these, so this is the assertion a resolved `{ started: false }`
      // refusal cannot survive. Checked from the TEST process — no app API
      // vouches for itself here.
      await expect
        .poll(() => fixtureArtifactsPresent(fixture), {
          timeout: SETTLE_TIMEOUT_MS,
        })
        .toBe(true);

      await settleInstalledState(launched.page, fixture, true);
      launched = await relaunchApp(launched, homes, userDataDir);
      await waitForInstalledState(launched.page, fixture, true);

      // (c) The run row, read on the grid the fresh launch opens on. Asserted
      // AFTER the restart on purpose: `useRunHistory` refetches only when
      // `historyKey` changes, and the sole bump happens in `runMutation`'s
      // `finally` at SPAWN time — so within the acting session the row is read
      // before `recordPackInstallRunEnd` and renders "Running" forever.
      await openPacksGrid(launched.page, fixture);
      await expectRunHistorySuccess(launched.page, fixture, "install");

      // (b) The control set flips. Both halves asserted — installed controls
      // present AND the not-installed control gone — so neither a stale panel
      // nor a half-rendered header can satisfy it.
      await selectPackCard(launched.page, fixture);
      await expect(
        launched.page.getByRole("button", { name: UPDATE_CLAUDE })
      ).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
      await expect(
        launched.page.getByRole("button", { name: UNINSTALL })
      ).toBeVisible();
      await expect(
        launched.page.getByRole("button", { name: INSTALL_CLAUDE })
      ).toHaveCount(0);

      // (d) The Contents-tab marker for the pack's one bundled skill now reads
      // Installed, in the DOM. This is the RENDERED half of the per-component
      // mapping the uninstall journey below asserts the clearing of — and it is
      // what makes that later "Not installed" a proven transition rather than a
      // selector that never matched anything.
      await expectContentMarker(launched.page, fixture, MARKER_INSTALLED);
    } finally {
      await launched.cleanup();
      fs.rmSync(userDataDir, { force: true, recursive: true });
      removeHarnessHomes(homes);
    }
  });

  test("ISS-6686: uninstalling through the UI returns the pack to a Not-installed control set AND clears its per-component install truth", async () => {
    test.setTimeout(UNINSTALL_JOURNEY_TIMEOUT_MS);
    const homes = makeHarnessHomes();
    const fixture = createPackInstallFixture({
      claudeHome: homes.claudeHome,
      displayName: "ClosedLoop E2E Uninstall Pack",
      packId: "closedloop-e2e-ui-uninstall",
      skillName: SKILL_NAME,
    });
    let launched = await launchDesktopApp({
      env: packLaunchEnv(homes),
      keepUserDataDir: true,
      userDataPrefix: "desktop-pack-uninstall-ui-e2e-",
    });
    const userDataDir = launched.userDataDir;

    try {
      // ARRANGE the installed state the way a user reaches it — through the same
      // rendered Install control. Seeding `agent_packs` directly would be worse
      // than slower: the scanner's prune only tombstones rows whose
      // `last_seen_at` predates the scan, so a hand-written row would survive the
      // uninstall that genuinely worked and invert the assertion.
      await seedFixturePack(userDataDir, fixture);
      await openPackDetail(launched.page, fixture);
      await launched.page.getByRole("button", { name: INSTALL_CLAUDE }).click();
      await expect
        .poll(() => fixtureArtifactsPresent(fixture), {
          timeout: SETTLE_TIMEOUT_MS,
        })
        .toBe(true);

      await settleInstalledState(launched.page, fixture, true);
      launched = await relaunchApp(launched, homes, userDataDir);
      await waitForInstalledState(launched.page, fixture, true);
      await openPackDetail(launched.page, fixture);

      const uninstallButton = launched.page.getByRole("button", {
        name: UNINSTALL,
      });
      await expect(uninstallButton).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
      await expect(
        launched.page.getByRole("button", { name: INSTALL_CLAUDE })
      ).toHaveCount(0);
      // THE POSITIVE CONTROL for the post-uninstall marker assertion. The same
      // locator that must later find "Not installed" — and must NOT find
      // "Installed" — is proven here to match the Installed marker, so the
      // absence half below cannot pass on a selector that matches nothing.
      await expectContentMarker(launched.page, fixture, MARKER_INSTALLED);
      // The per-component truth the markers are DERIVED from, BEFORE the
      // uninstall — so "cleared" afterwards is a real transition rather than a
      // value that was never anything else.
      expect(await readPackDetailSkillNames(launched.page, fixture)).toContain(
        fixture.skillName
      );

      // ACT
      await uninstallButton.click();
      await expect
        .poll(() => fixtureArtifactsPresent(fixture), {
          timeout: SETTLE_TIMEOUT_MS,
        })
        .toBe(false);

      await settleInstalledState(launched.page, fixture, false);
      launched = await relaunchApp(launched, homes, userDataDir);
      await waitForInstalledState(launched.page, fixture, false);
      await openPacksGrid(launched.page, fixture);
      await expectRunHistorySuccess(launched.page, fixture, "uninstall");
      await selectPackCard(launched.page, fixture);

      // ASSERT — the header returns to the Not-installed control set.
      await expect(
        launched.page.getByRole("button", { name: INSTALL_CLAUDE })
      ).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
      await expect(
        launched.page.getByRole("button", { name: UPDATE_CLAUDE })
      ).toHaveCount(0);
      await expect(
        launched.page.getByRole("button", { name: UNINSTALL })
      ).toHaveCount(0);

      // AND the per-component install truth followed, IN THE DOM. This is the
      // half a header-only assertion misses: the header reads
      // `getInstalledPacks` while the Contents markers read `getPackDetail`,
      // through a best-effort call that swallows its own rejection — so the
      // header can be correct while the per-component row still claims the
      // component is installed.
      //
      // Asserted on the RENDERED marker, not on the IPC payload behind it: a
      // `getPackDetail` assertion alone passes even if `applyContentInstallStates`
      // or `InstallStateStatus` keeps drawing "Installed" forever, because the
      // raw data is correct either way. Both halves of the flip are asserted —
      // the row reads "Not installed" AND no "Installed" marker survives — with
      // the pre-uninstall positive control above proving the locator matches.
      await expectContentMarker(launched.page, fixture, MARKER_NOT_INSTALLED);
      await expect(
        contentRow(launched.page, fixture).getByText(MARKER_INSTALLED, {
          exact: true,
        })
      ).toHaveCount(0);
      // And the read the marker is derived from agrees, so a passing marker
      // cannot be a renderer coincidence over stale data.
      expect(await readPackDetailSkillNames(launched.page, fixture)).toBeNull();
    } finally {
      await launched.cleanup();
      fs.rmSync(userDataDir, { force: true, recursive: true });
      removeHarnessHomes(homes);
    }
  });
});

/**
 * The launch env every fixture pack needs.
 *
 * `homes.env` redirects every collector home at the temp tree
 * {@link makeHarnessHomes} created, so the spawned install writes there instead
 * of the operator's real `~/.claude` and the scan reads it back from there, and
 * no boot collector imports a real local history.
 * `SKIP_CATALOG_DETECTORS` short-circuits the hardcoded per-pack detector table,
 * whose probes shell out to a login shell and `npm ls -g`; it still leaves the
 * scope marked succeeded, so the prune the uninstall half depends on keeps
 * running. `SKIP_CATALOG_CONTENTS_FETCH` keeps the seeded `contents_cache`
 * intact — see {@link seedFixturePack}.
 */
function packLaunchEnv(homes: HarnessHomes): Record<string, string> {
  return {
    ...homes.env,
    SKIP_CATALOG_CONTENTS_FETCH: "1",
    SKIP_CATALOG_DETECTORS: "1",
  };
}

/**
 * Restart the app against the SAME user-data dir and Claude home.
 *
 * The only way the panel re-reads the installed-pack store — see the file
 * header. Deliberately a restart rather than a navigation: the Packs view stays
 * mounted across hash changes, so `useCatalogData`'s mount effect does not run
 * again and no amount of waiting refreshes the control set.
 *
 * It is also what makes the observation RELIABLE rather than merely eventual,
 * and a RENDERER RELOAD is measurably NOT enough — that was tried and failed.
 * `PackScanCoordinator` coalesces concurrent scans single-flight, so the rescan
 * an install triggers can be swallowed by the deferred startup scan that was
 * already running — one that began before the install and therefore never sees
 * its files. Nothing re-runs it for the life of the process, so reloading the
 * window still shows the pre-install answer; only the NEXT launch's own boot
 * scan observes the new files. That is the sharpest form of the headline defect:
 * a user whose install lands in that window has to quit and reopen the app.
 */
async function relaunchApp(
  current: LaunchedApp,
  homes: HarnessHomes,
  userDataDir: string
): Promise<LaunchedApp> {
  await current.cleanup();
  return await launchDesktopApp({
    env: packLaunchEnv(homes),
    keepUserDataDir: true,
    userDataDir,
  });
}

/**
 * Seed the fixture's catalog row, INCLUDING the one bundled-contents entry the
 * Contents tab renders a per-component marker for.
 *
 * The contents entry names the same skill the install command writes, so the
 * marker is derived from a real correlation: `applyContentInstallStates` matches
 * this catalog name against `getPackDetail(...).skills[]`, which the scanner
 * populates only from files a spawned child actually created.
 *
 * It renders at all only because the app is launched with
 * `SKIP_CATALOG_CONTENTS_FETCH=1`. Opening a pack detail calls
 * `getCatalogContents`, whose handler refreshes BEFORE it reads; a seeded pack
 * has no GitHub scrape spec, so `fetchContents` returns `[]` and
 * `applyContentsFetch` overwrites the cache with it. Unguarded, the tab renders
 * "This pack does not list bundled contents" and there is no marker to assert.
 */
async function seedFixturePack(
  userDataDir: string,
  fixture: PackInstallFixture
): Promise<void> {
  await seedPackCatalogEntry(userDataDir, {
    contentsCache: [{ name: fixture.skillName, type: "skill" }],
    displayName: fixture.displayName,
    harnesses: [HarnessName.Claude],
    installCommands: { [HarnessName.Claude]: fixture.installCommand },
    packId: fixture.packId,
    uninstallCommands: { [HarnessName.Claude]: fixture.uninstallCommand },
  });
}

/**
 * SYNCHRONIZATION, NOT AN ASSERTION — on a freshly launched app, wait until its
 * boot scan has recorded (or tombstoned) the pack in the installed-pack store,
 * BEFORE anything navigates to Packs.
 *
 * Order matters twice over. The boot scan is deferred behind `waitForBackgroundSlot`,
 * so it lands well after the window opens; and the panel reads the store exactly
 * once, on mount, with no retry — so a spec that navigates first would pin the
 * pre-scan answer into the UI permanently and then wait on a DOM that can never
 * change. Gating here keeps every assertion that follows purely about rendering.
 *
 * It does not weaken them: reaching `true` requires a real child process to have
 * written artifacts that the scanner then correlated back to the seeded pack id.
 */
async function waitForInstalledState(
  page: Page,
  fixture: PackInstallFixture,
  expected: boolean
): Promise<void> {
  await waitForCatalogEntryServing(
    page,
    fixture.packId,
    CATALOG_READY_TIMEOUT_MS
  );
  await expect
    .poll(() => readInstalledFromStore(page, fixture), {
      timeout: CATALOG_READY_TIMEOUT_MS,
    })
    .toBe(expected);
}

/**
 * BEST-EFFORT SYNCHRONIZATION, asserting nothing — give the CURRENT session's
 * post-mutation rescan a chance to land before the app is restarted.
 *
 * Two independent scans can record a mutation, and neither is guaranteed: the
 * one `onComplete` triggers right after the child exits (prompt, but
 * single-flight-coalesced, so it can be swallowed by a scan already running),
 * and the next launch's boot scan (reliable, but deferred behind
 * `waitForBackgroundSlot`). Waiting here lets the prompt one win when it runs —
 * its row then persists in SQLite across the restart — while `waitForInstalledState`
 * after the relaunch remains the ASSERTING gate and the boot scan remains the
 * backstop. Deliberately returns rather than throws: a timeout here means "the
 * prompt scan did not run", which is not a failure, only a slower path.
 */
async function settleInstalledState(
  page: Page,
  fixture: PackInstallFixture,
  expected: boolean
): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await readInstalledFromStore(page, fixture)) === expected) {
      return;
    }
    await page.waitForTimeout(1000);
  }
}

/** Whether the app's installed-pack store currently lists the fixture pack. */
async function readInstalledFromStore(
  page: Page,
  fixture: PackInstallFixture
): Promise<boolean | null> {
  return await page.evaluate(async (id) => {
    const db = (window as PacksDesktopWindow).desktopApi?.db;
    if (!db?.getInstalledPacks) {
      return null;
    }
    const packs = await db.getInstalledPacks();
    return packs.some((pack) => pack.packId === id);
  }, fixture.packId);
}

/**
 * The machine's per-component install truth for the pack — the read the Contents
 * tab's markers are DERIVED from — as installed skill names, or `null` when the
 * pack has no installed detail at all.
 *
 * A companion to {@link expectContentMarker}, never a substitute for it: this is
 * the input, the marker is what the user sees. `getPackDetail` is a DIFFERENT
 * read from the header's `getInstalledPacks`, which is why it is worth asserting
 * alongside the header — the two can disagree.
 */
async function readPackDetailSkillNames(
  page: Page,
  fixture: PackInstallFixture
): Promise<string[] | null> {
  return await page.evaluate(async (id) => {
    const db = (window as PacksDesktopWindow).desktopApi?.db;
    if (!db?.getPackDetail) {
      return null;
    }
    const detail = await db.getPackDetail(id);
    if (!detail) {
      return null;
    }
    return (detail.skills ?? [])
      .map((skill) => skill.name)
      .filter((name): name is string => typeof name === "string");
  }, fixture.packId);
}

/**
 * Navigate to Packs and wait for the seeded pack's card.
 *
 * The grid is also the only surface that renders the run history (the workspace
 * `footerSlot`) — `PacksWorkspace` returns the detail early, without it.
 */
async function openPacksGrid(
  page: Page,
  fixture: PackInstallFixture
): Promise<void> {
  await waitForCatalogEntryServing(
    page,
    fixture.packId,
    CATALOG_READY_TIMEOUT_MS
  );
  await gotoNav(page, "packs");
  await expect(page.getByTestId(`pack-card-${fixture.packId}`)).toBeVisible({
    timeout: CATALOG_READY_TIMEOUT_MS,
  });
}

/** Open the seeded pack's detail from a grid that is already showing. */
async function selectPackCard(
  page: Page,
  fixture: PackInstallFixture
): Promise<void> {
  await page.getByTestId(`pack-card-${fixture.packId}`).click();
  await expect(
    page.getByRole("heading", { name: fixture.displayName })
  ).toBeVisible();
}

/** Navigate to Packs and open the seeded pack's detail. */
async function openPackDetail(
  page: Page,
  fixture: PackInstallFixture
): Promise<void> {
  await openPacksGrid(page, fixture);
  await selectPackCard(page, fixture);
}

/**
 * Assert the install-run history shows a COMPLETED, successful run for a pack.
 *
 * Exit 0, not merely "a row exists": `RunStatusBadge` renders "Running" for a
 * null exit code and "Failed (n)" otherwise. And a preflight refusal writes no
 * row at all, because `recordPackInstallRunStart` is reached only after every
 * gate in `streamRun` has passed — which is what makes this the assertion that
 * discriminates against the resolved-`{ started: false }` false green.
 */
async function expectRunHistorySuccess(
  page: Page,
  fixture: PackInstallFixture,
  action: "install" | "uninstall"
): Promise<void> {
  // ANCHORED at the start of the row. `hasText` with a string is a SUBSTRING
  // match, and "install · <id>" is a substring of "uninstall · <id>" — so an
  // unanchored install filter also matches the pack's uninstall row. Both ids
  // here are test constants of `[a-z0-9-]`, so they carry no regex metacharacters.
  const row = page
    .getByTestId("run-history-list")
    .getByRole("listitem")
    .filter({ hasText: new RegExp(`^${action} · ${fixture.packId}\\b`) });
  await expect(row).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
  await expect(row.getByText("Success")).toBeVisible({
    timeout: SETTLE_TIMEOUT_MS,
  });
}

/**
 * Record whether the install button's pending label ever reaches the DOM.
 *
 * Armed BEFORE the click, so it observes the whole transition rather than
 * sampling it. `MutationObserver` fires for every DOM change, so a label that
 * renders for a single frame is still recorded.
 */
async function armPendingLabelProbe(page: Page): Promise<void> {
  await page.evaluate(
    (probe) => {
      const probeWindow = window as PendingProbeWindow;
      probeWindow.__closedloopPendingLabelSeen = false;
      // Read SCOPED to the panel, even though we observe the whole document.
      // "Installing…" is not unique to this control — `OptInDistributionsBanner`
      // renders it too and is mounted globally in the app shell, above the
      // routed content — so an unscoped `document.body` read would let an
      // unrelated component satisfy this assertion. Observing the document (and
      // re-querying the panel on each check) is deliberate: the panel is
      // unmounted and remounted mid-mutation when `reload()` swaps in the
      // skeleton, so an observer bound to the panel node would go deaf.
      const check = () => {
        const panel = document.querySelector(probe.panelSelector);
        if (panel?.textContent?.includes(probe.label)) {
          probeWindow.__closedloopPendingLabelSeen = true;
        }
      };
      new MutationObserver(check).observe(document.body, {
        characterData: true,
        childList: true,
        subtree: true,
      });
      check();
    },
    {
      label: INSTALLING_PENDING_LABEL,
      panelSelector: PLUGINS_PANEL_SELECTOR,
    }
  );
}

function readPendingLabelProbe(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as PendingProbeWindow).__closedloopPendingLabelSeen === true
  );
}

/** The isolated harness homes one journey launches against. */

/**
 * The rendered Contents-tab row for the fixture's one bundled skill.
 *
 * Scoped to the panel and matched on an EXACT component name: the pack detail
 * and the run-history footer both render `listitem`s, and Playwright's string
 * text matching is a case-insensitive substring match.
 */
function contentRow(page: Page, fixture: PackInstallFixture) {
  return page
    .locator(PLUGINS_PANEL_SELECTOR)
    .getByRole("listitem")
    .filter({ has: page.getByText(fixture.skillName, { exact: true }) });
}

/**
 * Assert the VISIBLE per-component install marker on the fixture skill's
 * Contents row — the end of the chain
 * `scanner → getPackDetail → applyContentInstallStates → InstallStateStatus`,
 * which no read of the IPC payload can stand in for.
 *
 * The row is pinned to exactly one match first, so a marker asserted against a
 * duplicated or missing row fails loudly instead of resolving against whichever
 * element happened to match.
 */
async function expectContentMarker(
  page: Page,
  fixture: PackInstallFixture,
  marker: string
): Promise<void> {
  const row = contentRow(page, fixture);
  await expect(row).toHaveCount(1, { timeout: SETTLE_TIMEOUT_MS });
  await expect(row.getByText(marker, { exact: true })).toBeVisible({
    timeout: SETTLE_TIMEOUT_MS,
  });
}
