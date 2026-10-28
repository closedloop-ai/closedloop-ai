import {
  DocumentStatus,
  DocumentType,
  DocumentTypeAlias,
  IssueStatus,
  isTerminalStatusForSubtype,
  TERMINAL_DOCUMENT_STATUSES,
  TERMINAL_ISSUE_STATUSES,
} from "@repo/api/src/types/document";
import { describe, expect, it } from "vitest";
import {
  acceptsUnblockDestination,
  BLOCKED_STATUS,
  type InboundBlockerRow,
  selectUnblockableIds,
  UNBLOCKED_STATUS,
} from "../blocked-dependent-resolution";

/**
 * ISS-9632 decision core. Every case here is a rule the DB wiring delegates to,
 * so each fails on its own if the corresponding branch is reverted.
 */

const DEPENDENT = "dependent-1";
const OTHER_DEPENDENT = "dependent-2";

function issueCandidate(id: string) {
  return { id, subtype: DocumentType.Feature };
}

function blocker(
  targetId: string,
  subtype: string | null,
  status: string
): InboundBlockerRow {
  return { targetId, source: { subtype, status } };
}

describe("selectUnblockableIds", () => {
  it("keeps a dependent BLOCKED while one of its two blockers is still live", () => {
    const result = selectUnblockableIds({
      candidates: [issueCandidate(DEPENDENT)],
      inboundBlockers: [
        blocker(DEPENDENT, DocumentType.Feature, IssueStatus.Done),
        blocker(DEPENDENT, DocumentType.Feature, IssueStatus.InProgress),
      ],
    });

    expect(result).toEqual([]);
  });

  it("unblocks the same dependent once the second blocker also goes terminal", () => {
    const result = selectUnblockableIds({
      candidates: [issueCandidate(DEPENDENT)],
      inboundBlockers: [
        blocker(DEPENDENT, DocumentType.Feature, IssueStatus.Done),
        blocker(DEPENDENT, DocumentType.Feature, IssueStatus.Canceled),
      ],
    });

    expect(result).toEqual([DEPENDENT]);
  });

  it("treats CANCELED exactly as DONE — a negative terminal still unblocks", () => {
    const canceledOnly = selectUnblockableIds({
      candidates: [issueCandidate(DEPENDENT)],
      inboundBlockers: [
        blocker(DEPENDENT, DocumentType.Feature, IssueStatus.Canceled),
      ],
    });
    const doneOnly = selectUnblockableIds({
      candidates: [issueCandidate(OTHER_DEPENDENT)],
      inboundBlockers: [
        blocker(OTHER_DEPENDENT, DocumentType.Feature, IssueStatus.Done),
      ],
    });

    expect(canceledOnly).toEqual([DEPENDENT]);
    expect(doneOnly).toEqual([OTHER_DEPENDENT]);
  });

  it("unblocks on an APPROVED Document blocker, which is terminal post-PRD-495", () => {
    const result = selectUnblockableIds({
      candidates: [issueCandidate(DEPENDENT)],
      inboundBlockers: [
        blocker(DEPENDENT, DocumentType.Prd, DocumentStatus.Approved),
      ],
    });

    expect(result).toEqual([DEPENDENT]);
  });

  it("keeps a dependent blocked by an IN_REVIEW Document, which is not terminal for that vocabulary", () => {
    const result = selectUnblockableIds({
      candidates: [issueCandidate(DEPENDENT)],
      inboundBlockers: [
        blocker(DEPENDENT, DocumentType.Prd, DocumentStatus.InReview),
      ],
    });

    expect(result).toEqual([]);
  });

  it("classifies a blocker on the canonical ISSUE subtype alias by the Issue vocabulary", () => {
    const done = selectUnblockableIds({
      candidates: [issueCandidate(DEPENDENT)],
      inboundBlockers: [
        blocker(DEPENDENT, DocumentTypeAlias.Issue, IssueStatus.Done),
      ],
    });
    const live = selectUnblockableIds({
      candidates: [issueCandidate(OTHER_DEPENDENT)],
      inboundBlockers: [
        blocker(OTHER_DEPENDENT, DocumentTypeAlias.Issue, IssueStatus.Todo),
      ],
    });

    expect(done).toEqual([DEPENDENT]);
    expect(live).toEqual([]);
  });

  it("never writes a Document-lifecycle artifact to TODO, even with every blocker resolved", () => {
    const result = selectUnblockableIds({
      candidates: [{ id: DEPENDENT, subtype: DocumentType.Prd }],
      inboundBlockers: [
        blocker(DEPENDENT, DocumentType.Feature, IssueStatus.Done),
      ],
    });

    expect(result).toEqual([]);
    expect(acceptsUnblockDestination(DocumentType.Prd)).toBe(false);
    expect(acceptsUnblockDestination(DocumentType.Feature)).toBe(true);
  });

  it("keeps a dependent blocked when a blocker's source could not be resolved", () => {
    // `source: null` is what the DB layer produces for an edge whose source
    // artifact is not in the dependent's own organization — a shape reachable
    // because `ArtifactLink.organizationId` need not agree with its endpoints'.
    // It must fail CLOSED: an artifact we cannot read must never be the reason
    // someone else's work is declared ready.
    const result = selectUnblockableIds({
      candidates: [issueCandidate(DEPENDENT)],
      inboundBlockers: [
        blocker(DEPENDENT, DocumentType.Feature, IssueStatus.Done),
        { targetId: DEPENDENT, source: null },
      ],
    });

    expect(result).toEqual([]);
  });

  it("leaves a BLOCKED artifact with no BLOCKS edge at all alone", () => {
    const result = selectUnblockableIds({
      candidates: [issueCandidate(DEPENDENT)],
      inboundBlockers: [],
    });

    expect(result).toEqual([]);
  });

  it("counts a deleted edge as resolved — only the surviving edges decide", () => {
    // The dependent had two blockers; one was resolved by DELETING the edge
    // (so it is absent below) and the other by going terminal.
    const result = selectUnblockableIds({
      candidates: [issueCandidate(DEPENDENT)],
      inboundBlockers: [
        blocker(DEPENDENT, DocumentType.Feature, IssueStatus.Done),
      ],
    });

    expect(result).toEqual([DEPENDENT]);
  });

  it("resolves a BLOCKS cycle in one pass and cannot cascade", () => {
    // A blocks B and B blocks A. A is DONE, B is BLOCKED.
    const result = selectUnblockableIds({
      candidates: [issueCandidate("b")],
      inboundBlockers: [blocker("b", DocumentType.Feature, IssueStatus.Done)],
    });

    expect(result).toEqual(["b"]);
    // The whole reason no cycle detection is needed: the only status this ever
    // writes is non-terminal, so moving B can never terminalize anyone's
    // blocker and no second round is reachable.
    expect(
      isTerminalStatusForSubtype(DocumentType.Feature, UNBLOCKED_STATUS)
    ).toBe(false);
  });

  it("decides each dependent independently within one batch", () => {
    const result = selectUnblockableIds({
      candidates: [issueCandidate(DEPENDENT), issueCandidate(OTHER_DEPENDENT)],
      inboundBlockers: [
        blocker(DEPENDENT, DocumentType.Feature, IssueStatus.Done),
        blocker(OTHER_DEPENDENT, DocumentType.Feature, IssueStatus.Done),
        blocker(OTHER_DEPENDENT, DocumentType.Feature, IssueStatus.InReview),
      ],
    });

    expect(result).toEqual([DEPENDENT]);
  });
});

describe("blocked-dependent status contract", () => {
  /**
   * Pinned against independent literals on purpose. Asserting these sets
   * against the same constants the resolver reads would stay green if a member
   * were deleted from the canonical vocabulary — the duplication IS the test.
   */
  it("pins the terminal vocabularies and the unblock destination", () => {
    expect([...TERMINAL_ISSUE_STATUSES].sort()).toEqual(["CANCELED", "DONE"]);
    expect([...TERMINAL_DOCUMENT_STATUSES].sort()).toEqual([
      "APPROVED",
      "EXECUTED",
      "OBSOLETE",
    ]);
    expect(UNBLOCKED_STATUS).toBe("TODO");
    expect(BLOCKED_STATUS).toBe("BLOCKED");
  });
});
