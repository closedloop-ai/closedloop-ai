import type { FileAttachment } from "@repo/api/src/types/attachment";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AttachmentList } from "../attachment-list";

function makeAttachment(
  overrides: Partial<FileAttachment> = {}
): FileAttachment {
  return {
    id: "attachment-1",
    artifactId: "artifact-1",
    filename: "implementation-plan.md",
    mimeType: "text/markdown",
    sizeBytes: 42_000,
    createdAt: "2026-05-29T16:15:00.000Z",
    createdById: "user-1",
    ...overrides,
  };
}

describe("AttachmentList", () => {
  it("renders the emptyState when there are no attachments", () => {
    render(
      <AttachmentList attachments={[]} emptyState={<div>No attachments</div>} />
    );

    expect(screen.getByText("No attachments")).toBeInTheDocument();
  });

  it("makes a non-image (.md) attachment filename clickable to open it", () => {
    const onDownload = vi.fn();
    const attachment = makeAttachment();

    render(
      <AttachmentList attachments={[attachment]} onDownload={onDownload} />
    );

    // The filename itself must be an interactive control the user can click —
    // not dead text — for every viable file type, not just images (FEA-1940).
    const filenameButton = screen.getByRole("button", {
      name: attachment.filename,
    });
    fireEvent.click(filenameButton);

    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledWith(attachment);
  });

  it("also exposes an explicit download button for non-image attachments", () => {
    const onDownload = vi.fn();
    const attachment = makeAttachment();

    render(
      <AttachmentList attachments={[attachment]} onDownload={onDownload} />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: `Download ${attachment.filename}`,
      })
    );

    expect(onDownload).toHaveBeenCalledWith(attachment);
  });

  it("renders an image attachment as a preview link, not a filename button", () => {
    const onDownload = vi.fn();
    const attachment = makeAttachment({
      id: "attachment-image",
      filename: "wireframe.png",
      mimeType: "image/png",
      previewUrl: "https://example.com/preview.png",
    });

    render(
      <AttachmentList attachments={[attachment]} onDownload={onDownload} />
    );

    const previewLink = screen.getByRole("link");
    expect(previewLink).toHaveAttribute(
      "href",
      "https://example.com/preview.png"
    );
    // Image chips do not get a filename button or a download button.
    expect(
      screen.queryByRole("button", { name: attachment.filename })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: `Download ${attachment.filename}`,
      })
    ).not.toBeInTheDocument();
  });

  it("does not make the filename clickable when no download handler is provided", () => {
    const attachment = makeAttachment();

    render(<AttachmentList attachments={[attachment]} />);

    expect(
      screen.queryByRole("button", { name: attachment.filename })
    ).not.toBeInTheDocument();
    expect(screen.getByText(attachment.filename)).toBeInTheDocument();
  });
});
