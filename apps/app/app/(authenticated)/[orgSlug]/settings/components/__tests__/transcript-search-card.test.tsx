import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptSearchCard } from "../transcript-search-card";

const mocks = vi.hoisted(() => ({
  useCurrentUser: vi.fn(),
  useOrganization: vi.fn(),
  useUpdateOrganization: vi.fn(),
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: mocks.useCurrentUser,
}));

vi.mock("@repo/app/organizations/hooks/use-organizations", () => ({
  useOrganization: mocks.useOrganization,
  useUpdateOrganization: mocks.useUpdateOrganization,
}));

const DEFAULT_MUTATE = vi.fn();

const CURRENT_USER = { id: "user-1", organizationId: "org-1" };

const LOADING_RE = /loading settings/i;

function makeOrganization(searchIncludeTranscripts: boolean) {
  return { id: "org-1", searchIncludeTranscripts };
}

describe("TranscriptSearchCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useCurrentUser.mockReturnValue({
      data: CURRENT_USER,
      isLoading: false,
      error: null,
    });
    mocks.useOrganization.mockReturnValue({
      data: makeOrganization(false),
      isLoading: false,
      error: null,
    });
    mocks.useUpdateOrganization.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: false,
    });
  });

  it("renders nothing for non-admin users", () => {
    const { container } = render(<TranscriptSearchCard isAdmin={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the Search session transcripts card for admins", () => {
    render(<TranscriptSearchCard isAdmin />);
    expect(screen.getByText("Search session transcripts")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("reflects the persisted OFF value from the API", () => {
    mocks.useOrganization.mockReturnValue({
      data: makeOrganization(false),
      isLoading: false,
      error: null,
    });
    render(<TranscriptSearchCard isAdmin />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "false"
    );
  });

  it("reflects the persisted ON value from the API", () => {
    mocks.useOrganization.mockReturnValue({
      data: makeOrganization(true),
      isLoading: false,
      error: null,
    });
    render(<TranscriptSearchCard isAdmin />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true"
    );
  });

  it("fires updateOrganization with searchIncludeTranscripts=true when toggled ON", async () => {
    mocks.useOrganization.mockReturnValue({
      data: makeOrganization(false),
      isLoading: false,
      error: null,
    });
    render(<TranscriptSearchCard isAdmin />);

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() =>
      expect(DEFAULT_MUTATE).toHaveBeenCalledWith({
        id: "org-1",
        searchIncludeTranscripts: true,
      })
    );
  });

  it("fires updateOrganization with searchIncludeTranscripts=false when toggled OFF", async () => {
    mocks.useOrganization.mockReturnValue({
      data: makeOrganization(true),
      isLoading: false,
      error: null,
    });
    render(<TranscriptSearchCard isAdmin />);

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() =>
      expect(DEFAULT_MUTATE).toHaveBeenCalledWith({
        id: "org-1",
        searchIncludeTranscripts: false,
      })
    );
  });

  it("disables the switch while the mutation is in flight", () => {
    mocks.useUpdateOrganization.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: true,
    });
    render(<TranscriptSearchCard isAdmin />);
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("renders the loading state while user data loads", () => {
    mocks.useCurrentUser.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    render(<TranscriptSearchCard isAdmin />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(LOADING_RE)).toBeInTheDocument();
  });

  it("renders the loading state while organization data loads", () => {
    mocks.useOrganization.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    render(<TranscriptSearchCard isAdmin />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(LOADING_RE)).toBeInTheDocument();
  });

  it("renders an error state and no switch when the user fetch fails", () => {
    mocks.useCurrentUser.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("user fetch failed"),
    });
    render(<TranscriptSearchCard isAdmin />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("user fetch failed")).toBeInTheDocument();
  });

  it("renders an error state and no switch when the organization fetch fails", () => {
    mocks.useOrganization.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("org fetch failed"),
    });
    render(<TranscriptSearchCard isAdmin />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("org fetch failed")).toBeInTheDocument();
  });
});
