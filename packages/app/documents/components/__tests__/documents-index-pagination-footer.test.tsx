import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentsIndexPaginationFooter } from "../documents-index-pagination";

/**
 * ISS-9157 — the one mapping from the container's descriptor to the
 * design-system strip. `documents-index-paged.test.tsx` mocks this component
 * to assert the descriptor; this pins that the descriptor reaches the strip.
 */
describe("DocumentsIndexPaginationFooter", () => {
  it("renders the readout and pager from the descriptor", () => {
    const onPageChange = vi.fn();
    render(
      <DocumentsIndexPaginationFooter
        pagination={{
          page: 1,
          totalPages: 6,
          pageSize: 25,
          pageSizeOptions: [25, 50, 100],
          readout: "26–50 of 137 documents",
          disabled: false,
          onPageChange,
          onPageSizeChange: vi.fn(),
        }}
      />
    );

    expect(screen.getByText("26–50 of 137 documents")).toBeInTheDocument();
    screen.getByLabelText("Go to next page").click();
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("withholds the readout and pins the controls while the page is unsettled", () => {
    render(
      <DocumentsIndexPaginationFooter
        pagination={{
          page: 0,
          totalPages: 6,
          pageSize: 25,
          pageSizeOptions: [25, 50, 100],
          readout: null,
          disabled: true,
          onPageChange: vi.fn(),
          onPageSizeChange: vi.fn(),
        }}
      />
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Go to next page")).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });
});
