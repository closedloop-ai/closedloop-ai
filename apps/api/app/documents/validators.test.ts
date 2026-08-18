import {
  DocumentStatus,
  DocumentType,
  DocumentTypeAlias,
  IssueStatus,
} from "@repo/api/src/types/document";
import { describe, expect, it } from "vitest";
import {
  createDocumentValidator,
  findDocumentsQueryValidator,
} from "./validators";

// FEA-3949 Slice A: the DOC (evergreen document) subtype must be accepted by
// the document validators, which derive their type enum from the DocumentType
// SSOT. DOC routes through the DocumentStatus lifecycle, so a DRAFT status is
// valid for it.
describe("document validators accept the DOC subtype (FEA-3949)", () => {
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

  // FEA-4345: the converse guard — org-level types must NOT carry a project.
  it("createDocumentValidator rejects a projectId on a DOC (org-level type)", () => {
    const result = createDocumentValidator.safeParse({
      projectId: "11111111-1111-1111-1111-111111111111",
      type: DocumentType.Doc,
      title: "Team handbook",
      content: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.path.includes("projectId"))
      ).toBe(true);
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
  });

  it("findDocumentsQueryValidator rejects an offset without a limit (FEA-4373)", () => {
    const result = findDocumentsQueryValidator.safeParse({ offset: "50" });
    expect(result.success).toBe(false);
  });

  it("findDocumentsQueryValidator rejects includeTotal=true without a limit (ISS-4576, shafty023)", () => {
    // Requesting the total over an unbounded read materializes the full set plus
    // a full count — a self-DoS. The boundary must reject it.
    const result = findDocumentsQueryValidator.safeParse({
      includeTotal: "true",
    });
    expect(result.success).toBe(false);
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

  it("findDocumentsQueryValidator rejects an unknown type", () => {
    const result = findDocumentsQueryValidator.safeParse({ type: "EPIC" });
    expect(result.success).toBe(false);
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
