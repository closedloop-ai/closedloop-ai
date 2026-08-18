import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock setup — hoisted so vi.mock factories can reference them
// ---------------------------------------------------------------------------

const {
  mockSetActive,
  mockUseAuth,
  mockUseClerk,
  mockUseOrganization,
  mockUseOrganizationList,
  mockUseUser,
} = vi.hoisted(() => ({
  mockSetActive: vi.fn(),
  mockUseAuth: vi.fn(),
  mockUseClerk: vi.fn(),
  mockUseOrganization: vi.fn(),
  mockUseOrganizationList: vi.fn(),
  mockUseUser: vi.fn(),
}));

// `useUser` is consumed transitively via StaffParsingBugFlagProvider, which
// OrgIdentityProvider mounts on its render-children path (FEA-4347). These tests
// only assert org routing, so a loaded non-staff user keeps that provider inert.
vi.mock("@repo/auth/client", () => ({
  useAuth: mockUseAuth,
  useClerk: mockUseClerk,
  useOrganization: mockUseOrganization,
  useOrganizationList: mockUseOrganizationList,
  useUser: mockUseUser,
}));

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: mockNotFound,
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/test",
  useSearchParams: () => new URLSearchParams(),
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks are registered
// ---------------------------------------------------------------------------

import OrgIdentityProvider from "../org-identity-provider";

