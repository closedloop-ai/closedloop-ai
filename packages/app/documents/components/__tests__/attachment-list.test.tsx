import {
  AttachmentPurpose,
  type FileAttachment,
} from "@repo/api/src/types/attachment";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { INLINE_ATTACHMENT_BADGE_LABEL } from "../../lib/attachment-visibility";
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

  it("gives an image attachment a working download control beside its thumbnail", () => {
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

    // The thumbnail is KEPT and still opens the preview — it just never saved
    // the file, which is why an image needs the button too (ISS-8036).
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://example.com/preview.png"
    );
    fireEvent.click(
      screen.getByRole("button", { name: `Download ${attachment.filename}` })
    );
    expect(onDownload).toHaveBeenCalledWith(attachment);
    // The filename stays plain text: the thumbnail is already its click target.
    expect(
      screen.queryByRole("button", { name: attachment.filename })
    ).not.toBeInTheDocument();
  });

  it("marks an inline attachment and still offers its download control", () => {
    const onDownload = vi.fn();
    const attachment = makeAttachment({
      id: "attachment-inline",
      filename: "pasted-screenshot.png",
      mimeType: "image/png",
      previewUrl: "https://example.com/pasted.png",
      purpose: AttachmentPurpose.Inline,
    });

    render(
      <AttachmentList attachments={[attachment]} onDownload={onDownload} />
    );

    expect(screen.getByText(INLINE_ATTACHMENT_BADGE_LABEL)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: `Download ${attachment.filename}` })
    );
    expect(onDownload).toHaveBeenCalledWith(attachment);
  });

  it("does not mark a context attachment as inline", () => {
    render(
      <AttachmentList
        attachments={[makeAttachment({ purpose: AttachmentPurpose.Context })]}
      />
    );

    expect(
      screen.queryByText(INLINE_ATTACHMENT_BADGE_LABEL)
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

  it("renders a size that rounds up to a full 1024 KB as megabytes", () => {
    render(
      <AttachmentList
        attachments={[makeAttachment({ sizeBytes: 1_048_575 })]}
      />
    );

    expect(screen.getByText("1.0 MB")).toBeInTheDocument();
    expect(screen.queryByText("1024 KB")).not.toBeInTheDocument();
  });
});
