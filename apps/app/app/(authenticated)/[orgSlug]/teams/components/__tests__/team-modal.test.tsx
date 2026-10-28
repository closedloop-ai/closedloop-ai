import { ONBOARDING_STATUS_UNAVAILABLE_COPY } from "@repo/app/onboarding/components/onboarding-status-unavailable";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamModal } from "../team-modal";
import { TEAM } from "./support/use-team-modal-mocks";

const mockUseCurrentUser = vi.fn();
const mockUseOrganizationUsers = vi.fn();
const mockUseTeamMembers = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: vi.fn(() => ({ orgSlug: "test-org" })),
}));

vi.mock("@repo/app/shared/components/delete-confirmation-dialog", () => ({
  DeleteConfirmationDialog: () => null,
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => mockUseCurrentUser(),
  useOrganizationUsers: () => mockUseOrganizationUsers(),
}));

vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useCreateTeam: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useUpdateTeam: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useDeleteTeam: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useAddTeamMember: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useRemoveTeamMember: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useTeamMembers: () => mockUseTeamMembers(),
  useUpdateTeamMemberRole: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useTeamRepositories: () => ({
    data: [],
    isLoading: false,
  }),
  useAddTeamRepository: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useUpdateTeamRepository: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useRemoveTeamRepository: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@repo/design-system/components/ui/avatar", () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AvatarFallback: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AvatarImage: () => null,
  AvatarStatus: () => null,
  // PersonAvatar draws one initial through it (Nerys, 2026-10-22).
  avatarInitial: (text: string | null | undefined) =>
    (text ?? "").trim().charAt(0).toUpperCase(),
}));

vi.mock("@repo/design-system/components/ui/button", () => ({
  Button: ({
    "aria-disabled": ariaDisabled,
    children,
    disabled,
    onClick,
    type = "button",
  }: {
    "aria-disabled"?: boolean;
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    type?: "button" | "submit" | "reset";
  }) => (
    <button
      aria-disabled={ariaDisabled}
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {children}
    </button>
  ),
}));

vi.mock("@repo/design-system/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@repo/design-system/components/ui/input", () => ({
  Input: ({
    id,
    onChange,
    placeholder,
    required,
    value,
  }: {
    id: string;
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    placeholder?: string;
    required?: boolean;
    value: string;
  }) => (
    <input
      id={id}
      onChange={onChange}
      placeholder={placeholder}
      required={required}
      value={value}
    />
  ),
}));

vi.mock("@repo/design-system/components/ui/label", () => ({
  Label: ({
    children,
    htmlFor,
  }: {
    children: React.ReactNode;
    htmlFor?: string;
  }) => <label htmlFor={htmlFor}>{children}</label>,
}));

vi.mock("@repo/design-system/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: React.ReactNode; value: string }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
}));

