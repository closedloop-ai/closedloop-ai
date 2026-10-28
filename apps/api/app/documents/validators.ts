import {
  POSTGRES_INT4_MAX,
  POSTGRES_INT4_MIN,
} from "@closedloop-ai/loops-api/column-limits";
import { MAX_ADDITIONAL_REPOS } from "@closedloop-ai/loops-api/context-pack";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  IMAGE_MIME_TYPES,
  MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS,
} from "@repo/api/src/types/attachment";
import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import { Priority } from "@repo/api/src/types/common";
import { CustomFieldSortDirection } from "@repo/api/src/types/custom-field-list-query";
import {
  DOCUMENT_LIST_MAX_LIMIT,
  DOCUMENT_LIST_MAX_RECENCY_DAYS,
  DOCUMENT_LIST_MAX_SEARCH_LENGTH,
  DOCUMENT_LIST_MIN_RECENCY_DAYS,
  DocumentListRecency,
  DocumentType,
  DocumentTypeInput,
  documentTypeInputSchema,
  isProjectOptionalDocumentType,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS,
  MAX_CREATE_DOCUMENT_INLINE_IMAGES,
  sourceLinkedPlanPolicySchema,
  statusOptionsForSubtype,
} from "@repo/api/src/types/document";
import { DOCUMENT_SUMMARY_ID_BATCH_SIZE } from "@repo/api/src/types/document-list-summary";
import {
  customFieldFilterSetSchema,
  documentMetricScopeIdsSchema,
} from "@repo/api/src/types/document-metric-scope";
import {
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_ALT_TEXT_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_FILENAME_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_PLACEHOLDER_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGES,
} from "@repo/api/src/types/document-version";
import { unguardedGuardMessage } from "@repo/api/src/types/optimistic-write-guard";
import {
  containsNulCharacter,
  PostgresTextRejection,
} from "@repo/api/src/types/postgres-text";
import { isArtifactPriorityEditSurface } from "@repo/api/src/types/priority-contract";
import {
  MOVE_ARTIFACT_EXPECTED_ORDER_LIMIT,
  MovePosition,
} from "@repo/api/src/types/project-artifact-move";
import { z } from "zod";
import { uuidOrSlug } from "@/lib/identifier-utils";
import {
  repoBranchSchema,
  repoFullNameSchema,
} from "@/lib/repo-validator-helpers";
import {
  sanitizedTextFields,
  sanitizeTextFields,
  sanitizeTextValue,
} from "@/lib/sanitize-text-fields";
import {
  ARTIFACT_PRIORITY_EDIT_SURFACE_ERROR,
  optionalArtifactEditSurface,
  optionalSingleArtifactEditSurface,
} from "@/lib/single-artifact-edit-surface";
import { isRecord } from "@/lib/type-guards";
import {
  ANY_ARTIFACT_STATUS_COUNT,
  anyArtifactStatusEnum,
} from "@/lib/validators/artifact-status";
import { transformIsoDateTime } from "@/lib/validators/date-time";

// Documents (PRD/IMPLEMENTATION_PLAN/TEMPLATE) and Features (FEATURE) carry
// disjoint status vocabularies on the same freeform column (PRD-495). This
// union accepts any value from either set; the correct subset is enforced by
// the artifact's type/subtype — at the validator layer for create (where the
// type is in the body) and in the service for update/batch (after loading the
// target artifact's subtype).

/**
 * ISS-9436: each route accepts only the surfaces that actually reach IT. The
 * taxonomy names five write paths across three endpoints, so the whole union on
 * every body would let a caller file a `bulk` receipt through the
 * single-artifact PUT — a grouped commit of one row, which is not a thing the
 * product can do — or a `row_action` receipt on a document, whose control lives
 * on projects. The split makes the endpoint and the claimed surface agree by
 * construction.
 *
 * Narrowing is a REFINEMENT of the caught schema, not a replacement for it, so
 * the two contracts compose: an UNRECOGNIZED value has already degraded to
 * `undefined` by this point and the write still commits (ISS-9443), while a
 * KNOWN-but-inapplicable member is a 400. Same shape as the priority batch
 * below, for the same reason.
 */
const optionalBulkDocumentStatusEditSurface =
  optionalArtifactEditSurface.refine(
    (value) => value === undefined || value === ArtifactStatusEditSurface.Bulk,
    { message: "surface cannot have originated a bulk status write" }
  );
/**
 * ISS-9443: the batch PRIORITY body narrows that set to the surfaces that can
 * actually write a priority, so `board` (a kanban column is a status) and
 * `row_action` (a project route) are 400s here rather than silently uncounted
 * 200s. The single-artifact PUT above narrows to its own three, because there
 * one `surface` serves a status write and a priority write in the same body;
 * the priority emit applies this predicate at the call site instead.
 *
 * A KNOWN-but-inapplicable member is still a 400 here; only an unrecognized one
 * degrades, which is why this refines the caught schema rather than replacing
 * it — `undefined` has already absorbed the unknown value by this point.
 */
