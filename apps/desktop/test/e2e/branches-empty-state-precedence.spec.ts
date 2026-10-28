/**
 * ISS-9747 — the launched-shell half of the Branches list zero-state precedence.
 *
 * ISS-9429 gave both hosts one resolver (`resolveBranchesListState`), but the
 * signals it decides on are supplied by each host. The desktop renderer supplies
 * them from local SQLite and its own toolbar state, which no jsdom mount and no
 * web Playwright spec exercises — so this drives the real Electron shell over a
 * real seeded store and pins desktop to the same reading of a zero row count the
 * web spec pins the browser to: an unnarrowed zero is a fact about the corpus,
 * a narrowed zero is a fact about the question.
 *
 * Two launches over ONE profile, which is also the cheapest ordering: the first
 * launch is what creates the schema the seed writes into, and an org with
 * nothing in it yet is exactly the genuine-zero case.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action.ts";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy.ts";
import { MY_TASKS_RECENCY_SHOW_ALL_LABEL } from "@repo/app/my-tasks/lib/my-tasks-recency-window.ts";
import { summaryCard } from "./helpers/branches-cloud-fixture";
import {
  armBranchesPageDataGate,
  readHeldBranchesPageData,
  rejectHeldBranchesPageData,
} from "./helpers/branches-page-data-gate";
import {
  activeNavPanel,
  breadcrumbParentLink,
  DesktopDateRangeLabel,
  gotoHash,
  gotoNavSettled,
  launchDesktopApp,
  openDetailFromList,
  selectDesktopDateRange,
} from "./helpers/desktop-app";
import { mergeE2eFeatureFlagAssignment } from "./helpers/e2e-feature-flag-assignment-seed";
import {
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const FIRST_REPOSITORY = "acme/roadrunner";
const SECOND_REPOSITORY = "acme/coyote";
/** `repositoryDisplayLabels` shortens a repo whose short name is unambiguous. */
const FIRST_REPOSITORY_OPTION = "roadrunner";
const FIRST_BRANCH = "feature/iss-9747-first";
const SECOND_BRANCH = "feature/iss-9747-second";
const BRANCHES_NAV_ID = "branches";
const BRANCHES_REGION = "Branches";
const FILTER_BUTTON = "Filter";
const NAME_FACET_GROUP = "Name";
const REPOSITORY_FACET_GROUP = "Repository";
const NO_MATCHES_TITLE = "No matching branches";
const NO_BRANCHES_TITLE = "No branches yet";
const UNAVAILABLE_TITLE = "Couldn't load branches";
const RETRY_BUTTON = "Retry";
/** Escapes a copy literal for safe use inside a built accessible-name regex. */
const REGEX_METACHARACTER = /[.*+?^${}()|[\]\\]/g;
const ACTIVE_BRANCHES_LABEL = "Active branches";
/** `MetricCard`'s dash for a card that keeps its own Unavailable caption. */
const UNAVAILABLE_VALUE_TEXT = "—";
const CARD_VALUE_SELECTOR = '[data-slot="card-title"]';
/**
 * The explanation the retired Branches connect ask used to carry, read from the
 * canonical copy map rather than spelled here so a reword cannot turn the
 * ISS-11274 absence assertion into one that passes for the wrong reason.
 */
const CONNECT_GITHUB_EXPLANATION =
  GITHUB_CONNECT_COPY[GitHubConnectAction.SignUp].gatedMetricExplanation;
/**
 * Every verb the ask can wear, built from the canonical copy map rather than
 * spelled here: the label is action-dependent (`Connect GitHub` / `Reconnect
 * GitHub`) and placement-dependent since ISS-11476 (a card's inline `Connect to
 * GitHub`), so a name pinned to one of them would read as "absent" when another
 * is on screen, and a reword would silently narrow the check.
 */
const CONNECT_GITHUB_CONTROL_NAME = new RegExp(
  Object.values(GITHUB_CONNECT_COPY)
    // `cardCtaLabel` is absent for an action the ISS-11476 prototype never drew,
    // which falls back to `ctaLabel` — already in this list.
    .flatMap((copy) => [copy.ctaLabel, copy.cardCtaLabel ?? copy.ctaLabel])
    .map((label) => label.replace(REGEX_METACHARACTER, "\\$&"))
    .join("|"),
  "i"
);
/** The default tab a branch detail lands on. */
const BRANCH_DETAILS_TAB = "Branch details";
/** The breadcrumb parent that `openDetailFromList` waits on to prove the mount. */
const BRANCHES_BREADCRUMB = "Branches";
/**
 * The detail's comments-rail toggle, whose label flips with the rail's state —
 * matched on the stable half so the probe does not depend on which way it opens.
 */
