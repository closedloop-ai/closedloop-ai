import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchTypeControl } from "../search-type-control";

const RE_TRIGGER = /Filter by type/;
const RE_TRIGGER_TWO = /Filter by type, 2 selected/;
const RE_TRIGGER_ALL = /Filter by type, All types/;

describe("SearchTypeControl (FEA-4134)", () => {
  it("summarizes the active-kind count on the trigger", () => {
    render(
      <SearchTypeControl
        activeKinds={[SearchEntityType.Loop, SearchEntityType.Document]}
        onToggleKind={vi.fn()}
      />
    );
    // The trigger's accessible name carries the count summary.
    expect(
      screen.getByRole("button", { name: RE_TRIGGER_TWO })
    ).toBeInTheDocument();
  });

  it("reads 'All types' when nothing is selected", () => {
    render(<SearchTypeControl activeKinds={[]} onToggleKind={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: RE_TRIGGER_ALL })
    ).toBeInTheDocument();
  });

  it("toggles a kind and marks the active one pressed", async () => {
    const user = userEvent.setup();
    const onToggleKind = vi.fn();
    render(
      <SearchTypeControl
        activeKinds={[SearchEntityType.Loop]}
        onToggleKind={onToggleKind}
      />
    );

    await user.click(screen.getByRole("button", { name: RE_TRIGGER }));

    const loopOption = screen.getByRole("button", { name: "Loop" });
    expect(loopOption).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Document" }));
    expect(onToggleKind).toHaveBeenCalledWith(SearchEntityType.Document);
  });
});
