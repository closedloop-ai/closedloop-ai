import { describe, expect, it } from "vitest";
import {
  ArtifactRefConfidence,
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  SessionPrLinkSource,
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

describe("const-object enum values", () => {
  it("SessionPrRelationType has correct values", () => {
    expect(SessionPrRelationType.Created).toBe("CREATED");
    expect(SessionPrRelationType.Referenced).toBe("REFERENCED");
  });

  it("SessionPrLinkSource has correct values", () => {
    expect(SessionPrLinkSource.Deterministic).toBe("DETERMINISTIC");
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
