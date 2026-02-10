import { describe, expect, it } from "vitest";
import type { ProjectArtifact } from "@/types/teams";
import { ArtifactDisplayStatus, ProjectArtifactSubtype } from "@/types/teams";
import { getArtifactRoute } from "../artifact-routes";

// Regex patterns for route prefix testing
const PRD_PREFIX_REGEX = /^\/prds\//;
const IMPLEMENTATION_PLANS_PREFIX_REGEX = /^\/implementation-plans\//;
const ISSUES_PREFIX_REGEX = /^\/issues\//;

function createMockArtifact(
  overrides: Partial<ProjectArtifact>
): ProjectArtifact {
  return {
    id: "art-123",
    documentSlug: "test-doc",
    name: "Test Artifact",
    subtype: ProjectArtifactSubtype.Prd,
    status: ArtifactDisplayStatus.NotStarted,
    ...overrides,
  };
}

describe("getArtifactRoute", () => {
  describe("PRD artifacts", () => {
    it("returns PRD route with document slug", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Prd,
        documentSlug: "my-prd",
      });

      expect(getArtifactRoute(artifact)).toBe("/prds/my-prd");
    });

    it("returns null when PRD has no document slug", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Prd,
        documentSlug: null,
      });

      expect(getArtifactRoute(artifact)).toBeNull();
    });
  });

  describe("Implementation Plan artifacts", () => {
    it("returns implementation-plans route for IMPLEMENTATION_PLAN type", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.ImplementationPlan,
        documentSlug: "my-plan",
      });

      expect(getArtifactRoute(artifact)).toBe("/implementation-plans/my-plan");
    });

    it("returns implementation-plans route for IMPLEMENTATION_STRATEGY type", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.ImplementationStrategy,
        documentSlug: "my-strategy",
      });

      expect(getArtifactRoute(artifact)).toBe(
        "/implementation-plans/my-strategy"
      );
    });

    it("returns null when IMPLEMENTATION_PLAN has no document slug", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.ImplementationPlan,
        documentSlug: null,
      });

      expect(getArtifactRoute(artifact)).toBeNull();
    });

    it("returns null when IMPLEMENTATION_STRATEGY has no document slug", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.ImplementationStrategy,
        documentSlug: null,
      });

      expect(getArtifactRoute(artifact)).toBeNull();
    });
  });

  describe("Issue artifacts", () => {
    it("returns issues route for ISSUE type", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Issue,
        documentSlug: "my-issue",
      });

      expect(getArtifactRoute(artifact)).toBe("/issues/my-issue");
    });

    it("returns issues route for BUG type", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Bug,
        documentSlug: "my-bug",
      });

      expect(getArtifactRoute(artifact)).toBe("/issues/my-bug");
    });

    it("returns null when ISSUE has no document slug", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Issue,
        documentSlug: null,
      });

      expect(getArtifactRoute(artifact)).toBeNull();
    });

    it("returns null when BUG has no document slug", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Bug,
        documentSlug: null,
      });

      expect(getArtifactRoute(artifact)).toBeNull();
    });
  });

  describe("Link-based artifacts", () => {
    it("returns link for DESIGNS type when link is provided", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Designs,
        link: "https://figma.com/design-123",
      });

      expect(getArtifactRoute(artifact)).toBe("https://figma.com/design-123");
    });

    it("returns link for BRANCH type when link is provided", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Branch,
        link: "https://github.com/repo/tree/branch",
      });

      expect(getArtifactRoute(artifact)).toBe(
        "https://github.com/repo/tree/branch"
      );
    });

    it("returns null for DESIGNS when link is undefined", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Designs,
        link: undefined,
      });

      expect(getArtifactRoute(artifact)).toBeNull();
    });

    it("returns null for BRANCH when link is undefined", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Branch,
        link: undefined,
      });

      expect(getArtifactRoute(artifact)).toBeNull();
    });

    it("returns null for DESIGNS when link is empty string", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Designs,
        link: "",
      });

      expect(getArtifactRoute(artifact)).toBeNull();
    });
  });

  describe("Non-navigable artifacts", () => {
    it("returns null for PROJECT_BRIEF type", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.ProjectBrief,
        documentSlug: "has-slug",
      });

      expect(getArtifactRoute(artifact)).toBeNull();
    });

    it("returns null for TEMPLATE type", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Template,
        documentSlug: "has-slug",
      });

      expect(getArtifactRoute(artifact)).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("handles document slug with special characters", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Prd,
        documentSlug: "doc-123-special_chars",
      });

      expect(getArtifactRoute(artifact)).toBe("/prds/doc-123-special_chars");
    });

    it("handles link with query parameters", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Designs,
        link: "https://figma.com/design?id=123&mode=view",
      });

      expect(getArtifactRoute(artifact)).toBe(
        "https://figma.com/design?id=123&mode=view"
      );
    });

    it("handles link with hash fragment", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Branch,
        link: "https://github.com/repo/tree/branch#section",
      });

      expect(getArtifactRoute(artifact)).toBe(
        "https://github.com/repo/tree/branch#section"
      );
    });

    it("preserves document slug casing", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.ImplementationPlan,
        documentSlug: "MyPlan-WithCaps",
      });

      expect(getArtifactRoute(artifact)).toBe(
        "/implementation-plans/MyPlan-WithCaps"
      );
    });

    it("handles artifact type in different case (default case)", () => {
      // TypeScript should prevent this, but testing runtime behavior
      const artifact = createMockArtifact({
        subtype: "UNKNOWN_TYPE" as ProjectArtifact["subtype"],
        documentSlug: "test",
      });

      expect(getArtifactRoute(artifact)).toBeNull();
    });
  });

  describe("documentSlug vs link priority", () => {
    it("uses documentSlug for PRD even when link exists", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Prd,
        documentSlug: "my-prd",
        link: "https://example.com",
      });

      expect(getArtifactRoute(artifact)).toBe("/prds/my-prd");
    });

    it("uses link for DESIGNS even when documentSlug exists", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Designs,
        documentSlug: "ignored-slug",
        link: "https://figma.com/design",
      });

      expect(getArtifactRoute(artifact)).toBe("https://figma.com/design");
    });

    it("returns null for DESIGNS when both documentSlug and link are missing", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Designs,
        documentSlug: null,
        link: undefined,
      });

      expect(getArtifactRoute(artifact)).toBeNull();
    });
  });

  describe("route prefix consistency", () => {
    it("uses /prds/ prefix for PRD artifacts", () => {
      const artifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Prd,
        documentSlug: "doc",
      });

      expect(getArtifactRoute(artifact)).toMatch(PRD_PREFIX_REGEX);
    });

    it("uses /implementation-plans/ prefix for plan artifacts", () => {
      const planArtifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.ImplementationPlan,
        documentSlug: "doc",
      });
      const strategyArtifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.ImplementationStrategy,
        documentSlug: "doc",
      });

      expect(getArtifactRoute(planArtifact)).toMatch(
        IMPLEMENTATION_PLANS_PREFIX_REGEX
      );
      expect(getArtifactRoute(strategyArtifact)).toMatch(
        IMPLEMENTATION_PLANS_PREFIX_REGEX
      );
    });

    it("uses /issues/ prefix for issue artifacts", () => {
      const issueArtifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Issue,
        documentSlug: "doc",
      });
      const bugArtifact = createMockArtifact({
        subtype: ProjectArtifactSubtype.Bug,
        documentSlug: "doc",
      });

      expect(getArtifactRoute(issueArtifact)).toMatch(ISSUES_PREFIX_REGEX);
      expect(getArtifactRoute(bugArtifact)).toMatch(ISSUES_PREFIX_REGEX);
    });
  });
});
