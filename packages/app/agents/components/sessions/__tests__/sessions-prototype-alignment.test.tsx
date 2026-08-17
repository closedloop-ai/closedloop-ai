import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { useSessionsViewState } from "../../../hooks/use-sessions-view-state";
import { DEFAULT_SESSION_FACET_FILTERS } from "../../../lib/session-filter-adapter";
import { SessionGroupBy } from "../../../lib/session-grouping";
import { sessionsRangeReadout } from "../../../lib/sessions-range-readout";
import { SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS } from "../../../lib/sessions-table-columns";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsTable, type SessionTableRow } from "../sessions-table";
import { SessionsToolbar } from "../sessions-toolbar";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * ISS-5315 — the Sessions List page aligned to the Sessions prototype.
 *
 * These pin the user-visible outcomes of that alignment, which ships UNFLAGGED
 * (operator decision), so there is no gate behind which a regression could hide:
 * the renamed columns, the columns that must NOT render at rest, the Session
 * value's source and its honest fallback, the removal of the per-row overflow
 * menu, the View menu's Group-by section, and the footer readout.
 *
 * ISS-5315's Refresh control is no longer among them: ISS-5975 retired it once
 * ISS-5976 restored automatic freshness, so what is pinned here now is its
 * ABSENCE.
 */

/** A container wider than the table, so no column folds out of the assertions. */
const NATURAL_LAYOUT_CONTAINER_PX = 4000;

/**
 * ISS-5975: matches ANY spelling of a reintroduced Refresh control, not the
 * exact accessible name the removed one happened to use, so the guard cannot be
 * defeated by relabelling.
 */
const REFRESH_BUTTON_NAME_REGEX = /refresh/i;

const ROW: SessionTableRow = createSessionTableRowFixture({
  autonomy: 88,
  branch: "feat/auth-guard",
  mergeStatusLabel: "Merged",
  model: "opus-4.8",
  name: "Locate DESKTOP_SESSION_JWT_SECRET",
  pullRequestSummaryLabel: "#4380",
  repo: "acme/app",
  status: "Working",
  user: { avatarUrl: null, name: "Parker Byrd" },
});

function renderName(row: SessionTableRow, className: string) {
  return (
    <a className={className} href={`/sessions/${row.id}`}>
      {row.name}
    </a>
  );
}

let restoreContainerWidth: (() => void) | null = null;

beforeEach(() => {
  restoreContainerWidth = stubContainerWidthPx(NATURAL_LAYOUT_CONTAINER_PX);
});

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

function headerLabels(): string[] {
  const headerRow = screen.getByText("Session").closest(".grid");
  if (!(headerRow instanceof HTMLElement)) {
    throw new Error("Could not find the sessions table header row");
  }
  return [...headerRow.children]
    .map((cell) => cell.textContent?.trim() ?? "")
    .filter((label) => label.length > 0);
}

