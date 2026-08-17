import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AttachmentPurpose,
  buildInlineAttachmentMarkdownImage,
  buildInlineAttachmentRef,
  IMAGE_MIME_TYPES,
  type ImageMimeType,
  INLINE_ATTACHMENT_REF_PREFIX,
  MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS,
} from "@repo/api/src/types/attachment.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  describeIdOrSlug,
  encodePathSegment,
  readNumber,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

type InlineImageAttachmentMetadata = {
  id: string;
  artifactId: string | null;
  filename: string;
  mimeType: ImageMimeType;
  sizeBytes: number | null;
  purpose: AttachmentPurpose | null;
  createdAt: string | null;
  createdById: string | null;
  previewUrl?: string;
};

type InlineImageAttachmentOutput = {
  attachmentId: string;
  attachmentRef: string;
  markdownImage: string;
  attachment: InlineImageAttachmentMetadata;
};

type InlineImageAttachmentInputMetadata = {
  altText: string | undefined;
  filename: string;
  mimeType: ImageMimeType;
};

const inlineImageAttachmentMetadataOutputSchema = z.object({
  id: z.string(),
  artifactId: z.string().nullable(),
  filename: z.string(),
  mimeType: z.enum(IMAGE_MIME_TYPES),
  sizeBytes: z.number().int().nonnegative().nullable(),
  purpose: z
    .enum([AttachmentPurpose.Context, AttachmentPurpose.Inline])
    .nullable(),
  createdAt: z.string().nullable(),
  createdById: z.string().nullable(),
  previewUrl: z.string().optional(),
});

const inlineImageAttachmentOutputSchema = {
  attachmentId: z.string(),
  attachmentRef: z
    .string()
    .startsWith(INLINE_ATTACHMENT_REF_PREFIX)
    .describe("Attachment reference using the attachment:// scheme"),
  markdownImage: z.string(),
  attachment: inlineImageAttachmentMetadataOutputSchema,
};

/**
 * Register a one-call inline image attachment tool for existing documents.
 * The API stores the provided bytes and returns an attachment:// reference that
 * agents can insert into Markdown without handling S3 storage details.
 */
export function registerCreateInlineImageAttachment(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-inline-image-attachment",
    {
      description:
        "Create an inline image attachment for an existing document from base64 image bytes. Returns an attachment:// ref and Markdown image snippet; never returns the submitted bytes or storage key. Pass the user's document slug verbatim for entityId.",
      inputSchema: {
        entityId: z
          .string()
          .describe(
            describeIdOrSlug("Document", ["PRD-7", "PLN-12", "FEA-42"])
          ),
        filename: z.string().min(1).describe("Image filename to store"),
        mimeType: z
          .enum(IMAGE_MIME_TYPES)
          .describe("Image MIME type for the provided base64 bytes"),
        dataBase64: z
          .string()
          .min(1)
          .max(MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS)
          .describe("Raw base64-encoded image bytes without a data URL prefix"),
        altText: z
          .string()
          .optional()
          .describe(
            "Optional Markdown alt text for the returned image snippet"
          ),
      },
      outputSchema: inlineImageAttachmentOutputSchema,
    },
    ({ altText, dataBase64, entityId, filename, mimeType }) =>
      withErrorHandling(async () => {
        const path = `/documents/${encodePathSegment(entityId)}/attachments/images`;
        const result = await apiClient.post<unknown>(path, {
          filename,
          mimeType,
          dataBase64,
        });
        const payload = shapeInlineImageAttachmentOutput(result, {
          altText,
          filename,
          mimeType,
        });
        const text = JSON.stringify(payload, null, 2);
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: payload,
        };
      })
  );
}

function shapeInlineImageAttachmentOutput(
  result: unknown,
  input: InlineImageAttachmentInputMetadata
): InlineImageAttachmentOutput {
  const resultRecord = asRecord(result);
  const attachmentRecord = asRecord(resultRecord.attachment);
  const attachmentId = readRequiredString(
    resultRecord.attachmentId ?? attachmentRecord.id,
    "attachmentId"
  );
  const attachmentRef = resolveAttachmentRef(
    resultRecord.attachmentRef,
    attachmentId
  );
  const filename = readString(attachmentRecord.filename) ?? input.filename;
  const mimeType =
    readImageMimeType(attachmentRecord.mimeType) ?? input.mimeType;
  const previewUrl = readString(attachmentRecord.previewUrl);
  const attachment: InlineImageAttachmentMetadata = {
    id: readString(attachmentRecord.id) ?? attachmentId,
    artifactId: readString(attachmentRecord.artifactId),
    filename,
    mimeType,
    sizeBytes: readNumber(attachmentRecord.sizeBytes),
    purpose: readAttachmentPurpose(attachmentRecord.purpose),
    createdAt: readString(attachmentRecord.createdAt),
    createdById: readString(attachmentRecord.createdById),
    ...(previewUrl === null ? {} : { previewUrl }),
  };
  return {
    attachmentId,
    attachmentRef,
    markdownImage: buildInlineAttachmentMarkdownImage(
      attachmentRef,
      input.altText,
      filename
    ),
    attachment,
  };
}

function resolveAttachmentRef(
  value: unknown,
  attachmentId: string
): `${typeof INLINE_ATTACHMENT_REF_PREFIX}${string}` {
  const attachmentRef = readString(value);
  if (attachmentRef?.startsWith(INLINE_ATTACHMENT_REF_PREFIX)) {
    return attachmentRef as `${typeof INLINE_ATTACHMENT_REF_PREFIX}${string}`;
  }
  return buildInlineAttachmentRef(attachmentId);
}

function readRequiredString(value: unknown, fieldName: string): string {
  const parsed = readString(value);
  if (parsed === null) {
    throw new Error(`API response missing ${fieldName}`);
  }
  return parsed;
}

function readImageMimeType(value: unknown): ImageMimeType | null {
  const mimeType = readString(value);
  if (mimeType !== null && isSupportedImageMimeType(mimeType)) {
    return mimeType;
  }
  return null;
}

function isSupportedImageMimeType(mimeType: string): mimeType is ImageMimeType {
  return IMAGE_MIME_TYPES.some((imageMimeType) => imageMimeType === mimeType);
}

function readAttachmentPurpose(value: unknown): AttachmentPurpose | null {
  const purpose = readString(value);
  if (
    purpose === AttachmentPurpose.Context ||
    purpose === AttachmentPurpose.Inline
  ) {
    return purpose;
  }
  return AttachmentPurpose.Inline;
}
