import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSyncPolicyCard } from "../session-sync-policy-card";

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

const SAVE_ERROR_RE = /couldn't save that change/i;

const CARD_TITLE = "Sync session data to the cloud";

function makeOrganization(sessionSyncPolicyEnabled: boolean) {
  return { id: "org-1", sessionSyncPolicyEnabled };
}

describe("SessionSyncPolicyCard", () => {
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
    const { container } = render(<SessionSyncPolicyCard isAdmin={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the session-sync policy card for admins", () => {
    render(<SessionSyncPolicyCard isAdmin />);
    expect(screen.getByText(CARD_TITLE)).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("reflects the persisted OFF value from the API", () => {
    mocks.useOrganization.mockReturnValue({
      data: makeOrganization(false),
      isLoading: false,
      error: null,
    });
    render(<SessionSyncPolicyCard isAdmin />);
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
    render(<SessionSyncPolicyCard isAdmin />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true"
    );
  });

  it("fires updateOrganization with sessionSyncPolicyEnabled=true when toggled ON", async () => {
    mocks.useOrganization.mockReturnValue({
      data: makeOrganization(false),
      isLoading: false,
      error: null,
    });
    render(<SessionSyncPolicyCard isAdmin />);

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() =>
      expect(DEFAULT_MUTATE).toHaveBeenCalledWith({
        id: "org-1",
        sessionSyncPolicyEnabled: true,
      })
    );
  });

  it("fires updateOrganization with sessionSyncPolicyEnabled=false when toggled OFF", async () => {
    mocks.useOrganization.mockReturnValue({
      data: makeOrganization(true),
      isLoading: false,
      error: null,
    });
    render(<SessionSyncPolicyCard isAdmin />);

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() =>
      expect(DEFAULT_MUTATE).toHaveBeenCalledWith({
        id: "org-1",
        sessionSyncPolicyEnabled: false,
      })
    );
  });

  it("disables the switch while the mutation is in flight", () => {
    mocks.useUpdateOrganization.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: true,
    });
    render(<SessionSyncPolicyCard isAdmin />);
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
    render(<SessionSyncPolicyCard isAdmin />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(LOADING_RE)).toBeInTheDocument();
  });

  it("renders the loading state while organization data loads", () => {
    mocks.useOrganization.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    render(<SessionSyncPolicyCard isAdmin />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(LOADING_RE)).toBeInTheDocument();
  });

  it("renders an error state and no switch when the user fetch fails", () => {
    mocks.useCurrentUser.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("user fetch failed"),
    });
    render(<SessionSyncPolicyCard isAdmin />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("user fetch failed")).toBeInTheDocument();
  });

  it("renders an error state and no switch when the organization fetch fails", () => {
    mocks.useOrganization.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("org fetch failed"),
    });
    render(<SessionSyncPolicyCard isAdmin />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("org fetch failed")).toBeInTheDocument();
  });

  it("holds the loading card (does not vanish) when the org query settles without data", () => {
    // Paused/offline settle: isLoading false, no error, data undefined. The card
    // must not return null and disappear off the tab.
    mocks.useOrganization.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });
    render(<SessionSyncPolicyCard isAdmin />);
    expect(screen.getByText(CARD_TITLE)).toBeInTheDocument();
    expect(screen.getByText(LOADING_RE)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows an inline save-error line when the mutation fails", () => {
    mocks.useUpdateOrganization.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: false,
      isError: true,
    });
    render(<SessionSyncPolicyCard isAdmin />);
    expect(screen.getByRole("alert")).toHaveTextContent(SAVE_ERROR_RE);
  });
});