describe("Sessions columns — renames and the default-hidden set (ISS-5315)", () => {
  it('names the leading column "Session", not "Session Name"', () => {
    render(
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );
    expect(headerLabels()[0]).toBe("Session");
    expect(headerLabels()).not.toContain("Session Name");
  });

  it('names the branch column "Linked branches", not "Branch"', () => {
    render(
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );
    expect(headerLabels()).toContain("Linked branches");
    expect(headerLabels()).not.toContain("Branch");
  });

  // The point of the ticket is what a user SEES at rest, so this asserts the
  // headers are ABSENT from the rendered grid under the default view state —
  // not merely that the table renders, and not merely that a config lists them.
  it("renders no PR and no Merge column under the default view state", () => {
    const { result } = renderHook(() => useSessionsViewState(), {
      wrapper: AppCoreStoryProviders,
    });

    render(
      <SessionsTable
        items={[ROW]}
        mode="expanded"
        renderName={renderName}
        visibleColumns={result.current.visibleColumns}
      />
    );

    const labels = headerLabels();
    expect(labels).not.toContain("PR");
    expect(labels).not.toContain("Merge");
    // The columns that DO ship visible are still there, in prototype order.
    expect(labels).toEqual([
      "Session",
      "Status",
      "Owner",
      "Autonomy",
      "Repository",
      "Linked branches",
      "Harness",
      "Model",
      "Duration",
      "Cost",
      "Last active",
    ]);
  });

  it("hides PR, Merge, Started, Updated and the gated linked-entity pair by default", () => {
    const { result } = renderHook(() => useSessionsViewState(), {
      wrapper: AppCoreStoryProviders,
    });
    for (const id of SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS) {
      expect(result.current.visibleColumns.has(id)).toBe(false);
    }
    // ISS-5770: `projects` and `issues` join the set — the prototype ships both
    // default-OFF, and their feature gate alone would not have held that once
    // the gate opened.
    // ISS-6005: `updated` joins them — record-mutation recency, off by default
    // at operator direction until non-activity mutations (comments, tags,
    // status edits) make it earn its track.
    expect([...SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS].sort()).toEqual([
      "issues",
      "merge",
      "pr",
      "projects",
      "started",
      "updated",
    ]);
  });

  // Hiding PR and Merge is only honest because the renamed cell still carries
  // both facts. If that fold is ever dropped, the hidden columns become lost
  // information rather than a tidier grid — so it is asserted, not assumed.
  it("folds the PR summary and merge state into the Linked branches cell", () => {
    render(
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );
    // #4480: the branch name now appears twice inside this cell — once as the
    // chip label and once as the tooltip's first line — so the cell is located
    // by its column id rather than by that text.
    const branchCell = screen
      .getAllByText("feat/auth-guard")[0]
      .closest('[data-column-id="branches"]');
    expect(branchCell).not.toBeNull();
    expect(branchCell?.textContent).toContain("feat/auth-guard");
    // The tooltip mock renders its content inline, so the folded facts are
    // readable from the cell.
    expect(branchCell?.textContent).toContain("#4380");
    expect(branchCell?.textContent).toContain("Merged");
  });

  // #4480: only the branch is monospaced. A PR summary and a merge state are not
  // code, and setting all three in mono joined by a dot read as one code string.
  it("sets only the branch line of the Linked branches tooltip in mono", () => {
    render(
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );
    const tooltip = screen
      .getAllByTestId("tooltip-content")
      .find((node) => node.textContent?.includes("#4380"));
    expect(tooltip).toBeDefined();

    const monoLines = [...(tooltip?.querySelectorAll(".font-mono") ?? [])].map(
      (node) => node.textContent
    );
    expect(monoLines).toEqual(["feat/auth-guard"]);
    // The other two facts are their own lines, not dot-joined into the branch.
    expect(tooltip?.textContent).not.toContain("·");
  });

  it("still lets a user show PR and Merge from the View menu", () => {
    render(
      <SessionsTable
        items={[ROW]}
        mode="expanded"
        renderName={renderName}
        visibleColumns={new Set(["status", "pr", "merge"])}
      />
    );
    expect(headerLabels()).toContain("PR");
    expect(headerLabels()).toContain("Merge");
  });
});

describe("Session column value — the AI title (ISS-5315)", () => {
  // The desktop Claude collector consumes the harness-authored `ai-title` record
  // and uses it as the session `name` (FEA-3578, data revision 31), falling back
  // to the cwd-derived name only when no title was emitted. So the Session
  // column pulling from `row.name` IS pulling from the AI title — this pins that
  // the lead cell renders that field and nothing else.
  it("renders the session's AI-generated title in the lead cell", () => {
    render(
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );
    expect(
      screen.getByRole("link", { name: "Locate DESKTOP_SESSION_JWT_SECRET" })
    ).toBeVisible();
  });

  // A session with no AI title falls back to its producer-derived name. The one
  // outcome that is NOT acceptable is a blank cell that reads as "this session
  // has no name" — so the fallback is asserted as rendered text, not as absence.
  it("falls back to the producer-derived name when no AI title was emitted", () => {
    render(
      <SessionsTable
        items={[{ ...ROW, name: "symphony-alpha" }]}
        mode="expanded"
        renderName={renderName}
      />
    );
    expect(screen.getByRole("link", { name: "symphony-alpha" })).toBeVisible();
  });
});

