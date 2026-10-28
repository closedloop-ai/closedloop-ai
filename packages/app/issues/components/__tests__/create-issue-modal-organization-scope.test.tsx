import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  projects: vi.fn(),
  teamMembers: vi.fn(),
  navigate: vi.fn(),
  documents: vi.fn(),
  pending: false,
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: (...args: unknown[]) => {
    mocks.projects(...args);
    return {
      data: [
        { id: "project-a", name: "First project" },
        { id: "project-b", name: "Second project" },
      ],
      isLoading: false,
    };
  },
}));
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [], isLoading: false }),
}));
vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useTeamMembers: (...args: unknown[]) => {
    mocks.teamMembers(...args);
    return { data: [], isLoading: false };
  },
}));
vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useCreateDocument: () => ({ mutate: mocks.mutate, isPending: mocks.pending }),
  useDocumentsByProject: (...args: unknown[]) => {
    mocks.documents(...args);
    return { data: [] };
  },
}));
vi.mock("@repo/app/documents/hooks/use-artifact-links", () => ({
  useCreateArtifactLink: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { CreateIssueModal } from "../create-issue-modal";

const titleLabel = /issue title/i;
const projectLabel = /project/i;
const createLabel = /^create issue$/i;

function selectProject(name = "Second project") {
  fireEvent.click(screen.getByRole("combobox", { name: projectLabel }));
  fireEvent.click(screen.getByRole("option", { name }));
}

function enterTitle() {
  fireEvent.change(screen.getByLabelText(titleLabel), {
    target: { value: "  Fix organisation issues  " },
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.pending = false;
});

describe("CreateIssueModal without a team", () => {
  it("requires a project for an ISS and reads all org projects only while open", () => {
    render(<CreateIssueModal onOpenChange={vi.fn()} open />);
    expect(mocks.projects).toHaveBeenCalledWith(undefined, { enabled: true });
    expect(mocks.teamMembers).toHaveBeenCalledWith("", { enabled: false });
    enterTitle();
    expect(screen.getByRole("button", { name: createLabel })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText(titleLabel).closest("form")!);
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByText("Please select a project")).toBeVisible();
    expect(mocks.documents).toHaveBeenCalledWith("", { enabled: false });
  });

  it("creates a Feature in the selected project, then reports the created record and closes", async () => {
    const onSuccess = vi.fn();
    const onOpenChange = vi.fn();
    const issue = createMockDocument({
      type: DocumentType.Feature,
      slug: "ISS-123",
      projectId: "project-b",
      status: IssueStatus.Backlog,
    });
    render(
      <CreateIssueModal
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        open
      />
    );
    selectProject();
    enterTitle();
    fireEvent.click(screen.getByRole("button", { name: createLabel }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: DocumentType.Feature,
        projectId: "project-b",
        title: "Fix organisation issues",
        status: IssueStatus.Backlog,
      }),
      expect.anything()
    );
    await act(async () => {
      await mocks.mutate.mock.calls[0][1].onSuccess(issue);
    });
    expect(onSuccess).toHaveBeenCalledWith(issue);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("keeps the title and selected project after a failed create so a retry uses the same input", () => {
    const onOpenChange = vi.fn();
    render(<CreateIssueModal onOpenChange={onOpenChange} open />);
    selectProject();
    enterTitle();
    fireEvent.click(screen.getByRole("button", { name: createLabel }));
    act(() => mocks.mutate.mock.calls[0][1].onError(new Error("Failed")));
    expect(
      screen.getByText("Failed to create issue. Please try again.")
    ).toBeVisible();
    expect(screen.getByLabelText(titleLabel)).toHaveValue(
      "  Fix organisation issues  "
    );
    expect(
      screen.getByRole("combobox", { name: projectLabel })
    ).toHaveTextContent("Second project");
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: createLabel }));
    expect(mocks.mutate.mock.calls[1][0]).toEqual(
      mocks.mutate.mock.calls[0][0]
    );
  });

  it("uses the board lane's initial status", () => {
    render(
      <CreateIssueModal
        initialStatus={IssueStatus.InReview}
        onOpenChange={vi.fn()}
        open
      />
    );
    selectProject("First project");
    enterTitle();
    fireEvent.click(screen.getByRole("button", { name: createLabel }));
    expect(mocks.mutate.mock.calls[0][0].status).toBe(IssueStatus.InReview);
  });

  it("keeps an in-flight create open on Escape and disables cancellation", () => {
    mocks.pending = true;
    const onOpenChange = vi.fn();
    render(<CreateIssueModal onOpenChange={onOpenChange} open />);
    fireEvent.keyDown(screen.getByLabelText(titleLabel), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
