import { useUpdateProject } from "@repo/app/projects/hooks/use-projects";
import {
  InlineEditSubject,
  inlineEditEmptyValueMessage,
} from "@repo/app/shared/lib/inline-edit-empty-value-message";
import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditableProjectTitle } from "../editable-project-title";

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useUpdateProject: vi.fn(),
}));
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn() },
}));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

describe("EditableProjectTitle", () => {
  // ISS-11198: the rename carries the name it replaced, so a rename that
  // landed meanwhile is refused rather than silently overwritten.
  it("sends the name it showed as the write's guard", () => {
    const mutateAsync = vi.fn(() => new Promise(() => undefined));
    vi.mocked(useUpdateProject).mockReturnValue({
      mutateAsync,
    } as unknown as ReturnType<typeof useUpdateProject>);
    render(<EditableProjectTitle initialTitle="Apollo" projectId="proj-1" />);

    expect(useUpdateProject).toHaveBeenCalledWith();

    const input = screen.getByRole("textbox", { name: "Project title" });
    fireEvent.change(input, { target: { value: "Artemis" } });
    fireEvent.blur(input);

    expect(mutateAsync).toHaveBeenCalledWith({
      id: "proj-1",
      name: "Artemis",
      expectedName: "Apollo",
      recoverableErrorOwner: expect.any(Function),
    });
  });

  // ISS-9590: the sibling case in `editable-document-title.test.tsx` pins the
  // document title's key. Without this one, pointing this call site at
  // `DocumentTitle` would change what a user reads here and leave every suite
  // green — one subject cannot tell a per-subject answer from a global one.
  it("PRD-722 DT-033 keeps empty validation associated with the title", () => {
    const mutateAsync = vi.fn(() => new Promise(() => undefined));
    vi.mocked(useUpdateProject).mockReturnValue({
      mutateAsync,
    } as unknown as ReturnType<typeof useUpdateProject>);
    render(<EditableProjectTitle initialTitle="Apollo" projectId="proj-1" />);

    const input = screen.getByRole("textbox", { name: "Project title" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
    expect(input).toHaveAccessibleDescription(
      inlineEditEmptyValueMessage(InlineEditSubject.ProjectTitle)
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      inlineEditEmptyValueMessage(InlineEditSubject.ProjectTitle)
    );
  });

  it("PRD-722 DT-034 preserves and marks a title the server refuses", async () => {
    const mutateAsync = vi.fn(() => Promise.reject(new Error("refused")));
    vi.mocked(useUpdateProject).mockReturnValue({
      mutateAsync,
    } as unknown as ReturnType<typeof useUpdateProject>);
    render(<EditableProjectTitle initialTitle="Apollo" projectId="proj-1" />);

    const input = screen.getByRole("textbox", { name: "Project title" });
    fireEvent.change(input, { target: { value: "Artemis" } });
    fireEvent.blur(input);

    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue("Artemis");
    expect(input).toHaveAccessibleDescription(INLINE_EDIT_SAVE_ERROR_MESSAGE);
    expect(screen.getByRole("alert")).toHaveTextContent(
      INLINE_EDIT_SAVE_ERROR_MESSAGE
    );
  });
});