const COMMENTS_RAIL_TOGGLE = /comments rail/i;
const HOUR_MS = 60 * 60 * 1000;
const NON_WORD_RUN = /\W+/g;
const LAUNCHED_TEST_TIMEOUT_MS = 180_000;
// Two launches plus a gated read cycle; the sibling gated Branches spec budgets
// the same.
const GATED_TEST_TIMEOUT_MS = 240_000;
const FIRST_PAINT_TIMEOUT_MS = 30_000;

test("the launched Branches list separates an empty corpus from a narrowed one", async () => {
  test.setTimeout(LAUNCHED_TEST_TIMEOUT_MS);

  const dirs = fixtureDirectories();
  let launched: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    launched = await launchApp(dirs);
    await waitForBranchesSchema(dirs.userDataDir);
    const emptyOrgPanel = await gotoNavSettled(launched.page, BRANCHES_NAV_ID);
    const emptyOrgList = branchesList(emptyOrgPanel);

    // Nothing is captured yet AND the default window is bounded, so the honest
    // reading is "none in this range" — with the range reset offered, because
    // the range is the only thing narrowing.
    await expect(listText(emptyOrgList, NO_MATCHES_TITLE)).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });
    await expect(showAllTimeButton(emptyOrgList)).toBeVisible();
    await expect(listText(emptyOrgList, NO_BRANCHES_TITLE)).toHaveCount(0);

    // Drop the window: now nothing narrows the read, which is the only state in
    // which a zero may be reported as a fact about the organization.
    await selectDesktopDateRange(launched.page, DesktopDateRangeLabel.AllTime);
    await expect(listText(emptyOrgList, NO_BRANCHES_TITLE)).toBeVisible();
    await expect(listText(emptyOrgList, NO_MATCHES_TITLE)).toHaveCount(0);
    await expect(showAllTimeButton(emptyOrgList)).toHaveCount(0);

    await launched.cleanup();
    launched = null;

    await seedBranch(dirs.userDataDir, FIRST_REPOSITORY, FIRST_BRANCH);
    await seedBranch(dirs.userDataDir, SECOND_REPOSITORY, SECOND_BRANCH);

    launched = await launchApp(dirs);
    const panel = await gotoNavSettled(launched.page, BRANCHES_NAV_ID);
    const list = branchesList(panel);

    // Stated, not inherited: the facets applied below have to be the ONLY thing
    // narrowing this read, or the claim about which signal emptied the list is
    // unfalsifiable. The helper is idempotent and asserts the selection, so this
    // holds whether or not the profile carried the choice over.
    await selectDesktopDateRange(launched.page, DesktopDateRangeLabel.AllTime);
    await expect(branchLink(list, FIRST_BRANCH)).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });
    await expect(branchLink(list, SECOND_BRANCH)).toBeVisible();
    await expect(listText(list, NO_MATCHES_TITLE)).toHaveCount(0);

    await selectFacetOption(
      launched.page,
      REPOSITORY_FACET_GROUP,
      FIRST_REPOSITORY_OPTION
    );
    await expect(branchLink(list, SECOND_BRANCH)).toHaveCount(0);
    await expect(branchLink(list, FIRST_BRANCH)).toBeVisible();

    // Two facets whose intersection is empty. The corpus is still two branches —
    // the rows above prove it — so "No branches yet" here would tell a populated
    // workspace it had never captured anything.
    await selectFacetOption(launched.page, NAME_FACET_GROUP, SECOND_BRANCH);
    await expect(listText(list, NO_MATCHES_TITLE)).toBeVisible();
    await expect(listText(list, NO_BRANCHES_TITLE)).toHaveCount(0);
    await expect(showAllTimeButton(list)).toHaveCount(0);
    await expect(branchLink(list, FIRST_BRANCH)).toHaveCount(0);
    expect(launched.pageErrors).toEqual([]);
  } finally {
    await launched?.cleanup();
    removeFixtureDirectories(dirs);
  }
});

