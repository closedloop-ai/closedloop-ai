import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TablePaginationFooter } from "../components/ui/table-pagination-footer";

/**
 * ISS-9692 — the footer renders the rows-per-page control ONLY when a caller
 * wires both halves of it.
 *
 * That contract is what a surface uses to withhold the control while a gate is
 * closed: desktop Sessions has never shown one, so its closed-by-default gate is
 * expressed by supplying no `onPageSizeChange`. Asserted here, on the component
 * that owns the rule, because the desktop host's own harness never renders a
 * footer — an absence assertion there would pass for the wrong reason.
 */
const ROWS_PER_PAGE_LABEL = "Rows per page";

function renderFooter(
  props: Partial<React.ComponentProps<typeof TablePaginationFooter>>
) {
  return render(
    <TablePaginationFooter
      onPageChange={() => undefined}
      page={0}
      readout="1–25 of 240 sessions"
      totalPages={10}
      {...props}
    />
  );
}

describe("TablePaginationFooter rows-per-page control", () => {
  it("renders the control when both halves are wired", () => {
    renderFooter({ onPageSizeChange: () => undefined, pageSize: 25 });

    expect(screen.getByLabelText(ROWS_PER_PAGE_LABEL)).toBeDefined();
  });

  it("renders no control when the handler is withheld", () => {
    renderFooter({ pageSize: 25 });

    expect(screen.queryByLabelText(ROWS_PER_PAGE_LABEL)).toBeNull();
    // The readout beside it still renders, so the absence above is the control
    // being withheld and not the footer failing to mount at all.
    expect(screen.getByRole("status")).toBeDefined();
  });

  it("renders no control when the size is withheld", () => {
    renderFooter({ onPageSizeChange: () => undefined });

    expect(screen.queryByLabelText(ROWS_PER_PAGE_LABEL)).toBeNull();
    expect(screen.getByRole("status")).toBeDefined();
  });
});
