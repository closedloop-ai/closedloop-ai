import { describe, expect, it } from "vitest";
import {
  CONTEXT_ATTACHMENT_MAX_SIZE_BYTES,
  CONTEXT_ATTACHMENT_MIME_TYPES,
  createContextAttachmentValidator,
  importGDriveContextValidator,
} from "@/app/documents/[id]/context-attachments/validators";

// ---------------------------------------------------------------------------
// createContextAttachmentValidator
// ---------------------------------------------------------------------------

describe("createContextAttachmentValidator", () => {
  const validInput = {
    filename: "design.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
  };

  it("accepts a minimal valid payload without projectId", () => {
    const result = createContextAttachmentValidator.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("accepts a valid payload with optional projectId", () => {
    const result = createContextAttachmentValidator.safeParse({
      ...validInput,
      projectId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("accepts each CONTEXT_ATTACHMENT_MIME_TYPE value", () => {
    for (const mimeType of CONTEXT_ATTACHMENT_MIME_TYPES) {
      const result = createContextAttachmentValidator.safeParse({
        ...validInput,
        mimeType,
      });
      expect(result.success, `expected ${mimeType} to be accepted`).toBe(true);
    }
  });

  it("accepts a video mime type not present in base ALLOWED_MIME_TYPES", () => {
    const result = createContextAttachmentValidator.safeParse({
      ...validInput,
      mimeType: "video/mp4",
    });
    expect(result.success).toBe(true);
  });

  it("accepts file at the maximum allowed size", () => {
    const result = createContextAttachmentValidator.safeParse({
      ...validInput,
      sizeBytes: CONTEXT_ATTACHMENT_MAX_SIZE_BYTES,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty filename", () => {
    const result = createContextAttachmentValidator.safeParse({
      ...validInput,
      filename: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a disallowed mime type", () => {
    const result = createContextAttachmentValidator.safeParse({
      ...validInput,
      mimeType: "application/x-executable",
    });
    expect(result.success).toBe(false);
  });

  it("rejects sizeBytes exceeding the maximum", () => {
    const result = createContextAttachmentValidator.safeParse({
      ...validInput,
      sizeBytes: CONTEXT_ATTACHMENT_MAX_SIZE_BYTES + 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer sizeBytes", () => {
    const result = createContextAttachmentValidator.safeParse({
      ...validInput,
      sizeBytes: 1024.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero sizeBytes", () => {
    const result = createContextAttachmentValidator.safeParse({
      ...validInput,
      sizeBytes: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID projectId", () => {
    const result = createContextAttachmentValidator.safeParse({
      ...validInput,
      projectId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// importGDriveContextValidator
// ---------------------------------------------------------------------------

describe("importGDriveContextValidator", () => {
  const validInput = {
    docIds: ["doc-abc123", "doc-def456"],
    projectId: "550e8400-e29b-41d4-a716-446655440000",
  };

  it("accepts a valid payload with multiple docIds", () => {
    const result = importGDriveContextValidator.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("accepts a valid payload with a single docId", () => {
    const result = importGDriveContextValidator.safeParse({
      ...validInput,
      docIds: ["single-doc"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty docIds array", () => {
    const result = importGDriveContextValidator.safeParse({
      ...validInput,
      docIds: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a docIds array containing an empty string", () => {
    const result = importGDriveContextValidator.safeParse({
      ...validInput,
      docIds: [""],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID projectId", () => {
    const result = importGDriveContextValidator.safeParse({
      ...validInput,
      projectId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing projectId", () => {
    const { projectId: _projectId, ...withoutProject } = validInput;
    const result = importGDriveContextValidator.safeParse(withoutProject);
    expect(result.success).toBe(false);
  });

  it("rejects a missing docIds field", () => {
    const { docIds: _docIds, ...withoutDocIds } = validInput;
    const result = importGDriveContextValidator.safeParse(withoutDocIds);
    expect(result.success).toBe(false);
  });
});
