import { resolveAttributedBranchCost } from "@repo/api/src/types/branch-cost";
import { BranchDetailPage } from "@repo/app/branches/components/branch-detail-page";
import { BranchesTable } from "@repo/app/branches/components/branches-table";
import { RENDER_MISSING } from "@repo/app/branches/lib/branch-row";
import { adaptBranchRows } from "@repo/app/branches/lib/branch-row-adapter";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeSource,
  openPullRequestRow,
  phaseProjectionRows,
} from "../../../../../test/shared-branches-test-helpers.js";
import {
  getSharedBranchDetail,
  getSharedBranches,
} from "../../../../main/branch/shared-branches-api.js";

/**
 * ISS-6725: ONE stored branch, rendered on the Branches LIST row and on the
 * Branches DETAIL page, must report the same Last active, the same cost, and the
 * same PR identity.
 *
 * THE ASSERTION IS LIST-VS-DETAIL, NEVER EITHER-VS-A-CONSTANT. That is the
 * ticket: the Branches parity tests that already exist are each single-sided.
 * `branch-baseline-list-detail-parity.test.tsx` compares two CARD components
 * over hand-authored analytics fixtures and `canonical-projection-parity.test.ts`
 * pins the HTTP transport against a canned payload, so neither reaches the
 * desktop main-process projection at all and both stay green when it drifts; `branch-reads-billing-parity.test.ts` and
 * `branch-analytics-bounded-parity.test.ts` are desktop-only. Pinning each side
 * to its own literal is the same false green in a third shape — both sides
 * agree with their own literal while disagreeing with each other on every row
 * outside the fixture.
 *
 * WHY THIS IS NOT A COMPARISON OF ONE VALUE WITH ITSELF. `getSharedBranches` and
 * `getSharedBranchDetail` (`src/main/branch/shared-branches-api.ts`, the
 * 39-churn/26-fix module this ticket names) share the list projection but run it
 * over SEPARATELY EXECUTED reads — the detail's are the branch-scoped
 * `…ForBranch` variants. Injecting a divergence into the detail projection reds
 * the third case below while leaving the others green.
 *
 * WHAT THAT DOES NOT REACH, stated so the claim is not larger than the coverage:
 * the even-split divisor itself. It lives in the token-aggregate SQL
 * (`SUM(t.cost_usd_estimated / CAST(l.branch_count AS REAL))`), which never
 * executes against the canned source — `makeSource` dispatches the scoped and
 * unscoped token reads on the same `GROUP BY` fragment and serves both the same
 * pre-computed row at `branch_count: 1`. So a change to the DETAIL's divisor or
 * its `denominatorKeys` would not red anything here. What this case does catch
 * is a detail-specific transform applied AFTER the read, which is the shape both
 * counterfactuals take. Closing the divisor gap needs a fixture whose raw and
 * attributed costs differ (a session at `branch_count: 2`) plus a fake that
 * distinguishes the two reads; that is worth doing and is not done here.
 *
 * ISS-6725 ALSO ASKED FOR A DESKTOP-VS-WEB EQUALITY ON THESE SAME SCREENS. It
 * is NOT here, and the honest reason is narrower than "impossible":
 *
 *  - What was tried and REJECTED: serializing the desktop record and reviving it
 *    through the web API client to stand in for a web read. That is the identity
 *    function on this payload, so it is the desktop producer run twice.
 *    `ENDPOINT_STRING_ONLY_DATE_KEYS` (`packages/app/shared/api/
 *    endpoint-date-revival.ts`) SUPPRESSES revival of `lastActivityAt`,
 *    `mergedAt`, `createdAt`, `updatedAt` and the rest on both `/branches` and
 *    `/branches/[id]`, and disabling the reviver outright left such a test fully
 *    green. So that shape is a false green, measured rather than argued.
 *  - The CLOUD PRODUCER remains out of reach: `apps/api/app/branches/
 *    branch-read-service` cannot be imported from outside `apps/api`.
 *  - But a REAL second reader IS reachable in this process, and this file does
 *    not exercise it. `createLocalBranchesDataSource` (desktop) and
 *    `createHttpBranchesDataSource` (web) fork on the same record: the local one
 *    runs `suppressMismatchedSelectedPullRequest`, which on a selection mismatch
 *    blanks PR identity and drives canonical metrics to Unavailable, and the
 *    HTTP one does not; only the HTTP one validates pagination totals and
 *    follows pages. Same stored branch, same shared components, two different
 *    rendered detail headers. `apps/desktop/src/renderer/shared-branches/
 *    __tests__/read-source-cross-surface-parity.test.tsx` is a working template
 *    for exactly that comparison.
 *
 * So the cross-surface half of ISS-6725 is achievable at the ADAPTER layer, is
 * not delivered here, and should be picked up with that scope rather than closed.
 * Producer-level cloud-vs-desktop agreement stays separately covered by the
 * repo's two-file pattern (`apps/desktop/test/cross-surface-parity.test.ts` with
 * `apps/api/app/branches/cross-surface-parity.integration.test.ts`).
 *
 * WHERE EACH FIELD IS ASSERTED, and why that differs by field: the surfaces do
 * not render all three values on both screens. A list row renders Last active
 * and PR identity; the detail renders cost and PR identity. PR identity is
 * therefore compared as RENDERED TEXT on both screens. Last active and cost are
 * rendered on the screen that shows them and compared at the projection boundary
 * across the screen that does not — because the alternative, adding a Last
 * active row to the detail or a cost cell to the list, is a user-visible
 * capability change no ticket scoped (Product Decision Guardrail) and is not
 * this test's to make.
 *
 * ONE branch, not two: the canned `prs` read in `shared-branches-test-helpers`
 * serves every PR row to every branch query, so a second branch would put the
 * detail into its genuine "multiple pull requests are active" state and stop
 * rendering the single-PR panel this compares. The guard against a projection
 * that collapsed every field to one answer is therefore the positive siblings
 * below — a PR number pinned from the stored fixture, a Last active cell that
 * matches its adapted label rather than either placeholder, and a finite
 * compared cost — not a second row.
 *
 * The list half renders through `approved`, the variant both surfaces ship. That
 * prop is not cosmetic: without it `BranchesTable` renders a LEGACY GridTable
 * whose `pr` cell is a different renderer reading a different field, so the
 * rendered comparisons would be grading a component no user ever sees.
 */

