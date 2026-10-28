/**
 * ISS-6652 — the RENDERED pack inventory must follow an uninstall and an update,
 * in the launched Electron app.
 *
 * WHAT ISS-5027 ESTABLISHED, AND WHY IT BINDS HERE. Install got a launched-app
 * spec because the mocked renderer test proved only that the button calls the
 * IPC: the IPC resolved `{ started: false, ENOCOMMAND }` and nothing ever
 * spawned, and no assertion on the CALL could see it. `plugins-panel.test.tsx`
 * pins uninstall and update the same insufficient way — `catalogUninstall` /
 * `catalogInstall` "toHaveBeenCalledWith" — so neither crosses the boundary.
 * Everything below is therefore asserted on the SCREEN, never on an invocation.
 *
 * WHAT THIS ADDS THAT IS NOT ALREADY COVERED, verified against the branch head
 * rather than taken from the ticket (whose citations had drifted):
 *
 *  - `pack-install-ui-journey.spec.ts` (ISS-6686) DOES already drive uninstall
 *    through the launched app — but it asserts the DETAIL HEADER's control set
 *    and the Contents-tab markers. It never asserts the GRID CARD, which is the
 *    surface a user actually reads an inventory off, and which renders its own
 *    independent `installedByMe` branch (`pack-card.tsx` — a disabled
 *    "Installed" button versus an actionable "Install"). A regression confined
 *    to that branch leaves every existing assertion green.
 *  - NOTHING in the suite CLICKS Update. Its VISIBILITY is already asserted
 *    (`pack-install-ui-journey.spec.ts:271`), so this spec claims no credit for
 *    that half and the re-assertion below is only a local anchor for the
 *    absence check beside it. What has never been executed end to end is the
 *    idempotent re-install the control performs when pressed.
 *
 * HOW AN UPDATE IS DISCRIMINATED, measured rather than assumed. Update is not a
 * distinct IPC and does NOT write a distinct run row: `runMutation` maps it onto
 * `catalogInstall`, whose handler hardcodes `action: "install"`
 * (`agent-dashboard-catalog-pack-ipc.ts`). A first draft of this spec looked for
 * an `update · <id>` row and failed — the captured DOM showed two `install ·
 * <id>` rows instead. So what proves the Update control spawned a real child is
 * the SECOND completed install run, asserted as a count delta against the
 * arrange step's single row. Naming the action would have been the easier
 * assertion and the wrong one.
 *
 * The negative case ISS-6652 names — a `{ started: false }` resolution
 * surfacing as a retryable failure — is deliberately NOT re-asserted here, and
 * that is not a gap: the ticket itself records it as already pinned in jsdom
 * (`plugins-panel.member-install.test.tsx`), and it provably cannot be observed
 * on this surface. `runMutation`'s `finally` calls `reload()`, which swaps the
 * panel for its skeleton in the same React batch that sets the error, so the
 * message never reaches the DOM — measured and documented by two sibling specs.
 * What DOES discriminate a refusal here is the run history: a refusal writes no
 * row at all, because `recordPackInstallRunStart` is reached only after every
 * gate in `streamRun` passes. That is why each action below asserts a COMPLETED,
 * exit-0 row rather than merely a changed screen.
 *
 * One journey rather than two tests: both claims need the same
 * install-and-relaunch arrangement, which costs a real spawn and a filesystem
 * rescan per launch. Each ACT/ASSERT block below stands alone and names what it
 * pins, so a failure still points at one claim.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { HarnessName } from "@repo/api/src/types/harness-name.ts";
import type {
  InstalledPack,
  InstallRunRecord,
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

/** Install, update and uninstall, each with a real spawn, rescan and relaunch. */
const JOURNEY_TIMEOUT_MS = 600_000;
/** Ceiling for the asynchronous Agent Dashboard runtime to start serving. */
const CATALOG_READY_TIMEOUT_MS = 120_000;
/** Ceiling for a spawned run plus the pack rescan that follows it. */
const SETTLE_TIMEOUT_MS = 90_000;

/** Detail-header control labels (`install-controls.tsx`). */
const INSTALL_CLAUDE = "Install Claude";
const UPDATE_CLAUDE = "Update Claude";
const UNINSTALL = "Uninstall";

/**
 * Grid-card control labels (`pack-card.tsx`). Matched `{ exact: true }`
 * EVERYWHERE: Playwright's string matching is a case-insensitive SUBSTRING
 * match and "Install" is a substring of "Installed", so an inexact assertion
 * passes on the very state it is meant to exclude.
 */
const CARD_INSTALLED = "Installed";
const CARD_INSTALL = "Install";

