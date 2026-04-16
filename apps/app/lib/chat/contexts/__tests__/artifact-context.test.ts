import { describe, expect, test } from "vitest";
import { buildArtifactChatContext } from "../artifact-context";

const ARTIFACT_BASE = {
  type: "plan",
  slug: "PLN-123",
  title: "Sample Plan",
  url: "https://example.com/plans/PLN-123",
} as const;

describe("buildArtifactChatContext", () => {
  test("includes metadata fields (type, title, slug, url)", () => {
    const ctx = buildArtifactChatContext(
      { ...ARTIFACT_BASE },
      {
        available: true,
        serverName: "closedloop",
        matchedUrl: "https://example.com/mcp",
        checkedAt: "2026-01-01T00:00:00Z",
      }
    );
    expect(ctx).toContain("Artifact type: plan");
    expect(ctx).toContain("Title: Sample Plan");
    expect(ctx).toContain("Slug: PLN-123");
    expect(ctx).toContain("URL: https://example.com/plans/PLN-123");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain('"create-", "update-", or "delete-"');
    expect(ctx).toContain("DRAFT -> READY_FOR_REVIEW");
    expect(ctx).toContain("Plans unlock the Execute action");
  });

  test("includes MCP instructions when MCP is available (claude)", () => {
    const ctx = buildArtifactChatContext(
      { ...ARTIFACT_BASE },
      {
        available: true,
        serverName: "closedloop",
        matchedUrl: "https://example.com/mcp",
        checkedAt: "2026-01-01T00:00:00Z",
      }
    );
    expect(ctx).toContain("get-artifact");
    expect(ctx).toContain("READ-ONLY by default");
  });

  test("includes MCP instructions when legacy MCP availability is true (codex)", () => {
    const ctx = buildArtifactChatContext(
      { ...ARTIFACT_BASE },
      { closedloopAvailable: true, checkedAt: "2026-01-01T00:00:00Z" }
    );
    expect(ctx).toContain("get-artifact");
    expect(ctx).toContain("READ-ONLY by default");
  });

  test("includes MCP instructions optimistically when availability is null (claude)", () => {
    const ctx = buildArtifactChatContext({ ...ARTIFACT_BASE }, null);
    expect(ctx).toContain("get-artifact");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("DRAFT -> READY_FOR_REVIEW");
  });

  test("includes MCP instructions optimistically when availability is null (codex)", () => {
    const ctx = buildArtifactChatContext({ ...ARTIFACT_BASE }, null);
    expect(ctx).toContain("get-artifact");
    expect(ctx).toContain("READ-ONLY by default");
  });

  test("omits MCP instructions and falls back to inline content when MCP unavailable", () => {
    const ctx = buildArtifactChatContext(
      { ...ARTIFACT_BASE, inlineContent: "## Body\n\nplan body" },
      {
        available: false,
        serverName: null,
        matchedUrl: null,
        checkedAt: "2026-01-01T00:00:00Z",
      }
    );
    expect(ctx).not.toContain("get-artifact, list-artifact-versions");
    expect(ctx).toContain("## Artifact Content");
    expect(ctx).toContain("plan body");
    expect(ctx).toContain("READ-ONLY by default");
    expect(ctx).toContain("Plans unlock the Execute action");
  });

  test("omits MCP instructions and reports unavailability when no inline content", () => {
    const ctx = buildArtifactChatContext(
      { ...ARTIFACT_BASE },
      {
        available: false,
        serverName: null,
        matchedUrl: null,
        checkedAt: "2026-01-01T00:00:00Z",
      }
    );
    expect(ctx).not.toContain("get-artifact, list-artifact-versions");
    expect(ctx).toContain("MCP server unavailable");
    expect(ctx).toContain("READ-ONLY by default");
  });

  test("emits PRD-specific lifecycle note for prd-type artifacts", () => {
    const ctx = buildArtifactChatContext(
      {
        type: "prd",
        slug: "PRD-456",
        title: "Sample PRD",
        url: "https://example.com/prds/PRD-456",
      },
      {
        available: true,
        serverName: "closedloop",
        matchedUrl: "https://example.com/mcp",
        checkedAt: "2026-01-01T00:00:00Z",
      }
    );
    expect(ctx).toContain("Artifact type: prd");
    expect(ctx).toContain("PRDs can be Decomposed");
    expect(ctx).not.toContain("Plans unlock the Execute action");
  });
});