describe("Row overflow menu — removed (ISS-5315)", () => {
  // ISS-6239 deleted the `renderRowActions` seam this table used to append an
  // actions column for, so there is no host wiring left to supply. This pins the
  // resulting behavior: no trigger, no track.
  it("renders no per-row actions trigger when the host supplies none", () => {
    render(
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );
    expect(
      screen.queryByRole("button", { name: "Session actions" })
    ).toBeNull();
  });
});

describe("Sessions toolbar — Group by (ISS-5315), Refresh retired (ISS-5975)", () => {
  function renderToolbar(
    overrides: Partial<React.ComponentProps<typeof SessionsToolbar>> = {}
  ) {
    return render(
      <AppCoreStoryProviders>
        <SessionsToolbar
          dateRange="7d"
          filters={DEFAULT_SESSION_FACET_FILTERS}
          onDateRangeChange={vi.fn()}
          onFiltersChange={vi.fn()}
          onToggleColumn={vi.fn()}
          visibleColumns={new Set(["status"])}
          {...overrides}
        />
      </AppCoreStoryProviders>
    );
  }

  // ISS-5975 retired the Refresh control from this toolbar on BOTH surfaces.
  // ISS-5315 added it and ISS-5478 placed it, but it only ever existed because
  // the web shell had no automatic freshness (ISS-5976's root cause); with that
  // restored, and desktop already driving its own, a manual re-read has nothing
  // left to do.
  //
  // The assertion is deliberately name-agnostic (`/refresh/i` over the whole
  // toolbar) rather than pinned to the old "Refresh sessions" accessible name:
  // a reintroduction under any spelling — a bare "Refresh", an icon-only button
  // labelled "Reload sessions" — should fail this, not slip past a stale exact
  // string.
  it("renders no Refresh control, with or without host callbacks", () => {
    renderToolbar();

    // The toolbar itself still renders — this is an absence check against a
    // mounted component, not a component that failed to mount.
    expect(screen.getByRole("button", { name: "View" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: REFRESH_BUTTON_NAME_REGEX })
    ).toBeNull();
  });

  it("offers a Group by section in the View menu and reports the chosen dimension", async () => {
    const user = userEvent.setup();
    const onGroupByChange = vi.fn();
    renderToolbar({ groupBy: SessionGroupBy.None, onGroupByChange });

    await user.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByText("Group by")).toBeVisible();
    for (const label of ["None", "Status", "Harness", "Owner"]) {
      expect(screen.getByRole("radio", { name: label })).toBeVisible();
    }

    await user.click(screen.getByRole("radio", { name: "Harness" }));
    expect(onGroupByChange).toHaveBeenCalledWith(SessionGroupBy.Harness);
  });

  it("shows no Group by section when the host cannot band its rows", async () => {
    const user = userEvent.setup();
    renderToolbar();
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(screen.queryByText("Group by")).toBeNull();
  });

  // #4480: while Status is banded the table has no Status column, so a Status
  // show/hide checkbox reading "shown" was describing a column that is not
  // there, and unchecking it changed nothing on screen.
  it("drops the banded column from the show/hide list, and lists it again at None", async () => {
    const user = userEvent.setup();
    const { rerender } = renderToolbar({
      groupBy: SessionGroupBy.Status,
      onGroupByChange: vi.fn(),
    });

    await user.click(screen.getByRole("button", { name: "View" }));
    expect(screen.queryByRole("switch", { name: "Status" })).toBeNull();
    // Not vacuous: a sibling column is still listed.
    expect(screen.getByRole("switch", { name: "Harness" })).toBeVisible();

    rerender(
      <AppCoreStoryProviders>
        <SessionsToolbar
          dateRange="7d"
          filters={DEFAULT_SESSION_FACET_FILTERS}
          groupBy={SessionGroupBy.None}
          onDateRangeChange={vi.fn()}
          onFiltersChange={vi.fn()}
          onGroupByChange={vi.fn()}
          onToggleColumn={vi.fn()}
          visibleColumns={new Set(["status"])}
        />
      </AppCoreStoryProviders>
    );
    expect(screen.getByRole("switch", { name: "Status" })).toBeVisible();
  });
});

/**
 * #4480 — the grouped column is removed by the SHARED table, from its own
 * `groupBy` prop, so both shells behave identically. The deletion previously
 * lived only in `apps/app`'s Sessions page, so the desktop renderer banded the
 * rows and then repeated the banded value in every row beneath the band.
 */
