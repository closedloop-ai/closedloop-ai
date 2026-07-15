import { describe, expect, it } from "vitest";
import {
  ArtifactRefConfidence,
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  deriveSessionPrPurposeFromMetadata,
  isKnownArtifactRefKind,
  KNOWN_ARTIFACT_REF_KINDS,
  PR_INT_MAX,
  parseSessionPrLinkMetadata,
  SessionArtifactLinkKind,
  SessionPrPurpose,
  SessionPrRelationType,
  syncedArtifactRefSchema,
  syncedSessionPrRefSchema,
} from "./session-artifact-link.js";

describe("syncedArtifactRefSchema", () => {
  it.each([
    ["FEA-1", "FEA-1"],
    ["PRD-42", "PRD-42"],
    ["WRK-12", "WRK-12"],
    ["SES-999", "SES-999"],
    ["PLN-100", "PLN-100"],
    ["PRO-99999", "PRO-99999"],
  ])("accepts valid slug %s", (_label, slug) => {
    const result = syncedArtifactRefSchema.safeParse({
      slug,
      isPrimary: true,
      method: "mcp_tool_call",
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["unknown prefix", "TASK-10"],
    ["slug with 6 digits", "FEA-123456"],
    ["lowercase prefix", "fea-123"],
    ["empty string", ""],
    ["no dash", "FEA1"],
    ["no number", "FEA-"],
    ["only digits", "12345"],
  ])("rejects invalid slug: %s", (_label, slug) => {
    const result = syncedArtifactRefSchema.safeParse({
      slug,
      isPrimary: false,
      method: "slug_in_message",
    });
    expect(result.success).toBe(false);
  });

  it("requires method to be a non-empty string", () => {
    const result = syncedArtifactRefSchema.safeParse({
      slug: "FEA-1",
      isPrimary: true,
      method: "",
    });
    expect(result.success).toBe(false);
  });

  it("requires isPrimary to be a boolean", () => {
    const result = syncedArtifactRefSchema.safeParse({
      slug: "FEA-1",
      isPrimary: "true",
      method: "mcp_tool_call",
    });
    expect(result.success).toBe(false);
  });
});

describe("syncedArtifactRefSchema — kind-discriminated union (FEA-2729)", () => {
  it("normalizes a legacy ref with no kind to closedloop_artifact", () => {
    const result = syncedArtifactRefSchema.safeParse({
      slug: "FEA-1",
      isPrimary: true,
      method: ArtifactRefMethod.McpToolCall,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe(ArtifactRefTargetKind.ClosedloopArtifact);
    }
  });

  it("carries relation and observedAt on a closedloop ref", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.ClosedloopArtifact,
      slug: "FEA-1",
      isPrimary: false,
      method: ArtifactRefMethod.SlugInBranch,
      relation: ArtifactRefRelation.Workspace,
      observedAt: "2026-07-08T12:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a branch ref with repo identity, method, and relation", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/symphony-alpha",
      branchName: "feat/x",
      method: "git_command",
      relation: ArtifactRefRelation.Created,
      observedAt: "2026-07-08T12:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe(ArtifactRefTargetKind.Branch);
    }
  });

  it("accepts a branch ref without observedAt (optional)", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/symphony-alpha",
      branchName: "main",
      method: "git_command",
      relation: ArtifactRefRelation.Workspace,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a branch ref missing relation (relation is required)", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/symphony-alpha",
      branchName: "feat/x",
      method: "git_command",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a branch ref missing branchName", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/symphony-alpha",
      method: "git_command",
      relation: ArtifactRefRelation.Created,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a branch ref with an unknown relation value", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/symphony-alpha",
      branchName: "feat/x",
      method: "git_command",
      relation: "merged",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a pull_request ref carried for FEA-2732", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: "closedloop-ai/symphony-alpha",
      prNumber: 42,
      method: "pr_create_output",
      relation: ArtifactRefRelation.Created,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a commit ref carried for FEA-2731 (abbreviated sha + branch)", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Commit,
      repositoryFullName: "closedloop-ai/symphony-alpha",
      branchName: "feat/x",
      sha: "1a2b3c4",
      method: "git_command",
      relation: ArtifactRefRelation.Created,
      message: "feat: add thing",
      committedAt: "2026-07-08T12:00:00.000Z",
      linesAdded: 10,
      linesRemoved: 2,
      filesChanged: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe(ArtifactRefTargetKind.Commit);
    }
  });

  it("rejects a commit ref whose LOC count exceeds int4 (FEA-3206 — mirrors the PR schema's PR_INT_MAX bound, prevents commit_detail overflow aborting the batch)", () => {
    for (const field of [
      "linesAdded",
      "linesRemoved",
      "filesChanged",
    ] as const) {
      const result = syncedArtifactRefSchema.safeParse({
        kind: ArtifactRefTargetKind.Commit,
        repositoryFullName: "closedloop-ai/symphony-alpha",
        branchName: "feat/x",
        sha: "1a2b3c4",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
        [field]: PR_INT_MAX + 1,
      });
      expect(result.success).toBe(false);
    }
  });

  it("accepts a commit ref whose LOC count is exactly int4 max (FEA-3206 boundary)", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Commit,
      repositoryFullName: "closedloop-ai/symphony-alpha",
      branchName: "feat/x",
      sha: "1a2b3c4",
      method: "git_command",
      relation: ArtifactRefRelation.Created,
      linesAdded: PR_INT_MAX,
      linesRemoved: PR_INT_MAX,
      filesChanged: PR_INT_MAX,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a ref whose explicit kind is unknown to this contract version", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: "deployment_ref_from_the_future",
      repositoryFullName: "closedloop-ai/symphony-alpha",
      method: "git_command",
      relation: ArtifactRefRelation.Created,
    });
    expect(result.success).toBe(false);
  });
});

