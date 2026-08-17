import { buildTableRangeReadout } from "@repo/design-system/components/ui/table-page-size-select";
import { TablePaginationFooter } from "@repo/design-system/components/ui/table-pagination-footer";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
    // wongk review: an always-present left wrapper is still a flex child, so
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