const optionalArtifactPriorityEditSurface = optionalArtifactEditSurface.refine(
  (value) => value === undefined || isArtifactPriorityEditSurface(value),
  { message: ARTIFACT_PRIORITY_EDIT_SURFACE_ERROR }
);
/**
 * ISS-10332: the SINGLE session / branch priority writes (`PATCH
 * /agent-sessions/[id]`, `PATCH /branches/[id]`) narrow further still — a
 * `bulk` receipt through a one-row route is the grouped-commit-of-one the
 * single-artifact PUT above already refuses. Composes the two refinements, so
 * an unrecognized value still degrades to `undefined` and commits.
 */
export const optionalSingleArtifactPriorityEditSurface =
  optionalSingleArtifactEditSurface.refine(
    (value) => value === undefined || isArtifactPriorityEditSurface(value),
    { message: ARTIFACT_PRIORITY_EDIT_SURFACE_ERROR }
  );
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

/**
 * The highest rank a caller may write to `Artifact.sortOrder` — half the int4
 * range, not all of it (#7812 review, marisolashgrove). `computeNextSortOrder`
 * appends a new root at MAX + `STACK_RANK_GAP`, so a rank parked at
 * `POSTGRES_INT4_MAX` would make that project's next create fail at the driver
 * with 22003. Half the range leaves a parked project ~1M appends of room.
 *
 * ponytail: headroom, not a closed bound — appends still overflow after ~1M
 * creates above a parked rank; renumber in `computeNextSortOrder` if one ever
 * gets there.
 */
export const ARTIFACT_SORT_ORDER_MAX = Math.floor(POSTGRES_INT4_MAX / 2);

/**
 * `Artifact.sortOrder` is a Prisma `Int` (int4), and this validator is the only
 * boundary between a CALLER-SUPPLIED rank and that column. The server-computed
 * ranks (`artifactBulkRankService`, `documentMoveService`, and the
 * `computeNextSortOrder` append) are written without passing through it.
 *
 * ISS-8880 §3 bounded the other `sortOrder` writers (catalog, custom-field enum
 * options, organizations — see `app/catalog/__tests__/int4-and-target-kind-bounds.test.ts`);
 * this one writes a further int4 column and was missed, with no `.int()` either.
 * A bare `z.number()` admits `1.5`, which is not a value the column can hold,
 * and `2147483648` / `1e21`, which Prisma rejects at the driver as an uncaught
 * 500. The floor is the COLUMN's — a floor of `0` would be a product rule about
 * what a rank means, which no ticket has stated.
 */
const artifactSortOrderSchema = z
  .number()
  .int()
  .min(POSTGRES_INT4_MIN)
  .max(ARTIFACT_SORT_ORDER_MAX);

// Branch is `nullable().optional()` here (projects don't pin branches by
// default). The shared helpers cover regex and length.
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

const createDocumentBodyValidator = z
  .object({
    // `projectId` is optional for DOC and TEMPLATE (FEA-1749/FEA-4345),
    // required for the project-bound subtypes by the refine below, and refused
    // for TEMPLATE by the refine after it (ISS-12858). Storage writes NULL
    // project_id when it is absent.
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
          placeholder: sanitizeTextValue(
            z
              .string()
              .min(1)
              .max(MAX_CREATE_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS)
          ),
          filename: sanitizeTextValue(
            z
              .string()
              .min(1)
              .max(MAX_CREATE_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS)
          ),
          mimeType: z.enum(IMAGE_MIME_TYPES),
          dataBase64: z
            .string()
            .min(1)
            .max(MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS),
          altText: sanitizeTextValue(
            z.string().max(MAX_CREATE_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS)
          ).optional(),
        })
      )
      .max(MAX_CREATE_DOCUMENT_INLINE_IMAGES)
      .optional(),
    assigneeId: z.uuid().nullable().optional(),
    repositorySelection: repositorySelectionInputSchema.optional(),
    sourceLinkedPlanPolicy: sourceLinkedPlanPolicySchema.optional(),
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
  // A TEMPLATE is org-scoped and must NOT carry a project (FEA-4345): a clean
  // 400 here instead of the service silently dropping it. A DOC may carry one
  // (ISS-12858, PRD-799 G-04).
  .refine((data) => !(data.type === DocumentType.Template && data.projectId), {
    message: "projectId is not allowed for organization-level document types",
    path: ["projectId"],
  })
  .refine(
    (data) =>
      data.sourceLinkedPlanPolicy === undefined ||
      data.type === DocumentType.ImplementationPlan,
    {
      message:
        "sourceLinkedPlanPolicy is valid only for implementation plan creates",
      path: ["sourceLinkedPlanPolicy"],
    }
  )
  .refine(
    (data) =>
      data.sourceLinkedPlanPolicy === undefined || Boolean(data.sourceId),
    {
      message: "sourceId is required when sourceLinkedPlanPolicy is set",
      path: ["sourceId"],
    }
  )
  .refine(
    (data) =>
      data.sourceLinkedPlanPolicy === undefined ||
      data.inlineImages === undefined ||
      data.inlineImages.length === 0,
    {
      message: "inlineImages are not supported with sourceLinkedPlanPolicy",
      path: ["inlineImages"],
    }
  );

