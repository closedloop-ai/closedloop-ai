import { AGENTS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CatalogAdminPage from "../page";

const { authMock, catalogDashboardMock, headerMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  catalogDashboardMock: vi.fn(),
  headerMock: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({
  auth: authMock,
}));

vi.mock("@repo/analytics/components/feature-flagged", () => ({
  FeatureFlagged: ({
    children,
    flag,
  }: {
    children: ReactNode;
    flag: string;
  }) => <div data-feature-flag={flag}>{children}</div>,
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

vi.mock(
  "@/app/(authenticated)/[orgSlug]/admin/catalog/components/catalog-dashboard",
  () => ({
    CatalogDashboard: catalogDashboardMock,
  })
);

describe("CatalogAdminPage", () => {
  beforeEach(() => {
    authMock.mockReset();
    catalogDashboardMock.mockReset();
    headerMock.mockReset();
    headerMock.mockImplementation(() => <div data-testid="header" />);
    catalogDashboardMock.mockImplementation(
      ({ isAdmin }: { isAdmin: boolean }) => (
        <div data-admin={String(isAdmin)} data-testid="catalog-dashboard" />
      )
    );
  });

  it("renders the catalog dashboard for non-admin members", async () => {
    authMock.mockResolvedValue({
      has: ({ role }: { role: string }) => role === "org:member",
    });

    render(
      await CatalogAdminPage({
        params: Promise.resolve({ orgSlug: "test-org" }),
      })
    );

    expect(screen.getByTestId("catalog-dashboard")).toHaveAttribute(
      "data-admin",
      "false"
    );
    expect(
      screen.getByTestId("catalog-dashboard").closest("[data-feature-flag]")
    ).toHaveAttribute("data-feature-flag", AGENTS_FEATURE_FLAG_KEY);
  });

  it("passes admin capability for org admins", async () => {
    authMock.mockResolvedValue({
      has: ({ role }: { role: string }) => role === "org:admin",
    });

    render(
      await CatalogAdminPage({
        params: Promise.resolve({ orgSlug: "test-org" }),
      })
    );

    expect(screen.getByTestId("catalog-dashboard")).toHaveAttribute(
      "data-admin",
      "true"
    );
  });
});
