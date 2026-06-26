import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectRenameDialog } from "../project-rename-dialog";

const mockMutate = vi.fn();
const mockUseUpdateProject = vi.fn();

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useUpdateProject: () => mockUseUpdateProject(),
}));

const PROJECT_NAME_REGEX = /project name/i;
const SAVE_REGEX = /^save$/i;

describe("ProjectRenameDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: invoke the per-call onSuccess to simulate a successful mutation.
    mockMutate.mockImplementation((_input, options) => {
      options?.onSuccess?.();
    });
    mockUseUpdateProject.mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    });
  });

  it("opens with the current project name", () => {
    render(
      <ProjectRenameDialog
        currentName="Design Cleanup"
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    expect(screen.getByLabelText(PROJECT_NAME_REGEX)).toHaveValue(
      "Design Cleanup"
    );
  });

  it("submits the trimmed project name and closes after success", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <ProjectRenameDialog
        currentName="Design Cleanup"
        onOpenChange={onOpenChange}
        open={true}
        projectId="project-1"
      />
    );

    const input = screen.getByLabelText(PROJECT_NAME_REGEX);
    await user.clear(input);
    await user.type(input, "  Design Cleanup v2  ");
    await user.click(screen.getByRole("button", { name: SAVE_REGEX }));

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith(
        {
          id: "project-1",
          name: "Design Cleanup v2",
        },
        expect.objectContaining({ onSuccess: expect.any(Function) })
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not submit an unchanged project name", async () => {
    const user = userEvent.setup();

    render(
      <ProjectRenameDialog
        currentName="Design Cleanup"
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    const saveButton = screen.getByRole("button", { name: SAVE_REGEX });
    expect(saveButton).toBeDisabled();
    await user.click(saveButton);

    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("does not submit when only trimming the current project name", async () => {
    const user = userEvent.setup();

    render(
      <ProjectRenameDialog
        currentName=" Design Cleanup "
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    const input = screen.getByLabelText(PROJECT_NAME_REGEX);
    await user.clear(input);
    await user.type(input, "Design Cleanup");

    const saveButton = screen.getByRole("button", { name: SAVE_REGEX });
    expect(saveButton).toBeDisabled();
    await user.click(saveButton);

    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("does not submit a blank project name", async () => {
    const user = userEvent.setup();

    render(
      <ProjectRenameDialog
        currentName="Design Cleanup"
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    const input = screen.getByLabelText(PROJECT_NAME_REGEX);
    await user.clear(input);

    const saveButton = screen.getByRole("button", { name: SAVE_REGEX });
    expect(saveButton).toBeDisabled();
    await user.click(saveButton);

    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("keeps the dialog open when the rename fails", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    // A failed mutation never invokes the per-call onSuccess; the global
    // QueryClient onError handler owns the error toast.
    mockMutate.mockImplementation(() => undefined);

    render(
      <ProjectRenameDialog
        currentName="Design Cleanup"
        onOpenChange={onOpenChange}
        open={true}
        projectId="project-1"
      />
    );

    const input = screen.getByLabelText(PROJECT_NAME_REGEX);
    await user.clear(input);
    await user.type(input, "Design Cleanup v2");
    await user.click(screen.getByRole("button", { name: SAVE_REGEX }));

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalled();
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
