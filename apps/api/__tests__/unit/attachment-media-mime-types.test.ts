import {
  MAX_MEDIA_FILE_SIZE_BYTES,
  MEDIA_MIME_TYPES,
} from "@repo/api/src/types/attachment";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_MIME_TYPES,
  createAttachmentValidator,
  MAX_FILE_SIZE_BYTES,
} from "@/app/documents/[id]/attachments/validators";

const base = { filename: "capture.mov", sizeBytes: 1024 };

describe("artifact attachment media types (ISS-10415)", () => {
  it("accepts .mov, .mp4 and .mp3 under the spellings browsers actually send", () => {
    // `.mov` is video/quicktime and `.mp3` is audio/mpeg; neither spells the way
    // its extension does, which is the mistake this list exists to prevent.
    for (const mimeType of ["video/quicktime", "video/mp4", "audio/mpeg"]) {
      const result = createAttachmentValidator.safeParse({ ...base, mimeType });
      expect(result.success, `expected ${mimeType} to be accepted`).toBe(true);
    }
  });

  it("lets a media file exceed the document ceiling", () => {
    // The point of the ticket: accepting the type while rejecting every real
    // screen recording would be a capability in name only.
    const result = createAttachmentValidator.safeParse({
      ...base,
      mimeType: "video/quicktime",
      sizeBytes: MAX_FILE_SIZE_BYTES + 1,
    });

    expect(result.success).toBe(true);
  });

  it("still holds a non-media file to the document ceiling", () => {
    // A PDF must not borrow the media allowance.
    const result = createAttachmentValidator.safeParse({
      filename: "big.pdf",
      mimeType: "application/pdf",
      sizeBytes: MAX_FILE_SIZE_BYTES + 1,
    });

    expect(result.success).toBe(false);
  });

  it("caps media at the media ceiling", () => {
    const result = createAttachmentValidator.safeParse({
      ...base,
      mimeType: "video/quicktime",
      sizeBytes: MAX_MEDIA_FILE_SIZE_BYTES + 1,
    });

    expect(result.success).toBe(false);
  });

  it("keeps inline attachments images-only", () => {
    // Video is Context purpose. Widening IMAGE_MIME_TYPES to accept media inline
    // would put unplayable bytes in the inline image path.
    const result = createAttachmentValidator.safeParse({
      ...base,
      mimeType: "video/quicktime",
      purpose: "inline",
    });

    expect(result.success).toBe(false);
  });

  it("exposes every media type through the base allow-list", () => {
    for (const mimeType of MEDIA_MIME_TYPES) {
      expect(ALLOWED_MIME_TYPES).toContain(mimeType);
    }
  });
});