describe("isKnownArtifactRefKind / KNOWN_ARTIFACT_REF_KINDS (FEA-2729)", () => {
  it("recognizes the persistable/forwardable kinds (incl. commit — FEA-2731)", () => {
    expect(
      isKnownArtifactRefKind(ArtifactRefTargetKind.ClosedloopArtifact)
    ).toBe(true);
    expect(isKnownArtifactRefKind(ArtifactRefTargetKind.Branch)).toBe(true);
    expect(isKnownArtifactRefKind(ArtifactRefTargetKind.PullRequest)).toBe(
      true
    );
    expect(isKnownArtifactRefKind(ArtifactRefTargetKind.Commit)).toBe(true);
  });

  it("does not recognize arbitrary/unknown kinds", () => {
    expect(isKnownArtifactRefKind("something_new")).toBe(false);
    expect(isKnownArtifactRefKind(undefined)).toBe(false);
    expect(isKnownArtifactRefKind(42)).toBe(false);
  });

  it("KNOWN_ARTIFACT_REF_KINDS holds exactly the four persistable/forwardable kinds", () => {
    expect(KNOWN_ARTIFACT_REF_KINDS.size).toBe(4);
    expect(KNOWN_ARTIFACT_REF_KINDS.has(ArtifactRefTargetKind.Branch)).toBe(
      true
    );
    expect(KNOWN_ARTIFACT_REF_KINDS.has(ArtifactRefTargetKind.Commit)).toBe(
      true
    );
  });
});

describe("SessionArtifactLinkKind (FEA-2729)", () => {
  it("adds the session_branch link kind", () => {
    expect(SessionArtifactLinkKind.SessionBranch).toBe("session_branch");
    expect(SessionArtifactLinkKind.SessionPr).toBe("session_pr");
  });
});

