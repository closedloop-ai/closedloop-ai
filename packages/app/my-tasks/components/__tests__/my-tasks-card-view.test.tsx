import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DocumentRowData } from "../../../documents/lib/artifact-row-adapter";
import { makeArtifact } from "../../../shared/test-fixtures/documents";
import {
  MY_TASKS_UNDRAWABLE_PAGE_DESCRIPTION,
  MY_TASKS_UNDRAWABLE_PAGE_TITLE,
  MyTasksCardView,
} from "../my-tasks-card-view";

/** Any range readout at all — used to assert the footer stays silent. */
const ANY_RANGE_READOUT = /^Showing /;
/** The queue-wide total claim the page-scoped readout must NOT make. */
/**
 * The `DocumentsEmptyState` copy that tells the reader to adjust a filter. On an
 * all-undrawable page there IS no filter, so ISS-4682 must not land here.
 */
const ADJUST_FILTER_COPY = /adjusting your filter/i;
/** The ISS-4682 second line, which must not appear on a fully-drawn page. */
const ANY_ON_THIS_PAGE_NOTE = /^Only \d+ of this page/;

// ISS-4683: the board and the queue-clear state are slots, so this suite stubs
// them directly rather than mocking modules — the same seam that lets the
// Storybook canvas render all six states.
const BOARD_TEST_ID = "kanban";
const EMPTY_STATE_TEST_ID = "queue-clear";

function cardsOf(count: number): DocumentRowData[] {
  return Array.from({ length: count }, (_unused, i) =>
    makeArtifact({ id: `doc-${i}`, assigneeId: "user-1" })
  );
}

function renderCardView(
  overrides: Partial<React.ComponentProps<typeof MyTasksCardView>> = {}
) {
  const props: React.ComponentProps<typeof MyTasksCardView> = {
    artifacts: cardsOf(50),
    assigneeId: "user-1",
    board: <div data-testid={BOARD_TEST_ID} />,
    emptyState: <div data-testid={EMPTY_STATE_TEST_ID} />,
    isError: false,
    isLoading: false,
    isNarrowed: false,
    isUserLoading: false,
    offset: 0,
    onClearFilters: vi.fn(),
    onPageChange: vi.fn(),
    onRetry: vi.fn(),
    page: 0,
    pageCount: 50,
    total: 137,
    totalPages: 3,
    ...overrides,
  };
  return render(<MyTasksCardView {...props} />);
}

describe("MyTasksCardView pagination (ISS-4576)", () => {
  // NOTE: the bound that actually stops the crash lives in the page's read
  // params (`limit: MY_TASKS_PAGE_SIZE`), asserted in the page's own
  // `utils.test.ts` — this component does no slicing, so a card-count assertion
  // here would only restate its own prop.

  it("states the server's real total, not the page length", () => {
    renderCardView();

    expect(screen.getByText("Showing 1-50 of 137 tasks")).toBeTruthy();
  });

  it("anchors the range on the offset the server reports applying", () => {
    // Page 2 of 3: a client that recomputed `page * pageSize` would agree here,
    // but the server's offset is what actually produced these rows.
    renderCardView({
      artifacts: cardsOf(50),
      offset: 50,
      page: 1,
      pageCount: 50,
    });

    expect(screen.getByText("Showing 51-100 of 137 tasks")).toBeTruthy();
  });

  it("reports a short final page as its real span", () => {
    renderCardView({
      artifacts: cardsOf(37),
      offset: 100,
      page: 2,
      pageCount: 37,
    });

    expect(screen.getByText("Showing 101-137 of 137 tasks")).toBeTruthy();
  });

  it("exposes page controls when more than one page exists", () => {
    renderCardView();

    expect(screen.getByText("2")).toBeTruthy();
  });

  it("announces the range to assistive tech so a page turn is not silent", () => {
    renderCardView();

    expect(screen.getByRole("status").textContent).toContain(
      "Showing 1-50 of 137 tasks"
    );
  });
});

