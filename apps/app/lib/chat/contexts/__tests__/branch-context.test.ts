import { describe, expect, test } from "vitest";
import { buildBranchChatContext } from "../branch-context";

const BRANCH_BASE = {
  externalLinkId: "ext-1",
  prTitle: "Add feature X",
  prHtmlUrl: "https://github.com/acme/repo/pull/42",
  repoFullName: "acme/repo",
  headBranch: "feat/x",
  baseBranch: "main",
} as const;

const MCP_AVAILABLE = {
  available: true,
  serverName: "closedloop",
  matchedUrl: "https://example.com/mcp",
  checkedAt: "2026-01-01T00:00:00Z",
} as const;

const MCP_UNAVAILABLE = {
  available: false,
  serverName: null,
  matchedUrl: null,
  checkedAt: "2026-01-01T00:00:00Z",
} as const;

describe("buildBranchChatContext — no linked artifacts", () => {
  test("includes pull request metadata fields", () => {
    const ctx = buildBranchChatContext({ ...BRANCH_BASE }, MCP_AVAILABLE);
    expect(ctx).toContain("Pull Request: Add feature X");
    expect(ctx).toContain("URL: https://github.com/acme/repo/pull/42");
    expect(ctx).toContain("Repository: acme/repo");
    expect(ctx).toContain("Branch: feat/x -> main");
    expect(ctx).toContain("Policy (non-negotiable)");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("You do NOT have filesystem access");
    expect(ctx).not.toContain("You MAY read files");
  });

  test("omits MCP instructions when no feature or plan is linked (MCP available)", () => {
    const ctx = buildBranchChatContext({ ...BRANCH_BASE }, MCP_AVAILABLE);
    expect(ctx).not.toContain("get-artifact, list-artifact-versions");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("Policy (non-negotiable)");
    expect(ctx).toContain("You do NOT have filesystem access");
  });

  test("omits MCP instructions when no feature or plan is linked (MCP unavailable)", () => {
    const ctx = buildBranchChatContext({ ...BRANCH_BASE }, MCP_UNAVAILABLE);
    expect(ctx).not.toContain("get-artifact, list-artifact-versions");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("Policy (non-negotiable)");
    expect(ctx).toContain("You do NOT have filesystem access");
  });

  test("omits MCP instructions when no feature or plan is linked (MCP availability null)", () => {
    const ctx = buildBranchChatContext({ ...BRANCH_BASE }, null);
    expect(ctx).not.toContain("get-artifact, list-artifact-versions");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("Policy (non-negotiable)");
    expect(ctx).toContain("You do NOT have filesystem access");
  });

  test("omits Linked Feature and Implementation Plan sections when fields absent", () => {
    const ctx = buildBranchChatContext({ ...BRANCH_BASE }, MCP_AVAILABLE);
    expect(ctx).not.toContain("## Linked Feature");
    expect(ctx).not.toContain("## Implementation Plan");
    expect(ctx).not.toContain("## Working Directory");
    expect(ctx).toContain("Policy (non-negotiable)");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("You do NOT have filesystem access");
  });
});

describe("buildBranchChatContext — linked feature", () => {
  test("renders Linked Feature section when feature slug and title are present", () => {
    const ctx = buildBranchChatContext(
      {
        ...BRANCH_BASE,
        featureSlug: "FEAT-10",
        featureTitle: "Checkout redesign",
      },
      MCP_AVAILABLE
    );
    expect(ctx).toContain("## Linked Feature");
    expect(ctx).toContain("Title: Checkout redesign");
    expect(ctx).toContain("Slug: FEAT-10");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("Policy (non-negotiable)");
  });

  test("includes MCP instructions when feature slug is present and MCP available", () => {
    const ctx = buildBranchChatContext(
      { ...BRANCH_BASE, featureSlug: "FEAT-10" },
      MCP_AVAILABLE
    );
    expect(ctx).toContain("get-artifact");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("Policy (non-negotiable)");
  });

  test("includes MCP instructions optimistically when feature slug is present and MCP null", () => {
    const ctx = buildBranchChatContext(
      { ...BRANCH_BASE, featureSlug: "FEAT-10" },
      null
    );
    expect(ctx).toContain("get-artifact");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("Policy (non-negotiable)");
  });

  test("omits MCP instructions when feature slug is present but MCP unavailable", () => {
    const ctx = buildBranchChatContext(
      { ...BRANCH_BASE, featureSlug: "FEAT-10" },
      MCP_UNAVAILABLE
    );
    expect(ctx).not.toContain("get-artifact, list-artifact-versions");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("Policy (non-negotiable)");
  });
});

describe("buildBranchChatContext — implementation plan", () => {
  test("renders Implementation Plan section when plan slug and title are present", () => {
    const ctx = buildBranchChatContext(
      {
        ...BRANCH_BASE,
        producedByPlanSlug: "PLN-42",
        producedByPlanTitle: "Checkout rewrite",
      },
      MCP_AVAILABLE
    );
    expect(ctx).toContain("## Implementation Plan");
    expect(ctx).toContain("Title: Checkout rewrite");
    expect(ctx).toContain("Slug: PLN-42");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("Policy (non-negotiable)");
  });

  test("includes MCP instructions when plan slug alone is present and MCP available", () => {
    const ctx = buildBranchChatContext(
      { ...BRANCH_BASE, producedByPlanSlug: "PLN-42" },
      MCP_AVAILABLE
    );
    expect(ctx).toContain("get-artifact");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("Policy (non-negotiable)");
  });
});

describe("buildBranchChatContext — working directory", () => {
  test("renders filesystem policy when worktreePath is present", () => {
    const ctx = buildBranchChatContext(
      { ...BRANCH_BASE, worktreePath: "/Users/dev/source/acme-abc123" },
      MCP_AVAILABLE
    );
    expect(ctx).toContain("Filesystem:");
    expect(ctx).toContain("/Users/dev/source/acme-abc123");
    expect(ctx).toContain("You MAY read files");
    expect(ctx).not.toContain("You do NOT have filesystem access");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("Policy (non-negotiable)");
  });

  test("renders no-filesystem-access policy when worktreePath is null", () => {
    const ctx = buildBranchChatContext(
      { ...BRANCH_BASE, worktreePath: null },
      MCP_AVAILABLE
    );
    expect(ctx).toContain("Filesystem:");
    expect(ctx).toContain("You do NOT have filesystem access");
    expect(ctx).not.toContain("You MAY read files");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("Policy (non-negotiable)");
  });

  test("renders feature, plan, and filesystem policy together when all are present", () => {
    const ctx = buildBranchChatContext(
      {
        ...BRANCH_BASE,
        featureSlug: "FEAT-10",
        featureTitle: "Checkout redesign",
        producedByPlanSlug: "PLN-42",
        producedByPlanTitle: "Checkout rewrite",
        worktreePath: "/Users/dev/source/acme-feat-10",
      },
      MCP_AVAILABLE
    );
    expect(ctx).toContain("## Linked Feature");
    expect(ctx).toContain("## Implementation Plan");
    expect(ctx).toContain("Filesystem:");
    expect(ctx).toContain("You MAY read files");
    expect(ctx).not.toContain("You do NOT have filesystem access");
    expect(ctx).toContain("get-artifact");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("Policy (non-negotiable)");
  });
});
