import { describe, expect, it } from "vitest";
import {
  DOCUMENT_TYPE_INPUT_OPTIONS,
  DOCUMENT_TYPE_INPUT_TO_CANONICAL,
  DOCUMENT_TYPE_OPTIONS,
  DocumentStatus,
  DocumentType,
  DocumentTypeAlias,
  type DocumentTypeInput,
  fallbackStatusForSubtype,
  IssueStatus,
  isIssueLifecycleSubtype,
  isTerminalStatusForSubtype,
  normalizeDocumentType,
  statusOptionsForSubtype,
} from "./document";

// FEA-3949 Slice A: the DOC (evergreen document) ArtifactSubtype must join the
// DocumentType const SSOT and route through the DocumentStatus lifecycle (like
// every non-FEATURE subtype), not the IssueStatus lifecycle.
describe("DocumentType DOC subtype (FEA-3949)", () => {
  it("exposes DOC as a DocumentType member", () => {
    expect(DocumentType.Doc).toBe("DOC");
  });

  it("includes DOC in DOCUMENT_TYPE_OPTIONS", () => {
    expect(DOCUMENT_TYPE_OPTIONS).toContain(DocumentType.Doc);
  });

  it("selects the DocumentStatus vocabulary for DOC (not IssueStatus)", () => {
    const options = statusOptionsForSubtype(DocumentType.Doc);
    expect(options).toContain(DocumentStatus.Draft);
    expect(options).not.toContain(IssueStatus.Backlog);
  });

  it("falls back to DRAFT for a DOC with an out-of-contract status", () => {
    expect(fallbackStatusForSubtype(DocumentType.Doc)).toBe(
      DocumentStatus.Draft
    );
  });

  it("treats APPROVED as terminal for DOC and DRAFT as non-terminal", () => {
    expect(
      isTerminalStatusForSubtype(DocumentType.Doc, DocumentStatus.Approved)
    ).toBe(true);
    expect(
      isTerminalStatusForSubtype(DocumentType.Doc, DocumentStatus.Draft)
    ).toBe(false);
  });
});

// ISS-4397: `ISSUE` is a first-class *input* document type that normalizes to
// the persisted `FEATURE` subtype. It is intentionally NOT a persisted
// DocumentType member (so no exhaustive Record<DocumentType,…> map fragments);
// it only widens the accepted-input vocabulary and maps to FEATURE for storage.
describe("ISSUE input alias (ISS-4397)", () => {
  it("includes both ISSUE and FEATURE in DOCUMENT_TYPE_INPUT_OPTIONS", () => {
    expect(DOCUMENT_TYPE_INPUT_OPTIONS).toContain(DocumentTypeAlias.Issue);
    expect(DOCUMENT_TYPE_INPUT_OPTIONS).toContain(DocumentType.Feature);
  });

  it("keeps ISSUE OUT of the persisted DOCUMENT_TYPE_OPTIONS", () => {
    // ISSUE must never persist — it normalizes to FEATURE before storage.
    const persisted: readonly string[] = DOCUMENT_TYPE_OPTIONS;
    expect(persisted).not.toContain(DocumentTypeAlias.Issue);
    expect(persisted).toContain(DocumentType.Feature);
  });

  it("normalizes ISSUE to the persisted FEATURE subtype", () => {
    expect(normalizeDocumentType(DocumentTypeAlias.Issue)).toBe(
      DocumentType.Feature
    );
  });

  it("returns every canonical DocumentType unchanged when normalizing", () => {
    for (const type of DOCUMENT_TYPE_OPTIONS) {
      expect(normalizeDocumentType(type)).toBe(type);
    }
  });

  it("maps every input type to a persisted DocumentType via the exhaustive record", () => {
    // Exhaustive: every input value has a canonical mapping and the target is a
    // persisted DocumentType (never the ISSUE alias).
    for (const input of DOCUMENT_TYPE_INPUT_OPTIONS) {
      const canonical = DOCUMENT_TYPE_INPUT_TO_CANONICAL[input];
      expect(DOCUMENT_TYPE_OPTIONS).toContain(canonical);
    }
  });

  it("keeps a compile-time exhaustive keys-covered guard over the input record", () => {
    // If a new DocumentTypeInput member is added without a mapping entry, this
    // typed alias fails `tsc` (missing key) — the guard is compile-time; the
    // runtime assertion just anchors the type so the guard is not dead code.
    const keysCovered: Record<DocumentTypeInput, DocumentType> =
      DOCUMENT_TYPE_INPUT_TO_CANONICAL;
    expect(Object.keys(keysCovered).sort()).toEqual(
      [...DOCUMENT_TYPE_INPUT_OPTIONS].sort()
    );
  });
});

// FEA-3956 Phase 3: the widened Prisma ArtifactSubtype enum now PERMITS the
// canonical `ISSUE` value at the column even though no code path persists it
// (writes normalize ISSUE → FEATURE at the boundary). A version-skewed or direct
// write could still land a stored `ISSUE` row, so the lifecycle SSOT must treat
// a stored `ISSUE` as the Issue (delivery) lifecycle — NOT silently fall through
// to the Document (authoring) lifecycle, which would accept APPROVED / reject
// DONE and mis-terminate blockers.
describe("stored ISSUE follows the Issue lifecycle (FEA-3956)", () => {
  it("classifies both FEATURE and a stray stored ISSUE as the Issue lifecycle", () => {
    expect(isIssueLifecycleSubtype(DocumentType.Feature)).toBe(true);
    expect(isIssueLifecycleSubtype(DocumentTypeAlias.Issue)).toBe(true);
    // A genuine Document subtype is NOT the Issue lifecycle.
    expect(isIssueLifecycleSubtype(DocumentType.Prd)).toBe(false);
  });

  it("selects the IssueStatus vocabulary for a stored ISSUE (not DocumentStatus)", () => {
    const options = statusOptionsForSubtype(DocumentTypeAlias.Issue);
    expect(options).toContain(IssueStatus.Backlog);
    expect(options).not.toContain(DocumentStatus.Draft);
  });

  it("treats DONE as terminal and APPROVED as non-terminal for a stored ISSUE", () => {
    expect(
      isTerminalStatusForSubtype(DocumentTypeAlias.Issue, IssueStatus.Done)
    ).toBe(true);
    // APPROVED is a Document-only terminal status; it must NOT terminate an Issue.
    expect(
      isTerminalStatusForSubtype(
        DocumentTypeAlias.Issue,
        DocumentStatus.Approved
      )
    ).toBe(false);
  });

  it("falls back to BACKLOG for a stored ISSUE with an out-of-contract status", () => {
    expect(fallbackStatusForSubtype(DocumentTypeAlias.Issue)).toBe(
      IssueStatus.Backlog
    );
  });
});
