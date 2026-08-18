import { DocumentTableToolbar } from "@repo/app/documents/components/table/document-table-toolbar";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "./render-with-nav";

// The filter-category control the My Tasks page passes as `leadingContent`.
// The five segments plus the search input, filter popover, and view menu are
// what overflowed the toolbar at a phone width before the responsive fix.
function LeadingToggleGroup() {
  return (
    <ToggleGroup size="sm" type="single" value="all" variant="outline">
      <ToggleGroupItem value="all">All</ToggleGroupItem>
      <ToggleGroupItem value="documents">PRDs</ToggleGroupItem>
      <ToggleGroupItem value="features">Features</ToggleGroupItem>
      <ToggleGroupItem value="plans">Plans</ToggleGroupItem>
      <ToggleGroupItem value="branches">Branches</ToggleGroupItem>
    </ToggleGroup>
  );
}

afterEach(cleanup);

describe("DocumentTableToolbar — mobile layout (FEA-3927)", () => {
  it("renders the My Tasks leading filter-category control + search without throwing", () => {
    expect(() =>
      render(
        <DocumentTableToolbar
          filterText=""
          leadingContent={<LeadingToggleGroup />}
          onFilterTextChange={vi.fn()}
          tableViewMenuProps={{ view: "list", onChangeView: vi.fn() }}
        />
      )
    ).not.toThrow();

    // All five filter-category segments stay reachable (contained-scroll, not
    // dropped) so the control is usable at mobile width.
    for (const label of ["All", "PRDs", "Features", "Plans", "Branches"]) {
      expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
    }
    // Search keeps its accessible name.
    expect(screen.getByLabelText("Filter items")).toBeInTheDocument();
  });

  it("keeps the toolbar row wrappable so it never forces horizontal page overflow", () => {
    const { container } = render(
      <DocumentTableToolbar
        filterText=""
        leadingContent={<LeadingToggleGroup />}
        onFilterTextChange={vi.fn()}
        tableViewMenuProps={{ view: "list", onChangeView: vi.fn() }}
      />
    );
    // The header row wraps instead of pinning to its intrinsic (`min-w-fit`)
    // width — the regression this fix addresses. jsdom does not lay out, so
    // these class-contract checks only guard against the wrap being removed;
    // the actual "buttons stay on-screen at 360px" bounds + visibility proof
    // lives in the My Tasks case in `e2e/mobile-shell.spec.ts` (FEA-3927),
    // where a real browser runs flex line layout.
    const row = container.querySelector(".flex.flex-wrap");
    expect(row).not.toBeNull();
    expect(row?.className).not.toContain("min-w-fit");
    // The search-plus-menus group takes a full-width mobile line (`w-full`)
    // with a wide-breakpoint reset (`sm:w-auto`), so the non-shrinking Filter
    // and View buttons can never share the leading track's flex line and
    // overflow the `overflow-hidden` page ancestor.
    const menusRow = row?.querySelector(".w-full.sm\\:w-auto");
    expect(menusRow).not.toBeNull();
  });

  it("wraps the filter-category track in a scroll container with decorative edge fades", () => {
    const { container } = render(
      <DocumentTableToolbar
        filterText=""
        leadingContent={<LeadingToggleGroup />}
        onFilterTextChange={vi.fn()}
        tableViewMenuProps={{ view: "list", onChangeView: vi.fn() }}
      />
    );
    // The leading control still scrolls horizontally within the toolbar so it
    // never widens the page.
    expect(container.querySelector(".overflow-x-auto")).not.toBeNull();
    // The edge-fade cues that signal off-screen segments are decorative only, so
    // they must be aria-hidden and never steal the segments' accessible names.
    const fades = container.querySelectorAll('[aria-hidden="true"]');
    expect(fades.length).toBeGreaterThanOrEqual(2);
  });
});
