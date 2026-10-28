import { LinkType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  DOCUMENT_ROUTE_PREFIX,
  DocumentType,
  type DocumentWithProject,
  IssueStatus,
} from "@repo/api/src/types/document";
import { type TeamMember, TeamRole } from "@repo/api/src/types/teams";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateIssueModal } from "../create-issue-modal";

const PROJECT_LABEL_REGEX = /^project/i;
const CREATING_REGEX = /Creating/;

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mockNavigate = vi.fn();
const mockUseProjects = vi.fn();
const mockUseTeamMembers = vi.fn();
const mockUseOrganizationUsers = vi.fn();
const mockUseDocumentsByProject = vi.fn();
const mockCreateDocumentMutate = vi.fn();
const mockCreateArtifactLinkMutateAsync = vi.fn();
const mockToastError = vi.fn();

let createFeatureState: { isPending: boolean } = { isPending: false };
let createLinkState: { isPending: boolean } = { isPending: false };

// Declaration order scrambled on purpose. `Priority`'s key order is an
// authoring accident, and this modal's priority menu used to read it as its
// reading order; the menu must now follow the shared semantic order instead.
// Only the ORDER changes here — every value is untouched, so the tests below
// that pick an option by its label are unaffected.
vi.mock("@repo/api/src/types/common", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@repo/api/src/types/common")>();
  return {
    ...actual,
    Priority: {
      Urgent: actual.Priority.Urgent,
      Low: actual.Priority.Low,
      High: actual.Priority.High,
      Medium: actual.Priority.Medium,
    },
  };
});

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    replace: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: (...args: unknown[]) => mockUseProjects(...args),
}));

vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useTeamMembers: (...args: unknown[]) => mockUseTeamMembers(...args),
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: (...args: unknown[]) =>
    mockUseOrganizationUsers(...args),
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocumentsByProject: (...args: unknown[]) =>
    mockUseDocumentsByProject(...args),
  useCreateDocument: () => ({
    mutate: mockCreateDocumentMutate,
    isPending: createFeatureState.isPending,
  }),
}));

