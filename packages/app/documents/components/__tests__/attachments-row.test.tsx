import {
  AttachmentPurpose,
  buildInlineAttachmentRef,
  type FileAttachment,
} from "@repo/api/src/types/attachment";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mockUseDocumentAttachments = vi.fn();
const mockDeleteMutate = vi.fn();
const mockDownloadMutate = vi.fn();

vi.mock("@repo/app/documents/hooks/use-attachments", () => ({
  useDeleteAttachment: () => ({ mutate: mockDeleteMutate }),
  useDocumentAttachments: (documentId: string) =>
    mockUseDocumentAttachments(documentId),
  useDownloadAttachment: () => ({ mutate: mockDownloadMutate }),
}));

import { AttachmentsRow } from "../attachments-row";

const attachments: FileAttachment[] = [
  {
    id: "attachment-1",
    artifactId: "artifact-1",
    createdAt: "2026-05-29T16:15:00.000Z",
    createdById: "user-1",
    filename: "implementation-plan.md",
    mimeType: "text/markdown",
    sizeBytes: 42_000,
  },
];

const INLINE_ID = "00000000-0000-4000-8000-000000000001";

const inlineImage: FileAttachment = {
  id: INLINE_ID,
  artifactId: "artifact-1",
  createdAt: "2026-05-30T10:00:00.000Z",
  createdById: "user-1",
  filename: "pasted-screenshot.png",
  mimeType: "image/png",
  previewUrl: "https://example.com/pasted.png",
  purpose: AttachmentPurpose.Inline,
  sizeBytes: 96_000,
};

describe("AttachmentsRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("renders nothing when the document has no attachments", () => {
    mockUseDocumentAttachments.mockReturnValue({ data: [] });

    const { container } = render(<AttachmentsRow documentId="artifact-1" />);

    expect(container).toBeEmptyDOMElement();
  });

  test("wires delete and download handlers through the shared attachment list", () => {
    mockUseDocumentAttachments.mockReturnValue({ data: attachments });

    render(<AttachmentsRow documentId="artifact-1" />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Download implementation-plan.md",
      })
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete implementation-plan.md",
      })
    );

    expect(mockDownloadMutate).toHaveBeenCalledWith({
      attachmentId: "attachment-1",
      documentId: "artifact-1",
    });
    expect(mockDeleteMutate).toHaveBeenCalledWith("attachment-1");
  });

  test("requires confirmation before deleting an attachment referenced by latest content", () => {
    mockUseDocumentAttachments.mockReturnValue({ data: attachments });

    render(
      <AttachmentsRow
        documentId="artifact-1"
        latestContent="![plan](attachment://attachment-1)"
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete implementation-plan.md",
      })
    );

    expect(
      screen.getByRole("alertdialog", {
        name: "Delete referenced attachment?",
      })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockDeleteMutate).not.toHaveBeenCalled();
  });

  test("requires confirmation from saved latest content while viewing a historical version", () => {
    mockUseDocumentAttachments.mockReturnValue({ data: attachments });

    render(
      <AttachmentsRow
        documentId="artifact-1"
        latestContent="Historical view is older, but latest has ![plan](attachment://attachment-1)"
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete implementation-plan.md",
      })
    );

    expect(
      screen.getByRole("alertdialog", {
        name: "Delete referenced attachment?",
      })
    ).toBeInTheDocument();
    expect(mockDeleteMutate).not.toHaveBeenCalled();
  });

  test("deletes referenced latest-content attachments after confirmation", () => {
    mockUseDocumentAttachments.mockReturnValue({ data: attachments });

    render(
      <AttachmentsRow
        documentId="artifact-1"
        latestContent="![plan](attachment://attachment-1)"
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete implementation-plan.md",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete attachment" }));

    expect(mockDeleteMutate).toHaveBeenCalledWith("attachment-1");
  });

  // Narrow on purpose: the hook is mocked in this file, so no purpose is
  // observable here. That both purposes are actually requested is pinned in
  // `use-attachments.test.ts` against the real query options.
  test("reads through the composite hook, not a context-only one", () => {
    mockUseDocumentAttachments.mockReturnValue({ data: attachments });

    render(<AttachmentsRow documentId="artifact-1" />);

    expect(mockUseDocumentAttachments).toHaveBeenCalledWith("artifact-1");
  });

  test("lists an inline image the body never references, with a working download", () => {
    mockUseDocumentAttachments.mockReturnValue({ data: [inlineImage] });

    render(
      <AttachmentsRow
        documentId="artifact-1"
        latestContent="A body with no image references at all."
      />
    );

    expect(screen.getByText("pasted-screenshot.png")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Download pasted-screenshot.png" })
    );
    expect(mockDownloadMutate).toHaveBeenCalledWith({
      attachmentId: INLINE_ID,
      documentId: "artifact-1",
    });
  });

  test("hides an inline image the latest content already renders", () => {
    mockUseDocumentAttachments.mockReturnValue({
      data: [inlineImage, ...attachments],
    });

    render(
      <AttachmentsRow
        documentId="artifact-1"
        latestContent={`![shot](${buildInlineAttachmentRef(INLINE_ID)})`}
      />
    );

    expect(screen.queryByText("pasted-screenshot.png")).not.toBeInTheDocument();
    // Its unreferenced sibling is untouched — the filter is per row.
    expect(screen.getByText("implementation-plan.md")).toBeInTheDocument();
  });

  test("splits the two questions on a historical view: renderedContent hides, latestContent warns", () => {
    // A historical version that does NOT render the image, while the latest
    // saved body still does. Visibility must follow the version on screen (so
    // the file is reachable), and the delete warning must follow the latest
    // saved body (so deleting it still says what it would break).
    mockUseDocumentAttachments.mockReturnValue({ data: [inlineImage] });

    render(
      <AttachmentsRow
        documentId="artifact-1"
        latestContent={`![shot](${buildInlineAttachmentRef(INLINE_ID)})`}
        renderedContent="This older version never embedded the screenshot."
      />
    );

    expect(screen.getByText("pasted-screenshot.png")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Delete pasted-screenshot.png" })
    );

    // Guarded, not deleted: the latest body still references it.
    expect(mockDeleteMutate).not.toHaveBeenCalled();
    expect(
      screen.getByText("Delete referenced attachment?")
    ).toBeInTheDocument();
  });

  test("falls back to latestContent for visibility when no renderedContent is given", () => {
    // The scaffold always passes both; a mount site with no version notion must
    // keep behaving exactly as it did before the split.
    mockUseDocumentAttachments.mockReturnValue({
      data: [inlineImage, ...attachments],
    });

    render(
      <AttachmentsRow
        documentId="artifact-1"
        latestContent={`![shot](${buildInlineAttachmentRef(INLINE_ID)})`}
      />
    );

    expect(screen.queryByText("pasted-screenshot.png")).not.toBeInTheDocument();
  });

  test("renders nothing when every attachment is filtered out", () => {
    mockUseDocumentAttachments.mockReturnValue({ data: [inlineImage] });

    const { container } = render(
      <AttachmentsRow
        documentId="artifact-1"
        latestContent={`![shot](${buildInlineAttachmentRef(INLINE_ID)})`}
      />
    );

    // The emptiness check must read the FILTERED list, or this renders an empty
    // chip row instead of collapsing.
    expect(container).toBeEmptyDOMElement();
  });
});
