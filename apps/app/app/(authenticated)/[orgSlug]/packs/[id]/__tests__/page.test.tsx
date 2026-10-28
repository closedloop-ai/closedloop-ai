/**
 * @file page.test.tsx
 * @description ISS-6925 — the addressable pack-detail route. Pins that it is
 * gated on its own closed-by-default key, that it renders the SAME capability
 * -driven body as the grid route, and that its breadcrumb leads back to Packs.
 */
import { PACKS_DETAIL_ROUTE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PackDetailRoutePage from "../page";

const { authMock, bodyMock, breadcrumbMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  bodyMock: vi.fn(),
  breadcrumbMock: vi.fn(),
}));

// The gate's own flag-off / still-resolving branches are covered in
// `components/__tests__/feature-flag-route-gate.test.tsx`; here the stub renders
// children and leaves a `data-feature-flag` anchor for the gating assertion.
vi.mock("@/components/feature-flag-route-gate", () => ({
  FeatureFlagRouteGate: ({
    children,
    flag,
  }: {
    children: ReactNode;
    flag: string;
  }) => <div data-feature-flag={flag}>{children}</div>,
}));

vi.mock("@repo/auth/server", () => ({ auth: authMock }));

vi.mock("@/app/(authenticated)/[orgSlug]/packs/packs-route-body", () => ({
  PacksRouteBody: (props: { context: { mode: string } }) =>
    bodyMock(props) ?? <div data-testid="packs-body" />,
}));

vi.mock(
  "@/app/(authenticated)/[orgSlug]/packs/[id]/pack-detail-breadcrumb",
  () => ({
    PACK_CRUMB_FALLBACK: "Pack",
    PackDetailBreadcrumb: (props: { orgSlug: string; packId: string }) =>
      breadcrumbMock(props) ?? <div data-testid="crumb" />,
  })
);

const renderPage = async (orgSlug = "test-org", id = "pack-abc") =>
  render(
    await PackDetailRoutePage({ params: Promise.resolve({ orgSlug, id }) })
  );

describe("PackDetailRoutePage", () => {
  beforeEach(() => {
    authMock.mockReset();
    bodyMock.mockReset();
    breadcrumbMock.mockReset();
    authMock.mockResolvedValue({
      has: ({ role }: { role: string }) => role === "org:member",
    });
  });

  // ISS-4779 closed-by-default: the route must be unreachable until the key is
  // on, so a direct visit cannot open a surface nobody has rolled out.
  it("gates the route on the addressable-detail flag", async () => {
    await renderPage();

    expect(
      screen.getByTestId("packs-body").closest("[data-feature-flag]")
    ).toHaveAttribute("data-feature-flag", PACKS_DETAIL_ROUTE_FEATURE_FLAG_KEY);
  });

  it("renders the member treatment's body for a non-admin", async () => {
    await renderPage();

    expect(bodyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ mode: "web-member" }),
      })
    );
  });

  it("renders the admin treatment's body for an org admin", async () => {
    authMock.mockResolvedValue({
      has: ({ role }: { role: string }) => role === "org:admin",
    });

    await renderPage();

    expect(bodyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ mode: "web-admin" }),
      })
    );
  });

  it("hands the breadcrumb the pack the route addresses", async () => {
    await renderPage("acme", "pack-xyz");

    expect(breadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgSlug: "acme", packId: "pack-xyz" })
    );
  });
});
