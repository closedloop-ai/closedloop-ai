import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildInlineAttachmentRef,
  IMAGE_MIME_TYPES,
  INLINE_ATTACHMENT_REF_PREFIX,
  MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS,
} from "@repo/api/src/types/attachment.js";
import { Priority } from "@repo/api/src/types/common.js";
import {
  type CreateDocumentRequestBody,
  type CreateDocumentResponse,
  DocumentStatus,
  DocumentType,
  DocumentTypeAlias,
  IssueStatus,
  isProjectOptionalDocumentType,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS,
  MAX_CREATE_DOCUMENT_INLINE_IMAGES,
  normalizeDocumentType,
  RepositoryRole,
  SnapshotSource,
  snapshotSourceSchema,
} from "@repo/api/src/types/document.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { operationReceiptOutputShape } from "../tool-call-receipts.js";
import {
  asRecord,
  DOCUMENT_DOC_HELP,
  idOrSlugRequiredMessage,
  type McpUrlBuilder,
  readNumber,
  readString,
  requiredIdOrSlug,
  withErrorHandling,
} from "./tool-utils.js";

type CreateDocumentOutput = {
  id?: string;
  organizationId?: string;
  projectId?: string | null;
  slug?: string;
  title?: string;
  type?: string;
  status?: string;
  priority?: string;
  dueDate?: string | null;
  latestVersion?: number;
  fileName?: string | null;
  createdById?: string;
  createdBy?: BasicUserOutput | null;
  assigneeId?: string | null;
  assignee?: BasicUserOutput | null;
  approverId?: string | null;
  approver?: BasicUserOutput | null;
  repositorySnapshot?: RepositorySnapshotOutput;
  templateForType?: string | null;
  sortOrder?: number | null;
  createdAt?: string;
  updatedAt?: string;
  webUrl: string | null;
  versionContent?: string;
  inlineImages?: CreatedDocumentInlineImageOutput[];
};

type BasicUserOutput = {
  id?: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
};

type RepositorySnapshotOutput = {
  repositories: RepositorySnapshotEntryOutput[];
  source?: SnapshotSource;
  createdAt?: string;
};

type RepositorySnapshotEntryOutput = {
  fullName: string;
  role?: RepositoryRole;
  position?: number;
  branch?: string | null;
};

type CreatedDocumentInlineImageOutput = {
  placeholder: string;
  attachmentId: string;
  attachmentRef: string;
  markdownImage: string;
};

type CreateDocumentToolInput = {
  title: string;
  // Post-normalization persisted type (ISS-4397): `createDocumentTypeInputSchema`
  // transforms `ISSUE` to `FEATURE` before this handler runs, so TEMPLATE and the
  // alias never reach it.
  type: CreatableDocumentType;
  // Required for project-bound types and optional for DOC. A raw-shape schema
  // cannot express that, so the handler enforces the requirement.
  projectId?: string;
  content: string;
  assigneeId?: string | null;
  approverId?: string | null;
  priority?: Priority;
  dueDate?: string | null;
  fileName?: string;
  status?: CreateDocumentRequestBody["status"];
  repositorySelection?: CreateDocumentRequestBody["repositorySelection"];
  inlineImages?: CreateDocumentRequestBody["inlineImages"];
};

type CreateDocumentMcpRequestBody = Omit<
  CreateDocumentRequestBody,
  "dueDate"
> & {
  dueDate?: string | null;
};

const basicUserOutputSchema = z.object({
  id: z.string().optional(),
  email: z.string().nullable().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
});

const repositorySnapshotEntryOutputSchema = z.object({
  fullName: z.string(),
  role: z.enum(RepositoryRole).optional(),
  position: z.number().int().nonnegative().optional(),
  branch: z.string().nullable().optional(),
});

const repositorySnapshotOutputSchema = z.object({
  repositories: z.array(repositorySnapshotEntryOutputSchema),
  source: z.enum(SnapshotSource).optional(),
  createdAt: z.string().optional(),
});

const createdDocumentInlineImageOutputSchema = z.object({
  placeholder: z.string().min(1),
  attachmentId: z.string().min(1),
  attachmentRef: z
    .string()
    .startsWith(INLINE_ATTACHMENT_REF_PREFIX)
    .min(INLINE_ATTACHMENT_REF_PREFIX.length + 1)
    .describe("Attachment reference using the attachment:// scheme"),
  markdownImage: z.string().min(1),
});