const updateDocumentBodyValidator = z
  .object({
    title: z.string().min(1).optional(),
    fileName: z.string().optional(),
    approverId: z.uuid().nullable().optional(),
    status: anyArtifactStatusEnum.optional(),
    surface: optionalSingleArtifactEditSurface,
    // ISS-9665: explicit `null` CLEARS the priority. `nullable()` before
    // `optional()` so an omitted key still means "leave it alone" — the two are
    // different requests and the artifact column has always stored both.
    priority: priorityEnum.nullable().optional(),
    dueDate: nullableDueDateInput.optional(),
    // ISS-12858: `null` CLEARS the project; an omitted key leaves it alone (as `priority`).
    projectId: uuidOrSlug().nullable().optional(),
    assigneeId: z.uuid().nullable().optional(),
    expectedStatus: nulFreeString(z.string().min(1)).optional(),
    // ISS-9440: the priority half of the optimistic guard. Three states, and
    // all three are load-bearing — omitted leaves the write unguarded (what an
    // older client sends), `null` asserts the artifact currently holds NO
    // priority, and a member asserts that member.
    expectedPriority: priorityEnum.nullable().optional(),
    // ISS-11198: NOT bounded like `title`. It must equal the stored title byte
    // for byte, so a guard that could not name every stored title would make
    // that document impossible to rename under a guard.
    expectedTitle: nulFreeString(z.string()).optional(),
    expectedAssigneeId: z.uuid().nullable().optional(),
    sortOrder: artifactSortOrderSchema.nullable().optional(),
    customFields: z
      .record(
        z.uuid(),
        sanitizeTextValue(
          z.union([
            z.string().max(10_000),
            z.number(),
            z.array(z.uuid()).max(100),
            z.null(),
          ])
        )
      )
      .optional(),
  })
  .strict()
  .refine(
    (body) => body.expectedTitle === undefined || body.title !== undefined,
    { message: unguardedGuardMessage("title"), path: ["expectedTitle"] }
  )
  .refine(
    (body) =>
      body.expectedAssigneeId === undefined || body.assigneeId !== undefined,
    {
      message: unguardedGuardMessage("assigneeId"),
      path: ["expectedAssigneeId"],
    }
  );

const newVersionBodyValidator = z.object({
  content: z.string(),
  inlineImages: z
    .array(
      z.object({
        placeholder: sanitizeTextValue(
          z
            .string()
            .min(1)
            .max(MAX_DOCUMENT_VERSION_INLINE_IMAGE_PLACEHOLDER_CHARS)
        ),
        filename: sanitizeTextValue(
          z
            .string()
            .min(1)
            .max(MAX_DOCUMENT_VERSION_INLINE_IMAGE_FILENAME_CHARS)
        ),
        mimeType: z.enum(IMAGE_MIME_TYPES),
        dataBase64: z
          .string()
          .min(1)
          .max(MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS),
        altText: sanitizeTextValue(
          z.string().max(MAX_DOCUMENT_VERSION_INLINE_IMAGE_ALT_TEXT_CHARS)
        ).optional(),
      })
    )
    .max(MAX_DOCUMENT_VERSION_INLINE_IMAGES)
    .optional(),
});

// ISS-11195: stored text is stripped of NUL before validation (a NUL passes
// `z.string()` and fails the `text` column as a 500). Exhaustive policies, so a
// text field added to a body fails `tsc` here until it is classified.
export const createDocumentValidator = sanitizeTextFields(
  createDocumentBodyValidator,
  sanitizedTextFields({
    projectId: false,
    sourceId: false,
    type: false,
    title: true,
    fileName: true,
    approverId: false,
    status: false,
    priority: false,
    dueDate: false,
    content: true,
    // Nested: its text fields are wrapped with `sanitizeTextValue` above.
    inlineImages: false,
    assigneeId: false,
    repositorySelection: false,
    sourceLinkedPlanPolicy: false,
  } satisfies Record<keyof typeof createDocumentBodyValidator.shape, boolean>)
);

