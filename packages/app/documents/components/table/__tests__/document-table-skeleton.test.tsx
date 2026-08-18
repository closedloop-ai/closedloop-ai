import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocumentTableSkeleton } from "../document-table-skeleton";

describe("DocumentTableSkeleton (FEA-3938)", () => {
  it("renders a loading treatment (busy region + skeleton placeholders), not an empty state", () => {
    const { container } = render(
      <DocumentTableSkeleton
        rowCount={3}
        visibleColumns={[DocumentColumn.Type]}
      />
    );

    // Announces loading to assistive tech instead of flashing an empty state.
    // Defaults to the caller-agnostic label so the shared component does not
    // assert one caller's noun.
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    // Renders animated skeleton placeholders for the requested rows.
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("renders the provided screen-reader label instead of the default", () => {
    render(
      <DocumentTableSkeleton
        label="Loading tasks…"
        rowCount={2}
        visibleColumns={[DocumentColumn.Type]}
      />
    );

    expect(screen.getByText("Loading tasks…")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("scales the number of skeleton rows with rowCount", () => {
    const visibleColumns = [DocumentColumn.Type];
    const count = (root: HTMLElement) =>
      root.querySelectorAll('[data-slot="skeleton"]').length;

    // Each row renders one row-level skeleton plus one per visible column, and
    // the header chrome is the real (inert) header, not skeletonized — so the
    // total skeleton count scales purely with rowCount. Assert the ratio rather
    // than a fixed number so the test survives per-row markup tweaks.
    const { container: threeRows } = render(
      <DocumentTableSkeleton rowCount={3} visibleColumns={visibleColumns} />
    );
    const { container: sixRows } = render(
      <DocumentTableSkeleton rowCount={6} visibleColumns={visibleColumns} />
    );

    // Doubling the rows doubles the rendered skeletons.
    expect(count(sixRows)).toBe(count(threeRows) * 2);
  });
});
