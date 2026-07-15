import { MAX_ATTACHMENT_FILE_SIZE_BYTES } from "@repo/api/src/types/attachment";
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

function selectFile(sizeBytes: number, filename = "report.pdf") {
  const { container } = render(<AttachFilesButton documentId="document-1" />);
  const input = container.querySelector(
    'input[type="file"]'
  ) as HTMLInputElement;

  const file = new File(["x"], filename, { type: "application/pdf" });
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
        "Files must be 10 MiB or smaller"
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
});