const SKILL_NAME = "closedloop-e2e-skill";

/**
 * The preload reads this spec drives, typed against the SHARED contract rather
 * than a hand-written shape, so a field it depends on cannot be renamed without
 * failing `tsc` here.
 */
type PacksDesktopWindow = Window & {
  desktopApi?: {
    db?: {
      getInstalledPacks?: () => Promise<InstalledPack[]>;
      getInstallRuns?: (packId?: string) => Promise<InstallRunRecord[]>;
    };
  };
};

test("ISS-6652: update re-installs idempotently and uninstall clears the rendered grid inventory", async () => {
  test.setTimeout(JOURNEY_TIMEOUT_MS);

  const homes = makeHarnessHomes();
  const fixture = createPackInstallFixture({
    claudeHome: homes.claudeHome,
    displayName: "ClosedLoop E2E Update Pack",
    packId: "closedloop-e2e-update-uninstall",
    skillName: SKILL_NAME,
  });
  let launched = await launchDesktopApp({
    env: packLaunchEnv(homes),
    keepUserDataDir: true,
    userDataPrefix: "desktop-pack-update-uninstall-e2e-",
  });
  const userDataDir = launched.userDataDir;

  try {
    // ARRANGE the installed state the way a user reaches it — through the same
    // rendered Install control. Seeding `agent_packs` directly would be worse
    // than slower: the scanner's prune only tombstones rows whose `last_seen_at`
    // predates the scan, so a hand-written row would survive the uninstall that
    // genuinely worked and invert the assertion.
    await seedFixturePack(userDataDir, fixture);
    await openPackDetail(launched.page, fixture);
    await launched.page.getByRole("button", { name: INSTALL_CLAUDE }).click();
    await expect
      .poll(() => fixtureArtifactsPresent(fixture), {
        timeout: SETTLE_TIMEOUT_MS,
      })
      .toBe(true);
    await waitForCompletedRuns(launched.page, fixture, "install", 1);
    await settleInstalledState(launched.page, fixture, true);
    launched = await relaunchApp(launched, homes, userDataDir);
    await waitForInstalledState(launched.page, fixture, true);

    // THE GRID INVENTORY, BEFORE ANYTHING IS ACTED ON. Also the positive control
    // for the post-uninstall absence assertion at the end: the same locator that
    // must later find nothing is proven here to match, so that assertion cannot
    // pass on a selector that matches nothing.
    await openPacksGrid(launched.page, fixture);
    await expectCardInstalled(launched.page, fixture, true);
    // The BASELINE the update's delta is measured against. Without it, "two
    // install runs exist" afterwards could describe an arrange that already
    // wrote two.
    await expectRunRowsSucceeded(launched.page, fixture, "install", 1);

    // ACT 1 — UPDATE. The control re-runs the vetted install command
    // (`runMutation` maps update onto `catalogInstall`), so the contract is
    // IDEMPOTENCE: the pack must still be installed afterwards, not toggled off.
    await selectPackCard(launched.page, fixture);
    await launched.page.getByRole("button", { name: UPDATE_CLAUDE }).click();

    // WAIT FOR THE UPDATE'S RUN TO FINISH BEFORE TOUCHING THE APP. This gate is
    // load-bearing and its absence was a real defect in this spec:
    // `settleInstalledState(true)` polls for installed-state, which an update
    // NEVER changes — the pack is already installed — so it returned instantly,
    // the relaunch below killed the app with the child still running, and the
    // run's row was stranded at "Running" with no exit code for the rest of
    // time. Polling for a RECORDED EXIT CODE is the only thing here that
    // actually observes the spawned process finishing.
    await waitForCompletedRuns(launched.page, fixture, "install", 2);
    await settleInstalledState(launched.page, fixture, true);
    launched = await relaunchApp(launched, homes, userDataDir);
    await waitForInstalledState(launched.page, fixture, true);
    await openPacksGrid(launched.page, fixture);

    // THE PROOF THE UPDATE SPAWNED A REAL RUN: a SECOND completed install,
    // where the arrange step left exactly one. An IPC-invocation assertion — the
    // thing ISS-5027 showed is insufficient — cannot distinguish this from a
    // click that resolved and spawned nothing.
    await expectRunRowsSucceeded(launched.page, fixture, "install", 2);

    // ASSERT 1 — idempotent. The artifacts the command writes are still on
    // disk, the store still reports the pack installed, and BOTH rendered
    // surfaces still show the installed control set. An update that silently
    // uninstalled, or that left the inventory stale, fails here.
    expect(
      fixtureArtifactsPresent(fixture),
      "update must leave the pack's on-disk artifacts in place"
    ).toBe(true);
    await expectCardInstalled(launched.page, fixture, true);
    await selectPackCard(launched.page, fixture);
    await expect(
      launched.page.getByRole("button", { name: UPDATE_CLAUDE })
    ).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
    await expect(
      launched.page.getByRole("button", { name: INSTALL_CLAUDE })
    ).toHaveCount(0);

    // ACT 2 — UNINSTALL.
    await launched.page.getByRole("button", { name: UNINSTALL }).click();
    await expect
      .poll(() => fixtureArtifactsPresent(fixture), {
        timeout: SETTLE_TIMEOUT_MS,
      })
      .toBe(false);
    await waitForCompletedRuns(launched.page, fixture, "uninstall", 1);
    await settleInstalledState(launched.page, fixture, false);
    launched = await relaunchApp(launched, homes, userDataDir);
    await waitForInstalledState(launched.page, fixture, false);
    await openPacksGrid(launched.page, fixture);
    await expectRunRowsSucceeded(launched.page, fixture, "uninstall", 1);

    // ASSERT 2 — THE CLAIM ISS-6652 EXISTS FOR. The GRID card, which is the
    // inventory a user reads, returns to the actionable Install control and no
    // longer claims the pack is installed. `pack-install-ui-journey.spec.ts`
    // asserts the detail header and the Contents markers; this is the surface
    // neither of them covers, and it renders its own `installedByMe` branch.
    await expectCardInstalled(launched.page, fixture, false);

    expect(launched.pageErrors, "no uncaught renderer errors").toEqual([]);
  } finally {
    await launched.cleanup();
    fs.rmSync(userDataDir, { force: true, recursive: true });
    removeHarnessHomes(homes);
  }
});