describe("OrgIdentityProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseClerk.mockReturnValue({ setActive: mockSetActive });
    mockUseAuth.mockReturnValue({ orgSlug: null, isLoaded: true });
    mockUseOrganization.mockReturnValue({ organization: null, isLoaded: true });
    mockUseOrganizationList.mockReturnValue({
      userMemberships: { data: [], isLoading: false },
      isLoaded: true,
    });
    mockUseUser.mockReturnValue({ isLoaded: true, user: null });
  });

  it("renders children when the session org already matches the URL slug", () => {
    mockUseAuth.mockReturnValue({ orgSlug: "my-org", isLoaded: true });

    render(
      <OrgIdentityProvider orgSlug="my-org">
        <div>child content</div>
      </OrgIdentityProvider>
    );

    expect(screen.getByText("child content")).toBeInTheDocument();
    expect(mockSetActive).not.toHaveBeenCalled();
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("renders children for the active org without a matching membership-list entry", () => {
    // Regression: the membership list can omit the active org (large/paginated
    // lists, or slugs that don't surface there). The JWT org slug is the source
    // of truth, so the page must still render rather than 404.
    mockUseAuth.mockReturnValue({ orgSlug: "my-org", isLoaded: true });
    mockUseOrganizationList.mockReturnValue({
      userMemberships: { data: [], isLoading: false },
      isLoaded: true,
    });

    render(
      <OrgIdentityProvider orgSlug="my-org">
        <div>child content</div>
      </OrgIdentityProvider>
    );

    expect(screen.getByText("child content")).toBeInTheDocument();
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("calls setActive and renders children when the URL slug is a different org in memberships", async () => {
    mockUseAuth.mockReturnValue({ orgSlug: "other-org", isLoaded: true });
    mockUseOrganization.mockReturnValue({
      organization: { id: "org_123", slug: "other-org" },
      isLoaded: true,
    });
    mockUseOrganizationList.mockReturnValue({
      userMemberships: {
        data: [{ organization: { id: "org_456", slug: "target-org" } }],
        isLoading: false,
      },
      isLoaded: true,
    });
    mockSetActive.mockResolvedValue(undefined);

    const { rerender } = render(
      <OrgIdentityProvider orgSlug="target-org">
        <div>child content</div>
      </OrgIdentityProvider>
    );

    // While switching, shows loading spinner
    expect(screen.queryByText("child content")).not.toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).toBeInTheDocument();

    expect(mockSetActive).toHaveBeenCalledWith({
      organization: "org_456",
    });

    // After setActive resolves, the JWT org slug now matches the URL.
    mockUseAuth.mockReturnValue({ orgSlug: "target-org", isLoaded: true });

    await waitFor(() => {
      rerender(
        <OrgIdentityProvider orgSlug="target-org">
          <div>child content</div>
        </OrgIdentityProvider>
      );
      expect(screen.getByText("child content")).toBeInTheDocument();
    });
  });

  it("calls notFound when the URL slug is neither the session org nor in memberships", () => {
    mockUseAuth.mockReturnValue({ orgSlug: "other-org", isLoaded: true });
    mockUseOrganizationList.mockReturnValue({
      userMemberships: {
        data: [{ organization: { id: "org_123", slug: "some-other-org" } }],
        isLoading: false,
      },
      isLoaded: true,
    });

    expect(() =>
      render(
        <OrgIdentityProvider orgSlug="nonexistent-org">
          <div>child content</div>
        </OrgIdentityProvider>
      )
    ).toThrow("NEXT_NOT_FOUND");

    expect(mockNotFound).toHaveBeenCalled();
  });

  it("shows loading spinner while auth is still loading", () => {
    mockUseAuth.mockReturnValue({ orgSlug: undefined, isLoaded: false });

    render(
      <OrgIdentityProvider orgSlug="my-org">
        <div>child content</div>
      </OrgIdentityProvider>
    );

    expect(document.querySelector(".animate-spin")).toBeInTheDocument();
    expect(screen.queryByText("child content")).not.toBeInTheDocument();
    expect(mockSetActive).not.toHaveBeenCalled();
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("shows loading spinner when memberships are still loading during a switch", () => {
    mockUseAuth.mockReturnValue({ orgSlug: "other-org", isLoaded: true });
    mockUseOrganizationList.mockReturnValue({
      userMemberships: { data: [], isLoading: true },
      isLoaded: false,
    });

    render(
      <OrgIdentityProvider orgSlug="target-org">
        <div>child content</div>
      </OrgIdentityProvider>
    );

    expect(document.querySelector(".animate-spin")).toBeInTheDocument();
    expect(screen.queryByText("child content")).not.toBeInTheDocument();
    expect(mockSetActive).not.toHaveBeenCalled();
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("renders children immediately when the server says to bypass the client org gate", () => {
    // ISS-4406: under AUTH_MODE=local_trusted the server holds a synthetic
    // session but the browser has no Clerk session at all, so activeOrgSlug can
    // never match and this component would spin forever. Mocks are set to the
    // never-matching state on purpose — without the bypass this case renders a
    // spinner, so the assertion cannot pass for the wrong reason.
    mockUseAuth.mockReturnValue({ orgSlug: null, isLoaded: true });
    mockUseOrganizationList.mockReturnValue({
      userMemberships: { data: [], isLoading: false },
      isLoaded: true,
    });

    render(
      <OrgIdentityProvider bypassClientOrgGate orgSlug="closedloop-ai">
        <div>child content</div>
      </OrgIdentityProvider>
    );

    expect(screen.getByText("child content")).toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).not.toBeInTheDocument();
    // The bypass short-circuits the gate only; it must not fire an org switch
    // or a 404 against the synthetic session.
    expect(mockSetActive).not.toHaveBeenCalled();
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("still gates on the client org when the bypass prop is omitted", () => {
    // Same mock state as the bypass case above, with the prop left off: it
    // defaults to false, so the client gate still runs and this non-member slug
    // 404s. This is the paired negative — it proves the previous test passes
    // because of the bypass, not because the mocks happened to be permissive.
    mockUseAuth.mockReturnValue({ orgSlug: null, isLoaded: true });
    mockUseOrganizationList.mockReturnValue({
      userMemberships: { data: [], isLoading: false },
      isLoaded: true,
    });

    expect(() =>
      render(
        <OrgIdentityProvider orgSlug="closedloop-ai">
          <div>child content</div>
        </OrgIdentityProvider>
      )
    ).toThrow("NEXT_NOT_FOUND");

    expect(mockNotFound).toHaveBeenCalled();
  });

  it("does not switch while the active org is still loading", () => {
    // Cross-org target found in memberships, but Clerk has not yet reported the
    // active org (isLoaded:false). The provider must wait rather than treat the
    // undefined active org as a mismatch and fire a spurious setActive.
    mockUseAuth.mockReturnValue({ orgSlug: "other-org", isLoaded: true });
    mockUseOrganization.mockReturnValue({
      organization: undefined,
      isLoaded: false,
    });
    mockUseOrganizationList.mockReturnValue({
      userMemberships: {
        data: [{ organization: { id: "org_456", slug: "target-org" } }],
        isLoading: false,
      },
      isLoaded: true,
    });

    render(
      <OrgIdentityProvider orgSlug="target-org">
        <div>child content</div>
      </OrgIdentityProvider>
    );

    expect(document.querySelector(".animate-spin")).toBeInTheDocument();
    expect(screen.queryByText("child content")).not.toBeInTheDocument();
    expect(mockSetActive).not.toHaveBeenCalled();
    expect(mockNotFound).not.toHaveBeenCalled();
  });
});
