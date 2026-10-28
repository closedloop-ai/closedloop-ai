/**
 * Branch coverage for `mapCreateInlineImageAttachmentFailure` — the HTTP
 * translation for every `CreateInlineImageAttachmentError` the inline-image
 * create flow can return. Each case's optional-detail branches (additional
 * details present/absent, byte counters present/absent, unmapped code
 * fallback) are exercised individually against the real response shape.
 */

import { CreateInlineImageAttachmentErrorCode } from "@repo/api/src/types/attachment";
import { describe, expect, it } from "vitest";
import { mapCreateInlineImageAttachmentFailure } from "../attachment-route-responses";
import type { CreateInlineImageAttachmentError } from "../inline-image-attachment-contract";

describe("mapCreateInlineImageAttachmentFailure", () => {
  it("returns a 404 with code and details when additionalDetails is supplied for DocumentNotFound", async () => {
    const response = mapCreateInlineImageAttachmentFailure(
      { code: CreateInlineImageAttachmentErrorCode.DocumentNotFound },
      { attemptedDocumentId: "doc-1" }
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({
      success: false,
      error: "Document not found",
      code: CreateInlineImageAttachmentErrorCode.DocumentNotFound,
      details: { attemptedDocumentId: "doc-1" },
    });
  });

  it("returns a 404 with no code or details when additionalDetails is omitted for DocumentNotFound", async () => {
    const response = mapCreateInlineImageAttachmentFailure({
      code: CreateInlineImageAttachmentErrorCode.DocumentNotFound,
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ success: false, error: "Document not found" });
    expect(body).not.toHaveProperty("code");
    expect(body).not.toHaveProperty("details");
  });

  it("defaults retryAfterSeconds to 1 when the RateLimited error carries none", async () => {
    const response = mapCreateInlineImageAttachmentFailure({
      code: CreateInlineImageAttachmentErrorCode.RateLimited,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");
    const body = await response.json();
    expect(body.details).toEqual({ retryAfterSeconds: 1 });
  });

  it("omits actualBytes and maxBytes from PayloadTooLarge details when both are undefined", async () => {
    const response = mapCreateInlineImageAttachmentFailure({
      code: CreateInlineImageAttachmentErrorCode.PayloadTooLarge,
    });

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.details).toEqual({});
  });

  it("merges PayloadTooLarge byte counters with additionalDetails", async () => {
    const response = mapCreateInlineImageAttachmentFailure(
      {
        code: CreateInlineImageAttachmentErrorCode.PayloadTooLarge,
        actualBytes: 100,
        maxBytes: 200,
      },
      { placeholder: "img-1" }
    );

    const body = await response.json();
    expect(body.details).toEqual({
      actualBytes: 100,
      maxBytes: 200,
      placeholder: "img-1",
    });
  });

  it("returns the MIME-mismatch message for MimeMismatch", async () => {
    const response = mapCreateInlineImageAttachmentFailure({
      code: CreateInlineImageAttachmentErrorCode.MimeMismatch,
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe(
      "Inline image bytes do not match the declared MIME type"
    );
  });

  it("returns the unsupported-MIME-type message for UnsupportedMimeType", async () => {
    const response = mapCreateInlineImageAttachmentFailure({
      code: CreateInlineImageAttachmentErrorCode.UnsupportedMimeType,
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Inline image MIME type is not supported");
  });

  it("includes details on a 503 StorageUnconfigured response when additionalDetails is supplied", async () => {
    const response = mapCreateInlineImageAttachmentFailure(
      { code: CreateInlineImageAttachmentErrorCode.StorageUnconfigured },
      { bucket: "attachments" }
    );

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.details).toEqual({ bucket: "attachments" });
  });

  it("includes details on a 502 StorageWriteFailed response when additionalDetails is supplied", async () => {
    const response = mapCreateInlineImageAttachmentFailure(
      { code: CreateInlineImageAttachmentErrorCode.StorageWriteFailed },
      { attempt: 2 }
    );

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.details).toEqual({ attempt: 2 });
  });

  it("includes details on a 500 PersistenceFailed response when additionalDetails is supplied", async () => {
    const response = mapCreateInlineImageAttachmentFailure(
      { code: CreateInlineImageAttachmentErrorCode.PersistenceFailed },
      { documentId: "doc-2" }
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.details).toEqual({ documentId: "doc-2" });
  });

  it("falls back to a generic 400 message with details for an unmapped error code", async () => {
    // pins current behavior: the switch's `default:` arm is unreachable
    // through the closed `CreateInlineImageAttachmentErrorCode` union today,
    // but it exists as a defensive fallback for a future/version-skewed code
    // this module doesn't know about yet — hence the cast.
    const unknownError = {
      code: "unmapped_inline_image_error",
    } as unknown as CreateInlineImageAttachmentError;

    const response = mapCreateInlineImageAttachmentFailure(unknownError, {
      raw: "unmapped_inline_image_error",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({
      success: false,
      error: "Invalid inline image attachment",
      code: "unmapped_inline_image_error",
      details: { raw: "unmapped_inline_image_error" },
    });
  });

  it("falls back to a generic 400 message with no details for an unmapped error code without additionalDetails", async () => {
    const unknownError = {
      code: "another_unmapped_code",
    } as unknown as CreateInlineImageAttachmentError;

    const response = mapCreateInlineImageAttachmentFailure(unknownError);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({
      success: false,
      error: "Invalid inline image attachment",
      code: "another_unmapped_code",
    });
    expect(body).not.toHaveProperty("details");
  });
});
