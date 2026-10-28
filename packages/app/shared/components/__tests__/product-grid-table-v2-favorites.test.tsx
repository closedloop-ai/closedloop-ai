// @vitest-environment jsdom

import {
  type ProductGridFavoriteController,
  ProductGridTableV2,
} from "@repo/app/shared/components/product-grid-table-v2";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { GROUPED_ROW_LEAD_INSET_CLASS } from "@repo/design-system/components/ui/grid-table-v2-grouped-rows";
import { GRID_TABLE_V2_FAVORITE_TRACK } from "@repo/design-system/lib/grid-table-v2-constants";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type SessionRow = { id: string; name: string };
type BranchRow = { id: string; artifactId?: string; branchName: string };

const session: SessionRow = { id: "session-artifact", name: "Session A" };
const branch: BranchRow = {
  id: "repo::branch",
  artifactId: "branch-artifact",
  branchName: "Branch A",
};
const FAVORITES_LABEL = /favorites/;

describe("ProductGridTableV2 shared favorite column", () => {
  it("renders grouped Sessions and Branches stars in the same leading track", () => {
    const onSessionChange = vi.fn();
    const onBranchChange = vi.fn();
    const sessionFavorites: ProductGridFavoriteController<SessionRow> = {
      favoriteIds: new Set([session.id]),
      getArtifactId: (row) => row.id,
      getItemLabel: (row) => row.name,
      onChange: onSessionChange,
    };
    const branchFavorites: ProductGridFavoriteController<BranchRow> = {
      favoriteIds: new Set<string>(),
      getArtifactId: (row) => row.artifactId,
      getItemLabel: (row) => row.branchName,
      onChange: onBranchChange,
    };
    const { container } = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
        })}
      >
        <ProductGridTableV2<SessionRow>
          columns={[]}
          favorite={sessionFavorites}
          getRowId={(row) => row.id}
          gridTemplateColumns="minmax(12rem, 1fr)"
          groups={[{ key: "sessions", label: "Sessions", items: [session] }]}
          items={[session]}
          leadingLabel="Session"
          mode="expanded"
          renderCell={() => null}
          renderLead={(row) => row.name}
        />
        <ProductGridTableV2<BranchRow>
          columns={[]}
          favorite={branchFavorites}
          getRowId={(row) => row.id}
          gridTemplateColumns="minmax(12rem, 1fr)"
          groups={[{ key: "branches", label: "Branches", items: [branch] }]}
          items={[branch]}
          leadingLabel="Branch"
          mode="expanded"
          renderCell={() => null}
          renderLead={(row) => row.branchName}
        />
      </FeatureFlagAdapterProvider>
    );

    const rows = container.querySelectorAll("[data-grid-row-id]");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("style")).toBe(rows[1]?.getAttribute("style"));
    for (const row of rows) {
      // The inset targets the lead cell alone, so the row keeps the header's
      // tracks and the band header (no lead cell) stays at the label edge.
      expect(row.closest('[role="rowgroup"]')).toHaveClass(
        GROUPED_ROW_LEAD_INSET_CLASS
      );
      expect(row.querySelectorAll("[data-grid-lead-cell]")).toHaveLength(1);
      expect(row.querySelector("[data-grid-lead-cell]")).toHaveAttribute(
        "aria-colindex",
        "2"
      );
      expect(row.querySelector('[role="gridcell"]')).toHaveAttribute(
        "aria-colindex",
        "1"
      );
      expect(row.getAttribute("style")).toContain(
        `${GRID_TABLE_V2_FAVORITE_TRACK} minmax(12rem, 1fr)`
      );
    }
    for (const bandHeader of container.querySelectorAll(
      "[data-grid-group-header]"
    )) {
      expect(bandHeader.querySelector("[data-grid-lead-cell]")).toBeNull();
    }
    expect(
      screen.getAllByRole("columnheader", { name: "Favorite" })
    ).toHaveLength(2);
    expect(
      within(rows[0] as HTMLElement).getByRole("button", {
        name: "Remove Session A from favorites",
      })
    ).toBeVisible();
    fireEvent.click(
      within(rows[1] as HTMLElement).getByRole("button", {
        name: "Add Branch A to favorites",
      })
    );
    expect(onBranchChange).toHaveBeenCalledWith(branch, true);
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it("reserves the column without a false star for unavailable or missing artifacts", () => {
    const { container } = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
        })}
      >
        <ProductGridTableV2<BranchRow>
          columns={[]}
          favorite={{
            favoriteIds: new Set<string>(),
            getArtifactId: (row) => row.artifactId,
            getItemLabel: (row) => row.branchName,
            isUnavailable: true,
            onChange: vi.fn(),
          }}
          getRowId={(row) => row.id}
          gridTemplateColumns="minmax(12rem, 1fr)"
          items={[branch, { ...branch, id: "legacy", artifactId: undefined }]}
          leadingLabel="Branch"
          mode="expanded"
          renderCell={() => null}
          renderLead={(row) => row.branchName}
        />
      </FeatureFlagAdapterProvider>
    );
    expect(
      screen.getByRole("columnheader", { name: "Favorite" })
    ).toBeVisible();
    expect(
      container.querySelectorAll('[data-grid-row-id] [aria-colindex="1"]')
    ).toHaveLength(2);
    expect(screen.queryByRole("button", { name: FAVORITES_LABEL })).toBeNull();
  });

  it("keeps a host's own favorite track once instead of adding a second", () => {
    const { container } = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
        })}
      >
        <ProductGridTableV2<BranchRow>
          columns={[]}
          favorite={{
            favoriteIds: new Set<string>(),
            getArtifactId: (row) => row.artifactId,
            getItemLabel: (row) => row.branchName,
            onChange: vi.fn(),
          }}
          getRowId={(row) => row.id}
          gridTemplateColumns={`${GRID_TABLE_V2_FAVORITE_TRACK} minmax(12rem, 1fr)`}
          items={[branch]}
          leadingLabel="Branch"
          mode="expanded"
          renderCell={() => null}
          renderLead={(row) => row.branchName}
        />
      </FeatureFlagAdapterProvider>
    );
    expect(
      container.querySelector("[data-grid-row-id]")?.getAttribute("style")
    ).toContain(
      `grid-template-columns: ${GRID_TABLE_V2_FAVORITE_TRACK} minmax(12rem, 1fr)`
    );
  });

  it("refuses a second click on a star whose toggle is in flight", () => {
    const onChange = vi.fn();
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
        })}
      >
        <ProductGridTableV2<SessionRow>
          columns={[]}
          favorite={{
            favoriteIds: new Set<string>(),
            getArtifactId: (row) => row.id,
            getItemLabel: (row) => row.name,
            onChange,
            pendingIds: new Set([session.id]),
          }}
          getRowId={(row) => row.id}
          gridTemplateColumns="minmax(12rem, 1fr)"
          items={[session, { id: "other", name: "Session B" }]}
          leadingLabel="Session"
          mode="expanded"
          renderCell={() => null}
          renderLead={(row) => row.name}
        />
      </FeatureFlagAdapterProvider>
    );
    expect(
      screen.getByRole("button", { name: "Add Session A to favorites" })
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Add Session B to favorites" })
    );
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("gives a card's star a fixed box so it cannot squeeze the card title", () => {
    render(
      <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
        <ProductGridTableV2<BranchRow>
          cardCompatibility={{
            render: (row, _columns, favoriteAction) => (
              <div className="flex">
                {favoriteAction}
                <span>{row.branchName}</span>
              </div>
            ),
          }}
          columns={[]}
          favorite={{
            favoriteIds: new Set<string>(),
            getArtifactId: (row) => row.artifactId,
            getItemLabel: (row) => row.branchName,
            onChange: vi.fn(),
          }}
          getRowId={(row) => row.id}
          gridTemplateColumns="minmax(12rem, 1fr)"
          items={[branch]}
          leadingLabel="Branch"
          mode="compact"
          renderCell={() => null}
          renderLead={(row) => row.branchName}
        />
      </FeatureFlagAdapterProvider>
    );
    const star = screen.getByRole("button", {
      name: "Add Branch A to favorites",
    });
    expect(star.closest(".shrink-0")).toHaveClass("w-9", "shrink-0");
  });
});
