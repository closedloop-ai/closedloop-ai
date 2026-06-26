import { DocumentType } from "@repo/api/src/types/document";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { describe, expect, it } from "vitest";
import {
  MatchSource,
  MatchType,
  parseArtifactReferences,
} from "../artifact-reference-parser";

describe("parseArtifactReferences", () => {
  describe("PLN slug pattern", () => {
    it("extracts PLN-{n} from title", () => {
      const results = parseArtifactReferences("Fix bug for PLN-42", null);
      expect(results).toEqual([
        {
          slug: "PLN-42",
          prefix: SlugPrefix.Plan,
          docType: DocumentType.ImplementationPlan,
          matchType: MatchType.Slug,
          source: MatchSource.Title,
        },
      ]);
    });

    it("extracts PLN-{n} from body", () => {
      const results = parseArtifactReferences("Some PR", "Implements PLN-99");
      expect(results).toEqual([
        {
          slug: "PLN-99",
          prefix: SlugPrefix.Plan,
          docType: DocumentType.ImplementationPlan,
          matchType: MatchType.Slug,
          source: MatchSource.Body,
        },
      ]);
    });

    it("is case-insensitive (pln-42, Pln-42)", () => {
      const lower = parseArtifactReferences("fix pln-42", null);
      expect(lower).toHaveLength(1);
      expect(lower[0].slug).toBe("PLN-42");

      const mixed = parseArtifactReferences("fix Pln-42", null);
      expect(mixed).toHaveLength(1);
      expect(mixed[0].slug).toBe("PLN-42");
    });

    it("enforces word boundary — no match for MYPLN-42", () => {
      const results = parseArtifactReferences("MYPLN-42 is here", null);
      expect(results).toEqual([]);
    });

    it("enforces word boundary — no match for PLN-42abc", () => {
      const results = parseArtifactReferences("PLN-42abc", null);
      expect(results).toEqual([]);
    });

    it("does not match PLN- with no digits", () => {
      const results = parseArtifactReferences("PLN- is not valid", null);
      expect(results).toEqual([]);
    });
  });

  describe("FEA slug pattern", () => {
    it("extracts FEA-{n} from title", () => {
      const results = parseArtifactReferences(
        "FEA-42: fix login timeout",
        null
      );
      expect(results).toEqual([
        {
          slug: "FEA-42",
          prefix: SlugPrefix.Feature,
          docType: DocumentType.Feature,
          matchType: MatchType.Slug,
          source: MatchSource.Title,
        },
      ]);
    });

    it("extracts FEA-{n} from body", () => {
      const results = parseArtifactReferences(
        "Small fix",
        "Resolves FEA-7 per linked ticket"
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        slug: "FEA-7",
        prefix: SlugPrefix.Feature,
        docType: DocumentType.Feature,
      });
    });

    it("is case-insensitive (fea-42)", () => {
      const results = parseArtifactReferences("closes fea-42", null);
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe("FEA-42");
    });

    it("enforces word boundary — no match for PREFEA-42", () => {
      const results = parseArtifactReferences(
        "PREFEA-42 should not match",
        null
      );
      expect(results).toEqual([]);
    });

    it("enforces word boundary — no match for FEA-42abc", () => {
      const results = parseArtifactReferences("FEA-42abc", null);
      expect(results).toEqual([]);
    });
  });

  describe("URL pattern", () => {
    const appBaseUrl = "https://app.closedloop.dev";

    it("extracts plan from full URL in body", () => {
      const body =
        "See https://app.closedloop.dev/implementation-plans/PLN-42 for details";
      const results = parseArtifactReferences("Some PR", body, appBaseUrl);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        slug: "PLN-42",
        docType: DocumentType.ImplementationPlan,
        matchType: MatchType.Url,
        source: MatchSource.Body,
      });
    });

    it("extracts feature from full URL in body", () => {
      const body = "See https://app.closedloop.dev/features/FEA-17 for context";
      const results = parseArtifactReferences("Some PR", body, appBaseUrl);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        slug: "FEA-17",
        docType: DocumentType.Feature,
        matchType: MatchType.Url,
        source: MatchSource.Body,
      });
    });

    it("extracts plan from URL in title", () => {
      const title =
        "Implement https://app.closedloop.dev/implementation-plans/PLN-7";
      const results = parseArtifactReferences(title, null, appBaseUrl);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        slug: "PLN-7",
        matchType: MatchType.Url,
        source: MatchSource.Title,
      });
    });

    it("handles trailing slash in base URL", () => {
      const body = "See https://app.closedloop.dev/implementation-plans/PLN-10";
      const results = parseArtifactReferences(
        "PR",
        body,
        "https://app.closedloop.dev/"
      );
      expect(results).toHaveLength(1);
      expect(results[0]!.slug).toBe("PLN-10");
    });

    it("does not match URL with wrong base", () => {
      const body = "See https://other.domain.com/implementation-plans/PLN-42";
      const results = parseArtifactReferences("PR", body, appBaseUrl);
      // Should only match via slug pattern, not URL pattern
      expect(results).toHaveLength(1);
      expect(results[0].matchType).toBe(MatchType.Slug);
    });

    it("URL match takes precedence over slug match for same reference", () => {
      const body =
        "Implements PLN-42. See https://app.closedloop.dev/implementation-plans/PLN-42";
      const results = parseArtifactReferences("PR", body, appBaseUrl);
      expect(results).toHaveLength(1);
      expect(results[0].matchType).toBe(MatchType.Url);
      expect(results[0].slug).toBe("PLN-42");
    });

    it("extracts plan from org-scoped URL", () => {
      const body =
        "See https://app.closedloop.dev/acme/implementation-plans/PLN-42";
      const results = parseArtifactReferences("PR", body, appBaseUrl);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        slug: "PLN-42",
        docType: DocumentType.ImplementationPlan,
        matchType: MatchType.Url,
        source: MatchSource.Body,
      });
    });

    it("extracts feature from org-scoped URL", () => {
      const body =
        "See https://app.closedloop.dev/closedloop/features/FEA-17 for details";
      const results = parseArtifactReferences("PR", body, appBaseUrl);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        slug: "FEA-17",
        docType: DocumentType.Feature,
        matchType: MatchType.Url,
        source: MatchSource.Body,
      });
    });

    it("matches both org-scoped and legacy URLs in the same body", () => {
      const body = [
        "New: https://app.closedloop.dev/acme/features/FEA-1",
        "Old: https://app.closedloop.dev/features/FEA-2",
      ].join("\n");
      const results = parseArtifactReferences("PR", body, appBaseUrl);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.slug)).toEqual(["FEA-1", "FEA-2"]);
      expect(results.every((r) => r.matchType === MatchType.Url)).toBe(true);
    });

    it("org-scoped URL takes precedence over slug match", () => {
      const body =
        "PLN-42 at https://app.closedloop.dev/acme/implementation-plans/PLN-42";
      const results = parseArtifactReferences("PR", body, appBaseUrl);
      expect(results).toHaveLength(1);
      expect(results[0].matchType).toBe(MatchType.Url);
    });
  });

  describe("mixed references", () => {
    it("returns both plan and feature refs when both are present in title", () => {
      const results = parseArtifactReferences("FEA-42: implement PLN-17", null);
      expect(results).toHaveLength(2);
      const slugs = results.map((r) => r.slug);
      expect(slugs).toContain("FEA-42");
      expect(slugs).toContain("PLN-17");
      const planRef = results.find((r) => r.slug === "PLN-17");
      expect(planRef?.docType).toBe(DocumentType.ImplementationPlan);
      const featureRef = results.find((r) => r.slug === "FEA-42");
      expect(featureRef?.docType).toBe(DocumentType.Feature);
    });
  });

  describe("precedence and tie-breaking", () => {
    it("title matches take precedence over body matches", () => {
      const results = parseArtifactReferences(
        "PLN-1 in title",
        "PLN-2 in body"
      );
      expect(results).toHaveLength(2);
      expect(results[0].slug).toBe("PLN-1");
      expect(results[0].source).toBe(MatchSource.Title);
      expect(results[1].slug).toBe("PLN-2");
      expect(results[1].source).toBe(MatchSource.Body);
    });

    it("returns every occurrence in body in order", () => {
      const results = parseArtifactReferences(
        null,
        "PLN-10 then PLN-20 then PLN-30"
      );
      expect(results).toHaveLength(3);
      expect(results[0].slug).toBe("PLN-10");
    });

    it("deduplicates same slug across title and body", () => {
      const results = parseArtifactReferences("PLN-42", "Also mentions PLN-42");
      expect(results).toHaveLength(1);
      expect(results[0].source).toBe(MatchSource.Title);
    });

    it("deduplicates case-insensitively", () => {
      const results = parseArtifactReferences("pln-42", "PLN-42");
      expect(results).toHaveLength(1);
    });
  });

  describe("empty and null input handling", () => {
    it("returns empty array for null title and null body", () => {
      expect(parseArtifactReferences(null, null)).toEqual([]);
    });

    it("returns empty array for undefined title and undefined body", () => {
      expect(parseArtifactReferences(undefined, undefined)).toEqual([]);
    });

    it("returns empty array for empty strings", () => {
      expect(parseArtifactReferences("", "")).toEqual([]);
    });

    it("returns empty array when no references found", () => {
      expect(
        parseArtifactReferences("Regular PR title", "No refs here")
      ).toEqual([]);
    });
  });

  describe("no app base URL", () => {
    it("still matches slug pattern without appBaseUrl", () => {
      const body = "See https://app.closedloop.dev/implementation-plans/PLN-42";
      const results = parseArtifactReferences("PR", body);
      expect(results).toHaveLength(1);
      expect(results[0].matchType).toBe(MatchType.Slug);
    });
  });
});
