import { CreateInlineImageAttachmentErrorCode } from "@repo/api/src/types/attachment";
import { CreateDocumentErrorCode } from "@repo/api/src/types/document";
import { Status } from "@repo/api/src/types/result";
import { describe, expect, it } from "vitest";
import type { SourceLinkedPlanCreateError } from "@/app/documents/source-linked-plan-service";
import {
  mapCreateDocumentFailure,
  mapSourceLinkedPlanCreateFailure,
} from "./create-document-route-helpers";

async function jsonOf(response: Response) {
  return await response.json();
}

describe("mapCreateDocumentFailure — switch coverage", () => {
  it("maps DocumentCreateFailed to a 400 carrying the code", async () => {
    const response = mapCreateDocumentFailure({
      code: CreateDocumentErrorCode.DocumentCreateFailed,
    });

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toMatchObject({
      code: CreateDocumentErrorCode.DocumentCreateFailed,
      // The message pins THIS case, not a neighboring one: a switch that fell
      // through from this case into the next would keep the same status and
      // code (both come from `error`, unaffected by fallthrough) and differ
      // only in which message string got used.
      error: "Failed to create document",
      success: false,
    });
  });

  it("maps DuplicateInlineImagePlaceholder to a 400 naming the placeholder", async () => {
    const response = mapCreateDocumentFailure({
      code: CreateDocumentErrorCode.DuplicateInlineImagePlaceholder,
      placeholder: "[[diagram]]",
    });

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toMatchObject({
      code: CreateDocumentErrorCode.DuplicateInlineImagePlaceholder,
      details: { placeholder: "[[diagram]]" },
      error: "Inline image placeholders must be unique",
      success: false,
    });
  });

  it("maps MissingInlineImagePlaceholder to a 400", async () => {
    const response = mapCreateDocumentFailure({
      code: CreateDocumentErrorCode.MissingInlineImagePlaceholder,
      placeholder: "[[diagram]]",
    });

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toMatchObject({
      code: CreateDocumentErrorCode.MissingInlineImagePlaceholder,
      error: "Inline image placeholder must appear in content",
      success: false,
    });
  });

  it("maps OverlappingInlineImagePlaceholder to a 400", async () => {
    const response = mapCreateDocumentFailure({
      code: CreateDocumentErrorCode.OverlappingInlineImagePlaceholder,
      placeholder: "[[diagram]]",
    });

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toMatchObject({
      code: CreateDocumentErrorCode.OverlappingInlineImagePlaceholder,
      success: false,
    });
  });

  it("maps ExpandedContentTooLarge to a 413 carrying both size fields", async () => {
    const response = mapCreateDocumentFailure({
      code: CreateDocumentErrorCode.ExpandedContentTooLarge,
      estimatedContentChars: 2_000_000,
      maxContentChars: 1_048_576,
    });

    expect(response.status).toBe(413);
    expect(await jsonOf(response)).toMatchObject({
      code: CreateDocumentErrorCode.ExpandedContentTooLarge,
      details: {
        estimatedContentChars: 2_000_000,
        maxContentChars: 1_048_576,
      },
      success: false,
    });
  });

  it("omits estimatedContentChars and maxContentChars from other error details when absent", async () => {
    const response = mapCreateDocumentFailure({
      code: CreateDocumentErrorCode.DocumentCreateFailed,
    });

    const json = await jsonOf(response);
    expect(json.details).not.toHaveProperty("estimatedContentChars");
    expect(json.details).not.toHaveProperty("maxContentChars");
  });

  it("maps InlineImageCreationFailed with no inner error to a generic 500", async () => {
    const response = mapCreateDocumentFailure({
      code: CreateDocumentErrorCode.InlineImageCreationFailed,
      placeholder: "[[diagram]]",
    });

    expect(response.status).toBe(500);
    expect(await jsonOf(response)).toMatchObject({
      code: CreateDocumentErrorCode.InlineImageCreationFailed,
      success: false,
    });
  });

  it("maps InlineImageCreationFailed with an inner error through the attachment error contract", async () => {
    const response = mapCreateDocumentFailure({
      code: CreateDocumentErrorCode.InlineImageCreationFailed,
      inlineImageError: {
        code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
      },
    });

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toMatchObject({
      code: CreateInlineImageAttachmentErrorCode.InvalidBase64,
      success: false,
    });
  });

  it("maps VersionContentUpdateFailed to a 500", async () => {
    const response = mapCreateDocumentFailure({
      code: CreateDocumentErrorCode.VersionContentUpdateFailed,
    });

    expect(response.status).toBe(500);
    expect(await jsonOf(response)).toMatchObject({
      code: CreateDocumentErrorCode.VersionContentUpdateFailed,
      success: false,
    });
  });
});

describe("mapSourceLinkedPlanCreateFailure — switch coverage", () => {
  it("maps a 400 code to a bad-request response carrying the service message", async () => {
    const error: SourceLinkedPlanCreateError = {
      code: Status.BadRequest,
      message: "sourceId must be a document artifact",
    };

    const response = mapSourceLinkedPlanCreateFailure(error);

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toMatchObject({
      error: "sourceId must be a document artifact",
      success: false,
    });
  });

  it("maps a 404 code to a not-found response carrying the service message", async () => {
    const error: SourceLinkedPlanCreateError = {
      code: Status.NotFound,
      message: "Source artifact not found",
    };

    const response = mapSourceLinkedPlanCreateFailure(error);

    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toMatchObject({
      error: "Source artifact not found",
      success: false,
    });
  });
});
