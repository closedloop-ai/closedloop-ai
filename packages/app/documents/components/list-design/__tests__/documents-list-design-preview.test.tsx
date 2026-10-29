import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DOCUMENTS_LIST_DESIGN_ROWS } from "../documents-list-design-fixtures";
import { DocumentsListDesignPreview } from "../documents-list-design-preview";

// The favorite star's column is named, though its header shows no word.
const HEADERS = [
  "Favorite",
  "Document",
  "Owner",
  "Status",
  "Collaborators",
  "Comments",
  "Updated",
  "Current version",
  "Tags",
];

/** The person and tag cells read the navigation and flag ports. */
function renderPreview() {
  return render(
    <NavigationProvider
      adapter={createMemoryNavigation({ initialPath: "/documents" }).adapter}
    >
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <DocumentsListDesignPreview />
      </FeatureFlagAdapterProvider>
    </NavigationProvider>
  );
}

function headerNames(): string[] {
  return screen
    .getAllByRole("columnheader")
    .map((header) => header.textContent?.trim() ?? "")
    .filter(Boolean);
}

describe("DocumentsListDesignPreview (ISS-12586)", () => {
  it("shows PRD-798's columns after the favorite star, and no Type column", () => {
    renderPreview();
    expect(headerNames()).toEqual(HEADERS);
    expect(
      screen.queryByRole("columnheader", { name: "Type" })
    ).not.toBeInTheDocument();
  });

  it("shows one summary card: the document count", () => {
    renderPreview();
    const band = screen.getByTestId("grid-table-metric-band");
    const cards = within(band).getAllByText("Documents");
    expect(cards).toHaveLength(1);
    expect(
      within(band).getByText(String(DOCUMENTS_LIST_DESIGN_ROWS.length))
    ).toBeInTheDocument();
  });

  it("renders a row per fixture document", () => {
    renderPreview();
    for (const row of DOCUMENTS_LIST_DESIGN_ROWS) {
      expect(screen.getByText(row.document.title)).toBeInTheDocument();
    }
  });
});
