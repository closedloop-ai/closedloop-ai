import { randomUUID } from "node:crypto";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { IMAGE_MIME_TYPES } from "@repo/api/src/types/attachment";
import { Priority } from "@repo/api/src/types/common";
import {
  DOCUMENT_LIST_MAX_OFFSET,
  DOCUMENT_LIST_MAX_SEARCH_LENGTH,
  DocumentStatus,
  DocumentType,
  DocumentTypeAlias,
  IssueStatus,
} from "@repo/api/src/types/document";
import { NUL_CHARACTER as NUL } from "@repo/api/src/types/postgres-text";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  batchUpdatePriorityValidator,
  batchUpdateStatusValidator,
  createDocumentValidator,
  findDocumentsQueryValidator,
  newVersionValidator,
  updateDocumentValidator,
} from "./validators";

// FEA-3949 Slice A: the DOC (evergreen document) subtype must be accepted by
// the document validators, which derive their type enum from the DocumentType
// SSOT. DOC routes through the DocumentStatus lifecycle, so a DRAFT status is
// valid for it.
describe("document validators accept the DOC subtype (FEA-3949)", () => {
  it("validates the union subtype filter and rejects unknown or blank types", () => {
    const types = [
      DocumentType.Prd,
      DocumentType.ImplementationPlan,
      DocumentType.Doc,
    ];
    expect(findDocumentsQueryValidator.parse({ types }).types).toEqual(types);
    expect(
      findDocumentsQueryValidator.safeParse({ types: ["unknown"] }).success
    ).toBe(false);
    expect(findDocumentsQueryValidator.safeParse({ types: [""] }).success).toBe(
      false
    );
    expect(findDocumentsQueryValidator.safeParse({ types: [] }).success).toBe(
      false
    );
  });
  it("createDocumentValidator parses a DOC document", () => {
    // DOC is org-level (FEA-4345): created without a project.
    const result = createDocumentValidator.safeParse({
      type: DocumentType.Doc,
      title: "Onboarding guide",
      content: "# Onboarding",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe(DocumentType.Doc);
    }
  });

  it("createDocumentValidator accepts a DocumentStatus for a DOC", () => {
    const result = createDocumentValidator.safeParse({
      type: DocumentType.Doc,
      title: "Onboarding guide",
      content: "# Onboarding",
      status: DocumentStatus.Draft,
    });
    expect(result.success).toBe(true);
  });

  // FEA-4345: an org-level Document (DOC) is created without a project.
  it("createDocumentValidator accepts a project-less DOC (org-level create)", () => {
    const result = createDocumentValidator.safeParse({
      type: DocumentType.Doc,
      title: "Team handbook",
      content: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBeUndefined();
    }
  });

  it("createDocumentValidator accepts a project-less TEMPLATE (org-level create)", () => {
    const result = createDocumentValidator.safeParse({
      type: DocumentType.Template,
      title: "PRD template",
      content: "",
    });
    expect(result.success).toBe(true);
  });

  // ISS-12858 (PRD-799 G-04): a DOC may be created inside a project.
  it("createDocumentValidator accepts a projectId on a DOC (ISS-12858)", () => {
    const projectId = "11111111-1111-1111-1111-111111111111";
    const result = createDocumentValidator.safeParse({
      projectId,
      type: DocumentType.Doc,
      title: "Team handbook",
      content: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBe(projectId);
    }
  });

  it("createDocumentValidator rejects a projectId on a TEMPLATE (org-level type)", () => {
    // Previously reached the service and threw → 500; now a clean 400 at the
    // validator boundary.
    const result = createDocumentValidator.safeParse({
      projectId: "11111111-1111-1111-1111-111111111111",
      type: DocumentType.Template,
      title: "PRD template",
      content: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: z.ZodIssueCode.custom,
        path: ["projectId"],
      });
    }
  });

  it("createDocumentValidator still requires a projectId for a PRD (project-bound subtype)", () => {
    const result = createDocumentValidator.safeParse({
      type: DocumentType.Prd,
      title: "New PRD",
      content: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.path.includes("projectId"))
      ).toBe(true);
    }
  });

  it("createDocumentValidator still requires a projectId for a FEATURE (project-bound subtype)", () => {
    const result = createDocumentValidator.safeParse({
      type: DocumentType.Feature,
      title: "New issue",
      content: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: z.ZodIssueCode.custom,
        path: ["projectId"],
      });
    }
  });

  it("findDocumentsQueryValidator accepts DOC as a type filter", () => {
    const result = findDocumentsQueryValidator.safeParse({
      type: DocumentType.Doc,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe(DocumentType.Doc);
    }
  });

  it("findDocumentsQueryValidator trims and keeps a search term (ISS-9724)", () => {
    const result = findDocumentsQueryValidator.safeParse({
      search: "  quarterly plan  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.search).toBe("quarterly plan");
    }
  });

  it("findDocumentsQueryValidator rejects a whitespace-only search rather than dropping it (ISS-9724)", () => {
    // Coercing it to "no search" would answer with the whole population while
    // the caller's box still showed text — a filter silently dropped, which the
    // GET /search contract already refuses to do.
    const result = findDocumentsQueryValidator.safeParse({ search: "   " });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toEqual([
        ["search"],
      ]);
    }
  });

  it("findDocumentsQueryValidator rejects a search term past the length bound (ISS-9724)", () => {
    const result = findDocumentsQueryValidator.safeParse({
      search: "x".repeat(DOCUMENT_LIST_MAX_SEARCH_LENGTH + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toEqual([
        ["search"],
      ]);
    }
  });

  it("findDocumentsQueryValidator rejects an unknown filter token rather than ignoring it (ISS-9724)", () => {
    // `.strict()` is what makes a misspelled filter a 400 instead of a read that
    // silently answers a wider question than the caller asked.
    const result = findDocumentsQueryValidator.safeParse({ searchText: "abc" });
    expect(result.success).toBe(false);
  });

  it("findDocumentsQueryValidator keeps a search term containing SQL and LIKE metacharacters (ISS-9724)", () => {
    // The boundary's job is to admit the term intact; neutralizing `%`/`_` is
    // the predicate's, and rejecting these here would make them unsearchable.
    const result = findDocumentsQueryValidator.safeParse({
      search: "100% o'brien_v2",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.search).toBe("100% o'brien_v2");
    }
  });

  it("findDocumentsQueryValidator coerces unassignedProject 'true' to a boolean (FEA-4140)", () => {
    const result = findDocumentsQueryValidator.safeParse({
      type: DocumentType.Doc,
      unassignedProject: "true",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.unassignedProject).toBe(true);
    }
  });

  it("findDocumentsQueryValidator coerces unassignedProject 'false' to a boolean (FEA-4140)", () => {
    const result = findDocumentsQueryValidator.safeParse({
      unassignedProject: "false",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.unassignedProject).toBe(false);
    }
  });

  it("findDocumentsQueryValidator rejects a non-boolean unassignedProject (FEA-4140)", () => {
    const result = findDocumentsQueryValidator.safeParse({
      unassignedProject: "1",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: z.ZodIssueCode.invalid_value,
        path: ["unassignedProject"],
      });
    }
  });

  it("findDocumentsQueryValidator rejects an offset without a limit (FEA-4373)", () => {
    const result = findDocumentsQueryValidator.safeParse({ offset: "50" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: z.ZodIssueCode.custom,
        path: ["offset"],
      });
    }
  });

  it.each([DOCUMENT_LIST_MAX_OFFSET + 1, Number.MAX_SAFE_INTEGER])(
    "findDocumentsQueryValidator accepts offset %i past the old ceiling (ISS-11161)",
    (offset) => {
      const result = findDocumentsQueryValidator.safeParse({
        limit: "100",
        offset: String(offset),
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.offset).toBe(offset);
      }
    }
  );

  it("findDocumentsQueryValidator still rejects a negative offset (ISS-11161)", () => {
    const result = findDocumentsQueryValidator.safeParse({
      limit: "100",
      offset: "-1",
    });
    expect(result.success).toBe(false);
  });

  it("findDocumentsQueryValidator rejects includeTotal=true without a limit (ISS-4576, davetho)", () => {
    // Requesting the total over an unbounded read materializes the full set plus
    // a full count — a self-DoS. The boundary must reject it.
    const result = findDocumentsQueryValidator.safeParse({
      includeTotal: "true",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: z.ZodIssueCode.custom,
        path: ["includeTotal"],
      });
    }
  });

  it("findDocumentsQueryValidator accepts includeTotal=true with a limit (ISS-4576)", () => {
    const result = findDocumentsQueryValidator.safeParse({
      includeTotal: "true",
      limit: "50",
      offset: "0",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeTotal).toBe(true);
      expect(result.data.limit).toBe(50);
    }
  });

  it("findDocumentsQueryValidator accepts includeTotal=false without a limit (ISS-4576)", () => {
    // The bare-array read owns the unbounded default; only the total-bearing
    // envelope requires a bound.
    const result = findDocumentsQueryValidator.safeParse({
      includeTotal: "false",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeTotal).toBe(false);
    }
  });
});

