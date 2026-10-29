import {
  ALLOWED_EXTENSIONS,
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
  MAX_MEDIA_FILE_SIZE_BYTES,
  MEDIA_MIME_TYPES,
} from "@repo/api/src/types/attachment";
import { formatAttachmentSize } from "@repo/app/documents/lib/format-attachment-size";
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mockRequestUploadMutate = vi.fn();
const mockDeleteMutate = vi.fn();
const mockToastError = vi.fn();
const mockUploadToS3 = vi.fn();

vi.mock("@repo/app/documents/hooks/use-attachments", () => ({
  useRequestAttachmentUpload: () => ({ mutate: mockRequestUploadMutate }),
  useDeleteAttachment: () => ({ mutate: mockDeleteMutate }),
}));

vi.mock("@repo/app/shared/lib/s3-upload", () => ({
  uploadToS3: (...args: unknown[]) => mockUploadToS3(...args),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (message: string) => mockToastError(message),
  },
}));

import { AttachFilesButton } from "../attach-files-button";

function renderPicker() {
  const { container } = render(<AttachFilesButton documentId="document-1" />);
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

function selectFile(
  sizeBytes: number,
  mimeType = "application/pdf",
  filename = "report.pdf"
) {
  const input = renderPicker();
  const file = new File(["x"], filename, { type: mimeType });
  Object.defineProperty(file, "size", { value: sizeBytes });
  fireEvent.change(input, { target: { files: [file] } });
  return input;
}

describe("AttachFilesButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("rejects a file larger than the max size before requesting an upload", () => {
    // Spy on the value setter so we can prove resetFileInput() cleared the
    // input. A file input's own `value` always reads back "" (assigning
    // anything but "" throws), so `expect(input.value).toBe("")` is a tautology
    // that passes whether or not the reset ran — the setter spy is what
    // actually observes the `fileInputRef.current.value = ""` assignment.
    const valueSetter = vi.fn();
    const originalValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    );
    Object.defineProperty(HTMLInputElement.prototype, "value", {
      configurable: true,
      get: originalValue?.get,
      set: valueSetter,
    });

    try {
      selectFile(MAX_ATTACHMENT_FILE_SIZE_BYTES + 1);

      expect(mockToastError).toHaveBeenCalledWith(
        `Files must be ${formatAttachmentSize(MAX_ATTACHMENT_FILE_SIZE_BYTES)} or smaller`
      );
      expect(mockRequestUploadMutate).not.toHaveBeenCalled();
      // The input is cleared so the same file can be re-selected.
      expect(valueSetter).toHaveBeenCalledWith("");
    } finally {
      if (originalValue) {
        Object.defineProperty(
          HTMLInputElement.prototype,
          "value",
          originalValue
        );
      }
    }
  });

  test("requests an upload for a file within the max size", () => {
    selectFile(MAX_ATTACHMENT_FILE_SIZE_BYTES);

    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockRequestUploadMutate).toHaveBeenCalledTimes(1);
  });

  // ISS-10415 / operator ruling 2026-09-17: the API accepts media up to the
  // media ceiling, and this picker is the only way a user reaches it. The
  // contract is PER TYPE, so the fixture runs every media MIME — one format
  // cannot tell a media allowance from a blanket ceiling raise, and the
  // non-media case below is what kills the blanket-raise mutation.
  test.each([...MEDIA_MIME_TYPES])(
    "requests an upload for a %s file far above the document ceiling",
    (mimeType) => {
      selectFile(MAX_ATTACHMENT_FILE_SIZE_BYTES + 1, mimeType, "capture.bin");

      expect(mockToastError).not.toHaveBeenCalled();
      expect(mockRequestUploadMutate).toHaveBeenCalledTimes(1);
      expect(mockRequestUploadMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          mimeType,
          sizeBytes: MAX_ATTACHMENT_FILE_SIZE_BYTES + 1,
        }),
        expect.anything()
      );
    }
  );

  test.each([...MEDIA_MIME_TYPES])(
    "rejects a %s file above the media ceiling and names that ceiling",
    (mimeType) => {
      selectFile(MAX_MEDIA_FILE_SIZE_BYTES + 1, mimeType, "capture.bin");

      expect(mockToastError).toHaveBeenCalledWith(
        `Video and audio files must be ${formatAttachmentSize(MAX_MEDIA_FILE_SIZE_BYTES)} or smaller`
      );
      expect(mockRequestUploadMutate).not.toHaveBeenCalled();
    }
  );

  test("offers every media extension in the picker alongside the documents", () => {
    const accept = renderPicker().getAttribute("accept") ?? "";
    const offered = accept.split(",");

    for (const extension of [".mov", ".mp4", ".mp3"]) {
      expect(offered).toContain(extension);
    }
    // Positive control on the same locator: the pre-existing document
    // extensions are still offered, so a match here is not an empty `accept`.
    for (const extension of [".pdf", ".png", ".docx"]) {
      expect(offered).toContain(extension);
    }
    expect(accept).toBe(ALLOWED_EXTENSIONS);
  });
});