/**
 * The launch env every fixture pack needs.
 *
 * `homes.env` redirects every collector home at the temp tree
 * {@link makeHarnessHomes} created, so the spawned run writes there instead of
 * the operator's real `~/.claude`. `SKIP_CATALOG_DETECTORS` short-circuits the
 * per-pack detector probes (a login shell and `npm ls -g`) while still leaving
 * the scope marked succeeded — load-bearing, because the scanner skips its
 * prune entirely when a detector scope failed, and the uninstall assertion
 * depends on that prune. `SKIP_CATALOG_CONTENTS_FETCH` keeps a seeded pack's
 * cached contents from being overwritten by a refresh it has no scrape spec for.
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
 * The only way the panel re-reads the installed-pack store: `useCatalogData`
 * reads once on mount, the Packs view stays mounted across hash changes, and a
 * renderer reload is measurably not enough — `PackScanCoordinator` coalesces
 * scans single-flight, so the rescan a mutation triggers can be swallowed by a
 * boot scan already in flight and nothing re-runs it for the life of the
 * process. Only the NEXT launch's own boot scan observes the new files.
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

/** Seed the fixture's catalog row — the command text the real IPC resolves. */
async function seedFixturePack(
  userDataDir: string,
  fixture: PackInstallFixture
): Promise<void> {
  await seedPackCatalogEntry(userDataDir, {
    displayName: fixture.displayName,
    harnesses: [HarnessName.Claude],
    installCommands: { [HarnessName.Claude]: fixture.installCommand },
    packId: fixture.packId,
    uninstallCommands: { [HarnessName.Claude]: fixture.uninstallCommand },
  });
}

/** Whether the launched app's store currently reports the fixture installed. */
function readInstalledFromStore(
  page: Page,
  fixture: PackInstallFixture
): Promise<boolean> {
  return page.evaluate(async (packId) => {
    const db = (window as PacksDesktopWindow).desktopApi?.db;
    if (!db?.getInstalledPacks) {
      return false;
    }
    const packs = await db.getInstalledPacks();
    return packs.some((pack) => pack.packId === packId);
  }, fixture.packId);
}

/**
 * SYNCHRONIZATION, NOT AN ASSERTION — on a freshly launched app, wait until its
 * boot scan has recorded (or tombstoned) the pack BEFORE anything navigates to
 * Packs. The panel reads the store exactly once on mount with no retry, so a
 * spec that navigated first would pin the pre-scan answer into the UI
 * permanently and then wait on a DOM that can never change.
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
 * post-mutation rescan a chance to land before the app is restarted, so its row
 * persists across the restart. Deliberately returns rather than throws: a
 * timeout here means "the prompt scan did not run", which is not a failure, only
 * the slower path — {@link waitForInstalledState} after the relaunch remains the
 * asserting gate and the next boot scan remains the backstop.
 */