// `expectedStatus` and `expectedTitle` are NOT stripped: they are compared in a
// WHERE, so a stripped token would assert a value the caller never read. They
// refuse a NUL instead (`nulFreeString`).
export const updateDocumentValidator = sanitizeTextFields(
  updateDocumentBodyValidator,
  sanitizedTextFields({
    title: true,
    fileName: true,
    approverId: false,
    status: false,
    surface: false,
    priority: false,
    dueDate: false,
    projectId: false,
    assigneeId: false,
    expectedStatus: false,
    expectedPriority: false,
    expectedTitle: false,
    expectedAssigneeId: false,
    sortOrder: false,
    customFields: false,
  } satisfies Record<keyof typeof updateDocumentBodyValidator.shape, boolean>)
);

export const newVersionValidator = sanitizeTextFields(
  newVersionBodyValidator,
  sanitizedTextFields({
    content: true,
    // Nested: its text fields are wrapped with `sanitizeTextValue` above.
    inlineImages: false,
  } satisfies Record<keyof typeof newVersionBodyValidator.shape, boolean>)
);

/** A query-string boolean: only the literals, never a truthy guess. */
const queryBooleanSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

/**
 * The list query's FIELDS, before the cross-field rules below are attached.
 *
 * Named separately only because Zod 4 refuses `.omit()` on an object that
 * carries refinements, and the batch query-selection descriptor (ISS-9579) is
 * this object minus its paging and sort keys. Deriving is what keeps "which
 * artifacts are in this list" and "which artifacts does select-all name" ONE
 * vocabulary; a second hand-written copy is the drift ISS-9575's "the filter IS
 * the selection" cannot survive.
 *
 * A refinement added below binds the LIST endpoint only. One that must also
 * bind a batch selection belongs on this shape instead.
 */
const documentListFilterShape = z
  .object({
    type: documentTypeEnum.optional(),
    types: z
      .array(documentTypeEnum)
      .min(1)
      .max(Object.keys(DocumentTypeInput).length)
      .optional(),
    projectId: uuidOrSlug().optional(),
    assigneeId: z.uuid().optional(),
    // FEA-4140: list only project-less documents (API callers; ISS-12858).
    // Query params arrive as strings, so accept the literal "true"/"false" and
    // coerce to a boolean the service consumes.
    unassignedProject: queryBooleanSchema.optional(),
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
    // ISS-11161: `offset` has no ceiling. Refusing past one pushed the MCP
    // `list-documents` tool onto whole-corpus reads for every deep page; see
    // `DOCUMENT_LIST_MAX_OFFSET` for why a deep offset costs no more than the
    // unbounded arm this endpoint already serves.
    offset: z.coerce.number().int().min(0).optional(),
    // ISS-4576: opt into the paged envelope (items + a real server-side total)
    // instead of the bare array. Same string-literal coercion as
    // `unassignedProject` — and the same reject-don't-guess posture: anything
    // other than "true"/"false" is a 400 rather than a silent falsy default.
    includeTotal: queryBooleanSchema.optional(),
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
    includeArchivedProjects: queryBooleanSchema.optional(),
    // ISS-7211: only the field id and direction travel on the wire. Which column
    // that field sorts on, and whether the caller may sort by it at all, are
    // decided server-side from the stored definition — a client cannot name a
    // column.
    customFieldSortId: z.uuid().optional(),
    customFieldSortDir: z
      .enum([CustomFieldSortDirection.Asc, CustomFieldSortDirection.Desc])
      .optional(),
    // JSON-encoded because the facet count is variable and the route reads
    // params through `Object.fromEntries`, which keeps only the last value of a
    // repeated key. Piped into a real schema — `JSON.parse` accepts any shape.
    customFieldFilters: z
      .string()
      .transform((raw, ctx) => {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "customFieldFilters must be valid JSON",
          });
          return z.NEVER;
        }
      })
      .pipe(customFieldFilterSetSchema)
      .optional(),
    // ISS-9724: free-text narrowing on title/slug, executed in the database over
    // the whole matching population. `.trim().min(1)` REJECTS a blank or
    // whitespace-only term rather than coercing it to "no search": silently
    // dropping it would return the full population while the caller's box still
    // showed text, which is the same lie as a page-scoped search. Same shape and
    // bound as the Branches list's own `search`.
    search: z
      .string()
      .trim()
      .min(1)
      .max(DOCUMENT_LIST_MAX_SEARCH_LENGTH)
      .optional(),
    // ISS-6778: lifecycle-status narrowing, executed as an `IN` predicate in the
    // database. REPEATED, not comma-joined — `?status=TODO&status=IN_PROGRESS`
    // — per `apps/api/AGENTS.md`, which reserves comma lists for existing public
    // contracts and explicit compatibility requirements. This parameter is new
    // and unshipped, so it has neither, and `/search`'s `types` already spells
    // the same shape the same way (tamsinb, whitlockk review). The route reads
    // EVERY occurrence; a shape that kept one per key would answer
    // `?status=TODO&status=DONE` with DONE alone and never tell the caller TODO
    // was dropped, which is the exact silent no-op this filter exists to remove.
    //
    // The input is therefore always an ARRAY of raw strings. Each element is
    // trimmed and then checked against `anyArtifactStatusEnum`, the SAME union
    // the create/update bodies use, so this does not introduce a second status
    // inventory that could drift from the vocabulary. Deliberately NOT narrowed
    // by the requested `type`: `Artifact.status` is freeform and off-vocabulary
    // rows exist in production (a FEATURE carrying `OBSOLETE`), so a
    // type/status combination the lifecycle forbids is answered with the rows
    // that actually carry it — usually none — rather than a 400 that would make
    // exactly those rows unfindable. See `FindDocumentsOptions.status`.
    //
    // The trim is a spelling tolerance, NOT a dropped element: an occurrence
    // arriving as `%20IN_PROGRESS` from a hand-written curl still means
    // IN_PROGRESS and is answered as such (marisolashgrove review). Same
    // reject-don't-guess
    // posture as the siblings above everywhere else, and that is the half of the
    // ticket that keeps a typo loud: an element outside BOTH vocabularies is a
    // 400, and so is an element that is empty or whitespace-only — `?status=` is
    // malformed rather than "no filter", because silently widening to the whole
    // population behind a parameter the caller believes narrowed it is the same
    // lie. A client with nothing selected omits the parameter entirely; its
    // serializer emits no occurrences for an empty set, so it never lands here.
    status: z
      .array(z.string().trim().pipe(anyArtifactStatusEnum))
      .min(1)
      .max(ANY_ARTIFACT_STATUS_COUNT)
      .optional(),
  })
  .strict();