/** Pinned so a relative "Last active" label cannot change between two renders. */
const FIXED_NOW = new Date("2026-06-12T09:00:00.000Z");

/** The list column ids read one at a time, so each extraction is unambiguous. */
const LAST_ACTIVE_COLUMN = "lastActivity";
const PULL_REQUEST_COLUMN = "pr";

/** A currency-formatted figure. See the caveat on its assertion below. */
const RENDERED_CURRENCY_PATTERN = /\$\d/;

/**
 * The PR number the STORED fixture carries, read off the fixture factory rather
 * than off a projection's output. A shape assertion that took its expected
 * value from the row under test could only catch a rendering bug, never a
 * projection that selected the wrong pull request.
 */
const FIXTURE_PR_NUMBER = openPullRequestRow().pr_number;

type DesktopBranchDetail = NonNullable<
  Awaited<ReturnType<typeof getSharedBranchDetail>>
>;

/**
 * One list column, rendered through the variant BOTH surfaces actually ship.
 *
 * `approved` is load-bearing and NOT a default: `BranchesTable` returns early
 * into `ApprovedBranchesTable` when it is set, and that is what the desktop list
 * (`branches-view.tsx`) and the web list (the branches page) both pass —
 * unconditionally, not behind a flag. Without it this renders the LEGACY
 * GridTable path, whose `pr` cell is a different renderer reading a different
 * field, so a regression in the shipped component would leave this green.
 */
function renderListColumn(
  items: ReturnType<typeof adaptBranchRows>,
  columnId: string
) {
  return render(
    <AppCoreStoryProviders>
      <BranchesTable
        allRows={items}
        approved
        columnOrder={[]}
        columnWidths={{}}
        items={items}
        onColumnOrderChange={() => undefined}
        onColumnWidthChange={() => undefined}
        onSort={() => undefined}
        sortBy="updated"
        sortDir="desc"
        visibleColumns={new Set([columnId])}
      />
    </AppCoreStoryProviders>
  );
}