describe("syncedSessionPrRefSchema", () => {
  const validPrRef = {
    repositoryFullName: "closedloop-ai/symphony-alpha",
    prNumber: 42,
    prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
    relationType: SessionPrRelationType.Created,
  };

  it("accepts a valid PR ref", () => {
    expect(syncedSessionPrRefSchema.safeParse(validPrRef).success).toBe(true);
  });

  it("accepts relationType Referenced", () => {
    const result = syncedSessionPrRefSchema.safeParse({
      ...validPrRef,
      relationType: SessionPrRelationType.Referenced,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative prNumber", () => {
    const result = syncedSessionPrRefSchema.safeParse({
      ...validPrRef,
      prNumber: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero prNumber", () => {
    const result = syncedSessionPrRefSchema.safeParse({
      ...validPrRef,
      prNumber: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects fractional prNumber", () => {
    const result = syncedSessionPrRefSchema.safeParse({
      ...validPrRef,
      prNumber: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty repositoryFullName", () => {
    const result = syncedSessionPrRefSchema.safeParse({
      ...validPrRef,
      repositoryFullName: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid prUrl", () => {
    const result = syncedSessionPrRefSchema.safeParse({
      ...validPrRef,
      prUrl: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a PR ref without prUrl (derived server-side)", () => {
    const { prUrl: _omit, ...withoutUrl } = validPrRef;
    expect(syncedSessionPrRefSchema.safeParse(withoutUrl).success).toBe(true);
  });

  it("rejects unknown relationType", () => {
    const result = syncedSessionPrRefSchema.safeParse({
      ...validPrRef,
      relationType: "MERGED",
    });
    expect(result.success).toBe(false);
  });
});

describe("session PR purpose metadata", () => {
  it("derives authored purpose from CREATED metadata", () => {
    const metadata = parseSessionPrLinkMetadata({
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Created],
      confidence: 1,
    });

    expect(deriveSessionPrPurposeFromMetadata(metadata)).toBe(
      SessionPrPurpose.Authored
    );
  });

  it("derives referenced purpose from REFERENCED metadata", () => {
    const metadata = parseSessionPrLinkMetadata({
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Referenced],
      confidence: 1,
    });

    expect(deriveSessionPrPurposeFromMetadata(metadata)).toBe(
      SessionPrPurpose.Referenced
    );
  });

  it("falls back for unknown or low-confidence metadata", () => {
    const lowConfidence = parseSessionPrLinkMetadata({
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Created],
      confidence: 0.25,
    });

    expect(deriveSessionPrPurposeFromMetadata(null)).toBe(
      SessionPrPurpose.Unknown
    );
    expect(deriveSessionPrPurposeFromMetadata(lowConfidence)).toBe(
      SessionPrPurpose.Unknown
    );
    expect(parseSessionPrLinkMetadata({ relationTypes: ["UNKNOWN"] })).toBe(
      null
    );
  });
});

describe("const-object enum values", () => {
  it("SessionPrRelationType has correct values", () => {
    expect(SessionPrRelationType.Created).toBe("CREATED");
    expect(SessionPrRelationType.Referenced).toBe("REFERENCED");
  });

  it("ArtifactRefMethod has correct values", () => {
    expect(ArtifactRefMethod.McpToolCall).toBe("mcp_tool_call");
    expect(ArtifactRefMethod.UrlInMessage).toBe("url_in_message");
    expect(ArtifactRefMethod.SlugInMessage).toBe("slug_in_message");
    expect(ArtifactRefMethod.SlugInBranch).toBe("slug_in_branch");
    expect(ArtifactRefMethod.SlugInCwd).toBe("slug_in_cwd");
    expect(ArtifactRefMethod.SlugInSessionSlug).toBe("slug_in_session_slug");
    expect(ArtifactRefMethod.PrCreateOutput).toBe("pr_create_output");
    expect(ArtifactRefMethod.PrUrlInToolUse).toBe("pr_url_in_tool_use");
    expect(ArtifactRefMethod.LaunchMetadata).toBe("launch_metadata");
    expect(ArtifactRefMethod.GitCommand).toBe("git_command");
  });

  it("ArtifactRefTargetKind has correct values", () => {
    expect(ArtifactRefTargetKind.ClosedloopArtifact).toBe(
      "closedloop_artifact"
    );
    expect(ArtifactRefTargetKind.PullRequest).toBe("pull_request");
    expect(ArtifactRefTargetKind.Branch).toBe("branch");
    expect(ArtifactRefTargetKind.Commit).toBe("commit");
  });

  it("ArtifactRefRelation has correct values", () => {
    expect(ArtifactRefRelation.Input).toBe("input");
    expect(ArtifactRefRelation.Output).toBe("output");
    expect(ArtifactRefRelation.Referenced).toBe("referenced");
    expect(ArtifactRefRelation.Created).toBe("created");
    expect(ArtifactRefRelation.Workspace).toBe("workspace");
  });

  it("ArtifactRefConfidence has correct values", () => {
    expect(ArtifactRefConfidence.McpCall).toBe("mcp_call");
    expect(ArtifactRefConfidence.UrlMatch).toBe("url_match");
    expect(ArtifactRefConfidence.SlugMatchInProse).toBe("slug_match_in_prose");
    expect(ArtifactRefConfidence.SlugMatchInBranch).toBe(
      "slug_match_in_branch"
    );
  });
});