export const findDocumentsQueryValidator = documentListFilterShape
  // A direction without a field orders nothing, and silently ignoring it would
  // return an unsorted list while the toolbar's arrow claims otherwise.
  .refine(
    (query) =>
      query.customFieldSortDir === undefined ||
      query.customFieldSortId !== undefined,
    {
      message: "customFieldSortDir requires customFieldSortId",
      path: ["customFieldSortDir"],
    }
  )
  .refine((query) => query.offset === undefined || query.limit !== undefined, {
    message: "offset requires limit",
    path: ["offset"],
  })
  // `includeTotal=true` without a `limit` materializes the FULL matching set and
  // adds a full `count()` over the same predicate — the exact unbounded workload
  // this paginated path exists to avoid, and an easy self-DoS for any
  // authenticated caller on a large org (davetho review). The paged envelope
  // is only meaningful for a bounded page, so require a `limit` whenever the
  // total is requested; an unbounded read that wants every row uses the bare
  // array (no `includeTotal`), whose length already IS the total.
  .refine((query) => !query.includeTotal || query.limit !== undefined, {
    message: "includeTotal requires limit",
    path: ["includeTotal"],
  });

// Share the capped ID list across batch routes (ISS-9073); a prior copy
// omitted `.max()` and let 50k ids reach one `findMany` bind list.
export const batchDocumentIdsSchema = z
  .array(z.uuid())
  .min(1, "At least one document ID required")
  .max(BATCH_MUTATION_ENTITY_LIMIT);
const expectedByIdKeySchema = z.uuid();
const expectedStatusValueSchema = nulFreeString(z.string().min(1));

/**
 * The query half of a batch selection (ISS-9579): the list predicate, minus the
 * keys that describe a PAGE rather than a set.
 *
 * `limit`, `offset` and `includeTotal` are dropped because a bound is what
 * select-all is defined against, not part of it — accepting them would let a
 * caller hand the server a narrowed window and have the write call itself
 * "all results". `customFieldSortId` / `customFieldSortDir` are dropped because
 * an order does not change a membership.
 */
const batchSelectionQuerySchema = documentListFilterShape
  .omit({
    limit: true,
    offset: true,
    includeTotal: true,
    customFieldSortId: true,
    customFieldSortDir: true,
  })
  // Three fields carry a QUERY-STRING encoding that a JSON body does not.
  // `Object.fromEntries(searchParams)` hands the list route strings, so the
  // shape above spells a boolean `"true"` and a facet set as JSON inside a
  // string; `parseBody` hands this one the decoded object, where the natural
  // spelling — and the one this schema's own inferred type exposes — is a real
  // boolean and a real array. Each accepts BOTH, native arm first, rather than
  // forking a second filter vocabulary: one predicate, two transports.
  .extend({
    unassignedProject: z
      .union([z.boolean(), documentListFilterShape.shape.unassignedProject])
      .optional(),
    includeArchivedProjects: z
      .union([
        z.boolean(),
        documentListFilterShape.shape.includeArchivedProjects,
      ])
      .optional(),
    customFieldFilters: z
      .union([
        customFieldFilterSetSchema,
        documentListFilterShape.shape.customFieldFilters,
      ])
      .optional(),
  });