async function settleInstalledState(
  page: Page,
  fixture: PackInstallFixture,
  expected: boolean
): Promise<void> {
  await expect
    .poll(() => readInstalledFromStore(page, fixture), {
      timeout: SETTLE_TIMEOUT_MS,
    })
    .toBe(expected)
    .catch(() => undefined);
}

/** Navigate to Packs and wait for the seeded pack's card. */
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
  ).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
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
 * Assert what the GRID CARD says about the pack, both halves.
 *
 * Both directions are asserted every time — the installed pill present AND the
 * actionable Install absent, or the reverse — so a card that rendered neither
 * (or both) cannot satisfy either call. Scoped to the card so a control
 * elsewhere on the page cannot stand in for it.
 */
async function expectCardInstalled(
  page: Page,
  fixture: PackInstallFixture,
  installed: boolean
): Promise<void> {
  const card = page.getByTestId(`pack-card-${fixture.packId}`);
  await expect(card).toBeVisible({ timeout: CATALOG_READY_TIMEOUT_MS });
  const installedPill = card.getByRole("button", {
    name: CARD_INSTALLED,
    exact: true,
  });
  const installButton = card.getByRole("button", {
    name: CARD_INSTALL,
    exact: true,
  });
  if (installed) {
    await expect(installedPill).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
    await expect(installButton).toHaveCount(0);
    return;
  }
  await expect(installButton).toBeVisible({ timeout: SETTLE_TIMEOUT_MS });
  await expect(installedPill).toHaveCount(0);
}

/**
 * How many runs for an action have RECORDED AN EXIT CODE — i.e. the spawned
 * child actually finished and `recordPackInstallRunEnd` wrote its result.
 *
 * Read through the real preload, and used ONLY as synchronization, never as the
 * assertion: what this spec claims is asserted on screen afterwards.
 */
function readCompletedRunCount(
  page: Page,
  fixture: PackInstallFixture,
  action: string
): Promise<number> {
  return page.evaluate(
    async (input) => {
      const db = (window as PacksDesktopWindow).desktopApi?.db;
      if (!db?.getInstallRuns) {
        return 0;
      }
      const runs = await db.getInstallRuns(input.packId);
      return runs.filter(
        (run) => run.action === input.action && run.exitCode !== null
      ).length;
    },
    { action, packId: fixture.packId }
  );
}

/**
 * SYNCHRONIZATION, NOT AN ASSERTION — block until `expected` runs for this
 * action have finished, so nothing tears the app down mid-run.
 */
async function waitForCompletedRuns(
  page: Page,
  fixture: PackInstallFixture,
  action: "install" | "uninstall",
  expected: number
): Promise<void> {
  await expect
    .poll(() => readCompletedRunCount(page, fixture, action), {
      timeout: SETTLE_TIMEOUT_MS,
    })
    .toBe(expected);
}

/**
 * Assert the install-run history shows EXACTLY `expectedCount` completed,
 * successful runs for an action.
 *
 * Exit 0, not merely "a row exists": `RunStatusBadge` renders "Running" for a
 * null exit code and "Failed (n)" otherwise. And a preflight refusal writes no
 * row at all, because `recordPackInstallRunStart` is reached only after every
 * gate in `streamRun` has passed — which is what makes this the assertion that
 * discriminates against the resolved-`{ started: false }` false green ISS-5027
 * was about.
 */
async function expectRunRowsSucceeded(
  page: Page,
  fixture: PackInstallFixture,
  action: "install" | "uninstall",
  expectedCount: number
): Promise<void> {
  // ANCHORED at the start of the row: `hasText` with a string is a SUBSTRING
  // match, and "install · <id>" is a substring of "uninstall · <id>", so an
  // unanchored install filter also matches the pack's uninstall row. Both ids
  // here are test constants of `[a-z0-9-]`, so they carry no regex
  // metacharacters. The trailing `\b` bounds the id against a WORD character
  // only, so it would NOT exclude a sibling id with a hyphenated suffix; that
  // is sound here because this profile seeds exactly one pack, and is said
  // plainly rather than left to read as a stronger guarantee than it is.
  const rows = page
    .getByTestId("run-history-list")
    .getByRole("listitem")
    .filter({ hasText: new RegExp(`^${action} · ${fixture.packId}\\b`) });
  await expect(rows).toHaveCount(expectedCount, {
    timeout: SETTLE_TIMEOUT_MS,
  });
  // EVERY matching row, not merely one: `RunStatusBadge` renders "Running" for a
  // null exit code and "Failed (n)" otherwise, so asserting one Success among
  // them would stay green with a second run still in flight or already failed.
  await expect(rows.getByText("Success")).toHaveCount(expectedCount, {
    timeout: SETTLE_TIMEOUT_MS,
  });
}
