import { DocumentStatus } from "@repo/api/src/types/document";
import { describe, expect, it } from "vitest";
import {
  compareSlugValues,
  compareStatusValues,
  NAME_SORT_OPTIONS,
} from "../sort-comparators";

describe("compareStatusValues", () => {
  describe("lifecycle order", () => {
    const orderedStatuses = [
      DocumentStatus.Draft,
      DocumentStatus.InProgress,
      DocumentStatus.InReview,
      DocumentStatus.Approved,
      DocumentStatus.Executed,
      DocumentStatus.Done,
      DocumentStatus.Obsolete,
    ];

    it("sorts statuses according to lifecycle progression", () => {
      for (let i = 0; i < orderedStatuses.length - 1; i++) {
        expect(
          compareStatusValues(orderedStatuses[i], orderedStatuses[i + 1])
        ).toBeLessThan(0);
      }
    });

    it("sorts later lifecycle statuses after earlier ones", () => {
      expect(
        compareStatusValues(DocumentStatus.Done, DocumentStatus.Draft)
      ).toBeGreaterThan(0);
      expect(
        compareStatusValues(DocumentStatus.Obsolete, DocumentStatus.InProgress)
      ).toBeGreaterThan(0);
    });
  });

  describe("equal values", () => {
    it("returns 0 for identical statuses", () => {
      expect(
        compareStatusValues(DocumentStatus.Draft, DocumentStatus.Draft)
      ).toBe(0);
      expect(
        compareStatusValues(DocumentStatus.Done, DocumentStatus.Done)
      ).toBe(0);
    });
  });

  describe("unknown values", () => {
    it("sorts unknown strings after all known DocumentStatus values", () => {
      expect(
        compareStatusValues(DocumentStatus.Obsolete, "NOT_STARTED")
      ).toBeLessThan(0);
      expect(
        compareStatusValues("COMPLETED", DocumentStatus.Draft)
      ).toBeGreaterThan(0);
    });

    it("returns 0 for two unknown values", () => {
      expect(compareStatusValues("NOT_STARTED", "COMPLETED")).toBe(0);
    });
  });

  describe("null handling", () => {
    it("sorts null after real values", () => {
      expect(compareStatusValues(DocumentStatus.Draft, null)).toBeLessThan(0);
      expect(compareStatusValues(null, DocumentStatus.Draft)).toBeGreaterThan(
        0
      );
    });

    it("returns 0 when both are null", () => {
      expect(compareStatusValues(null, null)).toBe(0);
    });
  });

  describe("undefined handling", () => {
    it("sorts undefined after real values", () => {
      expect(
        compareStatusValues(DocumentStatus.InReview, undefined)
      ).toBeLessThan(0);
      expect(
        compareStatusValues(undefined, DocumentStatus.InReview)
      ).toBeGreaterThan(0);
    });

    it("returns 0 when both are undefined", () => {
      expect(compareStatusValues(undefined, undefined)).toBe(0);
    });

    it("returns 0 when one is null and the other is undefined", () => {
      expect(compareStatusValues(null, undefined)).toBe(0);
      expect(compareStatusValues(undefined, null)).toBe(0);
    });
  });
});

describe("compareSlugValues", () => {
  describe("natural numeric sort", () => {
    it("sorts numeric suffixes naturally rather than lexicographically", () => {
      expect(compareSlugValues("FEA-1", "FEA-2")).toBeLessThan(0);
      expect(compareSlugValues("FEA-2", "FEA-10")).toBeLessThan(0);
      expect(compareSlugValues("FEA-10", "FEA-1")).toBeGreaterThan(0);
    });
  });

  describe("cross-prefix sort", () => {
    it("sorts alphabetically by prefix", () => {
      expect(compareSlugValues("FEA-1", "PLN-1")).toBeLessThan(0);
      expect(compareSlugValues("PLN-1", "PRD-1")).toBeLessThan(0);
      expect(compareSlugValues("FEA-1", "PRD-1")).toBeLessThan(0);
    });
  });

  describe("equal values", () => {
    it("returns 0 for identical slugs", () => {
      expect(compareSlugValues("FEA-1", "FEA-1")).toBe(0);
    });
  });

  describe("null handling", () => {
    it("sorts null after real values", () => {
      expect(compareSlugValues("FEA-1", null)).toBeLessThan(0);
      expect(compareSlugValues(null, "FEA-1")).toBeGreaterThan(0);
    });

    it("returns 0 when both are null", () => {
      expect(compareSlugValues(null, null)).toBe(0);
    });
  });

  describe("undefined handling", () => {
    it("sorts undefined after real values", () => {
      expect(compareSlugValues("PLN-5", undefined)).toBeLessThan(0);
      expect(compareSlugValues(undefined, "PLN-5")).toBeGreaterThan(0);
    });

    it("returns 0 when both are undefined", () => {
      expect(compareSlugValues(undefined, undefined)).toBe(0);
    });
  });
});

describe("NAME_SORT_OPTIONS", () => {
  it("contains three entries with correct keys and labels", () => {
    expect(NAME_SORT_OPTIONS).toHaveLength(3);
    expect(NAME_SORT_OPTIONS[0]).toEqual({ key: "title", label: "Name" });
    expect(NAME_SORT_OPTIONS[1]).toEqual({ key: "status", label: "Status" });
    expect(NAME_SORT_OPTIONS[2]).toEqual({ key: "slug", label: "ID" });
  });
});