test("a failed launched Branches read outranks the filtered empty", async () => {
  test.setTimeout(GATED_TEST_TIMEOUT_MS);

  const dirs = fixtureDirectories();
  let launched: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    const bootstrap = await launchApp(dirs);
    try {
      await waitForBranchesSchema(dirs.userDataDir);
    } finally {
      await bootstrap.cleanup();
    }
    await seedBranch(dirs.userDataDir, FIRST_REPOSITORY, FIRST_BRANCH);
    await seedBranch(dirs.userDataDir, SECOND_REPOSITORY, SECOND_BRANCH);

    mergeE2eFeatureFlagAssignment(dirs.userDataDir, {
      "branches-listing-loading-parity": true,
    });
    launched = await launchApp(dirs, {
      branchesPageDataGate: true,
    });
    // Seeded from the URL, so the facet is narrowing before the first paint and
    // stays so through every state below.
    await gotoHash(
      launched.page,
      `/${BRANCHES_NAV_ID}?repo=${encodeURIComponent(FIRST_REPOSITORY)}`
    );
    const panel = activeNavPanel(launched.page, BRANCHES_NAV_ID);
    await expect(panel).toBeVisible({ timeout: FIRST_PAINT_TIMEOUT_MS });
    const list = branchesList(panel);
    await expect(branchLink(list, FIRST_BRANCH)).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });
    // The facet really is narrowing, and the corpus behind it really is larger
    // than what the list shows — both halves the error state below is about.
    await expect(branchLink(list, SECOND_BRANCH)).toHaveCount(0);

    await launched.page.clock.install();
    await armBranchesPageDataGate(launched.app);
    await selectDesktopDateRange(
      launched.page,
      DesktopDateRangeLabel.Last30Days
    );
    await expect(listText(list, "Loading branches...")).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });
    await expect(listText(list, NO_MATCHES_TITLE)).toHaveCount(0);
    await expect(listText(list, NO_BRANCHES_TITLE)).toHaveCount(0);
    await expect(listText(list, UNAVAILABLE_TITLE)).toHaveCount(0);

    await launched.page.clock.fastForward(31_000);
    await expect(retryButton(list)).toHaveCount(0);
    await expect(listText(list, UNAVAILABLE_TITLE)).toHaveCount(0);
    await rejectHeldPageData(launched.app);

    // An error is not an absence. Reporting it as "no branches match" would
    // delete the reader's only signal that anything went wrong.
    await expect(listText(list, UNAVAILABLE_TITLE)).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });
    await expect(retryButton(list)).toBeVisible();
    await expect(listText(list, NO_MATCHES_TITLE)).toHaveCount(0);
    await expect(listText(list, NO_BRANCHES_TITLE)).toHaveCount(0);
    await expect(listText(list, "Loading branches...")).toHaveCount(0);
    await expect(branchLink(list, FIRST_BRANCH)).toHaveCount(0);
  } finally {
    await launched?.cleanup();
    removeFixtureDirectories(dirs);
  }
});

/**
 * ISS-10864 and ISS-10574: a credential-less guest still reads published local
 * Branches without provider I/O. Default-branch authority is absent, so the
 * qualified Active branches number is unavailable while the rows remain visible.
 * The failed-read test above owns the positive assertions for the error and
 * Retry locators this case checks as absent.
 */
