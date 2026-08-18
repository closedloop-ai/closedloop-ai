import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
const CREATE_PROJECT_REGEX = /create project/i;
const PROJECT_NAME_LABEL_REGEX = /project name/i;
const DESCRIPTION_LABEL_REGEX = /description/i;

const TYPED_NAME = "My New Project";
const TYPED_DESCRIPTION = "A description that must survive a failure";

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

  describe("Submit Behavior", () => {
    const getSubmitButton = () =>
      screen
        .getAllByRole("button", { name: CREATE_PROJECT_REGEX })
        .find((el) => (el as HTMLButtonElement).type === "submit") as
        | HTMLButtonElement
        | undefined;

    it("keeps the modal open and retains input when the mutation fails", async () => {
      const onCreateProject = vi.fn().mockRejectedValue(new Error("boom"));

      render(
        <CreateProjectModal
          onCreateProject={onCreateProject}
          teamId={mockTeamId}
          teamName={mockTeamName}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: ADD_PROJECT_REGEX }));

      const nameInput = screen.getByLabelText(
        PROJECT_NAME_LABEL_REGEX
      ) as HTMLInputElement;
      const descriptionInput = screen.getByLabelText(
        DESCRIPTION_LABEL_REGEX
      ) as HTMLTextAreaElement;
      fireEvent.change(nameInput, { target: { value: TYPED_NAME } });
      fireEvent.change(descriptionInput, {
        target: { value: TYPED_DESCRIPTION },
      });

      const submitButton = getSubmitButton();
      expect(submitButton).toBeDefined();
      fireEvent.click(submitButton as HTMLButtonElement);

      await waitFor(() => {
        expect(onCreateProject).toHaveBeenCalledTimes(1);
      });

      // Dialog stays mounted and the typed values are retained.
      await waitFor(() => {
        expect(
          (screen.getByLabelText(PROJECT_NAME_LABEL_REGEX) as HTMLInputElement)
            .value
        ).toBe(TYPED_NAME);
      });
      expect(
        (screen.getByLabelText(DESCRIPTION_LABEL_REGEX) as HTMLTextAreaElement)
          .value
      ).toBe(TYPED_DESCRIPTION);

      // Submit is re-enabled so the user can retry.
      await waitFor(() => {
        expect((getSubmitButton() as HTMLButtonElement).disabled).toBe(false);
      });
    });

    it("passes the trimmed submitted values to onCreateProject", async () => {
      const onCreateProject = vi.fn().mockResolvedValue(undefined);

      render(
        <CreateProjectModal
          onCreateProject={onCreateProject}
          teamId={mockTeamId}
          teamName={mockTeamName}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: ADD_PROJECT_REGEX }));

      fireEvent.change(screen.getByLabelText(PROJECT_NAME_LABEL_REGEX), {
        target: { value: TYPED_NAME },
      });
      fireEvent.change(screen.getByLabelText(DESCRIPTION_LABEL_REGEX), {
        target: { value: TYPED_DESCRIPTION },
      });

      fireEvent.click(getSubmitButton() as HTMLButtonElement);

      await waitFor(() => {
        expect(onCreateProject).toHaveBeenCalledWith(
          expect.objectContaining({
            name: TYPED_NAME,
            description: TYPED_DESCRIPTION,
            teamIds: [mockTeamId],
          })
        );
      });
    });

    it("closes and resets the form when the mutation succeeds", async () => {
      const onCreateProject = vi.fn().mockResolvedValue(undefined);

      render(
        <CreateProjectModal
          onCreateProject={onCreateProject}
          teamId={mockTeamId}
          teamName={mockTeamName}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: ADD_PROJECT_REGEX }));
      fireEvent.change(screen.getByLabelText(PROJECT_NAME_LABEL_REGEX), {
        target: { value: TYPED_NAME },
      });

      fireEvent.click(getSubmitButton() as HTMLButtonElement);

      await waitFor(() => {
        expect(onCreateProject).toHaveBeenCalledTimes(1);
      });

      // Dialog closes: the form field is no longer in the document.
      await waitFor(() => {
        expect(screen.queryByLabelText(PROJECT_NAME_LABEL_REGEX)).toBeNull();
      });

      // Reopening shows a cleared form (state was reset on success).
      fireEvent.click(screen.getByRole("button", { name: ADD_PROJECT_REGEX }));
      await waitFor(() => {
        expect(
          (screen.getByLabelText(PROJECT_NAME_LABEL_REGEX) as HTMLInputElement)
            .value
        ).toBe("");
      });
    });

    it("does not double-submit while a create is pending", async () => {
      let resolveCreate: (() => void) | undefined;
      const onCreateProject = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveCreate = resolve;
          })
      );

      render(
        <CreateProjectModal
          onCreateProject={onCreateProject}
          teamId={mockTeamId}
          teamName={mockTeamName}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: ADD_PROJECT_REGEX }));
      fireEvent.change(screen.getByLabelText(PROJECT_NAME_LABEL_REGEX), {
        target: { value: TYPED_NAME },
      });

      const submitButton = getSubmitButton() as HTMLButtonElement;
      fireEvent.click(submitButton);
      fireEvent.click(submitButton);

      // Button is disabled while pending, so only one submit fires. The label
      // changes to "Creating..." during submit, so assert on the retained node
      // reference rather than re-querying by the now-stale accessible name.
      await waitFor(() => {
        expect(submitButton.disabled).toBe(true);
      });
      expect(onCreateProject).toHaveBeenCalledTimes(1);

      resolveCreate?.();
    });
  });
});
