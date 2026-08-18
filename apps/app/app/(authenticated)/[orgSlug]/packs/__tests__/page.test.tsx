import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PacksRoutePage from "../page";

const { authMock, memberPacksViewMock, adminPacksViewMock, headerMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    memberPacksViewMock: vi.fn(),
    adminPacksViewMock: vi.fn(),
    headerMock: vi.fn(),
  }));

// ISS-5037: the route now wraps its body in `FeatureFlagRouteGate` (Labs
// container flag OFF ⇒ notFound() ⇒ the in-shell "Page not found" recovery
// state). The flag-off / still-resolving branches are covered directly in
// `components/__tests__/feature-flag-route-gate.test.tsx`; these route tests
// exercise the flag-ON pass-through, so stub the gate to render its children
// and keep a `data-feature-flag` anchor for the wrapper-placement assertion.
vi.mock("@/components/feature-flag-route-gate", () => ({
  FeatureFlagRouteGate: ({
    children,
    flag,
  }: {
    children: ReactNode;
    flag: string;
  }) => <div data-feature-flag={flag}>{children}</div>,
}));

vi.mock("@repo/auth/server", () => ({
  auth: authMock,
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

vi.mock(
  "@/app/(authenticated)/[orgSlug]/packs/components/member-packs-view",
  () => ({
    MemberPacksView: memberPacksViewMock,
  })
);

vi.mock(
  "@/app/(authenticated)/[orgSlug]/packs/components/admin-packs-view",
  () => ({
    AdminPacksView: adminPacksViewMock,
  })
);

const renderPage = async (orgSlug = "test-org") =>
  render(await PacksRoutePage({ params: Promise.resolve({ orgSlug }) }));

describe("PacksRoutePage", () => {
  beforeEach(() => {
    authMock.mockReset();
    memberPacksViewMock.mockReset();
    adminPacksViewMock.mockReset();
    headerMock.mockReset();
    headerMock.mockImplementation(() => <div data-testid="header" />);
    memberPacksViewMock.mockImplementation(() => (
      <div data-testid="member-packs-view" />
    ));
    adminPacksViewMock.mockImplementation(() => (
      <div data-testid="admin-packs-view" />
    ));
  });

  // ISS-5037: Packs is a Labs destination, so the ROUTE carries the Labs
  // container gate — hiding the nav link while leaving this URL reachable would
  // defeat the gate.
  it("wraps the page in the Labs container route gate", async () => {
    authMock.mockResolvedValue({
      has: ({ role }: { role: string }) => role === "org:admin",
    });

    await renderPage();

    expect(
      screen.getByTestId("admin-packs-view").closest("[data-feature-flag]")
    ).toHaveAttribute("data-feature-flag", LABS_NAV_SECTION_FEATURE_FLAG_KEY);
  });

  it("renders the manage-first admin treatment for an org admin", async () => {
    authMock.mockResolvedValue({
      has: ({ role }: { role: string }) => role === "org:admin",
    });

    await renderPage();

    // The admin slot is the FEA-4088 manage-first AdminView, not the member
    // by-source treatment.
    expect(screen.getByTestId("admin-packs-view")).toBeInTheDocument();
    expect(screen.queryByTestId("member-packs-view")).toBeNull();
  });

  it("renders the manage-first admin treatment for an org owner", async () => {
    authMock.mockResolvedValue({
      has: ({ role }: { role: string }) => role === "org:owner",
    });

    await renderPage();

    expect(screen.getByTestId("admin-packs-view")).toBeInTheDocument();
  });

  it("renders the by-source member treatment for a non-admin member", async () => {
    authMock.mockResolvedValue({
      has: ({ role }: { role: string }) => role === "org:member",
    });

    await renderPage();

    // A member gets the FEA-4089 by-source MemberPacksView, not the admin
    // manage-first treatment.
    expect(screen.getByTestId("member-packs-view")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-packs-view")).toBeNull();
  });

  it("renders one page header (single main landmark owner)", async () => {
    authMock.mockResolvedValue({
      has: ({ role }: { role: string }) => role === "org:member",
    });

    await renderPage();

    expect(screen.getByTestId("header")).toBeInTheDocument();
  });
});
