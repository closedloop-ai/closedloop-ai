/**
 * @file admin-packs-view.test.tsx
 * @description Adapter test for the web-admin Packs treatment (FEA-4088 /
 * FEA-4084). Pins that the `PackAdminBoundary`'s loading + error states are real
 * — wired from the same catalog/distributions read as the primary table — not
 * dead scaffolding: the review flagged that the boundary was mounted with no
 * props, so its skeleton/error branches could never render.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useAdminPackViews: vi.fn(),
  catalogDashboard: vi.fn(),
}));

vi.mock("@repo/app/packs/hooks/use-admin-pack-views", () => ({
  useAdminPackViews: mocks.useAdminPackViews,
}));

// The marketplace workspace is heavyweight; stub it so the test focuses on the
// boundary state wiring.
vi.mock("../../../admin/catalog/components/catalog-dashboard", () => ({
  CatalogDashboard: mocks.catalogDashboard,
}));

import { AdminPacksView } from "../admin-packs-view";

const LOAD_ERROR_COPY = /couldn't load pack permissions/i;

describe("AdminPacksView", () => {
  beforeEach(() => {
    mocks.useAdminPackViews.mockReset();
    mocks.catalogDashboard.mockReset();
    mocks.catalogDashboard.mockImplementation(() => (
      <div data-testid="catalog-dashboard" />
    ));
  });

  it("shows the pack-permissions boundary skeleton while the read is loading", () => {
    mocks.useAdminPackViews.mockReturnValue({
      distributedRows: [],
      isLoading: true,
      error: null,
    });

    render(<AdminPacksView />);

    // The boundary shows its skeleton (real loading state), not the static
    // capability rows.
    expect(
      screen.getByTestId("pack-admin-boundary-skeleton")
    ).toBeInTheDocument();
    expect(screen.queryByText("Author the catalog")).toBeNull();
  });

  it("shows an honest boundary error when the catalog/distributions read fails", () => {
    mocks.useAdminPackViews.mockReturnValue({
      distributedRows: [],
      isLoading: false,
      error: new Error("boom"),
    });

    render(<AdminPacksView />);

    // The boundary renders its failure alert (not a confident static list an
    // admin could misread as loaded).
    expect(
      screen.getByRole("region", { name: "Pack permissions" })
    ).toBeInTheDocument();
    expect(screen.getByText(LOAD_ERROR_COPY)).toBeInTheDocument();
    expect(screen.queryByText("Author the catalog")).toBeNull();
  });

  it("renders the static capability rows when the read succeeds", () => {
    mocks.useAdminPackViews.mockReturnValue({
      distributedRows: [],
      isLoading: false,
      error: null,
    });

    render(<AdminPacksView />);

    expect(screen.getByText("Author the catalog")).toBeInTheDocument();
    expect(screen.getByText("Distribute packs")).toBeInTheDocument();
    expect(screen.getByText("Install to own machines")).toBeInTheDocument();
  });
});