describe("Group by — the banded column is stated once (#4480)", () => {
  it("removes the banded column from the grid and keeps every other one", () => {
    render(
      <SessionsTable
        groupBy={SessionGroupBy.Status}
        items={[ROW]}
        mode="expanded"
        renderName={renderName}
      />
    );

    expect(headerLabels()).not.toContain("Status");
    expect(headerLabels()).toContain("Harness");
  });

  it("keeps the column when nothing is banded, so the removal is not unconditional", () => {
    render(
      <SessionsTable
        groupBy={SessionGroupBy.None}
        items={[ROW]}
        mode="expanded"
        renderName={renderName}
      />
    );

    expect(headerLabels()).toContain("Status");
  });

  // The band header names the value; a bare number beside it would read as the
  // population when this table only ever holds one page of it.
  it("renders a band header carrying the display label and no count", () => {
    render(
      <SessionsTable
        groupBy={SessionGroupBy.Harness}
        items={[ROW, { ...ROW, id: "ses-2" }]}
        mode="expanded"
        renderName={renderName}
      />
    );

    const band = screen.getByRole("button", { expanded: true });
    expect(band).toHaveTextContent("Claude");
    expect(band.textContent?.trim()).toBe("Claude");
  });
});

describe("Sessions pagination readout (ISS-5315)", () => {
  it("states the visible range and the total", () => {
    expect(
      sessionsRangeReadout({
        pageIndex: 0,
        pageSize: 25,
        rowsOnPage: 25,
        total: 240,
      })
    ).toBe("Showing 1-25 of 240 sessions");
  });

  // The upper bound is the rows actually on screen, not the arithmetic
  // `(page + 1) * pageSize` — on the last page those differ, and the arithmetic
  // bound would claim rows the reader cannot see.
  it("bounds the range by the rows actually rendered on the last page", () => {
    expect(
      sessionsRangeReadout({
        pageIndex: 9,
        pageSize: 25,
        rowsOnPage: 7,
        total: 232,
      })
    ).toBe("Showing 226-232 of 232 sessions");
  });

  it("says nothing is shown rather than inventing a range for an empty page", () => {
    expect(
      sessionsRangeReadout({
        pageIndex: 0,
        pageSize: 25,
        rowsOnPage: 0,
        total: 0,
      })
    ).toBe("Showing 0 of 0 sessions");
  });

  it("agrees with itself on a single session", () => {
    expect(
      sessionsRangeReadout({
        pageIndex: 0,
        pageSize: 25,
        rowsOnPage: 1,
        total: 1,
      })
    ).toBe("Showing 1-1 of 1 session");
  });

  // wongk + stage (#4480): both shells hold the list with `keepPreviousData`, so
  // on a page click the index moves while the rows and the total are still the
  // previous page's. This exact input — page 10 of 240 over page 1's 25 rows —
  // is the "Showing 226-240 of 240" that contradicted the rows AND its own row
  // count. It must state nothing rather than a range that is about to be wrong.
  it("states no range while the rows on screen are the previous page's", () => {
    expect(
      sessionsRangeReadout({
        isPlaceholderPage: true,
        pageIndex: 9,
        pageSize: 25,
        rowsOnPage: 25,
        total: 240,
      })
    ).toBeNull();
    // Not vacuous: the same inputs settled DO produce the (wrong-for-that-page)
    // range, which is precisely why the gate has to be the helper's own input
    // rather than each caller's discipline.
    expect(
      sessionsRangeReadout({
        pageIndex: 9,
        pageSize: 25,
        rowsOnPage: 25,
        total: 240,
      })
    ).toBe("Showing 226-240 of 240 sessions");
  });

  // The bookmarked out-of-range page: `items` is empty and the empty state says
  // nothing matched, while an ungated readout said "Showing 0 of 240" for the
  // one paint before the clamp effect rewrites the page.
  it("states no range on the unsettled paint of an out-of-range page", () => {
    expect(
      sessionsRangeReadout({
        isPlaceholderPage: true,
        pageIndex: 99,
        pageSize: 25,
        rowsOnPage: 0,
        total: 240,
      })
    ).toBeNull();
  });
});
