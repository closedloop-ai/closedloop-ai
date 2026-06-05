import { describe, expect, it } from "vitest";
import {
  MatchSource,
  MatchType,
  parsePlanReferences,
} from "../plan-reference-parser";

describe("parsePlanReferences", () => {
  describe("slug pattern", () => {
    it("extracts PLN-{n} from title", () => {
      const results = parsePlanReferences("Fix bug for PLN-42", null);
      expect(results).toEqual([
        {
          slug: "PLN-42",
          matchType: MatchType.Slug,
          source: MatchSource.Title,
        },
      ]);
    });

    it("extracts PLN-{n} from body", () => {
      const results = parsePlanReferences("Some PR", "Implements PLN-99");
      expect(results).toEqual([
        {
          slug: "PLN-99",
          matchType: MatchType.Slug,
          source: MatchSource.Body,
        },
      ]);
    });

    it("is case-insensitive (pln-42, Pln-42)", () => {
      const lower = parsePlanReferences("fix pln-42", null);
      expect(lower).toHaveLength(1);
      expect(lower[0].slug).toBe("PLN-42");

      const mixed = parsePlanReferences("fix Pln-42", null);
      expect(mixed).toHaveLength(1);
      expect(mixed[0].slug).toBe("PLN-42");
    });

    it("enforces word boundary — no match for MYPLN-42", () => {
      const results = parsePlanReferences("MYPLN-42 is here", null);
      expect(results).toEqual([]);
    });

    it("enforces word boundary — no match for PLN-42abc (no boundary between digit and letter)", () => {
      // \b does NOT exist between '2' and 'a' since both are word characters
      // so PLN-42abc fails the trailing \b check
      const results = parsePlanReferences("PLN-42abc", null);
      expect(results).toEqual([]);
    });

    it("does not match PLN-0 with no digits", () => {
      const results = parsePlanReferences("PLN- is not valid", null);
      expect(results).toEqual([]);
    });
  });

  describe("URL pattern", () => {
    const appBaseUrl = "https://app.closedloop.dev";

    it("extracts plan from full URL in body", () => {
      const body =
        "See https://app.closedloop.dev/implementation-plans/PLN-42 for details";
      const results = parsePlanReferences("Some PR", body, appBaseUrl);
      expect(results).toEqual([
        { slug: "PLN-42", matchType: MatchType.Url, source: MatchSource.Body },
      ]);
    });

    it("extracts plan from URL in title", () => {
      const title =
        "Implement https://app.closedloop.dev/implementation-plans/PLN-7";
      const results = parsePlanReferences(title, null, appBaseUrl);
      expect(results).toEqual([
        { slug: "PLN-7", matchType: MatchType.Url, source: MatchSource.Title },
      ]);
    });

    it("handles trailing slash in base URL", () => {
      const body = "See https://app.closedloop.dev/implementation-plans/PLN-10";
      const results = parsePlanReferences(
        "PR",
        body,
        "https://app.closedloop.dev/"
      );
      expect(results).toHaveLength(1);
      expect(results[0]!.slug).toBe("PLN-10");
    });

    it("does not match URL with wrong base", () => {
      const body = "See https://other.domain.com/implementation-plans/PLN-42";
      const results = parsePlanReferences("PR", body, appBaseUrl);
      // Should only match via slug pattern, not URL pattern
      expect(results).toHaveLength(1);
      expect(results[0].matchType).toBe(MatchType.Slug);
    });

    it("URL match takes precedence over slug match for same reference", () => {
      const body =
        "Implements PLN-42. See https://app.closedloop.dev/implementation-plans/PLN-42";
      const results = parsePlanReferences("PR", body, appBaseUrl);
      // URL pattern is checked first, so the URL match wins for PLN-42
      expect(results).toHaveLength(1);
      expect(results[0].matchType).toBe(MatchType.Url);
      expect(results[0].slug).toBe("PLN-42");
    });
  });

  describe("precedence and tie-breaking", () => {
    it("title matches take precedence over body matches", () => {
      const results = parsePlanReferences("PLN-1 in title", "PLN-2 in body");
      expect(results).toHaveLength(2);
      expect(results[0].slug).toBe("PLN-1");
      expect(results[0].source).toBe(MatchSource.Title);
      expect(results[1].slug).toBe("PLN-2");
      expect(results[1].source).toBe(MatchSource.Body);
    });

    it("first occurrence in body wins when multiple references present", () => {
      const results = parsePlanReferences(
        null,
        "PLN-10 then PLN-20 then PLN-30"
      );
      expect(results).toHaveLength(3);
      expect(results[0].slug).toBe("PLN-10");
    });

    it("deduplicates same slug across title and body", () => {
      const results = parsePlanReferences("PLN-42", "Also mentions PLN-42");
      expect(results).toHaveLength(1);
      expect(results[0].source).toBe(MatchSource.Title);
    });

    it("deduplicates case-insensitively", () => {
      const results = parsePlanReferences("pln-42", "PLN-42");
      expect(results).toHaveLength(1);
    });
  });

  describe("empty and null input handling", () => {
    it("returns empty array for null title and null body", () => {
      expect(parsePlanReferences(null, null)).toEqual([]);
    });

    it("returns empty array for undefined title and undefined body", () => {
      expect(parsePlanReferences(undefined, undefined)).toEqual([]);
    });

    it("returns empty array for empty strings", () => {
      expect(parsePlanReferences("", "")).toEqual([]);
    });

    it("returns empty array when no plan references found", () => {
      expect(
        parsePlanReferences("Regular PR title", "No plan refs here")
      ).toEqual([]);
    });
  });

  describe("no app base URL", () => {
    it("still matches slug pattern without appBaseUrl", () => {
      const body = "See https://app.closedloop.dev/implementation-plans/PLN-42";
      const results = parsePlanReferences("PR", body);
      // Without base URL, URL pattern is skipped; slug pattern still matches
      expect(results).toHaveLength(1);
      expect(results[0].matchType).toBe(MatchType.Slug);
    });
  });
});