const JSON_INLINE_IMAGE_SECRET_FIELD_REGEX =
  /"(?:dataBase64|storageKey|key|previewUrl|downloadUrl|uploadUrl)"\s*:\s*"[^"]+"/g;
const INLINE_IMAGE_SECRET_LABEL_TEXT_REGEX =
  /\b(?:dataBase64|storageKey|previewUrl|downloadUrl|uploadUrl)\b["'\s:=]+[^\s,}]+/g;
const ATTACHMENT_STORAGE_KEY_TEXT_REGEX =
  /attachments\/[A-Za-z0-9._~:/#[\]@!$&'()*+,;=%-]+/g;
const PRESIGNED_URL_TEXT_REGEX =
  /https?:\/\/\S*(?:X-Amz-Signature|AWSAccessKeyId|Signature=|s3[.-])\S*/gi;
const MARKDOWN_IMAGE_DESTINATION_REGEX =
  /!\[(?:\\.|[^\]\\])*]\((?<destination>[^)\s]+)(?:\s+"[^"]*")?\)/;

const dueDateInput = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .nullable()
  .optional();

/**
 * Register the create-document tool on the given MCP server.
 * Calls POST /documents to create a new document.
 */
export function registerCreateDocument(
  server: McpServer,
  apiClient: ApiClient,
  urls: McpUrlBuilder
): void {
  server.registerTool(
    "create-document",
    {
      description:
        "Create a document — a PRD, implementation plan, or issue (ISS-*; `ISSUE`≡`FEATURE`, the legacy alias) attached to a project, or an organization-level document (`type: DOC`, DOC-*), which needs no projectId. Templates are not creatable through this tool. The assigned slug (PRD-*, PLN-*, ISS-*, DOC-*; legacy FEA-* slugs still resolve) is returned in the response and is the preferred handle for future calls.\n\nEditable fields (assignee, approver, priority, dueDate, fileName, status, repositorySelection) can be set at creation in the same operation. Issues/features default to TRIAGE when status is omitted; other types default to DRAFT. Repository context is captured as a server-owned snapshot at creation; callers cannot edit it afterwards, though the server corrects a snapshot it only ever guessed once a branch resolves the real repository.",
      inputSchema: {
        title: z.string().describe("Title of the document"),
        // ISS-4397: accepts `ISSUE` in addition to the canonical types;
        // `ISSUE` normalizes to `FEATURE` before the create body is built.
        type: createDocumentTypeInputSchema.describe(
          `${DOCUMENT_DOC_HELP} Choose the document type (\`ISSUE\`≡\`FEATURE\`; \`DOC\` for an organization-level document).`
        ),
        projectId: requiredIdOrSlug(...PROJECT_ID_ARGS)
          .optional()
          .describe(
            "Project UUID or slug (e.g. PRO-7). Required for PRD, IMPLEMENTATION_PLAN, and FEATURE/ISSUE; optional for DOC. Use list-projects to find one."
          ),
        content: z.string().describe("Initial document content/body"),
        assigneeId: z
          .string()
          .uuid()
          .nullable()
          .optional()
          .describe(
            "UUID of the user to assign this document to. Use list-users to find valid user IDs."
          ),
        approverId: z
          .string()
          .uuid()
          .nullable()
          .optional()
          .describe(
            "UUID of the user to set as approver. Use list-users to find valid user IDs."
          ),
        priority: z
          .enum(Priority)
          .optional()
          .describe("Initial priority: LOW, MEDIUM, HIGH, or URGENT."),
        dueDate: dueDateInput.describe(
          "Initial due date as ISO 8601 date (YYYY-MM-DD) or timezone-qualified datetime."
        ),
        fileName: z.string().optional().describe("File name for the document."),
        status: z
          .enum({ ...DocumentStatus, ...IssueStatus })
          .optional()
          .describe(
            "Initial status. Documents use DRAFT/IN_REVIEW/CHANGES_REQUESTED/APPROVED/EXECUTED/OBSOLETE; Features use TRIAGE/BACKLOG/TODO/IN_PROGRESS/IN_REVIEW/BLOCKED/DONE/CANCELED. When omitted, Features default to TRIAGE and other types to DRAFT."
          ),
        repositorySelection: z
          .object({
            primary: z.object({
              fullName: z.string(),
              branch: z.string().nullable().optional(),
            }),
            additional: z
              .array(
                z.object({
                  fullName: z.string(),
                  branch: z.string().nullable().optional(),
                })
              )
              .optional(),
          })
          .optional()
          .describe(
            "Repositories this document is created against (owner/repo full names, optional branches). Exact full-name/branch/count constraints are enforced by the API; the snapshot is read-only to callers after creation."
          ),
        inlineImages: z
          .array(
            z.object({
              placeholder: z
                .string()
                .min(1)
                .max(MAX_CREATE_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS)
                .describe(
                  "Exact marker text in content to replace with the created Markdown image ref"
                ),
              filename: z
                .string()
                .min(1)
                .max(MAX_CREATE_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS)
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
                .max(MAX_CREATE_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS)
                .optional()
                .describe("Optional Markdown alt text for the generated image"),
            })
          )
          .max(MAX_CREATE_DOCUMENT_INLINE_IMAGES)
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
        dueDate: z.string().nullable().optional(),
        latestVersion: z.number().int().optional(),
        fileName: z.string().nullable().optional(),
        createdById: z.string().optional(),
        createdBy: basicUserOutputSchema.nullable().optional(),
        assigneeId: z.string().nullable().optional(),
        assignee: basicUserOutputSchema.nullable().optional(),
        approverId: z.string().nullable().optional(),
        approver: basicUserOutputSchema.nullable().optional(),
        repositorySnapshot: repositorySnapshotOutputSchema.optional(),
        templateForType: z.string().nullable().optional(),
        sortOrder: z.number().nullable().optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
        webUrl: z.string().nullable(),
        versionContent: z.string().optional(),
        inlineImages: z
          .array(createdDocumentInlineImageOutputSchema)
          .optional(),
        ...operationReceiptOutputShape,
      },
    },
    (input: CreateDocumentToolInput) =>
      withCreateDocumentErrorHandling(async () => {
        if (
          input.projectId === undefined &&
          !isProjectOptionalDocumentType(input.type)
        ) {
          throw new Error(idOrSlugRequiredMessage(...PROJECT_ID_ARGS));
        }
        const body = buildCreateDocumentRequestBody(input);
        const response = await apiClient.post<CreateDocumentResponse>(
          "/documents",
          body
        );
        const payload = shapeCreateDocumentOutput(response, urls);

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

function buildCreateDocumentRequestBody(
  input: CreateDocumentToolInput
): CreateDocumentMcpRequestBody {
  const body: CreateDocumentMcpRequestBody = {
    title: input.title,
    type: input.type,
    content: input.content,
  };
  if (input.projectId !== undefined) {
    body.projectId = input.projectId;
  }
  if (input.assigneeId !== undefined) {
    body.assigneeId = input.assigneeId;
  }
  if (input.approverId !== undefined) {
    body.approverId = input.approverId;
  }
  if (input.priority !== undefined) {
    body.priority = input.priority;
  }
  if (input.dueDate !== undefined) {
    body.dueDate = input.dueDate;
  }
  if (input.fileName !== undefined) {
    body.fileName = input.fileName;
  }
  if (input.repositorySelection !== undefined) {
    body.repositorySelection = input.repositorySelection;
  }
  if (input.status !== undefined) {
    body.status = input.status;
  }
  // Agent-created Features land in TRIAGE so a human assesses them before they
  // enter the delivery flow (PRD-495); an explicit caller status overrides this.
  // Other document types use the server's DRAFT default.
  if (body.status === undefined && input.type === DocumentType.Feature) {
    body.status = IssueStatus.Triage;
  }
  if (input.inlineImages && input.inlineImages.length > 0) {
    body.inlineImages = input.inlineImages;
  }
  return body;
}

function shapeCreateDocumentOutput(
  result: unknown,
  urls: McpUrlBuilder
): CreateDocumentOutput {
  const envelope = asRecord(result);
  const row = asRecord(envelope.data ?? result);
  const webUrl = urls.buildDocumentUrlFromRecord(row);
  const versionContent = readString(row.versionContent);
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
    ...readNullableStringProp("dueDate", row.dueDate),
    ...readOptionalNumberProp("latestVersion", row.latestVersion),
    ...readNullableStringProp("fileName", row.fileName),
    ...readOptionalStringProp("createdById", row.createdById),
    ...readNullableUserProp("createdBy", row.createdBy),
    ...readNullableStringProp("assigneeId", row.assigneeId),
    ...readNullableUserProp("assignee", row.assignee),
    ...readNullableStringProp("approverId", row.approverId),
    ...readNullableUserProp("approver", row.approver),
    ...readOptionalRepositorySnapshotProp(
      "repositorySnapshot",
      row.repositorySnapshot
    ),
    ...readNullableStringProp("templateForType", row.templateForType),
    ...readNullableNumberProp("sortOrder", row.sortOrder),
    ...readOptionalStringProp("createdAt", row.createdAt),
    ...readOptionalStringProp("updatedAt", row.updatedAt),
    webUrl,
    ...(versionContent === null ? {} : { versionContent }),
    ...(inlineImages === undefined ? {} : { inlineImages }),
  };
}

function shapeCreatedInlineImages(
  value: unknown
): CreatedDocumentInlineImageOutput[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => {
    const row = asRecord(item);
    const attachmentId = readRequiredNonEmptyString(
      row.attachmentId,
      "inlineImages.attachmentId"
    );
    const placeholder = readRequiredNonEmptyString(
      row.placeholder,
      "inlineImages.placeholder"
    );
    const markdownImage = readRequiredNonEmptyString(
      row.markdownImage,
      "inlineImages.markdownImage"
    );
    const attachmentRef = resolveAttachmentRef(row.attachmentRef, attachmentId);
    assertMarkdownImageReferencesAttachmentRef(markdownImage, attachmentRef);
    return {
      placeholder,
      attachmentId,
      attachmentRef,
      markdownImage,
    };
  });
}

function resolveAttachmentRef(value: unknown, attachmentId: string): string {
  if (attachmentId.length === 0) {
    throw new Error("API response missing inlineImages.attachmentId");
  }
  const attachmentRef = readString(value);
  if (
    attachmentRef?.startsWith(INLINE_ATTACHMENT_REF_PREFIX) &&
    attachmentRef.length > INLINE_ATTACHMENT_REF_PREFIX.length
  ) {
    return attachmentRef;
  }
  return buildInlineAttachmentRef(attachmentId);
}

function assertMarkdownImageReferencesAttachmentRef(
  markdownImage: string,
  attachmentRef: string
): void {
  const destination =
    MARKDOWN_IMAGE_DESTINATION_REGEX.exec(markdownImage)?.groups?.destination;
  if (destination !== attachmentRef) {
    throw new Error(
      "API response inlineImages.markdownImage does not reference inlineImages.attachmentRef"
    );
  }
}

function withCreateDocumentErrorHandling(
  fn: Parameters<typeof withErrorHandling>[0]
): ReturnType<typeof withErrorHandling> {
  return withErrorHandling(fn).then((result) => {
    if (!result.isError) {
      return result;
    }
    return {
      ...result,
      content: result.content.map((item) =>
        item.type === "text"
          ? { ...item, text: redactInlineImageSensitiveText(item.text) }
          : item
      ),
    };
  });
}

function redactInlineImageSensitiveText(text: string): string {
  return text
    .replace(
      JSON_INLINE_IMAGE_SECRET_FIELD_REGEX,
      "[redacted inline image detail]"
    )
    .replace(
      INLINE_IMAGE_SECRET_LABEL_TEXT_REGEX,
      "[redacted inline image detail]"
    )
    .replace(PRESIGNED_URL_TEXT_REGEX, "[redacted inline image signed URL]")
    .replace(
      ATTACHMENT_STORAGE_KEY_TEXT_REGEX,
      "[redacted attachment storage key]"
    );
}

function readRequiredNonEmptyString(value: unknown, fieldName: string): string {
  const parsed = readString(value);
  if (parsed === null || parsed.length === 0) {
    throw new Error(`API response missing ${fieldName}`);
  }
  return parsed;
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

function readNullableUserProp(
  key: string,
  value: unknown
): Record<string, BasicUserOutput | null> {
  if (value === null) {
    return { [key]: null };
  }
  const user = shapeBasicUser(value);
  return user === undefined ? {} : { [key]: user };
}

function readOptionalRepositorySnapshotProp(
  key: string,
  value: unknown
): Record<string, RepositorySnapshotOutput> {
  const snapshot = shapeRepositorySnapshot(value);
  return snapshot === undefined ? {} : { [key]: snapshot };
}

function shapeBasicUser(value: unknown): BasicUserOutput | undefined {
  const row = asRecord(value);
  if (Object.keys(row).length === 0) {
    return undefined;
  }
  return {
    ...readOptionalStringProp("id", row.id),
    ...readNullableStringProp("email", row.email),
    ...readNullableStringProp("firstName", row.firstName),
    ...readNullableStringProp("lastName", row.lastName),
    ...readNullableStringProp("avatarUrl", row.avatarUrl),
  };
}

function shapeRepositorySnapshot(
  value: unknown
): RepositorySnapshotOutput | undefined {
  const row = asRecord(value);
  const rawRepositories = row.repositories;
  if (!Array.isArray(rawRepositories)) {
    return undefined;
  }
  return {
    repositories: rawRepositories
      .map(shapeRepositorySnapshotEntry)
      .filter(
        (entry): entry is RepositorySnapshotEntryOutput => entry !== null
      ),
    ...readOptionalSnapshotSourceProp("source", row.source),
    ...readOptionalStringProp("createdAt", row.createdAt),
  };
}

function shapeRepositorySnapshotEntry(
  value: unknown
): RepositorySnapshotEntryOutput | null {
  const row = asRecord(value);
  const fullName = readString(row.fullName);
  if (fullName === null || fullName.length === 0) {
    return null;
  }
  return {
    fullName,
    ...readOptionalRepositoryRoleProp("role", row.role),
    ...readOptionalNumberProp("position", row.position),
    ...readNullableStringProp("branch", row.branch),
  };
}

function readOptionalRepositoryRoleProp(
  key: string,
  value: unknown
): Record<string, RepositoryRole> {
  const role = readRepositoryRole(value);
  return role === null ? {} : { [key]: role };
}

function readOptionalSnapshotSourceProp(
  key: string,
  value: unknown
): Record<string, SnapshotSource> {
  const source = readSnapshotSource(value);
  return source === null ? {} : { [key]: source };
}

function readRepositoryRole(value: unknown): RepositoryRole | null {
  const role = readString(value);
  if (role === RepositoryRole.Primary || role === RepositoryRole.Additional) {
    return role;
  }
  return null;
}

// Parsed through the canonical enum schema rather than a hand-listed
// disjunction: a member added to SnapshotSource used to fall through here and
// silently drop the artifact's repository provenance from this tool's output
// (ISS-8164).
function readSnapshotSource(value: unknown): SnapshotSource | null {
  const parsed = snapshotSourceSchema.safeParse(readString(value));
  return parsed.success ? parsed.data : null;
}

const PROJECT_ID_ARGS = [
  "Project",
  "PRO-7",
  "Use list-projects to find one.",
] as const;

// Project-bound types need a projectId; DOC may omit it (FEA-4345) or carry one
// (ISS-12858). TEMPLATE stays uncreatable here: templates are internal.
// ISS-10984 added DOC so agents can create org-level documents without a raw
// POST /documents.
export const PROJECT_BOUND_DOCUMENT_TYPES = [
  DocumentType.Prd,
  DocumentType.ImplementationPlan,
  DocumentType.Feature,
] as const;

type CreatableDocumentType =
  | (typeof PROJECT_BOUND_DOCUMENT_TYPES)[number]
  | typeof DocumentType.Doc;

/**
 * ISS-4397: the accepted *input* document types for create-document — the
 * creatable canonical types plus the `ISSUE` alias, which normalizes to
 * `FEATURE`. The schema ({@link createDocumentTypeInputSchema}) transforms this
 * input superset to a canonical {@link CreatableDocumentType} before the request
 * body is built, so downstream code never sees `ISSUE`.
 */
export const CREATE_DOCUMENT_TYPE_INPUTS = [
  ...PROJECT_BOUND_DOCUMENT_TYPES,
  DocumentType.Doc,
  DocumentTypeAlias.Issue,
] as const;

/**
 * Narrows {@link normalizeDocumentType}'s widened `DocumentType` return: every
 * accepted input normalizes to itself except `ISSUE`→`FEATURE`, so TEMPLATE can
 * never come out of it.
 */
function normalizeToCreatableType(
  type: (typeof CREATE_DOCUMENT_TYPE_INPUTS)[number]
): CreatableDocumentType {
  return normalizeDocumentType(type) as CreatableDocumentType;
}

export const createDocumentTypeInputSchema = z
  .enum(CREATE_DOCUMENT_TYPE_INPUTS)
  .transform(normalizeToCreatableType);
