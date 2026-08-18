import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AttachmentPurpose,
  buildInlineAttachmentRef,
  IMAGE_MIME_TYPES,
  type ImageMimeType,
  INLINE_ATTACHMENT_REF_PREFIX,
  MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS,
} from "@repo/api/src/types/attachment.js";
import {
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_ALT_TEXT_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_FILENAME_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_PLACEHOLDER_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGES,
} from "@repo/api/src/types/document-version.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  describeIdOrSlug,
  encodePathSegment,
  type McpUrlBuilder,
  readNumber,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

type CreateDocumentVersionOutput = Record<string, unknown> & {
  id?: string;
  organizationId?: string;
  projectId?: string | null;
  slug?: string;
  title?: string;
  type?: string;
  status?: string;
  priority?: string;
  latestVersion?: number;
  fileName?: string | null;
  createdById?: string;
  createdBy?: unknown;
  assigneeId?: string | null;
  assignee?: unknown;
  approverId?: string | null;
  approver?: unknown;
  repositorySnapshot?: unknown;
  templateForType?: string | null;
  sortOrder?: number | null;
  createdAt?: string;
  updatedAt?: string;
  project?: unknown;
  generationStatus?: unknown;
  customFields?: unknown[];
  tags?: unknown[];
  latestVersionContent?: string | null;
  webUrl: string | null;
  versionContent?: string;
  version?: DocumentVersionOutput;
  inlineImages?: CreatedInlineImageOutput[];
};

type DocumentVersionOutput = {
  id?: string;
  documentId?: string;
  version?: number;
  content?: string | null;
  createdById?: string | null;
  createdAt?: string | null;
};

type CreatedInlineImageOutput = {
  placeholder: string;
  attachmentId: string;
  attachmentRef: string;
  markdownImage: string;
  attachment: InlineImageAttachmentMetadata;
};

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

const createdInlineImageOutputSchema = z.object({
  placeholder: z.string(),
  attachmentId: z.string(),
  attachmentRef: z
    .string()
    .startsWith(INLINE_ATTACHMENT_REF_PREFIX)
    .describe("Attachment reference using the attachment:// scheme"),
  markdownImage: z.string(),
  attachment: inlineImageAttachmentMetadataOutputSchema,
});

const documentVersionOutputSchema = z.object({
  id: z.string().optional(),
  documentId: z.string().optional(),
  version: z.number().int().optional(),
  content: z.string().nullable().optional(),
  createdById: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
});

