import { type BranchRow, BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { makeBranchRow } from "@repo/app/branches/data-source/__tests__/branch-row-test-fixture";
import type { BothHostRenderContract } from "@repo/app/shared/testing/both-host-render-contract";
import {
  DESKTOP_HOST,
  foundOrAbsent,
} from "@repo/app/shared/testing/both-host-render-contract";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * ISS-9544 — what the Branches list owes its reader on BOTH shells, stated once.
 *
 * `apps/app`'s page and `apps/desktop`'s `BranchesView` compose the same shared
 * `BranchesListSurfaceV2` body from different module graphs, provider stacks and
 * gate ports. A lane that inspects only direct desktop imports misses that shared
 * render path; this check mounts the shell and reads what came out.
 *
 * ISS-10301: each render problem is ONE case now. It used to be two, because
 * `grid-table-v2` closed routed every reader through a second component tree
 * entirely; that key retired ENABLED and the closed path is gone with it.
 */

/** The org this reader is in. Only the web route carries it in a path. */
export const CONTRACT_ORG_SLUG = "acme";

export type BranchesBothHostFixture = {
  readonly rows: readonly BranchRow[];
};

/**
 * Recent, not the canonical builder's pinned instant: both shells window the
 * list to the last 30 days of activity, so a fixed date silently ages out and
 * empties the table — which would leave every case below asserting over zero
 * rows and reading as a divergence that is really an expired fixture.
 */
const RECENT_ACTIVITY_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const OLDER_ACTIVITY_AT = new Date(
  Date.now() - 2 * 60 * 60 * 1000
).toISOString();

function contractRow(
  id: string,
  branchName: string,
  prNumber: number,
  status: BranchStatus,
  lastActivityAt: string
): BranchRow {
  return {
    ...makeBranchRow(id),
    branchName,
    lastActivityAt,
    prNumber,
    prState:
      status === BranchStatus.Merged
        ? GitHubPRState.Merged
        : GitHubPRState.Open,
    prTitle: `Wire ${branchName}`,
    prUrl: `https://github.com/acme/app/pull/${prNumber}`,
    sessionIds: [`session-${id}`],
    status,
  };
}

/**
 * Two rows, not one: a shell that renders a single hard-coded row, or collapses
 * the cohort to its first entry, satisfies a one-row fixture.
 */
export const CONTRACT_ROWS: readonly BranchRow[] = [
  contractRow(
    "branch-both-host-2",
    "feature/both-host-two",
    102,
    BranchStatus.Open,
    RECENT_ACTIVITY_AT
  ),
  contractRow(
    "branch-both-host-1",
    "feature/both-host-one",
    101,
    BranchStatus.Merged,
    OLDER_ACTIVITY_AT
  ),
];

async function everyBranchNamed({
  rows,
}: BranchesBothHostFixture): Promise<string | undefined> {
  for (const row of rows) {
    const named = await foundOrAbsent(() =>
      screen.findAllByText(row.branchName)
    );
    if (named === undefined) {
      return `no element names the branch "${row.branchName}"`;
    }
  }
  return undefined;
}

/**
 * Every row reaches its own detail route, asserted inside the row that NAMES
 * that branch.
 *
 * Row-scoped rather than scoped to the list region: the region only exists on
 * the v2 surface, which is exactly why the gate-closed path went unchecked and
 * a v1 regression that left rows visible while dropping their detail links
 * passed on both shells (davetho review). Per-row is also stronger than
 * per-region — one row carrying both hrefs no longer covers for a sibling that
 * carries none — and the facet menus, which list the same branch names, are not
 * rows and so still cannot satisfy it.
 */
async function rowsLinkToBranchDetail({
  rows,
}: BranchesBothHostFixture): Promise<string | undefined> {
  for (const row of rows) {
    const hrefs = await branchRowHrefs(row.branchName);
    if (hrefs === undefined) {
      return `no element names the branch "${row.branchName}"`;
    }
    if (!hrefs.some((href) => href.endsWith(`/branches/${row.id}`))) {
      return `the row naming "${row.branchName}" carries no link to /branches/${row.id}`;
    }
  }
  return undefined;
}

async function rowsExposePullRequestActions({
  rows,
}: BranchesBothHostFixture): Promise<string | undefined> {
  for (const row of rows) {
    const hrefs = await branchRowHrefs(row.branchName);
    if (hrefs === undefined) {
      return `no element names the branch "${row.branchName}"`;
    }
    if (row.prUrl !== null && !hrefs.includes(row.prUrl)) {
      return `the row naming "${row.branchName}" carries no pull-request action for ${row.prUrl}`;
    }
  }
  return undefined;
}

async function rowsExposeCanonicalStatuses({
  rows,
}: BranchesBothHostFixture): Promise<string | undefined> {
  for (const row of rows) {
    const named = await foundOrAbsent(() =>
      screen.findAllByText(row.branchName)
    );
    if (named === undefined) {
      return `no element names the branch "${row.branchName}"`;
    }
    const expectedStatus =
      row.status === BranchStatus.Merged ? "Merged" : "Open";
    const rowElement = named
      .map((candidate) => candidate.closest<HTMLElement>(TABLE_ROW_SELECTOR))
      .find((candidate) => candidate !== null);
    if (!(rowElement && within(rowElement).queryByText(expectedStatus))) {
      return `the row naming "${row.branchName}" does not expose status ${expectedStatus}`;
    }
  }
  return undefined;
}

async function rowsFollowLastActivityOrder(): Promise<string | undefined> {
  const newestRow = await branchRowElement("feature/both-host-two");
  const oldestRow = await branchRowElement("feature/both-host-one");
  if (!(newestRow && oldestRow)) {
    return "one or more fixture rows are absent";
  }
  const renderedRows = Array.from(
    document.querySelectorAll<HTMLElement>(TABLE_ROW_SELECTOR)
  );
  if (renderedRows.indexOf(newestRow) >= renderedRows.indexOf(oldestRow)) {
    return "the rows are not ordered by descending last activity";
  }
  return undefined;
}

/**
 * The web route is org-scoped; the desktop shell's is not. A real, named
 * divergence rather than a shared expectation neither shell could keep.
 */
async function orgScopedBranchLinks({
  rows,
}: BranchesBothHostFixture): Promise<string | undefined> {
  for (const row of rows) {
    const hrefs = await branchRowHrefs(row.branchName);
    if (hrefs === undefined) {
      return `no element names the branch "${row.branchName}"`;
    }
    const scoped = `/${CONTRACT_ORG_SLUG}/branches/${row.id}`;
    if (!hrefs.includes(scoped)) {
      return `the row naming "${row.branchName}" carries no link to ${scoped}`;
    }
  }
  return undefined;
}

/**
 * Every href inside the row that names `branchName`, or `undefined` when
 * nothing on screen names it at all.
 *
 * A name that IS on screen but sits outside any row THROWS rather than
 * returning a sentence. `caseOutcomeProblem` reads a sentence as proof that a
 * declared divergence is real, so a row lookup that quietly broke would excuse
 * the desktop shell from the org-scoping case forever — the same laundering
 * `foundOrAbsent` refuses one level up.
 */
async function branchRowHrefs(
  branchName: string
): Promise<string[] | undefined> {
  const row = await branchRowElement(branchName);
  if (row === undefined) {
    return;
  }
  return within(row)
    .queryAllByRole("link")
    .map((link) => link.getAttribute("href") ?? "");
}

async function branchRowElement(
  branchName: string
): Promise<HTMLElement | undefined> {
  const named = await foundOrAbsent(() => screen.findAllByText(branchName));
  if (named === undefined) {
    return;
  }
  const row = named
    .map((candidate) => candidate.closest<HTMLElement>(TABLE_ROW_SELECTOR))
    .find((candidate) => candidate !== null);
  if (row) {
    return row;
  }
  throw new Error(
    `"${branchName}" is on screen but inside no ${TABLE_ROW_SELECTOR}, so this contract cannot read the row it belongs to.`
  );
}

/** A grid body row, on both the v1 and the v2 table shape. */
const TABLE_ROW_SELECTOR = '[role="row"]';

const NO_ORG_IN_PATH =
  "The desktop shell signs one reader into one workspace and routes branch detail at /branches/:id with no org segment, so there is no slug for a link to carry.";

/** ISS-12664: a card row per summary card, named as the strip names it. */
const SUMMARY_CARD_MENU_LABELS = [
  "Active branches",
  "Median PR size",
  "Total LOC pushed",
  "Merge rate",
  "LOC per $",
];

async function optionsOffersEverySummaryCard(): Promise<string | undefined> {
  await userEvent.click(await screen.findByRole("button", { name: "Options" }));
  const menu = await screen.findByRole("menu");
  const missing = SUMMARY_CARD_MENU_LABELS.filter(
    (label) => within(menu).queryByRole("menuitem", { name: label }) === null
  );
  return missing.length === 0
    ? undefined
    : `the Options menu offers no summary-card row for ${missing.join(", ")}`;
}

export const BRANCHES_BOTH_HOST_CONTRACT: BothHostRenderContract<BranchesBothHostFixture> =
  {
    surface: "Branches list",
    // ISS-10301: each render problem used to be asserted twice, once per
    // `grid-table-v2` arm. There is one surface now, so each states its
    // contract once.
    cases: [
      {
        renderProblem: everyBranchNamed,
        fixture: { rows: CONTRACT_ROWS },
        name: "names every branch",
      },
      {
        renderProblem: rowsLinkToBranchDetail,
        fixture: { rows: CONTRACT_ROWS },
        name: "links every row to its own branch detail",
      },
      {
        renderProblem: rowsExposeCanonicalStatuses,
        fixture: { rows: CONTRACT_ROWS },
        name: "renders the same canonical PR-derived status",
      },
      {
        renderProblem: rowsFollowLastActivityOrder,
        fixture: { rows: CONTRACT_ROWS },
        name: "orders the same fixture by last activity",
      },
      {
        renderProblem: rowsExposePullRequestActions,
        fixture: { rows: CONTRACT_ROWS },
        name: "exposes each row's pull-request action",
      },
      {
        renderProblem: optionsOffersEverySummaryCard,
        fixture: { rows: CONTRACT_ROWS },
        name: "offers every summary card for hiding in Options",
      },
      {
        divergence: { [DESKTOP_HOST]: NO_ORG_IN_PATH },
        renderProblem: orgScopedBranchLinks,
        fixture: { rows: CONTRACT_ROWS },
        name: "scopes each branch link to the reader's org",
      },
    ],
  };