describe("MyTasksCardView footer anchor (ISS-4682 item 3)", () => {
  it("keeps the range line and moves the caveat to a second line", () => {
    // One non-navigable row used to cost the reader BOTH the queue total and
    // their place in it, while the 1 2 3 buttons stayed beside a sentence that
    // no longer described a page position.
    renderCardView({ artifacts: cardsOf(49), pageCount: 50 });

    expect(screen.getByText("Showing 1-50 of 137 tasks")).toBeTruthy();
    expect(
      screen.getByText("Only 49 of this page's 50 tasks are shown.")
    ).toBeTruthy();
    // ISS-5280: the superseded ISS-4576 wording must not come back.
    expect(
      screen.queryByText("Showing 49 of 50 tasks on this page")
    ).toBeNull();
  });

  it("adds no caveat line to a page the board drew in full", () => {
    renderCardView({});

    expect(screen.getByText("Showing 1-50 of 137 tasks")).toBeTruthy();
    expect(screen.queryByText(ANY_ON_THIS_PAGE_NOTE)).toBeNull();
  });
});

describe("MyTasksCardView empty-vs-no-match (ISS-4576)", () => {
  it("shows the truly-empty state when the server counts zero assigned artifacts", () => {
    renderCardView({ artifacts: [], pageCount: 0, total: 0, totalPages: 1 });

    expect(screen.getByTestId(EMPTY_STATE_TEST_ID)).toBeTruthy();
    expect(screen.queryByTestId(BOARD_TEST_ID)).toBeNull();
  });

  it("shows the no-match state with a way out when a filter emptied a non-empty queue", () => {
    renderCardView({
      artifacts: [],
      isNarrowed: true,
      pageCount: 50,
    });

    expect(screen.getByText("No items match your filters")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
    // The queue is NOT clear — 137 tasks exist; saying so would be a lie.
    expect(screen.queryByTestId(EMPTY_STATE_TEST_ID)).toBeNull();
  });

  it("withholds the footer entirely when the queue is empty", () => {
    renderCardView({ artifacts: [], pageCount: 0, total: 0, totalPages: 1 });

    expect(screen.queryByText(ANY_RANGE_READOUT)).toBeNull();
  });
});

describe("MyTasksCardView all-undrawable page (ISS-4682 item 4)", () => {
  it("names what is actually true instead of blaming an unset filter", () => {
    // Every row the server sent is non-navigable, so `artifacts` is empty while
    // `isNarrowed` is false and the queue is not empty.
    renderCardView({ artifacts: [], pageCount: 50 });

    expect(screen.getByText(MY_TASKS_UNDRAWABLE_PAGE_TITLE)).toBeTruthy();
    expect(screen.getByText(MY_TASKS_UNDRAWABLE_PAGE_DESCRIPTION)).toBeTruthy();
    expect(screen.queryByText(ADJUST_FILTER_COPY)).toBeNull();
    // No "Clear filters" — there is no filter to clear, so offering one would
    // send the reader after a control that changes nothing.
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("still routes a genuinely filtered empty page to the no-match state", () => {
    renderCardView({ artifacts: [], isNarrowed: true, pageCount: 50 });

    expect(screen.getByText("No items match your filters")).toBeTruthy();
    expect(screen.queryByText(MY_TASKS_UNDRAWABLE_PAGE_TITLE)).toBeNull();
  });
});

describe("MyTasksCardView degraded reads (ISS-4576)", () => {
  it("surfaces a retryable error instead of an empty board when the read fails", () => {
    renderCardView({ artifacts: [], isError: true, pageCount: 0, total: 0 });

    expect(screen.getByText("Couldn't load your tasks")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByTestId(EMPTY_STATE_TEST_ID)).toBeNull();
  });

  it("does not state a range while the page is still loading", () => {
    renderCardView({ artifacts: [], isLoading: true, pageCount: 0 });

    expect(screen.queryByText(ANY_RANGE_READOUT)).toBeNull();
  });

  it("hands the loading and signed-out states to the board", () => {
    // The board owns both, per its own contract — the view must not invent a
    // second spinner or a second signed-out message beside it.
    for (const overrides of [
      { isLoading: true },
      { assigneeId: null },
      { isUserLoading: true },
    ]) {
      const { unmount } = renderCardView(overrides);
      expect(screen.getByTestId(BOARD_TEST_ID)).toBeTruthy();
      expect(screen.queryByTestId(EMPTY_STATE_TEST_ID)).toBeNull();
      unmount();
    }
  });
});
