import { describe, expect, it } from "vitest";
import {
  createAttachmentValidator,
  MAX_FILE_SIZE_BYTES,
} from "@/app/artifacts/[id]/attachments/validators";

describe("createAttachmentValidator", () => {
  it("accepts a valid input with an allowed MIME type", () => {
    const result = createAttachmentValidator.safeParse({
      filename: "document.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a disallowed MIME type", () => {
    const result = createAttachmentValidator.safeParse({
      filename: "malware.exe",
      mimeType: "application/x-executable",
      sizeBytes: 1024,
    });
    expect(result.success).toBe(false);
  });

  it("rejects sizeBytes exceeding MAX_FILE_SIZE_BYTES", () => {
    const result = createAttachmentValidator.safeParse({
      filename: "huge.pdf",
      mimeType: "application/pdf",
      sizeBytes: MAX_FILE_SIZE_BYTES + 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative sizeBytes", () => {
    const result = createAttachmentValidator.safeParse({
      filename: "negative.pdf",
      mimeType: "application/pdf",
      sizeBytes: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero sizeBytes", () => {
    const result = createAttachmentValidator.safeParse({
      filename: "empty.pdf",
      mimeType: "application/pdf",
      sizeBytes: 0,
    });
    expect(result.success).toBe(false);
  });
});