function renderDetail(detail: DesktopBranchDetail) {
  return render(
    <AppCoreStoryProviders>
      <BranchDetailPage
        backHref="/branches"
        branchId={detail.id}
        detail={detail}
        isError={false}
        isLoading={false}
      />
    </AppCoreStoryProviders>
  );
}

/**
 * The rendered text of ONE column's cell in the data row.
 *
 * Scoped to `data-column-id` rather than to the row: every GridTable row also
 * renders a lead cell (the branch name) regardless of which columns are
 * visible, so reading the whole row means the lead alone satisfies any
 * "non-empty" check — a column whose cell renderer was deleted outright would
 * still look populated.
 */
function cellText(container: HTMLElement, columnId: string): string {
  const rows = Array.from(container.querySelectorAll('[role="row"]'));
  const dataRow = rows.at(-1);
  if (!dataRow || rows.length < 2) {
    throw new Error("branches table rendered no data row");
  }
  const cell = dataRow.querySelector(`[data-column-id="${columnId}"]`);
  if (!cell) {
    throw new Error(`branches table rendered no ${columnId} cell`);
  }
  return normalize(cell.textContent ?? "");
}

/** Accessible names of every rendered anchor pointing at `prUrl`. */
function prLinkNames(container: HTMLElement, prUrl: string): string[] {
  return Array.from(
    container.querySelectorAll<HTMLAnchorElement>(`a[href="${prUrl}"]`)
  )
    .map((anchor) =>
      normalize(anchor.getAttribute("aria-label") ?? anchor.textContent ?? "")
    )
    .filter((name) => name.length > 0);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The stored branch, read through BOTH of the desktop main process's paths. */
async function readListAndDetail() {
  const rows = phaseProjectionRows();
  const list = await getSharedBranches(makeSource(rows), {});
  const listRow = list.items[0];
  if (!listRow) {
    throw new Error("desktop list produced no row for the stored branch");
  }
  const detail = await getSharedBranchDetail(makeSource(rows), listRow.id);
  if (!detail) {
    throw new Error("desktop detail produced no record for the stored branch");
  }
  return { detail, listRow };
}

describe("Branches list and detail agree on one branch (ISS-6725)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders Last active and PR identity on the list row", async () => {
    const { listRow } = await readListAndDetail();
    const items = adaptBranchRows([listRow]);

    const lastActiveRender = renderListColumn(items, LAST_ACTIVE_COLUMN);
    const lastActive = cellText(lastActiveRender.container, LAST_ACTIVE_COLUMN);
    lastActiveRender.unmount();

    const pullRequestRender = renderListColumn(items, PULL_REQUEST_COLUMN);
    const pullRequest = cellText(
      pullRequestRender.container,
      PULL_REQUEST_COLUMN
    );
    pullRequestRender.unmount();

    // Positive siblings for the agreement cases below: both cells rendered a
    // real value, and a projection that collapsed every field to one answer
    // would not pass.
    //
    // Not `length > 0`. Two different placeholders defeat that: the approved
    // cell renders the literal "Unavailable" when `lastActivityAt` is falsy,
    // while `adaptBranchRow` puts `RENDER_MISSING` in the label — so a
    // non-empty string is satisfied by either. Requiring the cell to equal the
    // adapted label is what makes this bite: on a falsy timestamp the two
    // placeholders differ from each other and this reds. It also matters that
    // the label itself is not the missing marker, since BOTH projections going
    // empty from one shared upstream bug would otherwise let the list-vs-detail
    // equality compare two placeholders and pass.
    expect(lastActive).toBe(items[0]?.lastActivityLabel);
    expect(lastActive).not.toBe(RENDER_MISSING);
    expect(lastActive).not.toBe(pullRequest);
    // Pinned from the STORED fixture, not from `listRow`, so this also catches a
    // projection that selected the wrong pull request.
    expect(pullRequest).toContain(String(FIXTURE_PR_NUMBER));
  });

  it("renders the cost and PR identity on the detail page", async () => {
    const { detail, listRow } = await readListAndDetail();

    const detailRender = renderDetail(detail);
    const detailText = normalize(detailRender.container.textContent ?? "");

    // The detail is the screen that shows cost, so a currency figure has to be
    // on it.
    //
    // BE PRECISE ABOUT WHICH ONE. This matches `BranchCostToMerge`'s "Cost
    // breakdown" total, which is `detail.canonicalMetrics.totalCostUsd` — a sum
    // of the Build/Review/Rework phase rollups, NOT the flat
    // `resolveAttributedBranchCost` field the agreement case compares. The two
    // coincide on this fixture only because its three phase token events sum to
    // the same figure as its token-aggregate row. `resolveAttributedBranchCost`
    // renders only inside `BranchPrActivityTimeline`, under the
    // `sessions-timeline` tab, which Radix does not mount while the default
    // branch-details tab is active — so it is deliberately NOT claimed here.
    // The positive sibling for the compared field lives in the agreement case
    // itself, on the value rather than on the pixels.
    expect(detailText).toMatch(RENDERED_CURRENCY_PATTERN);
    expect(
      prLinkNames(detailRender.container, listRow.prUrl ?? "").length
    ).toBeGreaterThan(0);

    detailRender.unmount();
  });

  // ISS-8422 on THIS surface. The desktop list gets `prState` by spreading the
  // cloud overlay onto its row, which is an adapter step web does not have, and
  // the desktop coverage added with that change stopped at the main process.
  // This is the renderer end of it: the same wire row the desktop actually
  // receives, through `adaptBranchRows`, into the shipped `approved` table.
  it("renders an unobserved pull request as Unconfirmed on the desktop list", async () => {
    const { listRow } = await readListAndDetail();
    const items = adaptBranchRows([
      { ...listRow, prState: null, prTitle: null },
    ]);

    const render = renderListColumn(items, PULL_REQUEST_COLUMN);
    const cell = cellText(render.container, PULL_REQUEST_COLUMN);
    render.unmount();

    // The number survives (ISS-7362's split) and the state is a word, not a hue.
    expect(cell).toContain(`#${FIXTURE_PR_NUMBER}`);
    expect(cell).toContain("Unconfirmed");
    // Never the OPEN the cloud column default would have produced.
    expect(cell).not.toContain("Open");
  });

  it("agrees between the list row and the detail page", async () => {
    const { detail, listRow } = await readListAndDetail();

    // Positive siblings FIRST, on the compared values themselves. Without these
    // a shared upstream bug that emptied both projections would make the two
    // equalities below compare "" to "" and null to null, and pass.
    const listCost = resolveAttributedBranchCost(listRow);
    expect(listRow.lastActivityAt).not.toBe("");
    expect(Number.isFinite(listCost)).toBe(true);

    // Last active and cost: the list renders the first and the detail renders
    // the second, so these are compared where both projections produce them —
    // the branch-scoped read gap the historical drift lived in.
    expect(detail.lastActivityAt).toStrictEqual(listRow.lastActivityAt);
    expect(resolveAttributedBranchCost(detail)).toBe(listCost);

    // PR identity IS rendered on both screens, so it is compared as rendered
    // text rather than as a field.
    const listRender = renderListColumn(
      adaptBranchRows([listRow]),
      PULL_REQUEST_COLUMN
    );
    const detailRender = renderDetail(detail);

    const listCell = cellText(listRender.container, PULL_REQUEST_COLUMN);
    const detailPrNames = prLinkNames(
      detailRender.container,
      listRow.prUrl ?? ""
    );

    // Positive sibling first: the detail has to have rendered a PR affordance at
    // all, or the agreement below would hold over an empty set.
    expect(detailPrNames.length).toBeGreaterThan(0);
    // The list cell and every detail PR affordance name the SAME pull request.
    // The two screens format it differently on purpose (a compact `repo#n` chip
    // in a table cell, a full label on the detail), so the shared token is the
    // number the OTHER side projected — never a literal written here.
    expect(listCell).toContain(String(detail.prNumber));
    for (const name of detailPrNames) {
      expect(name).toContain(String(listRow.prNumber));
    }
    expect(detail.prTitle).toBe(listRow.prTitle);
    expect(detail.prUrl).toBe(listRow.prUrl);

    listRender.unmount();
    detailRender.unmount();
  });
});
