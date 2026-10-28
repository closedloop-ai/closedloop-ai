import { buildTableRangeReadout } from "@repo/design-system/components/ui/table-page-size-select";
import { TablePaginationFooter } from "@repo/design-system/components/ui/table-pagination-footer";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const PREVIOUS_PAGE_LABEL = "Go to previous page";
const NEXT_PAGE_LABEL = "Go to next page";

/**
 * ISS-4681: the shared paginated-table footer is a design-system component and
 * `packages/design-system` has no test runner of its own, so its behavior is
 * exercised here (the same place the `GridTable` ARIA semantics are pinned).
 *
 * What matters is the contract the four migrated surfaces rely on: the readout
 * is a live region (paging is button-driven with no route change, so it is the
 * only page-change announcement a screen-reader user gets), the readout is
 * omitted entirely when a surface has no honest total, and the controls
 * disappear on a single page without taking the readout with them.
 */
describe("TablePaginationFooter", () => {
  it("announces the range readout as a live region", () => {
    render(
      <TablePaginationFooter
        onPageChange={vi.fn()}
        page={0}
        readout="Showing 1-25 of 240 tasks"
        totalPages={10}
      />
    );

    const readout = screen.getByRole("status");
    expect(readout).toHaveTextContent("Showing 1-25 of 240 tasks");
  });

  it("keeps the readout on a single page while dropping the controls", () => {
    render(
      <TablePaginationFooter
        onPageChange={vi.fn()}
        page={0}
        readout="Showing 1-12 of 12 tasks"
        totalPages={1}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing 1-12 of 12 tasks"
    );
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("renders no live region at all when no readout is supplied", () => {
    render(
      <TablePaginationFooter onPageChange={vi.fn()} page={1} totalPages={8} />
    );

    // An empty `role="status"` would be a live region that announces nothing;
    // the Sessions / Branches / desktop surfaces pass no readout, so there must
    // be no status node rather than a blank one.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });

  it("renders the truncation note under the readout when supplied", () => {
    render(
      <TablePaginationFooter
        onPageChange={vi.fn()}
        page={0}
        readout="Showing 1-25 of 500 tasks"
        totalPages={20}
        truncationNote="Only the 500 most recently updated tasks are listed."
      />
    );

    expect(
      screen.getByText("Only the 500 most recently updated tasks are listed.")
    ).toBeInTheDocument();
  });

  it("keeps the shared border-t strip and merges a caller's padding override", () => {
    const { container } = render(
      <TablePaginationFooter
        className="shrink-0 px-2 py-2"
        onPageChange={vi.fn()}
        page={0}
        totalPages={4}
      />
    );

    // The desktop list views own tighter padding than the web pages; the strip
    // itself (border + horizontal scroll) is the component's, not the caller's.
    const strip = container.firstElementChild;
    expect(strip).toHaveClass("border-t");
    expect(strip).toHaveClass("overflow-x-auto");
    expect(strip).toHaveClass("shrink-0");
    expect(strip).toHaveClass("px-2");
  });

  it("renders NO left group at all for a legacy caller", () => {
    // whitlockk review: an always-present left wrapper is still a flex child, so
    // under `sm:justify-between` it pushed a legacy caller's pager from the left
    // edge to the right — a layout change with the flag off. The strip must have
    // exactly one child (the pager) when there is neither a readout nor a
    // page-size control.
    const { container } = render(
      <TablePaginationFooter onPageChange={vi.fn()} page={1} totalPages={8} />
    );

    const strip = container.firstElementChild as HTMLElement;
    expect(strip.children).toHaveLength(1);
    expect(strip.firstElementChild).toContainElement(
      screen.getByRole("navigation")
    );
  });

  it("matches the readout's type size to the page-size select beside it", () => {
    // stage review: the select's trigger is `text-xs`; a `text-sm` readout beside
    // it read as two unrelated pieces rather than one control and its state.
    const { rerender } = render(
      <TablePaginationFooter
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
        page={0}
        pageSize={25}
        readout="1–25 of 240 sessions"
        totalPages={10}
      />
    );
    expect(screen.getByRole("status")).toHaveClass("text-xs");

    // …and a footer with no select keeps the `text-sm` the four already-adopting
    // surfaces ship, so this is not a silent restyle of My Tasks / Branches.
    rerender(
      <TablePaginationFooter
        onPageChange={vi.fn()}
        page={0}
        readout="Showing 1-25 of 240 tasks"
        totalPages={10}
      />
    );
    expect(screen.getByRole("status")).toHaveClass("text-sm");
  });

  it("renders the rows-per-page control only when BOTH page-size props are wired", () => {
    const { rerender } = render(
      <TablePaginationFooter
        onPageChange={vi.fn()}
        page={0}
        pageSize={25}
        totalPages={10}
      />
    );
    expect(
      screen.queryByRole("combobox", { name: "Rows per page" })
    ).toBeNull();

    rerender(
      <TablePaginationFooter
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
        page={0}
        pageSize={25}
        totalPages={10}
      />
    );
    expect(
      screen.getByRole("combobox", { name: "Rows per page" })
    ).toBeInTheDocument();
  });

  // ISS-11412: the pager inside is now the v2 control, which stays mounted on a
  // single page by design. The footer keeps the v1 visibility rule itself
  // (PLN-1936 GV-052 KEEP), so these pin that rule at its edges.
  it("renders no pager for zero pages, even when asked to keep one", () => {
    render(
      <TablePaginationFooter
        onPageChange={vi.fn()}
        page={0}
        readout="No tasks"
        showPagerOnSinglePage
        totalPages={0}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("No tasks");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("keeps a one-page pager, both boundaries locked, when asked to", () => {
    const onPageChange = vi.fn();
    render(
      <TablePaginationFooter
        onPageChange={onPageChange}
        page={0}
        showPagerOnSinglePage
        totalPages={1}
      />
    );

    expect(screen.getByRole("navigation")).toBeInTheDocument();
    for (const label of [PREVIOUS_PAGE_LABEL, NEXT_PAGE_LABEL]) {
      const control = screen.getByLabelText(label);
      expect(control).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(control);
    }
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("locks every pager control and the page-size select when disabled", () => {
    const onPageChange = vi.fn();
    render(
      <TablePaginationFooter
        disabled
        onPageChange={onPageChange}
        onPageSizeChange={vi.fn()}
        page={1}
        pageSize={25}
        totalPages={3}
      />
    );

    const pageLinks = Array.from(
      screen
        .getByRole("navigation")
        .querySelectorAll<HTMLElement>('[data-slot="pagination-link"]')
    );
    // Previous, pages 1-3, Next: every one of them is announced as disabled
    // and none reports a page.
    expect(pageLinks).toHaveLength(5);
    for (const control of pageLinks) {
      expect(control).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(control);
    }
    expect(onPageChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("combobox", { name: "Rows per page" })
    ).toBeDisabled();
  });
});

describe("buildTableRangeReadout", () => {
  it("localizes every number in the range, not only the total", () => {
    // stage review: "1026–1050 of 12,550" put one readout in two number systems.
    expect(
      buildTableRangeReadout({
        noun: "sessions",
        page: 41,
        pageSize: 25,
        total: 12_550,
      })
    ).toBe("1,026–1,050 of 12,550 sessions");
  });

  it("returns null when there is nothing honest to say", () => {
    expect(
      buildTableRangeReadout({
        noun: "sessions",
        page: 0,
        pageSize: 25,
        total: 0,
      })
    ).toBeNull();
  });

  it("clamps a page index past the end instead of stating a range past the total", () => {
    expect(
      buildTableRangeReadout({
        noun: "sessions",
        page: 99,
        pageSize: 25,
        total: 30,
      })
    ).toBe("30–30 of 30 sessions");
  });
});

describe("buildTableRangeReadout — variable-height pages (ISS-4704)", () => {
  it("states the plan's own range instead of the page * pageSize stride", () => {
    // A grouped board packs whole sections, so page 1 held 38 rows and page 2
    // holds 23. The stride derivation would say "51–75"; those rows are not on
    // this page.
    expect(
      buildTableRangeReadout({
        noun: "issues",
        page: 1,
        pageSize: 50,
        range: { from: 39, to: 61 },
        total: 61,
      })
    ).toBe("39–61 of 61 issues");
  });

  it("still clamps the supplied end to the total", () => {
    expect(
      buildTableRangeReadout({
        noun: "issues",
        page: 0,
        pageSize: 50,
        range: { from: 1, to: 90 },
        total: 61,
      })
    ).toBe("1–61 of 61 issues");
  });

  it("derives the range from the stride when no plan range is supplied", () => {
    // The fixed-stride surfaces are unchanged: same call, same string.
    expect(
      buildTableRangeReadout({
        noun: "issues",
        page: 1,
        pageSize: 50,
        total: 61,
      })
    ).toBe("51–61 of 61 issues");
  });
});