/**
 * A batch selection defined by a server-resolved query rather than by ids.
 *
 * `excludedIds` is ISS-9575's "all except N": the rows the reader turned off
 * inside a select-all. It is the only id list the query arm carries, and it is
 * bounded by the same ceiling the id arm is, because it IS a client-sent list.
 */
export const batchDocumentSelectionSchema = z
  .object({
    query: batchSelectionQuerySchema,
    excludedIds: z.array(z.uuid()).max(BATCH_MUTATION_ENTITY_LIMIT).optional(),
  })
  .strict();

export type BatchDocumentSelection = z.infer<
  typeof batchDocumentSelectionSchema
>;

/**
 * Exactly one of `documentIds` and `selection` names the batch.
 *
 * Both arms are `.optional()` on the wire so the field stays additive for a
 * client that predates ISS-9579, and this rule is what stops "optional" from
 * meaning "omit both" — a body naming neither would otherwise parse and reach a
 * route with nothing to operate on.
 */
export function refineBatchSelectionArms(
  body: { documentIds?: string[]; selection?: BatchDocumentSelection },
  context: z.RefinementCtx
): void {
  const named = [body.documentIds, body.selection].filter(
    (arm) => arm !== undefined
  ).length;
  if (named === 1) {
    return;
  }
  context.addIssue({
    code: "custom",
    message: "Provide exactly one of documentIds or selection",
    path: ["selection"],
  });
}

export const batchMoveDocumentsValidator = z
  .object({
    documentIds: batchDocumentIdsSchema.optional(),
    selection: batchDocumentSelectionSchema.optional(),
    // ISS-12858: `null` files the documents into no project. Still a required key.
    targetProjectId: z.uuid().nullable(),
  })
  .superRefine(refineBatchSelectionArms);

export const mergeDocumentsValidator = z
  .object({
    primaryDocumentId: z.uuid(),
    secondaryDocumentId: z.uuid(),
  })
  .refine((data) => data.primaryDocumentId !== data.secondaryDocumentId, {
    message: "Primary and secondary document IDs must be different",
    path: ["secondaryDocumentId"],
  });

const expectedStatusByIdGuard = expectedByIdGuard(
  "expectedStatusById",
  expectedStatusValueSchema
);
// ISS-9440: an id present with `null` asserts "I believe this artifact holds no
// priority"; an id ABSENT from the map is unguarded and keeps the legacy
// last-write-wins, which is exactly what an older client sends.
const expectedPriorityByIdGuard = expectedByIdGuard(
  "expectedPriorityById",
  priorityEnum.nullable()
);

/**
 * ISS-9440's optimistic precondition is keyed to ids the CALLER enumerated, so
 * it cannot describe a set the caller never saw.
 *
 * Returns whether it reported, because the per-entry check must then be
 * SKIPPED rather than merely preceded: run against the empty id set a query
 * selection leaves behind, {@link expectedByIdGuard} reports every key as
 * unselected — up to one issue per guarded id, none of them naming the real
 * problem.
 */
function refineExpectedByIdRequiresIds(
  field: string,
  body: { selection?: BatchDocumentSelection; expectedById?: unknown },
  context: z.RefinementCtx
): boolean {
  if (body.selection === undefined || body.expectedById === undefined) {
    return false;
  }
  context.addIssue({
    code: "custom",
    message: `${field} cannot be combined with selection`,
    path: [field],
  });
  return true;
}

export const batchUpdateStatusValidator = z
  .object({
    documentIds: batchDocumentIdsSchema.optional(),
    selection: batchDocumentSelectionSchema.optional(),
    expectedStatusById: expectedStatusByIdGuard.schema.optional(),
    status: anyArtifactStatusEnum,
    surface: optionalBulkDocumentStatusEditSurface,
    /**
     * ISS-10458: the transaction identity of the bulk mutation THIS request
     * reverses, supplied by the undo registry's inverse. It changes nothing
     * about the write — only what the receipts say — so a request that omits it
     * behaves exactly as it did before the field existed.
     *
     * `z.uuid()`, matching what `newBulkTransactionId` mints, so a caller
     * cannot attach an arbitrary label to an append-only ledger row. Optional
     * because a forward issued against `/v1`, or against an api deployment that
     * predates ISS-9465, reports no id for the undo to name.
     */
    undoOfTransactionId: z.uuid().optional(),
  })
  .strict()
  .superRefine((body, context) => {
    refineBatchSelectionArms(body, context);
    const statusGuardRejected = refineExpectedByIdRequiresIds(
      "expectedStatusById",
      { selection: body.selection, expectedById: body.expectedStatusById },
      context
    );
    if (!statusGuardRejected) {
      expectedStatusByIdGuard.refineEntries(
        body.documentIds ?? [],
        body.expectedStatusById,
        context
      );
    }
  });