vi.mock("@repo/app/documents/hooks/use-artifact-links", () => ({
  useCreateArtifactLink: () => ({
    mutateAsync: mockCreateArtifactLinkMutateAsync,
    isPending: createLinkState.isPending,
  }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

function teamMember(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    id: "member-1",
    teamId: "team-1",
    userId: "user-1",
    role: TeamRole.Member,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    user: {
      id: "user-1",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
    },
    ...overrides,
  };
}

// Minimal shape: the component only reads `id` and `name` off each project.
function project(id: string, name: string) {
  return { id, name };
}

function setDefaults() {
  createFeatureState = { isPending: false };
  createLinkState = { isPending: false };
  mockUseProjects.mockReturnValue({
    data: [
      project("project-1", "Project One"),
      project("project-2", "Project Two"),
    ],
    isLoading: false,
  });
  mockUseTeamMembers.mockReturnValue({
    data: [teamMember()],
    isLoading: false,
  });
  mockUseOrganizationUsers.mockReturnValue({ data: [], isLoading: false });
  mockUseDocumentsByProject.mockReturnValue({ data: [], isLoading: false });
  mockCreateDocumentMutate.mockImplementation((_input, handlers) => {
    handlers?.onSuccess?.(
      createMockDocument({
        id: "issue-1",
        slug: "new-issue",
        type: DocumentType.Feature,
      })
    );
  });
  mockCreateArtifactLinkMutateAsync.mockResolvedValue(undefined);
}

function renderModal(
  overrides: Partial<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    projectId?: string;
    teamId: string;
  }> = {}
) {
  const onOpenChange = overrides.onOpenChange ?? vi.fn();
  render(
    <CreateIssueModal
      onOpenChange={onOpenChange}
      open={overrides.open ?? true}
      projectId={overrides.projectId}
      teamId={overrides.teamId ?? "team-1"}
    />
  );
  return { onOpenChange };
}

describe("CreateIssueModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    setDefaults();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not render the dialog content when closed", () => {
    renderModal({ open: false });

    expect(screen.queryByText("Create New Issue")).not.toBeInTheDocument();
  });

  it("shows the project selector when no projectId prop is given", () => {
    renderModal({ projectId: undefined });

    expect(screen.getByLabelText(PROJECT_LABEL_REGEX)).toBeInTheDocument();
    expect(screen.getByText("Select a project...")).toBeInTheDocument();
  });

  it("reads the team's projects and members, never the organization's", () => {
    renderModal({ projectId: undefined, teamId: "team-7" });

    expect(mockUseProjects).toHaveBeenCalledWith("team-7", { enabled: true });
    expect(mockUseTeamMembers).toHaveBeenCalledWith("team-7", {
      enabled: true,
    });
    expect(mockUseOrganizationUsers).toHaveBeenCalledWith({ enabled: false });
  });

  it("hides the project selector when a projectId prop is given", () => {
    renderModal({ projectId: "project-1" });

    expect(
      screen.queryByLabelText(PROJECT_LABEL_REGEX)
    ).not.toBeInTheDocument();
  });

  it("shows a loading placeholder and disables the trigger while team projects load", () => {
    mockUseProjects.mockReturnValue({ data: [], isLoading: true });

    renderModal({ projectId: undefined });

    expect(screen.getByText("Loading projects...")).toBeInTheDocument();
    expect(screen.getByLabelText(PROJECT_LABEL_REGEX)).toBeDisabled();
  });

  it("updates the title input as the user types", () => {
    renderModal({ projectId: "project-1" });

    const titleInput = screen.getByPlaceholderText("Issue Title");
    fireEvent.change(titleInput, { target: { value: "Fix the thing" } });

    expect(titleInput).toHaveValue("Fix the thing");
  });

  it("disables Create Issue when the title is empty", () => {
    renderModal({ projectId: "project-1" });

    expect(screen.getByRole("button", { name: "Create Issue" })).toBeDisabled();
  });

  it("disables Create Issue when no project is selected", () => {
    renderModal({ projectId: undefined });
    fireEvent.change(screen.getByPlaceholderText("Issue Title"), {
      target: { value: "Fix the thing" },
    });

    expect(screen.getByRole("button", { name: "Create Issue" })).toBeDisabled();
  });

  it("enables Create Issue once both a title and a project are present", () => {
    renderModal({ projectId: "project-1" });
    fireEvent.change(screen.getByPlaceholderText("Issue Title"), {
      target: { value: "Fix the thing" },
    });

    expect(screen.getByRole("button", { name: "Create Issue" })).toBeEnabled();
  });

  it("calls onOpenChange(false) when Cancel is clicked", () => {
    const { onOpenChange } = renderModal({ projectId: "project-1" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("changes the selected priority and submits it", async () => {
    renderModal({ projectId: "project-1" });
    fireEvent.change(screen.getByPlaceholderText("Issue Title"), {
      target: { value: "Fix the thing" },
    });

    const priorityContainer = screen.getByText("Priority")
      .parentElement as HTMLElement;
    within(priorityContainer).getByRole("combobox").click();
    await waitFor(() => {
      screen.getByRole("option", { name: "Urgent" }).click();
    });

    fireEvent.click(screen.getByRole("button", { name: "Create Issue" }));

    expect(mockCreateDocumentMutate).toHaveBeenCalledWith(
      expect.objectContaining({ priority: Priority.Urgent }),
      expect.anything()
    );
  });

  it("offers the priority options in the shared semantic order, not the enum's declaration order", async () => {
    // The real enum is declared lowest-first, which is also what this test
    // expects the menu to render — so without a live scramble the assertion
    // below would pass against the reverted component. Prove it is in effect.
    expect(Object.values(Priority)).toEqual([
      Priority.Urgent,
      Priority.Low,
      Priority.High,
      Priority.Medium,
    ]);
    renderModal({ projectId: "project-1" });

    const priorityContainer = screen.getByText("Priority")
      .parentElement as HTMLElement;
    within(priorityContainer).getByRole("combobox").click();

    await waitFor(() => {
      expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    });
    expect(
      screen.getAllByRole("option").map((option) => option.textContent)
    ).toEqual(["Low", "Medium", "High", "Urgent"]);
  });

  it("changes the selected status and submits it", async () => {
    renderModal({ projectId: "project-1" });
    fireEvent.change(screen.getByPlaceholderText("Issue Title"), {
      target: { value: "Fix the thing" },
    });

    const statusContainer = screen.getByText("Status")
      .parentElement as HTMLElement;
    within(statusContainer).getByRole("combobox").click();
    await waitFor(() => {
      screen.getByRole("option", { name: "Todo" }).click();
    });

    fireEvent.click(screen.getByRole("button", { name: "Create Issue" }));

    expect(mockCreateDocumentMutate).toHaveBeenCalledWith(
      expect.objectContaining({ status: IssueStatus.Todo }),
      expect.anything()
    );
  });

  it("shows a loading placeholder for the assignee popover while team members load", () => {
    mockUseTeamMembers.mockReturnValue({ data: [], isLoading: true });

    renderModal({ projectId: "project-1" });

    expect(screen.getByText("Loading users...")).toBeInTheDocument();
  });

  it("shows the unassigned placeholder for the assignee popover by default", () => {
    renderModal({ projectId: "project-1" });

    expect(screen.getByText("Select Assignee")).toBeInTheDocument();
  });

  it("adds an artifact from the relationships popover as a badge", async () => {
    mockUseDocumentsByProject.mockReturnValue({
      data: [createMockDocument({ id: "doc-1", title: "Existing PRD" })],
      isLoading: false,
    });

    renderModal({ projectId: "project-1" });
    screen.getByText("Select additional context...").click();

    await waitFor(() => {
      screen.getByText("Existing PRD").click();
    });

    const badges = await screen.findAllByText("Existing PRD");
    expect(badges).toHaveLength(1);
  });

  it("removes an added artifact badge when its remove control is clicked", async () => {
    mockUseDocumentsByProject.mockReturnValue({
      data: [createMockDocument({ id: "doc-1", title: "Existing PRD" })],
      isLoading: false,
    });

    renderModal({ projectId: "project-1" });
    screen.getByText("Select additional context...").click();
    await waitFor(() => {
      screen.getByText("Existing PRD").click();
    });
    await screen.findAllByText("Existing PRD");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Existing PRD" })
    );

    expect(screen.queryByText("Existing PRD")).not.toBeInTheDocument();
  });

  it("clears selected artifacts when the project changes", async () => {
    const docsByProject: Record<string, DocumentWithProject[]> = {
      "project-1": [
        createMockDocument({ id: "doc-1", title: "PRD in project one" }),
      ],
      "project-2": [],
    };
    mockUseDocumentsByProject.mockImplementation((projectId: string) => ({
      data: docsByProject[projectId] ?? [],
      isLoading: false,
    }));

    renderModal({ projectId: undefined });
    const projectTrigger = screen.getByLabelText(PROJECT_LABEL_REGEX);

    projectTrigger.click();
    await waitFor(() => {
      screen.getByRole("option", { name: "Project One" }).click();
    });

    screen.getByText("Select additional context...").click();
    await waitFor(() => {
      screen.getByText("PRD in project one").click();
    });
    await screen.findAllByText("PRD in project one");

    projectTrigger.click();
    await waitFor(() => {
      screen.getByRole("option", { name: "Project Two" }).click();
    });

    expect(screen.queryByText("PRD in project one")).not.toBeInTheDocument();
  });

  it("submits with the expected payload and navigates to the new issue on success", async () => {
    const { onOpenChange } = renderModal({ projectId: "project-1" });
    fireEvent.change(screen.getByPlaceholderText("Issue Title"), {
      target: { value: "  Fix the thing  " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create Issue" }));

    await waitFor(() => {
      expect(mockCreateDocumentMutate).toHaveBeenCalledWith(
        {
          type: DocumentType.Feature,
          projectId: "project-1",
          title: "Fix the thing",
          content: "",
          status: IssueStatus.Backlog,
          priority: Priority.Medium,
          assigneeId: undefined,
        },
        expect.anything()
      );
    });

    expect(mockNavigate).toHaveBeenCalledWith(
      `/acme/${DOCUMENT_ROUTE_PREFIX}/new-issue`
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("creates an artifact link for each selected artifact on success", async () => {
    mockUseDocumentsByProject.mockReturnValue({
      data: [createMockDocument({ id: "doc-1", title: "Existing PRD" })],
      isLoading: false,
    });

    renderModal({ projectId: "project-1" });
    fireEvent.change(screen.getByPlaceholderText("Issue Title"), {
      target: { value: "Fix the thing" },
    });
    screen.getByText("Select additional context...").click();
    await waitFor(() => {
      screen.getByText("Existing PRD").click();
    });
    await screen.findAllByText("Existing PRD");

    fireEvent.click(screen.getByRole("button", { name: "Create Issue" }));

    await waitFor(() => {
      expect(mockCreateArtifactLinkMutateAsync).toHaveBeenCalledWith({
        sourceId: "doc-1",
        targetId: "issue-1",
        linkType: LinkType.Produces,
      });
    });
  });

  // The summary toast is raised by the link mutation's hook-level `onError`
  // (ISS-11741), which this mocked hook never runs. Its text and count are
  // pinned against the real mutation in
  // create-issue-modal-link-failure-toast.test.tsx.
  it("still navigates, with no toast from its own catch, when linking a relationship fails", async () => {
    mockUseDocumentsByProject.mockReturnValue({
      data: [createMockDocument({ id: "doc-1", title: "Existing PRD" })],
      isLoading: false,
    });
    mockCreateArtifactLinkMutateAsync.mockRejectedValue(
      new Error("link failed")
    );

    renderModal({ projectId: "project-1" });
    fireEvent.change(screen.getByPlaceholderText("Issue Title"), {
      target: { value: "Fix the thing" },
    });
    screen.getByText("Select additional context...").click();
    await waitFor(() => {
      screen.getByText("Existing PRD").click();
    });
    await screen.findAllByText("Existing PRD");

    fireEvent.click(screen.getByRole("button", { name: "Create Issue" }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        `/acme/${DOCUMENT_ROUTE_PREFIX}/new-issue`
      );
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("shows an inline error and does not navigate when creating the issue fails", async () => {
    mockCreateDocumentMutate.mockImplementation((_input, handlers) => {
      handlers?.onError?.(new Error("boom"));
    });

    renderModal({ projectId: "project-1" });
    fireEvent.change(screen.getByPlaceholderText("Issue Title"), {
      target: { value: "Fix the thing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Issue" }));

    await waitFor(() => {
      expect(
        screen.getByText("Failed to create issue. Please try again.")
      ).toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("shows a Creating state and disables submit while the mutation is pending", () => {
    createFeatureState = { isPending: true };

    renderModal({ projectId: "project-1" });
    fireEvent.change(screen.getByPlaceholderText("Issue Title"), {
      target: { value: "Fix the thing" },
    });

    expect(screen.getByText("Creating...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CREATING_REGEX })).toBeDisabled();
  });
});