export function registerCreateDocumentVersion(
  server: McpServer,
  apiClient: ApiClient,
  urls: McpUrlBuilder
): void {
  server.registerTool(
    "create-document-version",
    {
      description:
        "Append a new version to a document by UUID or slug (PRD-*, PLN-*, FEA-*). Older versions stay in history. Pass the user's slug verbatim.",
      inputSchema: {
        documentId: z
          .string()
          .describe(
            describeIdOrSlug("Document", ["PRD-7", "PLN-12", "FEA-42"])
          ),
        content: z.string().describe("Full content for the new version"),
        inlineImages: z
          .array(
            z.object({
              placeholder: z
                .string()
                .min(1)
                .max(MAX_DOCUMENT_VERSION_INLINE_IMAGE_PLACEHOLDER_CHARS)
                .describe(
                  "Exact marker text in content to replace with the created Markdown image ref"
                ),
              filename: z
                .string()
                .min(1)
                .max(MAX_DOCUMENT_VERSION_INLINE_IMAGE_FILENAME_CHARS)
                .describe("Image filename to store"),
              mimeType: z
                .enum(IMAGE_MIME_TYPES)
                .describe("Image MIME type for the provided base64 bytes"),
              dataBase64: z
                .string()
                .min(1)
                .max(MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS)
                .describe(
                  "Raw base64-encoded image bytes without a data URL prefix"
                ),
              altText: z
                .string()
                .max(MAX_DOCUMENT_VERSION_INLINE_IMAGE_ALT_TEXT_CHARS)
                .optional()
                .describe("Optional Markdown alt text for the generated image"),
            })
          )
          .max(MAX_DOCUMENT_VERSION_INLINE_IMAGES)
          .optional()
          .describe(
            "Optional inline images to create in the same call. Each unique placeholder must appear in content and will be rewritten to ![alt](attachment://<created-id>)."
          ),
      },
      outputSchema: {
        id: z.string().optional(),
        organizationId: z.string().optional(),
        projectId: z.string().nullable().optional(),
        slug: z.string().optional(),
        title: z.string().optional(),
        type: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        latestVersion: z.number().int().optional(),
        fileName: z.string().nullable().optional(),
        createdById: z.string().optional(),
        createdBy: z.unknown().nullable().optional(),
        assigneeId: z.string().nullable().optional(),
        assignee: z.unknown().nullable().optional(),
        approverId: z.string().nullable().optional(),
        approver: z.unknown().nullable().optional(),
        repositorySnapshot: z.unknown().optional(),
        templateForType: z.string().nullable().optional(),
        sortOrder: z.number().nullable().optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
        project: z.unknown().nullable().optional(),
        generationStatus: z.unknown().optional(),
        customFields: z.array(z.unknown()).optional(),
        tags: z.array(z.unknown()).optional(),
        latestVersionContent: z.string().nullable().optional(),
        webUrl: z.string().nullable(),
        versionContent: z.string().optional(),
        version: documentVersionOutputSchema.optional(),
        inlineImages: z.array(createdInlineImageOutputSchema).optional(),
      },
    },
    ({ documentId, content, inlineImages }) =>
      withErrorHandling(async () => {
        const body =
          inlineImages && inlineImages.length > 0
            ? { content, inlineImages }
            : { content };
        const result = await apiClient.post<unknown>(
          `/documents/${encodePathSegment(documentId)}/versions`,
          body
        );
        const payload = shapeCreateDocumentVersionOutput(result, urls);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(payload, null, 2),
            },
          ],
          structuredContent: payload,
        };
      })
  );
}

function shapeCreateDocumentVersionOutput(
  result: unknown,
  urls: McpUrlBuilder
): CreateDocumentVersionOutput {
  const row = asRecord(result);
  const webUrl = urls.buildDocumentUrlFromRecord(row);
  const versionContent =
    readString(row.versionContent) ?? readString(row.latestVersionContent);
  const latestVersionContent = readNullableString(row.latestVersionContent);
  const version = shapeDocumentVersion(row.version);
  const inlineImages = shapeCreatedInlineImages(row.inlineImages);
  return {
    ...readOptionalStringProp("id", row.id),
    ...readOptionalStringProp("organizationId", row.organizationId),
    ...readNullableStringProp("projectId", row.projectId),
    ...readOptionalStringProp("slug", row.slug),
    ...readOptionalStringProp("title", row.title),
    ...readOptionalStringProp("type", row.type),
    ...readOptionalStringProp("status", row.status),
    ...readOptionalStringProp("priority", row.priority),
    ...readOptionalNumberProp("latestVersion", row.latestVersion),
    ...readNullableStringProp("fileName", row.fileName),
    ...readOptionalStringProp("createdById", row.createdById),
    ...readOptionalUnknownProp("createdBy", row.createdBy),
    ...readNullableStringProp("assigneeId", row.assigneeId),
    ...readOptionalUnknownProp("assignee", row.assignee),
    ...readNullableStringProp("approverId", row.approverId),
    ...readOptionalUnknownProp("approver", row.approver),
    ...readOptionalUnknownProp("repositorySnapshot", row.repositorySnapshot),
    ...readNullableStringProp("templateForType", row.templateForType),
    ...readNullableNumberProp("sortOrder", row.sortOrder),
    ...readOptionalStringProp("createdAt", row.createdAt),
    ...readOptionalStringProp("updatedAt", row.updatedAt),
    ...readOptionalUnknownProp("project", row.project),
    ...readOptionalUnknownProp("generationStatus", row.generationStatus),
    ...readOptionalUnknownArrayProp("customFields", row.customFields),
    ...readOptionalUnknownArrayProp("tags", row.tags),
    ...(latestVersionContent === undefined ? {} : { latestVersionContent }),
    webUrl,
    ...(versionContent === null ? {} : { versionContent }),
    ...(version === undefined ? {} : { version }),
    ...(inlineImages === undefined ? {} : { inlineImages }),
  };
}

