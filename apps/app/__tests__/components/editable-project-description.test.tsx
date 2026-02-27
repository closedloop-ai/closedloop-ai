/**
 * Unit tests for EditableProjectDescription component.
 * Tests always-editable textarea, blur-to-save, Enter-to-save, Escape-to-cancel,
 * optimistic updates, and error handling.
 */

import type {
  ProjectWithDetails,
  UpdateProjectInput,
} from "@repo/api/src/types/project";
import type { UseMutationResult } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the hooks - create mocks inside factory functions to avoid hoisting issues
const mockMutate = vi.fn();
let mockUpdateProjectInstance: UseMutationResult<
  ProjectWithDetails,
  Error,
  UpdateProjectInput
>;

vi.mock("@/hooks/queries/use-projects", () => ({
  useUpdateProject: vi.fn(),
}));

// Mock toast
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

import { toast } from "@repo/design-system/components/ui/sonner";
// Import after mocks
import { EditableProjectDescription } from "@/components/editable-project-description";
import { useUpdateProject } from "@/hooks/queries/use-projects";

describe("EditableProjectDescription", () => {
  const projectId = "01PROJECT000000000000000";

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default mock return value
    mockUpdateProjectInstance = {
      mutate: mockMutate,
      mutateAsync: vi.fn(),
      isPending: false,
      isIdle: true,
      isError: false,
      isSuccess: false,
      data: undefined,
      error: null,
      reset: vi.fn(),
      status: "idle",
      submittedAt: 0,
      variables: undefined,
      failureCount: 0,
      failureReason: null,
      isPaused: false,
      context: undefined,
    } as unknown as UseMutationResult<
      ProjectWithDetails,
      Error,
      UpdateProjectInput
    >;

    vi.mocked(useUpdateProject).mockReturnValue(mockUpdateProjectInstance);
  });

  afterEach(() => {
    cleanup();
  });

  describe("Default rendering", () => {
    it("renders textarea with description text", () => {
      const { container } = render(
        <EditableProjectDescription
          initialDescription="Test project description"
          projectId={projectId}
        />
      );

      const textarea = within(container).getByRole("textbox");
      expect(textarea).toBeInTheDocument();
      expect(textarea).toHaveValue("Test project description");
    });

    it("renders textarea with placeholder when description is empty", () => {
      const { container } = render(
        <EditableProjectDescription
          initialDescription=""
          projectId={projectId}
        />
      );

      const textarea = within(container).getByRole("textbox");
      expect(textarea).toHaveAttribute(
        "placeholder",
        "Add a description for this project..."
      );
    });

    it("configures textarea with correct rows", () => {
      const { container } = render(
        <EditableProjectDescription
          initialDescription=""
          projectId={projectId}
        />
      );

      const textarea = within(container).getByRole("textbox");
      expect(textarea).toHaveAttribute("rows", "1");
    });
  });

  describe("Save behavior", () => {
    it("saves on blur with trimmed value", async () => {
      const { container } = render(
        <EditableProjectDescription
          initialDescription="Original description"
          projectId={projectId}
        />
      );

      const textarea = within(container).getByRole("textbox");
      fireEvent.change(textarea, {
        target: { value: "  Updated description  " },
      });

      fireEvent.blur(textarea);

      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalledWith(
          {
            id: projectId,
            description: "Updated description",
          },
          expect.any(Object)
        );
      });
    });

    it("saves on Enter key without Shift", async () => {
      const { container } = render(
        <EditableProjectDescription
          initialDescription="Original"
          projectId={projectId}
        />
      );

      const textarea = within(container).getByRole("textbox");
      fireEvent.change(textarea, { target: { value: "New description" } });

      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalledWith(
          {
            id: projectId,
            description: "New description",
          },
          expect.any(Object)
        );
      });
    });

    it("does not save on Enter with Shift held", () => {
      const { container } = render(
        <EditableProjectDescription
          initialDescription="Original"
          projectId={projectId}
        />
      );

      const textarea = within(container).getByRole("textbox");
      fireEvent.change(textarea, { target: { value: "Line 1\nLine 2" } });

      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

      expect(mockMutate).not.toHaveBeenCalled();
    });

    it("does not save when value unchanged", () => {
      const { container } = render(
        <EditableProjectDescription
          initialDescription="Unchanged"
          projectId={projectId}
        />
      );

      const textarea = within(container).getByRole("textbox");
      fireEvent.blur(textarea);

      expect(mockMutate).not.toHaveBeenCalled();
    });

    it("sends undefined for empty descriptions", async () => {
      const { container } = render(
        <EditableProjectDescription
          initialDescription="Original"
          projectId={projectId}
        />
      );

      const textarea = within(container).getByRole("textbox");
      fireEvent.change(textarea, { target: { value: "   " } });

      fireEvent.blur(textarea);

      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalledWith(
          {
            id: projectId,
            description: undefined,
          },
          expect.any(Object)
        );
      });
    });
  });

  describe("Cancel behavior", () => {
    it("resets value on Escape key", () => {
      const { container } = render(
        <EditableProjectDescription
          initialDescription="Original"
          projectId={projectId}
        />
      );

      const textarea = within(container).getByRole("textbox");
      fireEvent.change(textarea, { target: { value: "Modified" } });

      fireEvent.keyDown(textarea, { key: "Escape" });

      expect(mockMutate).not.toHaveBeenCalled();
      expect(textarea).toHaveValue("Original");
    });
  });

  describe("Optimistic updates", () => {
    it("immediately updates value on save", async () => {
      const { container } = render(
        <EditableProjectDescription
          initialDescription="Original"
          projectId={projectId}
        />
      );

      const textarea = within(container).getByRole("textbox");
      fireEvent.change(textarea, { target: { value: "Updated" } });
      fireEvent.blur(textarea);

      await waitFor(() => {
        expect(textarea).toHaveValue("Updated");
      });
    });

    it("calls onDescriptionChange callback on success", async () => {
      const onDescriptionChange = vi.fn();

      const { container } = render(
        <EditableProjectDescription
          initialDescription="Original"
          onDescriptionChange={onDescriptionChange}
          projectId={projectId}
        />
      );

      const textarea = within(container).getByRole("textbox");
      fireEvent.change(textarea, { target: { value: "Updated" } });
      fireEvent.blur(textarea);

      await waitFor(() => {
        const mutateCall = mockMutate.mock.calls[0];
        const options = mutateCall[1];
        options.onSuccess();
      });

      expect(onDescriptionChange).toHaveBeenCalledWith("Updated");
    });

    it("reverts to original value on error", async () => {
      const { container } = render(
        <EditableProjectDescription
          initialDescription="Original"
          projectId={projectId}
        />
      );

      const textarea = within(container).getByRole("textbox");
      fireEvent.change(textarea, { target: { value: "Updated" } });
      fireEvent.blur(textarea);

      await waitFor(() => {
        const mutateCall = mockMutate.mock.calls[0];
        const options = mutateCall[1];
        options.onError();
      });

      expect(textarea).toHaveValue("Original");
      expect(toast.error).toHaveBeenCalledWith(
        "Failed to update project description. Please try again."
      );
    });
  });

  describe("Disabled state", () => {
    it("disables textarea when mutation is pending", () => {
      mockUpdateProjectInstance.isPending = true;
      vi.mocked(useUpdateProject).mockReturnValue(mockUpdateProjectInstance);

      const { container } = render(
        <EditableProjectDescription
          initialDescription="Test"
          projectId={projectId}
        />
      );

      const textarea = within(container).getByRole("textbox");
      expect(textarea).toBeDisabled();
    });
  });

  describe("Prop synchronization", () => {
    it("syncs with initialDescription changes", () => {
      const { container, rerender } = render(
        <EditableProjectDescription
          initialDescription="First"
          projectId={projectId}
        />
      );

      const textarea = within(container).getByRole("textbox");
      expect(textarea).toHaveValue("First");

      rerender(
        <EditableProjectDescription
          initialDescription="Second"
          projectId={projectId}
        />
      );

      expect(textarea).toHaveValue("Second");
    });
  });

  describe("Multi-line support", () => {
    it("preserves newlines in description", () => {
      const multilineDescription = "Line 1\nLine 2\nLine 3";

      const { container } = render(
        <EditableProjectDescription
          initialDescription={multilineDescription}
          projectId={projectId}
        />
      );

      const textarea = within(container).getByRole("textbox");
      expect(textarea).toHaveValue(multilineDescription);
    });
  });
});
