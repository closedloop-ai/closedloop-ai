import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, test } from "vitest";
import { matchesFilter } from "../document-filter";

describe("matchesFilter", () => {
  test("returns true for exact title match", () => {
    const artifact = createMockDocument({ title: "Login Flow" });
    expect(matchesFilter(artifact, "Login Flow")).toBe(true);
  });

  test("returns true for partial title match", () => {
    const artifact = createMockDocument({ title: "Login Flow" });
    expect(matchesFilter(artifact, "login")).toBe(true);
  });

  test("returns true for case-insensitive title match", () => {
    const artifact = createMockDocument({ title: "Login Flow" });
    expect(matchesFilter(artifact, "LOGIN FLOW")).toBe(true);
  });

  test("returns true for any artifact when term is empty", () => {
    const artifact = createMockDocument({ title: "Anything" });
    expect(matchesFilter(artifact, "")).toBe(true);
  });

  test("returns true for whitespace-only term (trims to empty)", () => {
    const artifact = createMockDocument({ title: "Anything" });
    expect(matchesFilter(artifact, "   ")).toBe(true);
  });

  test("cross-field boundary false-positive: query spanning two fields returns false", () => {
    // "endfoo" ends title, "barstart" starts snippet — query "foo bar" must NOT match
    const artifact = createMockDocument({
      title: "endfoo",
    });
    expect(matchesFilter(artifact, "foo bar")).toBe(false);
  });

  test("returns false when no field matches the term", () => {
    const artifact = createMockDocument({
      title: "Login Flow",
    });
    expect(matchesFilter(artifact, "zzznomatch")).toBe(false);
  });

  test("matches on exact slug", () => {
    const artifact = createMockDocument({
      title: "Unrelated Title",
      slug: "FEA-414",
    });
    expect(matchesFilter(artifact, "FEA-414")).toBe(true);
  });

  test("matches on partial slug prefix", () => {
    const artifact = createMockDocument({
      title: "Unrelated Title",
      slug: "FEA-414",
    });
    expect(matchesFilter(artifact, "FEA-4")).toBe(true);
  });

  test("matches slug case-insensitively", () => {
    const artifact = createMockDocument({
      title: "Unrelated Title",
      slug: "FEA-414",
    });
    expect(matchesFilter(artifact, "fea-414")).toBe(true);
  });

  test("matches when only slug matches and title does not", () => {
    const artifact = createMockDocument({
      title: "Completely Different Name",
      slug: "PRD-42",
    });
    expect(matchesFilter(artifact, "PRD-42")).toBe(true);
  });
});