export const batchUpdatePriorityValidator = z
  .object({
    documentIds: batchDocumentIdsSchema.optional(),
    selection: batchDocumentSelectionSchema.optional(),
    expectedPriorityById: expectedPriorityByIdGuard.schema.optional(),
    priority: priorityEnum,
    surface: optionalArtifactPriorityEditSurface,
  })
  .strict()
  .superRefine((body, context) => {
    refineBatchSelectionArms(body, context);
    const priorityGuardRejected = refineExpectedByIdRequiresIds(
      "expectedPriorityById",
      { selection: body.selection, expectedById: body.expectedPriorityById },
      context
    );
    if (!priorityGuardRejected) {
      expectedPriorityByIdGuard.refineEntries(
        body.documentIds ?? [],
        body.expectedPriorityById,
        context
      );
    }
  });

export const batchDeleteValidator = z
  .object({
    documentIds: batchDocumentIdsSchema.optional(),
    selection: batchDocumentSelectionSchema.optional(),
  })
  .superRefine(refineBatchSelectionArms);

/**
 * Body schema for `POST /projects/:id/artifacts/move` (PRD-421 / PLN-755).
 * Discriminated union with `.strict()` on every branch so unknown fields are
 * rejected uniformly: `top` / `bottom` reject any extra key (notably
 * `referenceArtifactId`), and `before` / `after` require `referenceArtifactId`
 * while still rejecting anything else. Keeps callers honest at the API
 * boundary so the service never has to handle ambiguous inputs.
 */
/**
 * The optional concurrency precondition on a move (ISS-8728).
 *
 * Declared ONCE and spread into all four arms of the discriminated union rather
 * than written out per arm: the union members are `.strict()`, so a field added
 * to three of them is silently rejected on the fourth — which is how a caller
 * discovers the gap as a 400 on whichever position it happened to use.
 *
 * UUIDs, not {@link uuidOrSlug}. This array is an echo of a prior server read,
 * not something a human types, and a slug arm would cost one resolver lookup per
 * entry inside the transaction that is about to take the write.
 *
 * `.optional()` is the compatibility contract: omitting it keeps the
 * long-standing last-write-wins behavior every shipped caller relies on.
 */
const expectedOrderSchema = z
  .array(z.uuid())
  .max(
    MOVE_ARTIFACT_EXPECTED_ORDER_LIMIT,
    `expectedOrder supports at most ${MOVE_ARTIFACT_EXPECTED_ORDER_LIMIT} artifacts`
  )
  .optional();

export const moveArtifactValidator = z.discriminatedUnion("position", [
  z
    .object({
      artifactId: uuidOrSlug(),
      position: z.literal(MovePosition.Top),
      expectedOrder: expectedOrderSchema,
    })
    .strict(),
  z
    .object({
      artifactId: uuidOrSlug(),
      position: z.literal(MovePosition.Bottom),
      expectedOrder: expectedOrderSchema,
    })
    .strict(),
  z
    .object({
      artifactId: uuidOrSlug(),
      position: z.literal(MovePosition.Before),
      referenceArtifactId: uuidOrSlug(),
      expectedOrder: expectedOrderSchema,
    })
    .strict(),
  z
    .object({
      artifactId: uuidOrSlug(),
      position: z.literal(MovePosition.After),
      referenceArtifactId: uuidOrSlug(),
      expectedOrder: expectedOrderSchema,
    })
    .strict(),
]);

function transformDueDateInput(value: string): Date {
  const isoDateTime = value.includes("T") ? value : `${value}T00:00:00.000Z`;
  return transformIsoDateTime(isoDateTime) ?? new Date(isoDateTime);
}

/**
 * An `expected<Field>ById` optimistic guard: the container schema plus the
 * per-entry refinement that actually checks the values.
 *
 * Parameterized rather than copied per route (ISS-9440). The status route's
 * version WAS the whole shape, and a second hand-written one is precisely how
 * `batch-move` lost its id cap in ISS-9073.
 *
 * The two halves come back TOGETHER, from one call that binds the value schema,
 * because `z.custom` validates only the container: its `Record<string, TValue>`
 * is a type-level claim that nothing checks until `refineEntries` runs. Handing
 * out the schema on its own would be an unvalidated cast on an untrusted body
 * field, so the value schema is bound here and a call site cannot take half the
 * contract. The per-entry rules live at body level because they need the sibling
 * `documentIds`, which the container schema cannot see.
 */
