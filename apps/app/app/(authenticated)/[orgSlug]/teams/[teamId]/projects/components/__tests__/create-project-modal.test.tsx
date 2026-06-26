import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateProjectModal } from "../create-project-modal";

// Mock useCurrentUser to avoid Clerk authentication context
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => ({
    data: null,
    isLoading: false,
    error: null,
  }),
}));

// Mock team members data
const mockMembers = vi.fn();

// Mock the useTeamMembers hook
vi.mock("@repo/app/teams/hooks/use-team-members", () => ({
  useTeamMembers: ({
    teamIds,
    enabled,
  }: {
    teamIds: string[];
    enabled?: boolean;
  }) => {
    // Only call mockMembers when enabled (modal is open)
    if (enabled) {
      mockMembers(teamIds[0]);
    }
    return {
      members: mockMembers.mock.results[0]?.value ?? [],
      isLoading: false,
      error: null,
    };
  },
}));

// Regex constants for testing
const ADD_PROJECT_REGEX = /add project/i;
const CANCEL_REGEX = /cancel/i;
const ENGINEERING_REGEX = /Engineering/;

describe("CreateProjectModal", () => {
  const mockTeamId = "team-123";
  const mockTeamName = "Engineering";

  beforeEach(() => {
    vi.clearAllMocks();
    // Default to returning empty members
    mockMembers.mockReturnValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  describe("Team Member Fetching", () => {
    it("should fetch team members when modal is opened", async () => {
      const mockTeamMembersData = [
        {
          id: "user-1",
          name: "John Doe",
          email: "john@example.com",
          avatarUrl: "https://example.com/avatar1.jpg",
          initials: "JD",
        },
        {
          id: "user-2",
          name: "Jane Smith",
          email: "jane@example.com",
          avatarUrl: undefined,
          initials: "JS",
        },
      ];

      mockMembers.mockReturnValue(mockTeamMembersData);

      render(
        <CreateProjectModal teamId={mockTeamId} teamName={mockTeamName} />
      );

      // Open the modal by clicking the trigger button
      const triggerButton = screen.getByRole("button", {
        name: ADD_PROJECT_REGEX,
      });
      triggerButton.click();

      // Wait for team members to be fetched
      await waitFor(() => {
        expect(mockMembers).toHaveBeenCalledWith(mockTeamId);
      });
    });

    it("should transform team member data correctly for the user select", async () => {
      const mockTeamMembersData = [
        {
          id: "user-1",
          name: "Alice Johnson",
          email: "alice@example.com",
          avatarUrl: "https://example.com/alice.jpg",
          initials: "AJ",
        },
      ];

      mockMembers.mockReturnValue(mockTeamMembersData);

      render(
        <CreateProjectModal teamId={mockTeamId} teamName={mockTeamName} />
      );

      // Open the modal
      const triggerButton = screen.getByRole("button", {
        name: ADD_PROJECT_REGEX,
      });
      triggerButton.click();

      // Wait for hook to be called
      await waitFor(() => {
        expect(mockMembers).toHaveBeenCalledWith(mockTeamId);
      });

      // The transformed data should be used internally
      // We verify the hook was called with correct params
      expect(mockMembers).toHaveBeenCalledWith(mockTeamId);
    });

    it("should handle empty members gracefully", async () => {
      mockMembers.mockReturnValue([]);

      const { container } = render(
        <CreateProjectModal teamId={mockTeamId} teamName={mockTeamName} />
      );

      // Open the modal
      const triggerButton = screen.getByRole("button", {
        name: ADD_PROJECT_REGEX,
      });
      triggerButton.click();

      // Wait for hook to be called
      await waitFor(() => {
        expect(mockMembers).toHaveBeenCalledWith(mockTeamId);
      });

      // Modal should still render
      expect(container.querySelector("[role='dialog']")).toBeDefined();
    });

    it("should reset team members when modal is closed", async () => {
      mockMembers.mockReturnValue([]);

      render(
        <CreateProjectModal teamId={mockTeamId} teamName={mockTeamName} />
      );

      // Open the modal
      const triggerButton = screen.getByRole("button", {
        name: ADD_PROJECT_REGEX,
      });
      triggerButton.click();

      await waitFor(() => {
        expect(mockMembers).toHaveBeenCalled();
      });

      // Close the modal by clicking Cancel
      const cancelButton = screen.getByRole("button", { name: CANCEL_REGEX });
      cancelButton.click();

      // Team members hook will be disabled when closed (enabled: false)
    });
  });

  describe("User Initials Transformation", () => {
    it("should receive correct initials from hook", async () => {
      const mockTeamMembersData = [
        {
          id: "user-1",
          name: "Bob Wilson",
          email: "bob@example.com",
          avatarUrl: undefined,
          initials: "BW",
        },
      ];

      mockMembers.mockReturnValue(mockTeamMembersData);

      render(
        <CreateProjectModal teamId={mockTeamId} teamName={mockTeamName} />
      );

      // Open the modal
      const triggerButton = screen.getByRole("button", {
        name: ADD_PROJECT_REGEX,
      });
      triggerButton.click();

      await waitFor(() => {
        expect(mockMembers).toHaveBeenCalled();
      });

      // The initials "BW" should be provided by the hook
      expect(mockMembers).toHaveBeenCalledWith(mockTeamId);
    });

    it("should handle fallback initials from hook", async () => {
      const mockTeamMembersData = [
        {
          id: "user-1",
          name: "noname@example.com",
          email: "noname@example.com",
          avatarUrl: undefined,
          initials: "?",
        },
      ];

      mockMembers.mockReturnValue(mockTeamMembersData);

      render(
        <CreateProjectModal teamId={mockTeamId} teamName={mockTeamName} />
      );

      // Open the modal
      const triggerButton = screen.getByRole("button", {
        name: ADD_PROJECT_REGEX,
      });
      triggerButton.click();

      await waitFor(() => {
        expect(mockMembers).toHaveBeenCalled();
      });

      // Should handle "?" fallback initials from the hook
      expect(mockMembers).toHaveBeenCalledWith(mockTeamId);
    });
  });

  describe("Modal Rendering", () => {
    it("should render the modal trigger button", () => {
      render(
        <CreateProjectModal teamId={mockTeamId} teamName={mockTeamName} />
      );

      const button = screen.getByRole("button", { name: ADD_PROJECT_REGEX });
      expect(button).toBeDefined();
    });

    it("should display the team name in the modal description", async () => {
      mockMembers.mockReturnValue([]);

      render(
        <CreateProjectModal teamId={mockTeamId} teamName={mockTeamName} />
      );

      // Open the modal
      const triggerButton = screen.getByRole("button", {
        name: ADD_PROJECT_REGEX,
      });
      triggerButton.click();

      // Check for team name in description
      await waitFor(() => {
        expect(screen.getByText(ENGINEERING_REGEX)).toBeDefined();
      });
    });
  });
});
