import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TablePagination } from "../components/ui/table-pagination-v2";

/**
 * ISS-11412: the v2 pager's `disabled` input, approved by the Gridview owner so
 * `TablePaginationFooter` can compose v2 without losing the lock it applies
 * while a placeholder page is on screen (ISS-9216). The contract is v1's: every
 * control announces `aria-disabled="true"` and none of them reports a page.
 */

const PREVIOUS = "Go to previous page";
const NEXT = "Go to next page";
const PAGE_NUMBER = /^\d+$/;

/** Page 3 of 5: both boundaries and three numbered links are live. */
function renderMiddlePage(props: { disabled?: boolean } = {}) {
  const onPageChange = vi.fn();
  render(
    <TablePagination
      onPageChange={onPageChange}
      page={2}
      totalPages={5}
      {...props}
    />
  );
  return onPageChange;
}

/**
 * The numbered page anchors. They carry no `href`, so they have no `link` role
 * to query by; the shared `PaginationLink` slot is the stable hook.
 */
function numberedPageLinks(): HTMLElement[] {
  return Array.from(
    screen
      .getByRole("navigation", { name: "pagination" })
      .querySelectorAll<HTMLElement>('[data-slot="pagination-link"]')
  ).filter((link) => PAGE_NUMBER.test(link.textContent ?? ""));
}

describe("TablePagination (v2) disabled", () => {
  it("marks every control aria-disabled and reports no page", () => {
    const onPageChange = renderMiddlePage({ disabled: true });

    const controls = [
      screen.getByLabelText(PREVIOUS),
      screen.getByLabelText(NEXT),
      ...numberedPageLinks(),
    ];
    expect(numberedPageLinks().map((link) => link.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    for (const control of controls) {
      expect(control).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(control);
    }
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("disables the rows-per-page select in the readout layout", () => {
    render(
      <TablePagination
        disabled
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
        page={0}
        pageSize={25}
        readout="Showing 1-25 of 240"
        totalPages={10}
      />
    );

    expect(
      screen.getByRole("combobox", { name: "Rows per page" })
    ).toBeDisabled();
  });

  it("keeps every control live when not disabled", () => {
    const onPageChange = renderMiddlePage();

    expect(screen.getByLabelText(PREVIOUS)).toHaveAttribute(
      "aria-disabled",
      "false"
    );
    for (const link of numberedPageLinks()) {
      expect(link).not.toHaveAttribute("aria-disabled");
    }

    fireEvent.click(screen.getByLabelText(NEXT));
    fireEvent.click(screen.getByText("5"));
    expect(onPageChange.mock.calls).toEqual([[3], [4]]);
  });

  it("renders the same markup for disabled={false} as for no prop", () => {
    const { container: omitted } = render(
      <TablePagination onPageChange={vi.fn()} page={2} totalPages={5} />
    );
    const { container: explicit } = render(
      <TablePagination
        disabled={false}
        onPageChange={vi.fn()}
        page={2}
        totalPages={5}
      />
    );

    expect(explicit.innerHTML).toBe(omitted.innerHTML);
  });
});