function expectedByIdGuard<TValue>(
  field: string,
  valueSchema: z.ZodType<TValue>
) {
  const schema = z
    .custom<Record<string, TValue>>((value) => isRecord(value), {
      message: `${field} must be an object`,
    })
    .superRefine((expectedById, context) => {
      if (Object.keys(expectedById).length > BATCH_MUTATION_ENTITY_LIMIT) {
        context.addIssue({
          code: z.ZodIssueCode.too_big,
          maximum: BATCH_MUTATION_ENTITY_LIMIT,
          origin: "object",
          inclusive: true,
          message: `${field} supports at most ${BATCH_MUTATION_ENTITY_LIMIT} documents`,
        });
      }
    });

  return {
    schema,
    refineEntries(
      documentIds: string[],
      expectedById: Record<string, TValue> | undefined,
      context: z.RefinementCtx
    ): void {
      if (!expectedById) {
        return;
      }
      // Already reported by the container schema; re-reporting per entry would
      // emit one issue per id past the cap.
      if (Object.keys(expectedById).length > BATCH_MUTATION_ENTITY_LIMIT) {
        return;
      }
      const selectedIds = new Set(documentIds);
      for (const [documentId, expectedValue] of Object.entries(expectedById)) {
        refineExpectedByIdEntry(
          { context, field, selectedIds, valueSchema },
          documentId,
          expectedValue
        );
      }
    },
  };
}

/**
 * One entry of an `expected<Field>ById` map: the key is a uuid the same request
 * selected, and the value parses against the field's own vocabulary.
 *
 * Keys must be selected ids because a guard on an id the batch will not touch
 * can only ever be a client bug, and silently ignoring it would let a caller
 * believe a row was protected when nothing read the entry.
 */
function refineExpectedByIdEntry<TValue>(
  scope: {
    context: z.RefinementCtx;
    field: string;
    selectedIds: Set<string>;
    valueSchema: z.ZodType<TValue>;
  },
  documentId: string,
  expectedValue: TValue
): void {
  const { context, field, selectedIds, valueSchema } = scope;
  const keyResult = expectedByIdKeySchema.safeParse(documentId);
  if (!keyResult.success) {
    addIssuesUnderKey(context, field, documentId, keyResult.error.issues);
    return;
  }

  if (!selectedIds.has(documentId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${field} keys must be selected documentIds`,
      path: [field, documentId],
    });
    return;
  }

  const valueResult = valueSchema.safeParse(expectedValue);
  if (!valueResult.success) {
    addIssuesUnderKey(context, field, documentId, valueResult.error.issues);
  }
}

/** Re-path a nested parse failure onto `<field>.<documentId>…`. */
function addIssuesUnderKey(
  context: z.RefinementCtx,
  field: string,
  documentId: string,
  issues: z.core.$ZodIssue[]
): void {
  for (const issue of issues) {
    context.addIssue({ ...issue, path: [field, documentId, ...issue.path] });
  }
}

/**
 * ISS-11195: a comparison token that reaches a WHERE (`statusGuard`,
 * `titleGuard`) refuses a NUL with a 400. Postgres raises 22021 on a NUL bind
 * parameter, and stripping would compare a value the caller did not send.
 * NUL only, not `postgresStorableTextSchema`: a lone surrogate in a bind
 * parameter is encoded to U+FFFD and does not raise, and the ruling for these
 * tokens is refuse-NUL.
 */
function nulFreeString<Schema extends z.ZodType<string>>(schema: Schema) {
  return schema.refine(
    (value) => !containsNulCharacter(value),
    PostgresTextRejection.ContainsNul
  );
}

/**
 * ISS-8936 — the query half of `GET /documents/summary`: the list predicate,
 * minus every key that describes a PAGE or an ORDER rather than a SET.
 *
 * Same omission and the same reasoning as {@link batchSelectionQuerySchema},
 * which asks the same question of the same shape: a bound is what a summary is
 * defined AGAINST, not part of it — accepting `limit` would let a caller hand
 * the server one window and have the band call it "Total Documents" — and an
 * order cannot change a membership.
 *
 * ISS-12600: `customFieldFilters` is ACCEPTED and resolved to entity ids by
 * `documentSummaryService.summarizeScope`, the same resolution the list read
 * uses, beside the metric-only owner, tag and favorite filters. Those three are
 * not on the list shape because `GET /documents` does not honor them.
 */
export const documentSummaryQueryValidator = documentListFilterShape
  .extend({
    artifactIds: z.preprocess(
      (value) =>
        Array.isArray(value) && value.length === 1 && value[0] === ""
          ? []
          : value,
      z.array(z.uuid()).max(DOCUMENT_SUMMARY_ID_BATCH_SIZE).optional()
    ),
    assigneeIds: documentMetricScopeIdsSchema.optional(),
    includeUnassigned: queryBooleanSchema.optional(),
    tagIds: documentMetricScopeIdsSchema.optional(),
    favoritesOnly: queryBooleanSchema.optional(),
  })
  .omit({
    limit: true,
    offset: true,
    includeTotal: true,
    customFieldSortId: true,
    customFieldSortDir: true,
  });
