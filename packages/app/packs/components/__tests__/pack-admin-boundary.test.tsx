/**
 * @file pack-admin-boundary.test.tsx
 * @description Behavioral tests for the FEA-4084 pack-permission boundary row:
 * it renders each capability with its honest holder audience, renders read-only
 * (no manage action) by default, exposes the manage action only when the viewer
 * may manage roles, and renders loading / error states honestly.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PackAdminBoundary } from "../pack-admin-boundary";

const LOAD_ERROR_COPY = /couldn't load pack permissions/i;

describe("PackAdminBoundary", () => {
  it("renders the three pack capabilities with their holder audiences", () => {
    render(<PackAdminBoundary />);

    expect(
      screen.getByRole("region", { name: "Pack permissions" })
    ).toBeInTheDocument();
    expect(screen.getByText("Author the catalog")).toBeInTheDocument();
    expect(screen.getByText("Distribute packs")).toBeInTheDocument();
    expect(screen.getByText("Install to own machines")).toBeInTheDocument();
    // The two admin-gated capabilities read "Admins & owners"; installing to
    // own machines reads "Everyone" — the boundary stated in words.
    expect(
      screen.getAllByText("Admins & owners").length
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Everyone")).toBeInTheDocument();
  });

  it("is read-only by default — no manage action rendered", () => {
    render(
      <PackAdminBoundary
        manageAction={<button type="button">Manage roles</button>}
      />
    );

    // canManageRoles defaults false: the surface does not pretend an editable
    // control it doesn't own.
    expect(screen.queryByText("Manage roles")).toBeNull();
  });

  it("renders the manage action when the viewer may manage roles (editable-if-permitted)", () => {
    render(
      <PackAdminBoundary
        canManageRoles
        manageAction={<button type="button">Manage roles</button>}
      />
    );

    expect(
      screen.getByRole("button", { name: "Manage roles" })
    ).toBeInTheDocument();
  });

  it("renders the loading skeleton, not the capability rows", () => {
    render(<PackAdminBoundary isLoading />);

    expect(
      screen.getByTestId("pack-admin-boundary-skeleton")
    ).toBeInTheDocument();
    expect(screen.queryByText("Author the catalog")).toBeNull();
  });

  it("surfaces a failed read as an honest error, never a silent empty boundary", () => {
    render(<PackAdminBoundary error={new Error("boom")} />);

    expect(screen.getByRole("alert")).toHaveTextContent(LOAD_ERROR_COPY);
    expect(screen.queryByText("Author the catalog")).toBeNull();
  });
});
