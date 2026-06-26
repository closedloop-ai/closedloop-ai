import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamModal } from "../team-modal";

const mockUseCurrentUser = vi.fn();
const mockUseOrganizationUsers = vi.fn();

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
  useTeamMembers: () => ({
    data: [],
    isLoading: false,
  }),
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
}));

vi.mock("@repo/design-system/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
    type = "button",
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    type?: "button" | "submit" | "reset";
  }) => (
    <button disabled={disabled} onClick={onClick} type={type}>
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
  LoaderIcon: () => <svg />,
  PlusIcon: () => <svg />,
  TrashIcon: () => <svg />,
  XIcon: () => <svg />,
}));

describe("TeamModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCurrentUser.mockReturnValue({ data: null, isPending: false });
    mockUseOrganizationUsers.mockReturnValue({
      data: [],
      isLoading: false,
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
});
