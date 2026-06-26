import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  editorProps: vi.fn(),
  useCurrentUser: vi.fn(),
  useOrganization: vi.fn(),
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: mocks.useCurrentUser,
}));

vi.mock("@repo/app/organizations/hooks/use-organizations", () => ({
  useOrganization: mocks.useOrganization,
}));

vi.mock("../organization-slug-editor", () => ({
  OrganizationSlugEditor: (props: unknown) => {
    mocks.editorProps(props);
    return <div data-testid="slug-editor" />;
  },
}));

import { OrganizationSlugSettings } from "../organization-slug-settings";

const CURRENT_USER = {
  id: "user-1",
  organizationId: "org-1",
};

const ORGANIZATION = {
  id: "org-1",
  name: "Acme",
  slug: "acme",
};

describe("OrganizationSlugSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useCurrentUser.mockReturnValue({
      data: CURRENT_USER,
      error: null,
      isLoading: false,
    });
    mocks.useOrganization.mockReturnValue({
      data: ORGANIZATION,
      error: null,
      isLoading: false,
    });
  });

  it("renders the editor for admins", () => {
    render(<OrganizationSlugSettings isAdmin />);

    expect(screen.getByTestId("slug-editor")).toBeInTheDocument();
    expect(mocks.editorProps).toHaveBeenCalledWith({
      currentSlug: "acme",
      organizationId: "org-1",
      organizationName: "Acme",
    });
  });

  it("renders nothing for non-admin users", () => {
    const { container } = render(<OrganizationSlugSettings isAdmin={false} />);

    expect(container.innerHTML).toBe("");
  });

  it("renders the loading state while user data loads", () => {
    mocks.useCurrentUser.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
    });

    render(<OrganizationSlugSettings isAdmin />);

    expect(screen.getByTestId("slug-settings-loading")).toBeInTheDocument();
  });

  it("renders the loading state while organization data loads", () => {
    mocks.useOrganization.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
    });

    render(<OrganizationSlugSettings isAdmin />);

    expect(screen.getByTestId("slug-settings-loading")).toBeInTheDocument();
  });

  it("renders user errors", () => {
    mocks.useCurrentUser.mockReturnValue({
      data: undefined,
      error: new Error("User failed"),
      isLoading: false,
    });

    render(<OrganizationSlugSettings isAdmin />);

    expect(screen.getByText("User failed")).toBeInTheDocument();
  });

  it("renders organization errors", () => {
    mocks.useOrganization.mockReturnValue({
      data: undefined,
      error: new Error("Organization failed"),
      isLoading: false,
    });

    render(<OrganizationSlugSettings isAdmin />);

    expect(screen.getByText("Organization failed")).toBeInTheDocument();
  });

  it("renders nothing when organization data is empty", () => {
    mocks.useOrganization.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
    });

    const { container } = render(<OrganizationSlugSettings isAdmin />);

    expect(container.querySelector("[data-testid='slug-editor']")).toBeNull();
  });
});