test("a credential-less reader's launched Branches list renders its corpus", async () => {
  test.setTimeout(LAUNCHED_TEST_TIMEOUT_MS);

  const dirs = fixtureDirectories();
  let launched: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    const bootstrap = await launchApp(dirs, { env: GUEST_ENV });
    try {
      await waitForBranchesSchema(dirs.userDataDir);
    } finally {
      await bootstrap.cleanup();
    }
    await seedBranch(dirs.userDataDir, FIRST_REPOSITORY, FIRST_BRANCH);
    await seedBranch(dirs.userDataDir, SECOND_REPOSITORY, SECOND_BRANCH);

    launched = await launchApp(dirs, { env: GUEST_ENV });
    // The assertions below cannot tell this case apart from a launch carrying a
    // key that merely fails to authenticate, so they stay green when the blank
    // stops reaching the launch. Read the main process directly, or an operator
    // or runner with `CLOSEDLOOP_API_KEY` exported silently runs a DIFFERENT
    // condition under this name.
    expect(
      await launched.app.evaluate(() => process.env.CLOSEDLOOP_API_KEY)
    ).toBe(BLANK_CREDENTIAL);
    const panel = await gotoNavSettled(launched.page, BRANCHES_NAV_ID);
    const list = branchesList(panel);
    await selectDesktopDateRange(launched.page, DesktopDateRangeLabel.AllTime);

    // The corpus renders. Asserting the rows — not merely that no error card
    // appeared — is what separates the fix from an empty profile.
    await expect(branchLink(list, FIRST_BRANCH)).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });
    await expect(branchLink(list, SECOND_BRANCH)).toBeVisible();

    // No failure, and no Retry for a state a retry cannot change.
    await expect(listText(list, UNAVAILABLE_TITLE)).toHaveCount(0);
    await expect(retryButton(list)).toHaveCount(0);
    await expect(listText(list, NO_BRANCHES_TITLE)).toHaveCount(0);
    await expect(listText(list, NO_MATCHES_TITLE)).toHaveCount(0);

    // The two visible local rows do not establish a qualified cohort total:
    // without account authority, either could be the repository default.
    await expect(
      summaryCardValue(launched.page, ACTIVE_BRANCHES_LABEL)
    ).toHaveText(UNAVAILABLE_VALUE_TEXT, { timeout: FIRST_PAINT_TIMEOUT_MS });

    // ISS-12638 put the connect ask on the GitHub-truth summary cards, not on
    // this one: Active branches is not GitHub truth, so it keeps its dash and
    // carries no ask. The dash above is the presence pair for this absence.
    await expect(
      summaryCard(launched.page, ACTIVE_BRANCHES_LABEL).getByRole("button", {
        name: CONNECT_GITHUB_CONTROL_NAME,
      })
    ).toHaveCount(0);

    // ISS-11274 removed the standalone connect bar from the DETAIL too, and a
    // list-only check never visits it. Same reader, same launch, one click.
    //
    // Scoped to the PAGE, not to `panel`: a branch detail is not rendered inside
    // the Branches nav panel at all — `App.tsx` replaces the whole keep-alive
    // panel tree with the detail view once the route carries a branch id, so a
    // `panel`-scoped probe here resolves nothing and every absence below would
    // pass vacuously. That is precisely what the presence pair caught.
    await openDetailFromList(
      launched.page,
      branchLink(list, FIRST_BRANCH),
      BRANCHES_BREADCRUMB
    );
    await expect(
      launched.page.getByRole("tab", { name: BRANCH_DETAILS_TAB }).first()
    ).toBeVisible({ timeout: FIRST_PAINT_TIMEOUT_MS });
    await expectNoConnectGitHubAsk(launched.page, {
      button: launched.page
        .getByRole("button", { name: COMMENTS_RAIL_TOGGLE })
        .first(),
      link: breadcrumbParentLink(launched.page, BRANCHES_BREADCRUMB),
    });

    expect(launched.pageErrors).toEqual([]);
  } finally {
    await launched?.cleanup();
    removeFixtureDirectories(dirs);
  }
});

/**
 * A launch with no cloud credential.
 *
 * `launchDesktopApp` spreads `...process.env` into the Electron launch, so an
 * EMPTY object is not credential-free: a `CLOSEDLOOP_API_KEY` exported in the
 * operator's or CI's shell reaches the app and eligibility resolves `fresh`
 * with no authorities — a DIFFERENT condition from this one, and one that still
 * legitimately fails closed. Blanking the key is what makes the launch
 * credential-free; the desktop env schemas set `emptyStringAsUndefined`, so
 * `""` reads as unset, not as a bad key.
 *
 * The local read never calls those callbacks; it uses the no-network
 * not-connected eligibility source and still serves published rows.
 */
const BLANK_CREDENTIAL = "";
const GUEST_ENV: Readonly<Record<string, string>> = {
  CLOSEDLOOP_API_KEY: BLANK_CREDENTIAL,
};

function summaryCardValue(page: Page, label: string): Locator {
  return summaryCard(page, label).locator(CARD_VALUE_SELECTOR);
}

/**
 * The Branches list region inside the COMMITTED nav panel. Keep-alive leaves
 * every visited view mounted, so an unscoped query ranges over surfaces the user
 * is not looking at — including other lists that render branch names.
 */
function branchesList(panel: Locator): Locator {
  return panel.getByRole("region", { name: BRANCHES_REGION });
}

/** An empty-state title: `EmptyState` renders it as a div, so there is no role. */
function listText(list: Locator, text: string): Locator {
  return list.getByText(text, { exact: true });
}

function showAllTimeButton(list: Locator): Locator {
  return list.getByRole("button", { name: MY_TASKS_RECENCY_SHOW_ALL_LABEL });
}

function branchLink(list: Locator, name: string): Locator {
  return list.getByRole("link", { exact: true, name });
}

/**
 * The Retry inside the LIST's own error alert. The summary band renders inside
 * this same region and has design-system `Alert`s of its own, so the title
 * filter is what keeps the query pinned to the list's failure rather than to
 * whichever alert happens to come first.
 */
