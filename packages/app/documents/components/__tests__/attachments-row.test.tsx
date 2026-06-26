import type { FileAttachment } from "@repo/api/src/types/attachment";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mockUseAttachments = vi.fn();
const mockDeleteMutate = vi.fn();
const mockDownloadMutate = vi.fn();

vi.mock("@repo/app/documents/hooks/use-attachments", () => ({
  useAttachments: (documentId: string) => mockUseAttachments(documentId),
  useDeleteAttachment: () => ({ mutate: mockDeleteMutate }),
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

describe("AttachmentsRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("renders nothing when the document has no attachments", () => {
    mockUseAttachments.mockReturnValue({ data: [] });

    const { container } = render(<AttachmentsRow documentId="artifact-1" />);

    expect(container).toBeEmptyDOMElement();
  });

  test("wires delete and download handlers through the shared attachment list", () => {
    mockUseAttachments.mockReturnValue({ data: attachments });

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
    mockUseAttachments.mockReturnValue({ data: attachments });

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
    mockUseAttachments.mockReturnValue({ data: attachments });

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
    mockUseAttachments.mockReturnValue({ data: attachments });

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
});