function shapeDocumentVersion(
  value: unknown
): DocumentVersionOutput | undefined {
  const row = asRecord(value);
  if (Object.keys(row).length === 0) {
    return undefined;
  }
  const content = readNullableString(row.content);
  const createdById = readNullableString(row.createdById);
  const createdAt = readNullableString(row.createdAt);
  return {
    ...readOptionalStringProp("id", row.id),
    ...readOptionalStringProp("documentId", row.documentId),
    ...readOptionalNumberProp("version", row.version),
    ...(content === undefined ? {} : { content }),
    ...(createdById === undefined ? {} : { createdById }),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

function shapeCreatedInlineImages(
  value: unknown
): CreatedInlineImageOutput[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => {
    const row = asRecord(item);
    const attachment = shapeInlineImageAttachmentMetadata(row.attachment);
    const attachmentId =
      readString(row.attachmentId) ?? readString(attachment.id) ?? "";
    return {
      placeholder: readString(row.placeholder) ?? "",
      attachmentId,
      attachmentRef: resolveAttachmentRef(row.attachmentRef, attachmentId),
      markdownImage: readString(row.markdownImage) ?? "",
      attachment,
    };
  });
}

function shapeInlineImageAttachmentMetadata(
  value: unknown
): InlineImageAttachmentMetadata {
  const row = asRecord(value);
  const mimeType = readImageMimeType(row.mimeType) ?? "image/png";
  const previewUrl = readString(row.previewUrl);
  return {
    id: readString(row.id) ?? "",
    artifactId: readString(row.artifactId),
    filename: readString(row.filename) ?? "",
    mimeType,
    sizeBytes: readNumber(row.sizeBytes),
    purpose: readAttachmentPurpose(row.purpose),
    createdAt: readString(row.createdAt),
    createdById: readString(row.createdById),
    ...(previewUrl === null ? {} : { previewUrl }),
  };
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

function resolveAttachmentRef(value: unknown, attachmentId: string): string {
  const attachmentRef = readString(value);
  if (attachmentRef?.startsWith(INLINE_ATTACHMENT_REF_PREFIX)) {
    return attachmentRef;
  }
  return buildInlineAttachmentRef(attachmentId);
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

function readOptionalStringProp(
  key: string,
  value: unknown
): Record<string, string> {
  const parsed = readString(value);
  return parsed === null ? {} : { [key]: parsed };
}

function readOptionalNumberProp(
  key: string,
  value: unknown
): Record<string, number> {
  const parsed = readNumber(value);
  return parsed === null ? {} : { [key]: parsed };
}

function readNullableStringProp(
  key: string,
  value: unknown
): Record<string, string | null> {
  if (value === null) {
    return { [key]: null };
  }
  return readOptionalStringProp(key, value);
}

function readNullableNumberProp(
  key: string,
  value: unknown
): Record<string, number | null> {
  if (value === null) {
    return { [key]: null };
  }
  return readOptionalNumberProp(key, value);
}

function readOptionalUnknownProp(
  key: string,
  value: unknown
): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}

function readOptionalUnknownArrayProp(
  key: string,
  value: unknown
): Record<string, unknown[]> {
  return Array.isArray(value) ? { [key]: value } : {};
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return readString(value) ?? undefined;
}