vi.mock("@repo/design-system/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

vi.mock("lucide-react", () => ({
  AlertCircleIcon: () => <svg />,
  LoaderIcon: () => <svg />,
  PlusIcon: () => <svg />,
  TrashIcon: () => <svg />,
  XIcon: () => <svg />,
}));

describe("TeamModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // In flight, not settled. `isPending: false` with no data is the settled
    // failed read (ISS-9794) and renders the error state, which is its own case
    // below — the default here is the ordinary "still fetching" open.
    mockUseCurrentUser.mockReturnValue({ data: null, isPending: true });
    mockUseOrganizationUsers.mockReturnValue({
      data: [],
      isLoading: false,
    });
    mockUseTeamMembers.mockReturnValue({
      data: [],
      isLoading: false,
      isLoadingError: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("adds the current user as owner when /me resolves after the dialog opens", async () => {
    const currentUser = {
      id: "user-1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      avatarUrl: null,
    };

    const { rerender } = render(
      <TeamModal onOpenChange={vi.fn()} open={true} />
    );

    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByText("Loading your owner membership...")).toBeVisible();
    expect(screen.getByRole("button", { name: "Create Team" })).toBeDisabled();

    mockUseCurrentUser.mockReturnValue({ data: currentUser, isPending: false });
    rerender(<TeamModal onOpenChange={vi.fn()} open={true} />);

    await waitFor(() => {
      expect(screen.getByText("Ada Lovelace")).toBeVisible();
    });

    expect(screen.getByText("ada@example.com")).toBeVisible();
    expect(screen.queryByText("Loading your owner membership...")).toBeNull();
  });

  it("keeps create disabled until the owner is available", () => {
    mockUseCurrentUser.mockReturnValue({ data: null, isPending: true });

    render(<TeamModal onOpenChange={vi.fn()} open={true} />);

    expect(screen.getByText("Loading your owner membership...")).toBeVisible();
    expect(screen.getByRole("button", { name: "Create Team" })).toBeDisabled();
  });

  // ISS-9794. The sibling case above proves this same panel does show the
  // loading copy while `/me` is genuinely in flight, so its absence here is a
  // statement about the settled read and not about the locator.
  it("names the failed read instead of claiming to load once /me settles with no user", () => {
    mockUseCurrentUser.mockReturnValue({ data: null, isPending: false });

    render(<TeamModal onOpenChange={vi.fn()} open={true} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("We couldn't load your account");
    expect(
      screen.getByText(
        "We need it to add you as the team owner, so you can't create a team right now."
      )
    ).toBeVisible();
    expect(screen.queryByText("Loading your owner membership...")).toBeNull();
    expect(screen.getByRole("button", { name: "Create Team" })).toBeDisabled();
  });

  // ISS-11068. The failed state's way back: Retry re-reads `/me`, and a
  // resolved user replaces the failed state with the seeded Owner row.
  it("re-reads /me from the failed state and becomes submittable when it resolves", async () => {
    const refetch = vi.fn();
    mockUseCurrentUser.mockReturnValue({
      data: undefined,
      isPending: false,
      refetch,
    });

    const { rerender } = render(
      <TeamModal onOpenChange={vi.fn()} open={true} />
    );
    fireEvent.change(screen.getByLabelText("Team Name"), {
      target: { value: "New Team" },
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: ONBOARDING_STATUS_UNAVAILABLE_COPY.retryLabel,
      })
    );
    expect(refetch).toHaveBeenCalledTimes(1);

    mockUseCurrentUser.mockReturnValue({
      data: CREATE_OWNER,
      isPending: false,
      refetch,
    });
    rerender(<TeamModal onOpenChange={vi.fn()} open={true} />);

    await waitFor(() => {
      expect(screen.getByText("Ada Lovelace")).toBeVisible();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Create Team" })).toBeEnabled();
  });

  // ISS-11068. The retry in flight keeps the failed state and the SAME Retry
  // element (inert via `aria-disabled`, not `disabled`) so keyboard focus is
  // not dropped; a second failure leaves the honest failed state in place.
  it("keeps the focused Retry through a retry that fails again, with submit still disabled", () => {
    const refetch = vi.fn();
    mockUseCurrentUser.mockReturnValue({
      data: undefined,
      errorUpdatedAt: FAILED_AT,
      isPending: false,
      refetch,
    });

    const { rerender } = render(
      <TeamModal onOpenChange={vi.fn()} open={true} />
    );
    fireEvent.change(screen.getByLabelText("Team Name"), {
      target: { value: "New Team" },
    });
    const retry = screen.getByRole("button", {
      name: ONBOARDING_STATUS_UNAVAILABLE_COPY.retryLabel,
    });
    retry.focus();
    fireEvent.click(retry);

    mockUseCurrentUser.mockReturnValue({
      data: undefined,
      errorUpdatedAt: FAILED_AT,
      isPending: true,
      refetch,
    });
    rerender(<TeamModal onOpenChange={vi.fn()} open={true} />);

    const retrying = screen.getByRole("button", {
      name: ONBOARDING_STATUS_UNAVAILABLE_COPY.retryingLabel,
    });
    expect(retrying).toBe(retry);
    expect(retrying).toHaveAttribute("aria-disabled", "true");
    expect(retrying).toHaveFocus();
    expect(screen.queryByText("Loading your owner membership...")).toBeNull();
    fireEvent.click(retrying);
    expect(refetch).toHaveBeenCalledTimes(1);

    mockUseCurrentUser.mockReturnValue({
      data: undefined,
      errorUpdatedAt: FAILED_AT,
      isPending: false,
      refetch,
    });
    rerender(<TeamModal onOpenChange={vi.fn()} open={true} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "We couldn't load your account"
    );
    expect(
      screen.getByRole("button", {
        name: ONBOARDING_STATUS_UNAVAILABLE_COPY.retryLabel,
      })
    ).toHaveFocus();
    expect(screen.getByRole("button", { name: "Create Team" })).toBeDisabled();
  });

  // Review on #7850: a focus or reconnect refetch re-reads a failed `/me`
  // before anyone presses Retry. The focused Retry must survive it the same way.
  it("keeps the focused Retry through a re-read nobody asked for", () => {
    const refetch = vi.fn();
    mockUseCurrentUser.mockReturnValue({
      data: undefined,
      errorUpdatedAt: FAILED_AT,
      isPending: false,
      refetch,
    });

    const { rerender } = render(
      <TeamModal onOpenChange={vi.fn()} open={true} />
    );
    const retry = screen.getByRole("button", {
      name: ONBOARDING_STATUS_UNAVAILABLE_COPY.retryLabel,
    });
    retry.focus();

    mockUseCurrentUser.mockReturnValue({
      data: undefined,
      errorUpdatedAt: FAILED_AT,
      isPending: true,
      refetch,
    });
    rerender(<TeamModal onOpenChange={vi.fn()} open={true} />);

    expect(
      screen.getByRole("button", {
        name: ONBOARDING_STATUS_UNAVAILABLE_COPY.retryingLabel,
      })
    ).toBe(retry);
    expect(retry).toHaveFocus();
    expect(screen.queryByText("Loading your owner membership...")).toBeNull();
    expect(refetch).not.toHaveBeenCalled();
  });
});

// ISS-9805. The edit-mode twin of the create-mode case above: `useTeamMembers`
// erroring settles with `isLoading` false and an empty `data`, so before this
// the panel hydrated drafts to `[]` and rendered the failure as "No members
// yet". All three cases assert the same two locators so no one of them can pass
// by collapsing into another — failure shows the alert and NOT the empty copy,
// a genuinely empty team shows the empty copy and NO alert, and a read still in
// flight shows neither.
describe("TeamModal — edit mode members read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCurrentUser.mockReturnValue({ data: null, isPending: false });
    mockUseOrganizationUsers.mockReturnValue({ data: [], isLoading: false });
  });

  afterEach(() => {
    cleanup();
  });

  it("names the failed members read instead of claiming the team has no members", () => {
    mockUseTeamMembers.mockReturnValue({
      data: undefined,
      isLoading: false,
      isLoadingError: true,
    });

    render(<TeamModal onOpenChange={vi.fn()} open={true} team={TEAM} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("We couldn't load this team's members");
    expect(alert).toHaveTextContent("Reload the page and try again.");
    expect(screen.queryByText(EMPTY_MEMBERS_COPY)).toBeNull();
  });

  it("still shows the empty-team copy when the members read succeeds with none", () => {
    mockUseTeamMembers.mockReturnValue({
      data: [],
      isLoading: false,
      isLoadingError: false,
    });

    render(<TeamModal onOpenChange={vi.fn()} open={true} team={TEAM} />);

    expect(screen.getByText(EMPTY_MEMBERS_COPY)).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows neither the failure nor the empty copy while the members read is in flight", () => {
    mockUseTeamMembers.mockReturnValue({
      data: undefined,
      isPending: true,
      isLoading: true,
      isLoadingError: false,
    });

    render(<TeamModal onOpenChange={vi.fn()} open={true} team={TEAM} />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(EMPTY_MEMBERS_COPY)).toBeNull();
  });
});

const EMPTY_MEMBERS_COPY = "No members yet. Add members above.";

const CREATE_OWNER = {
  id: "user-1",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  avatarUrl: null,
};

const FAILED_AT = 1_700_000_000_000;