// ISS-4397: the API accepts `type=ISSUE` (previously rejected as "Invalid query
// parameters"), normalizes it to the persisted FEATURE subtype, and keeps
// `type=FEATURE` working as an alias — both resolve to FEATURE-typed artifacts.
describe("document validators accept the ISSUE type alias (ISS-4397)", () => {
  const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

  it("findDocumentsQueryValidator accepts type=ISSUE and normalizes it to FEATURE", () => {
    const result = findDocumentsQueryValidator.safeParse({
      type: DocumentTypeAlias.Issue,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Normalized to the persisted subtype so the downstream Prisma `where`
      // filter (subtype = FEATURE) matches existing Issue rows.
      expect(result.data.type).toBe(DocumentType.Feature);
    }
  });

  it("findDocumentsQueryValidator still accepts type=FEATURE (compat alias)", () => {
    const result = findDocumentsQueryValidator.safeParse({
      type: DocumentType.Feature,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe(DocumentType.Feature);
    }
  });

  it("findDocumentsQueryValidator accepts a single status occurrence (ISS-6778)", () => {
    const result = findDocumentsQueryValidator.safeParse({
      status: [IssueStatus.Todo],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toEqual([IssueStatus.Todo]);
    }
  });

  it("findDocumentsQueryValidator keeps EVERY repeated status occurrence (ISS-6778)", () => {
    // The multi-value shape AGENTS.md asks to be asserted. Keeping only one
    // would answer a two-status request with one status and say nothing.
    const result = findDocumentsQueryValidator.safeParse({
      status: [IssueStatus.Todo, IssueStatus.InProgress],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toEqual([
        IssueStatus.Todo,
        IssueStatus.InProgress,
      ]);
    }
  });

  it("findDocumentsQueryValidator trims each status occurrence (ISS-6778)", () => {
    // A hand-written curl picks up stray whitespace; that is a spelling slip in
    // a value the caller did ask for, not a status to drop (marisolashgrove).
    const result = findDocumentsQueryValidator.safeParse({
      status: [` ${IssueStatus.Todo}`, `${IssueStatus.InProgress} `],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toEqual([
        IssueStatus.Todo,
        IssueStatus.InProgress,
      ]);
    }
  });

  it("findDocumentsQueryValidator rejects a comma-joined status set (ISS-6778)", () => {
    // The comma form is not a second accepted spelling. Accepting it silently
    // would leave two wire shapes for one filter; rejecting it tells a caller
    // who reached for `/search`-style habits exactly which one is wrong.
    const result = findDocumentsQueryValidator.safeParse({
      status: [`${IssueStatus.Todo},${IssueStatus.InProgress}`],
    });
    expect(result.success).toBe(false);
  });

  it("findDocumentsQueryValidator leaves status unset when it is omitted (ISS-6778)", () => {
    // The live-endpoint case: every shipped consumer sends no `status` and must
    // keep getting the unnarrowed list.
    const result = findDocumentsQueryValidator.safeParse({
      type: DocumentType.Doc,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBeUndefined();
    }
  });

  it("findDocumentsQueryValidator accepts a Document status alongside type=FEATURE (ISS-6778)", () => {
    // The pairing is deliberately NOT policed: `Artifact.status` is freeform and
    // a FEATURE carrying OBSOLETE exists in production, so refusing this would
    // make exactly those rows unreachable through the filter meant to find them.
    const result = findDocumentsQueryValidator.safeParse({
      type: DocumentType.Feature,
      status: [DocumentStatus.Obsolete],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toEqual([DocumentStatus.Obsolete]);
    }
  });

  it("findDocumentsQueryValidator rejects a status outside both vocabularies (ISS-6778)", () => {
    // The half that keeps a typo loud. Accepting it would return the whole
    // population behind a parameter the caller believes narrowed it.
    const result = findDocumentsQueryValidator.safeParse({ status: ["TODOO"] });
    expect(result.success).toBe(false);
  });

  it("findDocumentsQueryValidator rejects a blank or whitespace-only status (ISS-6778)", () => {
    // `?status=` is malformed, not "no filter" — a client with nothing selected
    // omits the parameter, so a blank occurrence can only be a status that
    // failed to spell itself, and widening to the whole population behind it
    // is the silent no-op this ticket is about.
    expect(
      findDocumentsQueryValidator.safeParse({ status: [""] }).success
    ).toBe(false);
    expect(
      findDocumentsQueryValidator.safeParse({ status: ["   "] }).success
    ).toBe(false);
    expect(
      findDocumentsQueryValidator.safeParse({
        status: [IssueStatus.Todo, ""],
      }).success
    ).toBe(false);
  });

  it("findDocumentsQueryValidator rejects more occurrences than the vocabulary has (ISS-6778)", () => {
    const tooMany = new Array(20).fill(IssueStatus.Todo);
    expect(
      findDocumentsQueryValidator.safeParse({ status: tooMany }).success
    ).toBe(false);
  });

  it("findDocumentsQueryValidator rejects an unknown type", () => {
    const result = findDocumentsQueryValidator.safeParse({ type: "EPIC" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: z.ZodIssueCode.invalid_value,
        path: ["type"],
      });
    }
  });

  it("createDocumentValidator accepts type=ISSUE and round-trips it to FEATURE", () => {
    const result = createDocumentValidator.safeParse({
      projectId: PROJECT_ID,
      type: DocumentTypeAlias.Issue,
      title: "New issue via ISSUE alias",
      content: "# Issue",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // The create input persists as FEATURE; ISSUE never reaches the service.
      expect(result.data.type).toBe(DocumentType.Feature);
    }
  });

  it("createDocumentValidator requires a projectId for ISSUE (project-bound, like FEATURE)", () => {
    const result = createDocumentValidator.safeParse({
      type: DocumentTypeAlias.Issue,
      title: "Project-less issue",
      content: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.path.includes("projectId"))
      ).toBe(true);
    }
  });

  it("createDocumentValidator accepts a IssueStatus for an ISSUE create", () => {
    const result = createDocumentValidator.safeParse({
      projectId: PROJECT_ID,
      type: DocumentTypeAlias.Issue,
      title: "Triaged issue",
      content: "",
      status: IssueStatus.Triage,
    });
    expect(result.success).toBe(true);
  });
});

describe("document validators parse artifact priority values (ISS-9445)", () => {
  it.each([Priority.Low, Priority.Medium, Priority.High, Priority.Urgent])(
    "accepts %s on create, update, and batch update",
    (priority) => {
      const createResult = createDocumentValidator.safeParse({
        content: "",
        priority,
        projectId: randomUUID(),
        title: "New issue",
        type: DocumentType.Feature,
      });
      const updateResult = updateDocumentValidator.safeParse({ priority });
      const batchResult = batchUpdatePriorityValidator.safeParse({
        documentIds: [randomUUID()],
        priority,
      });

      expect(createResult.success).toBe(true);
      expect(updateResult.success).toBe(true);
      expect(batchResult.success).toBe(true);
    }
  );

  it("keeps an omitted create priority absent rather than defaulting it", () => {
    const result = createDocumentValidator.safeParse({
      content: "",
      projectId: randomUUID(),
      title: "New issue",
      type: DocumentType.Feature,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect("priority" in result.data).toBe(false);
    }
  });

  it("accepts null only on update, where it means clear priority", () => {
    const createResult = createDocumentValidator.safeParse({
      content: "",
      priority: null,
      projectId: randomUUID(),
      title: "New issue",
      type: DocumentType.Feature,
    });
    const updateResult = updateDocumentValidator.safeParse({ priority: null });

    expect(createResult.success).toBe(false);
    expect(updateResult.success).toBe(true);
    if (updateResult.success) {
      expect(updateResult.data.priority).toBeNull();
    }
  });

  it("rejects an unknown priority token instead of folding it to a default", () => {
    const createResult = createDocumentValidator.safeParse({
      content: "",
      priority: "BLOCKER",
      projectId: randomUUID(),
      title: "New issue",
      type: DocumentType.Feature,
    });
    const updateResult = updateDocumentValidator.safeParse({
      priority: "BLOCKER",
    });
    const batchResult = batchUpdatePriorityValidator.safeParse({
      documentIds: [randomUUID()],
      priority: "BLOCKER",
    });

    expect(createResult.success).toBe(false);
    expect(updateResult.success).toBe(false);
    expect(batchResult.success).toBe(false);
  });
});

// ISS-9440: the single-artifact optimistic guard. Three request shapes that a
// `Priority | undefined` field could not express between them, so each is
// pinned rather than only the happy one.
describe("updateDocumentValidator parses the priority guard (ISS-9440)", () => {
  it("keeps an omitted guard absent rather than normalizing it to null", () => {
    const result = updateDocumentValidator.safeParse({
      priority: Priority.High,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // Omission is what an older client sends and what "unguarded" means; a
      // `null` here would silently become an assertion that the artifact holds
      // no priority.
      expect("expectedPriority" in result.data).toBe(false);
    }
  });

  it("accepts a null guard as the assertion that no priority is set", () => {
    const result = updateDocumentValidator.safeParse({
      expectedPriority: null,
      priority: Priority.High,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.expectedPriority).toBeNull();
    }
  });

  it("rejects a guard value outside the vocabulary", () => {
    const result = updateDocumentValidator.safeParse({
      expectedPriority: "CRITICAL",
      priority: Priority.High,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.path.includes("expectedPriority")
        )
      ).toBe(true);
    }
  });
});

// ISS-11198: a title or assignee guard is valid only beside the field it
// guards, and reaches the service byte for byte.
describe("updateDocumentValidator parses the title and assignee guards (ISS-11198)", () => {
  it("keeps an untrimmed title guard and a null assignee guard", () => {
    const result = updateDocumentValidator.safeParse({
      title: "Plan v2",
      expectedTitle: " Plan ",
      assigneeId: randomUUID(),
      expectedAssigneeId: null,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.expectedTitle).toBe(" Plan ");
      expect(result.data.expectedAssigneeId).toBeNull();
    }
  });

  it("refuses each guard sent without its field", () => {
    const title = updateDocumentValidator.safeParse({ expectedTitle: "Plan" });
    const assignee = updateDocumentValidator.safeParse({
      expectedAssigneeId: null,
    });

    expect(title.error?.issues.map((issue) => issue.message)).toEqual([
      "Send `expectedTitle` only together with `title`",
    ]);
    expect(assignee.error?.issues.map((issue) => issue.path)).toEqual([
      ["expectedAssigneeId"],
    ]);
  });
});

/**
 * ISS-9443 review — `surface` is OPTIONAL provenance for telemetry and is never
 * required for the write, so version skew must cost the event and not the
 * user's mutation. These pin the difference between an UNRECOGNIZED member
 * (degrade to `undefined`, write proceeds) and a KNOWN-but-inapplicable one
 * (still a 400 on the priority batch, which is a deliberate contract).
 */
describe("edit-surface provenance under version skew", () => {
  it("drops a surface this build cannot place, leaving the update valid", () => {
    const result = updateDocumentValidator.safeParse({
      priority: Priority.High,
      surface: "command_palette",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // Dropped, not preserved: an origin we cannot place must not be counted.
      expect(result.data.surface).toBeUndefined();
      // Positive control on the SAME field — a known member still survives, so
      // the assertion above cannot pass by the field being dropped wholesale.
      expect(result.data.priority).toBe(Priority.High);
    }

    const known = updateDocumentValidator.safeParse({
      priority: Priority.High,
      surface: ArtifactStatusEditSurface.Detail,
    });
    expect(known.success).toBe(true);
    if (known.success) {
      expect(known.data.surface).toBe(ArtifactStatusEditSurface.Detail);
    }
  });

  it("drops an unplaceable surface on the priority batch rather than 400ing it", () => {
    const result = batchUpdatePriorityValidator.safeParse({
      documentIds: [randomUUID()],
      priority: Priority.High,
      surface: "command_palette",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.surface).toBeUndefined();
    }
  });

  it("still refuses a KNOWN surface a priority cannot come from", () => {
    // `board` is a kanban column, which writes a status. Unlike an unknown
    // value this one IS placeable, and placing it would put a real number on a
    // bar nobody can click — so it stays a 400.
    const result = batchUpdatePriorityValidator.safeParse({
      documentIds: [randomUUID()],
      priority: Priority.High,
      surface: ArtifactStatusEditSurface.Board,
    });

    expect(result.success).toBe(false);
  });
});

// ISS-11195: every stored text field is stripped of NUL (and lone surrogates)
// BEFORE its own length rule runs; every comparison token that reaches a WHERE
// refuses a NUL instead, because stripping would compare a different value.
describe("document text fields and NUL (ISS-11195)", () => {
  const LONE_HIGH_SURROGATE = String.fromCharCode(0xd8_00);
  const REPLACEMENT = String.fromCharCode(0xff_fd);
  const FIELD_ID = randomUUID();

  it("strips NUL from create title, fileName and content", () => {
    const result = createDocumentValidator.safeParse({
      type: DocumentType.Doc,
      title: `a${NUL}b`,
      fileName: `f${NUL}.md`,
      content: `c${NUL}d`,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      title: "ab",
      fileName: "f.md",
      content: "cd",
    });
  });

  it("rewrites a lone surrogate in content to U+FFFD", () => {
    const result = newVersionValidator.safeParse({
      content: `x${LONE_HIGH_SURROGATE}y`,
    });

    expect(result.data?.content).toBe(`x${REPLACEMENT}y`);
  });

  it("strips NUL from version content", () => {
    const result = newVersionValidator.safeParse({ content: `v${NUL}1` });

    expect(result.data?.content).toBe("v1");
  });

  it("strips NUL from inline-image placeholder, filename and altText on create and version", () => {
    const inlineImages = [
      {
        placeholder: `{{img${NUL}}}`,
        filename: `a${NUL}.png`,
        mimeType: IMAGE_MIME_TYPES[0],
        dataBase64: "AAAA",
        altText: `alt${NUL}`,
      },
    ];
    const stripped = {
      placeholder: "{{img}}",
      filename: "a.png",
      altText: "alt",
    };

    const created = createDocumentValidator.safeParse({
      type: DocumentType.Doc,
      title: "T",
      content: "{{img}}",
      inlineImages,
    });
    const versioned = newVersionValidator.safeParse({
      content: "{{img}}",
      inlineImages,
    });

    expect(created.data?.inlineImages?.[0]).toMatchObject(stripped);
    expect(versioned.data?.inlineImages?.[0]).toMatchObject(stripped);
  });

  it("still refuses an inline-image filename that is nothing but NULs", () => {
    expect(
      newVersionValidator.safeParse({
        content: "{{img}}",
        inlineImages: [
          {
            placeholder: "{{img}}",
            filename: NUL,
            mimeType: IMAGE_MIME_TYPES[0],
            dataBase64: "AAAA",
          },
        ],
      }).success
    ).toBe(false);
  });

  it("strips NUL from update title, fileName and string custom-field values", () => {
    const result = updateDocumentValidator.safeParse({
      title: `a${NUL}b`,
      fileName: `f${NUL}`,
      customFields: { [FIELD_ID]: `v${NUL}` },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      title: "ab",
      fileName: "f",
      customFields: { [FIELD_ID]: "v" },
    });
  });

  it("leaves non-string custom-field values alone", () => {
    const result = updateDocumentValidator.safeParse({
      customFields: { [FIELD_ID]: 3 },
    });

    expect(result.data?.customFields).toEqual({ [FIELD_ID]: 3 });
  });

  it("still refuses a title that is nothing but NULs", () => {
    // The length rule runs on the sanitized value, so this is an empty title.
    expect(updateDocumentValidator.safeParse({ title: NUL }).success).toBe(
      false
    );
    expect(
      createDocumentValidator.safeParse({
        type: DocumentType.Doc,
        title: `${NUL}${NUL}`,
        content: "",
      }).success
    ).toBe(false);
  });

  it("refuses a NUL in expectedStatus and expectedTitle", () => {
    expect(
      updateDocumentValidator.safeParse({
        status: IssueStatus.Done,
        expectedStatus: `${IssueStatus.Todo}${NUL}`,
      }).success
    ).toBe(false);
    expect(
      updateDocumentValidator.safeParse({
        title: "New",
        expectedTitle: `Old${NUL}`,
      }).success
    ).toBe(false);
  });

  it("accepts expectedStatus and expectedTitle with no NUL unchanged", () => {
    const result = updateDocumentValidator.safeParse({
      status: IssueStatus.Done,
      expectedStatus: IssueStatus.Todo,
      title: "New",
      expectedTitle: "Old 🚀 ",
    });

    expect(result.data).toMatchObject({
      expectedStatus: IssueStatus.Todo,
      expectedTitle: "Old 🚀 ",
    });
  });

  it("refuses a NUL in a bulk expectedStatusById value", () => {
    const id = randomUUID();

    expect(
      batchUpdateStatusValidator.safeParse({
        documentIds: [id],
        status: IssueStatus.Done,
        expectedStatusById: { [id]: `${IssueStatus.Todo}${NUL}` },
      }).success
    ).toBe(false);
    expect(
      batchUpdateStatusValidator.safeParse({
        documentIds: [id],
        status: IssueStatus.Done,
        expectedStatusById: { [id]: IssueStatus.Todo },
      }).success
    ).toBe(true);
  });
});
