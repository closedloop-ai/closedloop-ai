import { describe, expect, it } from "vitest";
import type { SyncedSessionPrRef } from "./session-artifact-link.ts";
import {
  ArtifactRefMethod,
  collectSessionPrEvidence,
  deriveSessionPrPurposeFromMetadata,
  isHigherPrecedenceArtifactRole,
  parseSessionPrLinkMetadata,
  resolveSessionPrAdmissionIdentity,
  roleFromMethod,
  SessionArtifactLinkRole,
  SessionPrEvidenceKind,
  SessionPrPurpose,
  SessionPrRelationType,
  toSessionPrEvidenceRecords,
} from "./session-artifact-link.ts";

describe("deriveSessionPrPurposeFromMetadata relationTypes fallback", () => {
  it("falls back to unknown purpose when metadata carries no relationTypes field at all", () => {
    const metadata = parseSessionPrLinkMetadata({ confidence: 1 });

    expect(metadata?.relationTypes).toBeUndefined();
    expect(deriveSessionPrPurposeFromMetadata(metadata)).toBe(
      SessionPrPurpose.Unknown
    );
  });
});

describe("collectSessionPrEvidence", () => {
  it("adds an authored record's identity and legacy twin to the authored sets only", () => {
    const evidence = collectSessionPrEvidence([
      {
        repositoryFullName: "acme/web",
        prNumber: 7,
        kind: SessionPrEvidenceKind.Authored,
      },
    ]);

    expect(evidence.authoredIdentities.has("acme/web#7")).toBe(true);
    expect(evidence.authoredLegacyIdentities.has("legacy#7")).toBe(true);
    expect(evidence.adjudicatedIdentities.size).toBe(0);
  });

  it("adds a non-authored record's repo-scoped AND legacy identity to adjudicated evidence", () => {
    const evidence = collectSessionPrEvidence([
      {
        repositoryFullName: "acme/web",
        prNumber: 8,
        kind: SessionPrEvidenceKind.Adjudicated,
      },
    ]);

    expect(evidence.adjudicatedIdentities.has("acme/web#8")).toBe(true);
    expect(evidence.adjudicatedIdentities.has("legacy#8")).toBe(true);
    expect(evidence.authoredIdentities.size).toBe(0);
    expect(evidence.authoredLegacyIdentities.size).toBe(0);
  });
});

describe("resolveSessionPrAdmissionIdentity", () => {
  it("admits a repo-scoped record the evidence authored at its own identity", () => {
    const evidence = collectSessionPrEvidence([
      {
        repositoryFullName: "acme/web",
        prNumber: 7,
        kind: SessionPrEvidenceKind.Authored,
      },
    ]);

    expect(
      resolveSessionPrAdmissionIdentity(
        { repositoryFullName: "acme/web", prNumber: 7 },
        evidence
      )
    ).toBe("acme/web#7");
  });

  it("admits a repo-less record via the legacy authored twin (the documented legacy fallback)", () => {
    const evidence = collectSessionPrEvidence([
      {
        repositoryFullName: "acme/web",
        prNumber: 42,
        kind: SessionPrEvidenceKind.Authored,
      },
    ]);

    expect(
      resolveSessionPrAdmissionIdentity(
        { repositoryFullName: null, prNumber: 42 },
        evidence
      )
    ).toBe("legacy#42");
  });

  it("rejects a repo-less record whose legacy identity was adjudicated but never authored", () => {
    const evidence = collectSessionPrEvidence([
      {
        repositoryFullName: "acme/web",
        prNumber: 99,
        kind: SessionPrEvidenceKind.Adjudicated,
      },
    ]);

    expect(
      resolveSessionPrAdmissionIdentity(
        { repositoryFullName: null, prNumber: 99 },
        evidence
      )
    ).toBeNull();
  });

  it("rejects a repo-scoped record whose legacy twin was adjudicated by different-repo evidence", () => {
    // Pins the documented asymmetry in resolveSessionPrAdmissionIdentity's
    // docstring: consulting legacy#<n> to REJECT is conservative (some
    // evidence looked at this PR number and did not call it authoring), even
    // though the same lookup is deliberately NOT used to admit a record.
    const evidence = collectSessionPrEvidence([
      {
        repositoryFullName: null,
        prNumber: 55,
        kind: SessionPrEvidenceKind.Adjudicated,
      },
    ]);

    expect(
      resolveSessionPrAdmissionIdentity(
        { repositoryFullName: "acme/web", prNumber: 55 },
        evidence
      )
    ).toBeNull();
  });

  it("keeps a record with no evidence at all (absent evidence is incomplete, not exculpatory)", () => {
    const evidence = collectSessionPrEvidence([]);

    expect(
      resolveSessionPrAdmissionIdentity(
        { repositoryFullName: "acme/web", prNumber: 100 },
        evidence
      )
    ).toBe("acme/web#100");
  });
});

