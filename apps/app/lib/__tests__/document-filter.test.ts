import { describe, expect, test } from "vitest";
import { createMockDocument } from "@/__tests__/fixtures/documents";
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

  test("null snippet does not throw and non-matching still returns false", () => {
    const artifact = createMockDocument({ title: "No Snippet", snippet: null });
    expect(matchesFilter(artifact, "zzznomatch")).toBe(false);
  });

  test("matches on snippet content", () => {
    const artifact = createMockDocument({
      snippet: "payment gateway integration",
    });
    expect(matchesFilter(artifact, "payment")).toBe(true);
  });

  test("matches on workstream title", () => {
    const artifact = createMockDocument({
      workstream: { id: "ws-1", title: "Target Thread", state: "INITIATED" },
    });
    expect(matchesFilter(artifact, "target thread")).toBe(true);
  });

  test("cross-field boundary false-positive: query spanning two fields returns false", () => {
    // "endfoo" ends title, "barstart" starts snippet — query "foo bar" must NOT match
    const artifact = createMockDocument({
      title: "endfoo",
      snippet: "barstart",
    });
    expect(matchesFilter(artifact, "foo bar")).toBe(false);
  });

  test("returns false when no field matches the term", () => {
    const artifact = createMockDocument({
      title: "Login Flow",
      snippet: "some content",
      workstream: { id: "ws-1", title: "Feature A", state: "INITIATED" },
    });
    expect(matchesFilter(artifact, "zzznomatch")).toBe(false);
  });
});
