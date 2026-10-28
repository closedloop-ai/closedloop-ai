import { DocumentStatus, IssueStatus } from "@closedloop-ai/loops-api/document";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_STATUS_EDITABILITY,
  type ArtifactStatusCapability,
  type ArtifactStatusCommit,
  type ArtifactStatusEditability,
  ArtifactStatusEditSurface,
  ArtifactStatusReadOnlyReason,
  ArtifactStatusVocabulary,
} from "./artifact-status-contract.ts";

describe("ArtifactStatusVocabulary", () => {
  it("declares exactly the five vocabularies ISS-9432 shipped a table for", () => {
    // Wire strings, asserted literally: a vocabulary reaches an activity
    // receipt and a persisted capability, so a rename is a contract break.
    expect(Object.values(ArtifactStatusVocabulary)).toEqual([
      "document",
      "issue",
      "branch",
      "project",
      "session",
    ]);
  });
});

describe("ArtifactStatusEditSurface", () => {
  it("declares exactly the five production write paths", () => {
    // `row_action` joined the four document surfaces in this change: project
    // status is written by the archive/unarchive menu item through
    // `PUT /projects/[id]`, and with no surface naming it a project commit had
    // to borrow one whose docstring binds it to a document route.
    expect(Object.values(ArtifactStatusEditSurface)).toEqual([
      "detail",
      "inline_cell",
      "board",
      "bulk",
      "row_action",
    ]);
  });
});

describe("ArtifactStatusReadOnlyReason", () => {
  it("declares exactly the two structural and two per-row reasons", () => {
    expect(Object.values(ArtifactStatusReadOnlyReason)).toEqual([
      "provider_derived",
      "machine_written",
      "not_permitted",
      "unrecognized_status",
    ]);
  });
});

describe("ARTIFACT_STATUS_EDITABILITY", () => {
  it("records today's behaviour: branch and session are read-only", () => {
    expect(ARTIFACT_STATUS_EDITABILITY).toEqual({
      document: { editable: true },
      issue: { editable: true },
      branch: { editable: false, reason: "provider_derived" },
      project: { editable: true },
      session: { editable: false, reason: "machine_written" },
    });
  });

  it("covers every vocabulary key and no others", () => {
    expect(Object.keys(ARTIFACT_STATUS_EDITABILITY).sort()).toEqual(
      Object.values(ArtifactStatusVocabulary).slice().sort()
    );
  });

  it("uses only the two STRUCTURAL read-only reasons", () => {
    const reasons: ArtifactStatusReadOnlyReason[] = [];
    for (const entry of Object.values(ARTIFACT_STATUS_EDITABILITY)) {
      if (!entry.editable) {
        reasons.push(entry.reason);
      }
    }
    expect(reasons).toEqual([
      ArtifactStatusReadOnlyReason.ProviderDerived,
      ArtifactStatusReadOnlyReason.MachineWritten,
    ]);
    // The per-row reasons must never become a vocabulary-wide fact: one actor's
    // refusal, or one corrupt row, is not a property of every artifact of that
    // kind.
    expect(reasons).not.toContain(ArtifactStatusReadOnlyReason.NotPermitted);
    expect(reasons).not.toContain(
      ArtifactStatusReadOnlyReason.UnrecognizedStatus
    );
  });

  it("freezes the table and every row", () => {
    expect(Object.isFrozen(ARTIFACT_STATUS_EDITABILITY)).toBe(true);
    for (const entry of Object.values(ARTIFACT_STATUS_EDITABILITY)) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });
});

describe("ArtifactStatusCapability", () => {
  const summarize = (capability: ArtifactStatusCapability): string =>
    capability.editable
      ? `editable:${capability.allowedTargets.join("|")}`
      : `read_only:${capability.reason}`;

  it("discriminates a read-only capability without allowedTargets in scope", () => {
    const capability: ArtifactStatusCapability = {
      editable: false,
      reason: ArtifactStatusReadOnlyReason.NotPermitted,
    };
    expect(summarize(capability)).toBe("read_only:not_permitted");
  });

  it("requires allowedTargets on an editable capability", () => {
    const capability: ArtifactStatusCapability = {
      editable: true,
      allowedTargets: [IssueStatus.Todo, IssueStatus.InProgress],
    };
    expect(summarize(capability)).toBe("editable:TODO|IN_PROGRESS");
  });
});

describe("compile-time guards", () => {
  it("refuses a per-row reason on the vocabulary-wide table", () => {
    // The prose says only the two STRUCTURAL reasons may appear here; this is
    // what makes it true rather than conventional. Widening
    // `ArtifactStatusEditability` back to the full reason union makes this
    // assignment legal and fails `tsc` as an unused directive.
    const widened: ArtifactStatusEditability = {
      editable: false,
      // @ts-expect-error — `not_permitted` is a per-row fact, never a whole kind.
      reason: ArtifactStatusReadOnlyReason.NotPermitted,
    };

    expect(widened.editable).toBe(false);
  });

  it("requires a commitGroupId on a grouped surface and forbids one elsewhere", () => {
    const bulk: ArtifactStatusCommit = {
      artifactId: "01a08d2f-1a65-727e-903d-e99434e66aab",
      vocabulary: ArtifactStatusVocabulary.Document,
      from: DocumentStatus.Draft,
      to: DocumentStatus.Approved,
      surface: ArtifactStatusEditSurface.Bulk,
      commitGroupId: "01a08d2f-1a65-727e-903d-e99434e66aac",
    };

    // The directive sits on the DECLARATION because `commitGroupId?: never`
    // makes the whole literal unassignable rather than failing that one
    // property, so a property-level directive reads as unused.
    // @ts-expect-error — a single-row write has no group to belong to.
    const single: ArtifactStatusCommit = {
      artifactId: "01a08d2f-1a65-727e-903d-e99434e66aab",
      vocabulary: ArtifactStatusVocabulary.Document,
      from: DocumentStatus.Draft,
      to: DocumentStatus.Approved,
      surface: ArtifactStatusEditSurface.Detail,
      commitGroupId: "01a08d2f-1a65-727e-903d-e99434e66aac",
    };

    expect(bulk.commitGroupId).toBeDefined();
    expect(single.surface).toBe(ArtifactStatusEditSurface.Detail);
  });

  it("refuses a write target that is not a value some vocabulary persists", () => {
    const typo: ArtifactStatusCommit = {
      artifactId: "01a08d2f-1a65-727e-903d-e99434e66aab",
      vocabulary: ArtifactStatusVocabulary.Document,
      from: DocumentStatus.Draft,
      // @ts-expect-error — typed `string`, this misspelling reached a column.
      to: "IN_PRGORESS",
      surface: ArtifactStatusEditSurface.Detail,
    };

    expect(typo.vocabulary).toBe(ArtifactStatusVocabulary.Document);
  });
});