describe("toSessionPrEvidenceRecords", () => {
  it("maps a CREATED relation type to authored evidence and other relation types to adjudicated", () => {
    const refs: SyncedSessionPrRef[] = [
      {
        repositoryFullName: "acme/web",
        prNumber: 7,
        relationType: SessionPrRelationType.Created,
      },
      {
        repositoryFullName: "acme/web",
        prNumber: 8,
        relationType: SessionPrRelationType.Referenced,
      },
      {
        repositoryFullName: "acme/web",
        prNumber: 9,
        relationType: SessionPrRelationType.Reviewed,
      },
    ];

    expect(toSessionPrEvidenceRecords(refs)).toEqual([
      {
        kind: SessionPrEvidenceKind.Authored,
        prNumber: 7,
        repositoryFullName: "acme/web",
      },
      {
        kind: SessionPrEvidenceKind.Adjudicated,
        prNumber: 8,
        repositoryFullName: "acme/web",
      },
      {
        kind: SessionPrEvidenceKind.Adjudicated,
        prNumber: 9,
        repositoryFullName: "acme/web",
      },
    ]);
  });
});

describe("roleFromMethod", () => {
  it("returns Input for a primary ref regardless of its detection method", () => {
    // Pins current behavior: isPrimary short-circuits before the method
    // switch, so a primary ref detected via SlugInBranch (which otherwise
    // maps to Workspace for a non-primary ref) still comes back Input.
    expect(roleFromMethod(ArtifactRefMethod.SlugInBranch, true)).toBe(
      SessionArtifactLinkRole.Input
    );
  });

  it.each([
    [ArtifactRefMethod.McpToolCall, SessionArtifactLinkRole.Input],
    [ArtifactRefMethod.LaunchMetadata, SessionArtifactLinkRole.Input],
    [ArtifactRefMethod.SlugInBranch, SessionArtifactLinkRole.Workspace],
    [ArtifactRefMethod.SlugInCwd, SessionArtifactLinkRole.Workspace],
    [ArtifactRefMethod.SlugInSessionSlug, SessionArtifactLinkRole.Workspace],
    [ArtifactRefMethod.UrlInMessage, SessionArtifactLinkRole.Referenced],
  ])("maps non-primary method %s to role %s", (method, expectedRole) => {
    expect(roleFromMethod(method, false)).toBe(expectedRole);
  });
});

describe("isHigherPrecedenceArtifactRole", () => {
  it("ranks Input ahead of Referenced ahead of Workspace", () => {
    expect(
      isHigherPrecedenceArtifactRole(
        SessionArtifactLinkRole.Input,
        SessionArtifactLinkRole.Referenced
      )
    ).toBe(true);
    expect(
      isHigherPrecedenceArtifactRole(
        SessionArtifactLinkRole.Referenced,
        SessionArtifactLinkRole.Input
      )
    ).toBe(false);
  });

  it("treats an unrecognized existing role as lowest precedence, so any known role outranks it", () => {
    expect(
      isHigherPrecedenceArtifactRole(
        SessionArtifactLinkRole.Workspace,
        "future_role"
      )
    ).toBe(true);
  });

  it("treats an unrecognized candidate role as lowest precedence, so it never outranks a known role", () => {
    expect(
      isHigherPrecedenceArtifactRole(
        "future_role",
        SessionArtifactLinkRole.Workspace
      )
    ).toBe(false);
  });
});
