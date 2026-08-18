import {
  IMAGE_MIME_TYPES,
  MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS,
} from "@repo/api/src/types/attachment";
import { Priority } from "@repo/api/src/types/common";
import {
  DOCUMENT_LIST_MAX_LIMIT,
  DOCUMENT_LIST_MAX_OFFSET,
  DOCUMENT_LIST_MAX_RECENCY_DAYS,
  DOCUMENT_LIST_MIN_RECENCY_DAYS,
  DocumentListRecency,
  DocumentStatus,
  documentTypeInputSchema,
  IssueStatus,
  isProjectOptionalDocumentType,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS,
  MAX_CREATE_DOCUMENT_INLINE_IMAGES,
  statusOptionsForSubtype,
} from "@repo/api/src/types/document";
import {
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_ALT_TEXT_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_FILENAME_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_PLACEHOLDER_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGES,
} from "@repo/api/src/types/document-version";
import { MAX_ADDITIONAL_REPOS } from "@repo/api/src/types/loop";
import { MovePosition } from "@repo/api/src/types/project-artifact-move";
import { z } from "zod";
import { uuidOrSlug } from "@/lib/identifier-utils";
import {
  repoBranchSchema,
  repoFullNameSchema,
} from "@/lib/repo-validator-helpers";
import { transformIsoDateTime } from "@/lib/validators/date-time";

// Documents (PRD/IMPLEMENTATION_PLAN/TEMPLATE) and Features (FEATURE) carry
// disjoint status vocabularies on the same freeform column (PRD-495). This
// union accepts any value from either set; the correct subset is enforced by
// the artifact's type/subtype — at the validator layer for create (where the
// type is in the body) and in the service for update/batch (after loading the
// target artifact's subtype).
const anyArtifactStatusEnum = z.enum({ ...DocumentStatus, ...IssueStatus });
// ISS-4397: `documentTypeEnum` is the shared public-contract input schema
// (`documentTypeInputSchema`, colocated with the type in `@repo/api`). It accepts
// the input-type superset (canonical DocumentType + the `ISSUE` alias) and
// normalizes to the persisted DocumentType. `type=ISSUE` and `type=FEATURE` both
// resolve to FEATURE-typed artifacts; the alias never leaks past this boundary
// into the service/Prisma layer. Reused by the create body, the `findDocuments`
// query here, and the MCP `list-documents` tool so all three share one schema.
const documentTypeEnum = documentTypeInputSchema;

const dueDateInput = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform(transformDueDateInput);
const nullableDueDateInput = dueDateInput.nullable();
const priorityEnum = z.enum(Priority);

// Document repos differ from Loop repos in one place: branch is
// `nullable().optional()` here (projects don't pin branches by default) vs.
// required for Loops. The shared helpers cover regex and length so both
// surfaces validate the same shape.
const documentRepoEntrySchema = z.object({
  fullName: repoFullNameSchema,
  branch: repoBranchSchema.nullable().optional(),
});

const repositorySelectionInputSchema = z.object({
  primary: documentRepoEntrySchema,
  additional: z
    .array(documentRepoEntrySchema)
    .max(MAX_ADDITIONAL_REPOS)
    .optional(),
});