function retryButton(list: Locator): Locator {
  return list
    .getByRole("alert")
    .filter({ hasText: UNAVAILABLE_TITLE })
    .getByRole("button", { name: RETRY_BUTTON });
}

/**
 * Select one option in a `FilterPopover` facet submenu. The options are plain
 * `menuitem`s and a multi-select facet keeps the menu open, so it is dismissed
 * before the caller reads the list: Radix `aria-hidden`s the page behind an open
 * dropdown, which would make a list query resolve to nothing whether or not the
 * selection ever reached the view.
 */
async function selectFacetOption(
  page: Page,
  group: string,
  option: string
): Promise<void> {
  await page
    .getByRole("button", { exact: true, name: FILTER_BUTTON })
    .filter({ visible: true })
    .click();
  await page.getByRole("menuitem", { name: group }).click();
  await page.getByRole("menuitem", { name: option }).click();
  await page.keyboard.press("Escape");
}

/**
 * Fail every page-data response the gate is holding. Polled rather than read
 * once: arming the gate only intercepts a response the main process has yet to
 * produce, so a single snapshot taken while the SQLite read is still running
 * sees nothing held and would report an empty hold as a failed one.
 */
async function rejectHeldPageData(
  app: Parameters<typeof readHeldBranchesPageData>[0]
): Promise<void> {
  await expect
    .poll(async () => (await readHeldBranchesPageData(app)).length)
    .toBeGreaterThan(0);
  for (const entry of await readHeldBranchesPageData(app)) {
    await rejectHeldBranchesPageData(app, entry.id);
  }
}

async function seedBranch(
  userDataDir: string,
  repoFullName: string,
  branchName: string
): Promise<void> {
  await seedNoPullRequestBranch(userDataDir, {
    activityAt: new Date(Date.now() - HOUR_MS).toISOString(),
    branchName,
    repoFullName,
    sessionId: `iss-9747-${branchName.replace(NON_WORD_RUN, "-")}`,
  });
}

function launchApp(
  dirs: FixtureDirectories,
  options: Readonly<{
    branchesPageDataGate?: boolean;
    env?: Readonly<Record<string, string>>;
  }> = {}
) {
  return launchDesktopApp({
    branchesPageDataGate: options.branchesPageDataGate,
    env: {
      CLAUDE_HOME: dirs.claudeHome,
      CODEX_HOME: dirs.codexHome,
      ...options.env,
    },
    keepUserDataDir: true,
    revealWindow: false,
    userDataDir: dirs.userDataDir,
  });
}

function fixtureDirectories() {
  return {
    claudeHome: fs.mkdtempSync(path.join(os.tmpdir(), "iss-9747-claude-")),
    codexHome: fs.mkdtempSync(path.join(os.tmpdir(), "iss-9747-codex-")),
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "iss-9747-udd-")),
  };
}

type FixtureDirectories = ReturnType<typeof fixtureDirectories>;

function removeFixtureDirectories(dirs: FixtureDirectories): void {
  fs.rmSync(dirs.userDataDir, { force: true, recursive: true });
  fs.rmSync(dirs.claudeHome, { force: true, recursive: true });
  fs.rmSync(dirs.codexHome, { force: true, recursive: true });
}

/**
 * No connect-GitHub ask on this surface — the sentence AND both shapes the
 * control can take (`button` on desktop's `onConnect`, `link` on web's href),
 * since a surface that kept the verb and dropped the sentence would satisfy a
 * copy-only check.
 *
 * `presence` is REQUIRED and asserted before any absence: an absence assertion
 * on a locator that resolves nothing always passes, so each caller must name a
 * real control of the surface under test for each role the probe uses. Taking
 * them as arguments is what makes the pairing structural — a caller cannot add
 * a new surface without also naming what proves its locators resolve.
 */
async function expectNoConnectGitHubAsk(
  scope: Page | Locator,
  presence: Readonly<{ button: Locator; link: Locator }>
): Promise<void> {
  await expect(presence.button).toBeVisible();
  await expect(presence.link).toBeVisible();
  await expect(scope.getByText(CONNECT_GITHUB_EXPLANATION)).toHaveCount(0);
  await expect(
    scope.getByRole("button", { name: CONNECT_GITHUB_CONTROL_NAME })
  ).toHaveCount(0);
  await expect(
    scope.getByRole("link", { name: CONNECT_GITHUB_CONTROL_NAME })
  ).toHaveCount(0);
}
