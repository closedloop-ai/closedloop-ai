import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TablePagination } from "../components/ui/table-pagination-v2";

/**
 * ISS-7052 Part A — the v2 paginator's parity with `TablePaginationFooter`.
 *
 * Mounting the v2 Sessions surface replaces that footer, and the footer carried
 * two things this control did not: the FEA-4199 rows-per-page select and the
 * ISS-5315 range readout. Both shipped behind the same `grid-table-v2` flag the
 * surface is gated on, so without them turning the flag ON would have TAKEN AWAY
 * two controls it currently gives.
 *
 * The readout is the one that matters most: it is a `role="status"` live region,
 * and paging here is button-driven with no route change, so it is the only thing
 * that tells a screen-reader user the page moved.
 */

describe("TablePagination (v2) parity with the v1 footer", () => {
  it("announces the range through a live region, not just as text", () => {
    render(
      <TablePagination
        onPageChange={vi.fn()}
        page={0}
        readout="Showing 1-25 of 240"
        totalPages={10}
      />
    );

    // `getByRole("status")`, not `getByText`: plain text would satisfy a text
    // query while announcing nothing, which is the regression this pins.
    expect(screen.getByRole("status")).toHaveTextContent("Showing 1-25 of 240");
  });

  it("offers rows-per-page when the host can report the change", () => {
    const onPageSizeChange = vi.fn();
    render(
      <TablePagination
        onPageChange={vi.fn()}
        onPageSizeChange={onPageSizeChange}
        page={0}
        pageSize={25}
        totalPages={10}
      />
    );

    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("renders no page-size select when the host cannot report the change", () => {
    // A select whose movement reaches nobody is a lying control — so `pageSize`
    // without `onPageSizeChange` renders nothing rather than a dead dropdown.
    render(
      <TablePagination
        onPageChange={vi.fn()}
        page={0}
        pageSize={25}
        totalPages={10}
      />
    );

    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("keeps the plain layout when neither is supplied", () => {
    render(<TablePagination onPageChange={vi.fn()} page={0} totalPages={10} />);

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    // The controls themselves still render — this is the pre-ISS-7052 shape,
    // which every other v2 consumer still gets.
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });

  it("renders the same page controls in both layouts", () => {
    // The two branches must not drift into offering different navigation.
    const plain = render(
      <TablePagination onPageChange={vi.fn()} page={2} totalPages={5} />
    );
    const plainItems = screen.getAllByRole("listitem").length;
    plain.unmount();

    render(
      <TablePagination
        onPageChange={vi.fn()}
        page={2}
        readout="Showing 51-75 of 125"
        totalPages={5}
      />
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(plainItems);
  });
});
