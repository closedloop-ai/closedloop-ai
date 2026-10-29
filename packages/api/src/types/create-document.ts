import {
  MAX_DOCUMENT_VERSION_INLINE_EXPANDED_CONTENT_CHARS as SHARED_MAX_DOCUMENT_INLINE_EXPANDED_CONTENT_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_ALT_TEXT_CHARS as SHARED_MAX_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_FILENAME_CHARS as SHARED_MAX_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_PLACEHOLDER_CHARS as SHARED_MAX_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGES as SHARED_MAX_DOCUMENT_INLINE_IMAGES,
  MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES as SHARED_MAX_DOCUMENT_INLINE_REQUEST_BODY_BYTES,
} from "@closedloop-ai/loops-api/document";
import { z } from "zod";
import type { OperationReceipt } from "./attribution-evidence.ts";
import type { Priority } from "./common.js";
import type {
  ArtifactStatus,
  Document,
  DocumentType,
  DocumentTypeInput,
} from "./document.ts";
import type {
  CreateDocumentVersionInlineImageInput,
  CreatedDocumentVersionInlineImage,
} from "./document-version.js";

export const SourceLinkedPlanPolicy = {
  ReuseOrCreate: "reuse_or_create",
} as const;
export type SourceLinkedPlanPolicy =
  (typeof SourceLinkedPlanPolicy)[keyof typeof SourceLinkedPlanPolicy];
export const sourceLinkedPlanPolicySchema = z.enum(SourceLinkedPlanPolicy);

export const SourceLinkedPlanOutcome = {
  Created: "created",
  ReusedExisting: "reused_existing",
} as const;
export type SourceLinkedPlanOutcome =
  (typeof SourceLinkedPlanOutcome)[keyof typeof SourceLinkedPlanOutcome];

export const SourceLinkedPlanCreateErrorCode = {
  Ambiguous: "source_linked_implementation_plan_ambiguous",
} as const;
export type SourceLinkedPlanCreateErrorCode =
  (typeof SourceLinkedPlanCreateErrorCode)[keyof typeof SourceLinkedPlanCreateErrorCode];

export type SourceLinkedPlanResult = {
  policy: typeof SourceLinkedPlanPolicy.ReuseOrCreate;
  outcome: SourceLinkedPlanOutcome;
  sourceId: string;
  planId: string;
  currentPlanVersion: number;
};

export type SourceLinkedPlanAmbiguousPlan = {
  id: string;
  slug?: string;
  title: string;
  currentVersion: number;
};

export type SourceLinkedPlanAmbiguousResponse = {
  success: false;
  error: string;
  code: typeof SourceLinkedPlanCreateErrorCode.Ambiguous;
  plans: SourceLinkedPlanAmbiguousPlan[];
};

/**
 * Client-supplied repository selection used to build the document's
 * `repositorySnapshot` at creation time (PLN-602). When present, the server
 * assembles a `loop_selection` snapshot from this input. When absent the
 * snapshot falls through to project defaults. Branch/ref are optional —
 * projects do not pin branches by default.
 */
export type RepositorySelectionInput = {
  primary: { fullName: string; branch?: string | null };
  additional?: Array<{ fullName: string; branch?: string | null }>;
};

export type CreateDocumentInput = {
  /**
   * Owning project. Optional for org-level artifacts — a generic Document
   * (DOC) or a Template (FEA-1749/FEA-4345); a DOC may carry one and a
   * Template may not (ISS-12858). Required for project-bound subtypes (PRD/IMPLEMENTATION_PLAN/FEATURE). Because this
   * shared type serves both org-level and project-bound creates it is typed
   * optional; the "required for project-bound types" rule is enforced at
   * runtime by BOTH the create validator refine AND the service-layer guard in
   * `createDocumentRecord` (via `isProjectOptionalDocumentType`), so a direct
   * service caller cannot bypass the check the validator would apply on the
   * HTTP path.
   */
  projectId?: string;
  sourceId?: string;
  /**
   * Accepted request-side document type: the persisted `DocumentType` superset
   * plus the `ISSUE` alias (`DocumentTypeInput`, ISS-4397). A typed caller
   * (e.g. `useCreateDocument`) may pass `ISSUE` or `FEATURE`; both create
   * FEATURE-typed artifacts. Normalized to a persisted `DocumentType` at the
   * API/MCP boundary (`normalizeDocumentType`) — and defensively re-normalized
   * in `createDocumentRecord` for the in-code service callers — so the alias
   * never persists as `Artifact.subtype`.
   */
  type: DocumentTypeInput;
  title: string;
  fileName?: string;
  approverId?: string | null;
  status?: ArtifactStatus;
  priority?: Priority;
  dueDate?: Date | null;
  content: string;
  assigneeId?: string | null;
  templateForType?: DocumentType | null;
  /**
   * Explicit per-document repository selection (e.g. the user picked these in
   * the Create-Document modal). Accepted by the client validator; the server
   * builds a `loop_selection` snapshot from it. See PLN-602.
   */
  repositorySelection?: RepositorySelectionInput;
  /**
   * Opt-in race-safe source-linked Implementation Plan creation. When set to
   * `reuse_or_create`, the server serializes writers for the source artifact,
   * reuses a single existing linked Implementation Plan, or creates one.
   * Omission preserves legacy normal-create behavior.
   */
  sourceLinkedPlanPolicy?: SourceLinkedPlanPolicy;
};

export const MAX_CREATE_DOCUMENT_INLINE_IMAGES =
  SHARED_MAX_DOCUMENT_INLINE_IMAGES;
export const MAX_CREATE_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS =
  SHARED_MAX_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS;
export const MAX_CREATE_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS =
  SHARED_MAX_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS;
export const MAX_CREATE_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS =
  SHARED_MAX_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS;
export const MAX_CREATE_DOCUMENT_INLINE_EXPANDED_CONTENT_CHARS =
  SHARED_MAX_DOCUMENT_INLINE_EXPANDED_CONTENT_CHARS;
export const MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES =
  SHARED_MAX_DOCUMENT_INLINE_REQUEST_BODY_BYTES;

export const CreateDocumentErrorCode = {
  DocumentCreateFailed: "document_create_failed",
  DuplicateInlineImagePlaceholder: "duplicate_inline_image_placeholder",
  ExpandedContentTooLarge: "expanded_inline_image_content_too_large",
  InlineImageCreationFailed: "inline_image_creation_failed",
  MissingInlineImagePlaceholder: "missing_inline_image_placeholder",
  OverlappingInlineImagePlaceholder: "overlapping_inline_image_placeholder",
  RequestBodyTooLarge: "create_document_inline_images_request_too_large",
  VersionContentUpdateFailed: "document_initial_version_update_failed",
} as const;
export type CreateDocumentErrorCode =
  (typeof CreateDocumentErrorCode)[keyof typeof CreateDocumentErrorCode];

export type CreateDocumentInlineImageInput =
  CreateDocumentVersionInlineImageInput;
export type CreatedDocumentInlineImage = Pick<
  CreatedDocumentVersionInlineImage,
  "attachmentId" | "attachmentRef" | "markdownImage" | "placeholder"
>;

export type CreateDocumentRequestBody = CreateDocumentInput & {
  inlineImages?: CreateDocumentInlineImageInput[];
};

export type CreateDocumentResponse = Document & {
  inlineImages?: CreatedDocumentInlineImage[];
  sourceLinkedPlanResult?: SourceLinkedPlanResult;
  versionContent?: string;
  /** ISS-12552: present on API-key writes only; absent on browser writes. */
  operationReceipt?: OperationReceipt;
};
