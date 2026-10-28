import { SessionsControls } from "@repo/app/agents/components/sessions/sessions-controls";
import type { SessionControls } from "@repo/app/agents/lib/session-types";
import type { PaginationState } from "@repo/design-system/components/ui/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const REFRESH_BUTTON_NAME = "Refresh";
const SESSIONS_COUNT_SUFFIX = "sessions";
const LIVE_LABEL = "Live";
const OFFLINE_LABEL = "Offline";

function buildControls(
  overrides: Partial<SessionControls> = {}
): SessionControls {
  return {
    directoryOptions: [],
    harnessOptions: [],
    sortOptions: [{ value: "time", label: "Newest" }],
    statusOptions: [],
    ...overrides,
  };
}

function buildPagination(overrides: Partial<PaginationState> = {}) {
  return {
    page: 0,
    pageSize: 25,
    total: 0,
    totalPages: 1,
    ...overrides,
  };
}

describe("SessionsControls header", () => {
  it("hides the whole header block when there is no title or count label", () => {
    render(
      <SessionsControls
        controls={buildControls()}
        pagination={buildPagination()}
      />
    );

    expect(
      screen.queryByRole("button", { name: REFRESH_BUTTON_NAME })
    ).toBeNull();
    expect(
      screen.queryByText((text) => text.endsWith(SESSIONS_COUNT_SUFFIX))
    ).toBeNull();
  });

  it("shows the title and the default live indicator", () => {
    render(
      <SessionsControls
        controls={buildControls({ title: "My Sessions", isLive: true })}
        pagination={buildPagination()}
      />
    );

    expect(screen.getByText("My Sessions")).toBeInTheDocument();
    expect(screen.getByText(LIVE_LABEL)).toBeInTheDocument();
  });

  it("shows the default offline label when not live", () => {
    render(
      <SessionsControls
        controls={buildControls({ title: "My Sessions", isLive: false })}
        pagination={buildPagination()}
      />
    );

    expect(screen.getByText(OFFLINE_LABEL)).toBeInTheDocument();
  });

  it("prefers caller-supplied live/offline labels over the defaults", () => {
    render(
      <SessionsControls
        controls={buildControls({
          title: "My Sessions",
          isLive: true,
          liveLabel: "Streaming",
        })}
        pagination={buildPagination()}
      />
    );

    expect(screen.getByText("Streaming")).toBeInTheDocument();
    expect(screen.queryByText(LIVE_LABEL)).toBeNull();
  });

  it("renders a header from countLabel alone, with no title or live indicator", () => {
    render(
      <SessionsControls
        controls={buildControls({ countLabel: "3 active" })}
        pagination={buildPagination()}
      />
    );

    expect(screen.getByText("3 active")).toBeInTheDocument();
    expect(screen.queryByText(LIVE_LABEL)).toBeNull();
    expect(screen.queryByText(OFFLINE_LABEL)).toBeNull();
  });

  it("defaults the count label to the comma-formatted session total", () => {
    render(
      <SessionsControls
        controls={buildControls({ title: "Sessions" })}
        pagination={buildPagination({ total: 1234 })}
      />
    );

    expect(
      screen.getByText(`1,234 ${SESSIONS_COUNT_SUFFIX}`)
    ).toBeInTheDocument();
  });

  it("disables the Refresh action when no handler is supplied", () => {
    render(
      <SessionsControls
        controls={buildControls({ title: "Sessions" })}
        pagination={buildPagination()}
      />
    );

    expect(
      screen.getByRole("button", { name: REFRESH_BUTTON_NAME })
    ).toBeDisabled();
  });

  it("calls onRefresh when the Refresh action is pressed", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(
      <SessionsControls
        controls={buildControls({ title: "Sessions" })}
        onRefresh={onRefresh}
        pagination={buildPagination()}
      />
    );

    await user.click(screen.getByRole("button", { name: REFRESH_BUTTON_NAME }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("SessionsControls search", () => {
  it("disables and read-only-locks the search field when no handler is supplied", () => {
    render(
      <SessionsControls
        controls={buildControls({ searchValue: "foo" })}
        pagination={buildPagination()}
      />
    );

    const input = screen.getByRole("textbox", { name: "Search sessions" });
    expect(input).toBeDisabled();
    expect(input).toHaveValue("foo");
  });

  it("forwards typed text to onSearchValueChange", async () => {
    const user = userEvent.setup();
    const onSearchValueChange = vi.fn();
    render(
      <SessionsControls
        controls={buildControls()}
        onSearchValueChange={onSearchValueChange}
        pagination={buildPagination()}
      />
    );

    const input = screen.getByRole("textbox", { name: "Search sessions" });
    expect(input).not.toBeDisabled();
    await user.type(input, "x");
    expect(onSearchValueChange).toHaveBeenCalledWith("x");
  });
});

describe("SessionsControls directory filter", () => {
  it("disables the directory select when no handler is supplied", () => {
    render(
      <SessionsControls
        controls={buildControls({
          directoryOptions: [{ value: "", label: "All directories" }],
        })}
        pagination={buildPagination()}
      />
    );

    // The trigger has no accessible name (the ARIA combobox naming rule does
    // not read subtree content), so locate it via its visible selected label.
    expect(
      screen.getByText("All directories").closest("button")
    ).toBeDisabled();
  });

  it("shows the selected directory option's label", () => {
    render(
      <SessionsControls
        controls={buildControls({
          directoryOptions: [
            { value: "", label: "All directories" },
            { value: "apps/app", label: "apps/app" },
          ],
          directoryValue: "apps/app",
        })}
        onDirectoryValueChange={vi.fn()}
        pagination={buildPagination()}
      />
    );

    expect(screen.getByText("apps/app")).toBeInTheDocument();
  });
});

describe("SessionsControls sort controls", () => {
  it("shows the selected sort option's label", () => {
    render(
      <SessionsControls
        controls={buildControls({
          sortOptions: [
            { value: "time", label: "Newest" },
            { value: "cost", label: "Cost" },
          ],
          sortValue: "cost",
        })}
        onSortValueChange={vi.fn()}
        pagination={buildPagination()}
      />
    );

    expect(screen.getByText("Cost")).toBeInTheDocument();
  });

  it("labels the direction toggle 'Sort descending' by default and disables it with no handler", () => {
    render(
      <SessionsControls
        controls={buildControls()}
        pagination={buildPagination()}
      />
    );

    const toggle = screen.getByRole("button", { name: "Sort descending" });
    expect(toggle).toBeDisabled();
  });

  it("labels the direction toggle 'Sort ascending' once sortDescending is true", () => {
    render(
      <SessionsControls
        controls={buildControls({ sortDescending: true })}
        onSortDirectionChange={vi.fn()}
        pagination={buildPagination()}
      />
    );

    expect(
      screen.getByRole("button", { name: "Sort ascending" })
    ).toBeInTheDocument();
  });

  it("flips the direction on click", async () => {
    const user = userEvent.setup();
    const onSortDirectionChange = vi.fn();
    render(
      <SessionsControls
        controls={buildControls({ sortDescending: false })}
        onSortDirectionChange={onSortDirectionChange}
        pagination={buildPagination()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Sort descending" }));
    expect(onSortDirectionChange).toHaveBeenCalledWith(true);
  });
});

describe("SessionsControls filter pill groups", () => {
  it("marks the active harness option and leaves the rest unselected", () => {
    render(
      <SessionsControls
        controls={buildControls({
          harnessOptions: [
            { value: "", label: "All" },
            { value: "claude", label: "Claude" },
          ],
          harnessValue: "claude",
        })}
        onHarnessValueChange={vi.fn()}
        pagination={buildPagination()}
      />
    );

    expect(screen.getByRole("button", { name: "Claude" }).className).toContain(
      "bg-secondary"
    );
    expect(screen.getByRole("button", { name: "All" }).className).not.toContain(
      "bg-secondary"
    );
  });

  it("disables every harness pill when no handler is supplied", () => {
    render(
      <SessionsControls
        controls={buildControls({
          harnessOptions: [{ value: "claude", label: "Claude" }],
        })}
        pagination={buildPagination()}
      />
    );

    expect(screen.getByRole("button", { name: "Claude" })).toBeDisabled();
  });

  it("calls onStatusValueChange with the pressed option's value", async () => {
    const user = userEvent.setup();
    const onStatusValueChange = vi.fn();
    render(
      <SessionsControls
        controls={buildControls({
          statusOptions: [
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ],
        })}
        onStatusValueChange={onStatusValueChange}
        pagination={buildPagination()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Inactive" }));
    expect(onStatusValueChange).toHaveBeenCalledWith("inactive");
  });
});

describe("SessionsControls pagination summary", () => {
  it("reports zero-zero-of-zero when there is nothing to show", () => {
    render(
      <SessionsControls
        controls={buildControls()}
        pagination={buildPagination({ total: 0 })}
      />
    );

    expect(screen.getByText("Showing 0-0 of 0")).toBeInTheDocument();
  });

  it("computes the visible range for a middle page", () => {
    render(
      <SessionsControls
        controls={buildControls()}
        pagination={buildPagination({ page: 2, pageSize: 25, total: 120 })}
      />
    );

    expect(screen.getByText("Showing 51-75 of 120")).toBeInTheDocument();
  });
});

describe("SessionsControls pagination controls", () => {
  it("renders at most five page links even with more pages available", () => {
    render(
      <SessionsControls
        controls={buildControls()}
        onPageChange={vi.fn()}
        pagination={buildPagination({ totalPages: 8 })}
      />
    );

    for (const page of ["1", "2", "3", "4", "5"]) {
      expect(screen.getByRole("link", { name: page })).toBeInTheDocument();
    }
    expect(screen.queryByRole("link", { name: "6" })).toBeNull();
  });

  it("marks the current page link as the active page", () => {
    render(
      <SessionsControls
        controls={buildControls()}
        onPageChange={vi.fn()}
        pagination={buildPagination({ page: 1, totalPages: 3 })}
      />
    );

    expect(screen.getByRole("link", { name: "2" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(
      screen.getByRole("link", { name: "1" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("disables Previous on the first page and does not call the handler", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <SessionsControls
        controls={buildControls()}
        onPageChange={onPageChange}
        pagination={buildPagination({ page: 0, totalPages: 3 })}
      />
    );

    const previous = screen.getByRole("link", { name: "Go to previous page" });
    expect(previous).toHaveAttribute("aria-disabled", "true");
    await user.click(previous);
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("moves back a page when Previous is pressed from a later page", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <SessionsControls
        controls={buildControls()}
        onPageChange={onPageChange}
        pagination={buildPagination({ page: 1, totalPages: 3 })}
      />
    );

    await user.click(screen.getByRole("link", { name: "Go to previous page" }));
    expect(onPageChange).toHaveBeenCalledWith(0);
  });

  it("disables Next on the last page and does not call the handler", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <SessionsControls
        controls={buildControls()}
        onPageChange={onPageChange}
        pagination={buildPagination({ page: 2, totalPages: 3 })}
      />
    );

    const next = screen.getByRole("link", { name: "Go to next page" });
    expect(next).toHaveAttribute("aria-disabled", "true");
    await user.click(next);
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("moves forward a page when Next is pressed", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <SessionsControls
        controls={buildControls()}
        onPageChange={onPageChange}
        pagination={buildPagination({ page: 0, totalPages: 3 })}
      />
    );

    await user.click(screen.getByRole("link", { name: "Go to next page" }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("jumps directly to the clicked page number", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <SessionsControls
        controls={buildControls()}
        onPageChange={onPageChange}
        pagination={buildPagination({ page: 0, totalPages: 3 })}
      />
    );

    await user.click(screen.getByRole("link", { name: "3" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("marks every page link non-navigable when no onPageChange is supplied", () => {
    render(
      <SessionsControls
        controls={buildControls()}
        pagination={buildPagination({ page: 0, totalPages: 3 })}
      />
    );

    const first = screen.getByRole("link", { name: "1" });
    expect(first).toHaveAttribute("aria-disabled", "true");
    expect(first).toHaveAttribute("tabindex", "-1");
  });
});
