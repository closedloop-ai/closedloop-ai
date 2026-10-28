import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { useUpdateDocument } from "@repo/app/documents/hooks/use-documents";
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
import { EditableDocumentTitle } from "../editable-document-title";

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useUpdateDocument: vi.fn(),
}));
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn() },
}));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

describe("EditableDocumentTitle", () => {
  // ISS-11198: the rename carries the title it replaced, so a rename that
  // landed meanwhile is refused rather than silently overwritten.
  it("sends the title it showed as the write's guard", () => {
    const mutateAsync = vi.fn(() => new Promise(() => undefined));
    vi.mocked(useUpdateDocument).mockReturnValue({
      mutateAsync,
    } as unknown as ReturnType<typeof useUpdateDocument>);
    render(<EditableDocumentTitle documentId="doc-1" initialTitle="Plan" />);

    expect(useUpdateDocument).toHaveBeenCalledWith();

    const input = screen.getByRole("textbox", { name: "Document title" });
    fireEvent.change(input, { target: { value: "Plan v2" } });
    fireEvent.blur(input);

    expect(mutateAsync).toHaveBeenCalledWith({
      id: "doc-1",
      title: "Plan v2",
      expectedTitle: "Plan",
      recoverableErrorOwner: expect.any(Function),
      surface: ArtifactStatusEditSurface.Detail,
    });
  });

  // ISS-9590: pins this field's SUBJECT KEY, paired with the sibling case in
  // `editable-project-title.test.tsx` — pointing either call site at the other's
  // key changes what a user reads, and one subject alone cannot see it. It does
  // not observe that the string came from the map: the map's entry equals the
  // literal this call site used to hold, so reverting to that literal is
  // value-identical and stays green (#code-review, ISS-9590).
  it("PRD-722 DT-033 keeps empty validation associated with the title", () => {
    const mutateAsync = vi.fn(() => new Promise(() => undefined));
    vi.mocked(useUpdateDocument).mockReturnValue({
      mutateAsync,
    } as unknown as ReturnType<typeof useUpdateDocument>);
    render(<EditableDocumentTitle documentId="doc-1" initialTitle="Plan" />);

    const input = screen.getByRole("textbox", { name: "Document title" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
    expect(input).toHaveAccessibleDescription(
      inlineEditEmptyValueMessage(InlineEditSubject.DocumentTitle)
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      inlineEditEmptyValueMessage(InlineEditSubject.DocumentTitle)
    );
  });

  it("PRD-722 DT-034 preserves and marks a title the server refuses", async () => {
    const mutateAsync = vi.fn(() => Promise.reject(new Error("refused")));
    vi.mocked(useUpdateDocument).mockReturnValue({
      mutateAsync,
    } as unknown as ReturnType<typeof useUpdateDocument>);
    render(<EditableDocumentTitle documentId="doc-1" initialTitle="Plan" />);

    const input = screen.getByRole("textbox", { name: "Document title" });
    fireEvent.change(input, { target: { value: "Plan v2" } });
    fireEvent.blur(input);

    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue("Plan v2");
    expect(input).toHaveAccessibleDescription(INLINE_EDIT_SAVE_ERROR_MESSAGE);
    expect(screen.getByRole("alert")).toHaveTextContent(
      INLINE_EDIT_SAVE_ERROR_MESSAGE
    );
  });
});