export const createDocumentValidator = z
  .object({
    // Org-level artifacts (a generic Document — DocumentType.Doc — or a
    // Template) are not attached to a project (FEA-1749/FEA-4345), so
    // `projectId` is optional here and required only for the project-bound
    // subtypes below via the refine. The storage layer already tolerates an
    // absent project for these types (it writes NULL project_id).
    projectId: uuidOrSlug().optional(),
    sourceId: uuidOrSlug().optional(),
    type: documentTypeEnum,
    title: z.string().min(1, "Title is required"),
    fileName: z.string().optional(),
    approverId: z.uuid().nullable().optional(),
    status: anyArtifactStatusEnum.optional(),
    priority: priorityEnum.optional(),
    dueDate: nullableDueDateInput.optional(),
    content: z.string(),
    inlineImages: z
      .array(
        z.object({
          placeholder: z
            .string()
            .min(1)
            .max(MAX_CREATE_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS),
          filename: z
            .string()
            .min(1)
            .max(MAX_CREATE_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS),
          mimeType: z.enum(IMAGE_MIME_TYPES),
          dataBase64: z
            .string()
            .min(1)
            .max(MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS),
          altText: z
            .string()
            .max(MAX_CREATE_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS)
            .optional(),
        })
      )
      .max(MAX_CREATE_DOCUMENT_INLINE_IMAGES)
      .optional(),
    assigneeId: z.uuid().nullable().optional(),
    repositorySelection: repositorySelectionInputSchema.optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.status === undefined ||
      statusOptionsForSubtype(data.type).includes(data.status),
    {
      message: "status is not a valid value for the document type",
      path: ["status"],
    }
  )
  .refine(
    (data) =>
      isProjectOptionalDocumentType(data.type) || Boolean(data.projectId),
    {
      message: "projectId is required for this document type",
      path: ["projectId"],
    }
  )
  // The converse: org-level types (DOC/TEMPLATE) are org-scoped and must NOT
  // carry a project (FEA-4345). Rejecting here turns a TEMPLATE+projectId into a
  // clean 400 (the service otherwise throws → 500) and stops a DOC from being
  // silently persisted under a project even though it is defined as org-level.
  .refine(
    (data) => !(isProjectOptionalDocumentType(data.type) && data.projectId),
    {
      message: "projectId is not allowed for organization-level document types",
      path: ["projectId"],
    }
  );

export const updateDocumentValidator = z
  .object({
    title: z.string().min(1).optional(),
    fileName: z.string().optional(),
    approverId: z.uuid().nullable().optional(),
    status: anyArtifactStatusEnum.optional(),
    priority: priorityEnum.optional(),
    dueDate: nullableDueDateInput.optional(),
    projectId: uuidOrSlug().optional(),
    assigneeId: z.uuid().nullable().optional(),
    sortOrder: z.number().nullable().optional(),
    customFields: z
      .record(
        z.uuid(),
        z.union([
          z.string().max(10_000),
          z.number(),
          z.array(z.uuid()).max(100),
          z.null(),
        ])
      )
      .optional(),
  })
  .strict();

export const newVersionValidator = z.object({
  content: z.string(),
  inlineImages: z
    .array(
      z.object({
        placeholder: z
          .string()
          .min(1)
          .max(MAX_DOCUMENT_VERSION_INLINE_IMAGE_PLACEHOLDER_CHARS),
        filename: z
          .string()
          .min(1)
          .max(MAX_DOCUMENT_VERSION_INLINE_IMAGE_FILENAME_CHARS),
        mimeType: z.enum(IMAGE_MIME_TYPES),
        dataBase64: z
          .string()
          .min(1)
          .max(MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS),
        altText: z
          .string()
          .max(MAX_DOCUMENT_VERSION_INLINE_IMAGE_ALT_TEXT_CHARS)
          .optional(),
      })
    )
    .max(MAX_DOCUMENT_VERSION_INLINE_IMAGES)
    .optional(),
});

export const findDocumentsQueryValidator = z
  .object({
    type: documentTypeEnum.optional(),
    projectId: uuidOrSlug().optional(),
    assigneeId: z.uuid().optional(),
    // Org-level Documents index (FEA-4140): list only project-less documents.
    // Query params arrive as strings, so accept the literal "true"/"false" and
    // coerce to a boolean the service consumes.
    unassignedProject: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    // FEA-4373: optional page bound for clients that render one row/card per
    // returned artifact and could crash on a very large set (the My Tasks board).
    // The bound is OPT-IN — omitting `limit` leaves the list unbounded (the
    // long-standing default other consumers rely on). Query params arrive as
    // strings; coerce, then REJECT (not clamp) out-of-range values so a caller
    // asking for more than the endpoint can serve gets a 400 rather than a
    // silently-narrowed page. The service floors/ceils supplied values as defense
    // in depth. Mirrors the Branches list bound.
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(DOCUMENT_LIST_MAX_LIMIT)
      .optional(),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(DOCUMENT_LIST_MAX_OFFSET)
      .optional(),
    // ISS-4576: opt into the paged envelope (items + a real server-side total)
    // instead of the bare array. Same string-literal coercion as
    // `unassignedProject` — and the same reject-don't-guess posture: anything
    // other than "true"/"false" is a 400 rather than a silent falsy default.
    includeTotal: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    // FEA-1626: recency window in days, applied to `Artifact.updatedAt`. The
    // literal "all" opts out of the window entirely and is matched FIRST — it
    // must not reach `z.coerce.number()`, which would turn it into NaN. Same
    // reject-don't-clamp posture as `limit`/`offset`: an out-of-range day count
    // is a 400 rather than a silently-narrowed window (the service clamps too,
    // as defense in depth for direct callers).
    recencyDays: z
      .union([
        z.literal(DocumentListRecency.All),
        z.coerce
          .number()
          .int()
          .min(DOCUMENT_LIST_MIN_RECENCY_DAYS)
          .max(DOCUMENT_LIST_MAX_RECENCY_DAYS),
      ])
      .optional(),
    // FEA-1626: whether artifacts whose parent project is ARCHIVED are kept.
    // Omission and `true` both mean "keep them" (the legacy behavior); only an
    // explicit `false` drops them. Same string-literal coercion and
    // reject-don't-guess posture as `includeTotal`.
    includeArchivedProjects: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict()
  .refine((query) => query.offset === undefined || query.limit !== undefined, {
    message: "offset requires limit",
    path: ["offset"],
  })
  // `includeTotal=true` without a `limit` materializes the FULL matching set and
  // adds a full `count()` over the same predicate — the exact unbounded workload
  // this paginated path exists to avoid, and an easy self-DoS for any
  // authenticated caller on a large org (shafty023 review). The paged envelope
  // is only meaningful for a bounded page, so require a `limit` whenever the
  // total is requested; an unbounded read that wants every row uses the bare
  // array (no `includeTotal`), whose length already IS the total.
  .refine((query) => !query.includeTotal || query.limit !== undefined, {
    message: "includeTotal requires limit",
    path: ["includeTotal"],
  });

export const batchMoveDocumentsValidator = z.object({
  documentIds: z.array(z.uuid()).min(1, "At least one document ID required"),
  targetProjectId: z.uuid(),
});

export const mergeDocumentsValidator = z
  .object({
    primaryDocumentId: z.uuid(),
    secondaryDocumentId: z.uuid(),
  })
  .refine((data) => data.primaryDocumentId !== data.secondaryDocumentId, {
    message: "Primary and secondary document IDs must be different",
    path: ["secondaryDocumentId"],
  });

export const batchUpdateStatusValidator = z.object({
  documentIds: z
    .array(z.uuid())
    .min(1, "At least one document ID required")
    .max(500),
  status: anyArtifactStatusEnum,
});

export const batchDeleteValidator = z.object({
  documentIds: z
    .array(z.uuid())
    .min(1, "At least one document ID required")
    .max(500),
});

/**
 * Body schema for `POST /projects/:id/artifacts/move` (PRD-421 / PLN-755).
 * Discriminated union with `.strict()` on every branch so unknown fields are
 * rejected uniformly: `top` / `bottom` reject any extra key (notably
 * `referenceArtifactId`), and `before` / `after` require `referenceArtifactId`
 * while still rejecting anything else. Keeps callers honest at the API
 * boundary so the service never has to handle ambiguous inputs.
 */
export const moveArtifactValidator = z.discriminatedUnion("position", [
  z
    .object({
      artifactId: uuidOrSlug(),
      position: z.literal(MovePosition.Top),
    })
    .strict(),
  z
    .object({
      artifactId: uuidOrSlug(),
      position: z.literal(MovePosition.Bottom),
    })
    .strict(),
  z
    .object({
      artifactId: uuidOrSlug(),
      position: z.literal(MovePosition.Before),
      referenceArtifactId: uuidOrSlug(),
    })
    .strict(),
  z
    .object({
      artifactId: uuidOrSlug(),
      position: z.literal(MovePosition.After),
      referenceArtifactId: uuidOrSlug(),
    })
    .strict(),
]);

function transformDueDateInput(value: string): Date {
  const isoDateTime = value.includes("T") ? value : `${value}T00:00:00.000Z`;
  return transformIsoDateTime(isoDateTime) ?? new Date(isoDateTime);
}
