import { describe, expect, it } from "vitest";
import { isUuid, normalizeUuid } from "../../lib/is-uuid";

describe("isUuid", () => {
  it("returns true for a valid UUID v4", () => {
    expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("returns true for a valid UUID v7", () => {
    expect(isUuid("01932b3a-7e4d-7c8f-9a1b-2c3d4e5f6a7b")).toBe(true);
  });

  it("returns true for uppercase UUID", () => {
    expect(isUuid("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("returns false for typed slugs", () => {
    expect(isUuid("PRD-42")).toBe(false);
    expect(isUuid("FEAT-1")).toBe(false);
    expect(isUuid("PROJ-123")).toBe(false);
    expect(isUuid("WORK-5")).toBe(false);
    expect(isUuid("PLAN-7")).toBe(false);
  });

  it("returns false for nanoid slugs", () => {
    expect(isUuid("m4e8g7k2j9h5b3")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isUuid("")).toBe(false);
  });

  it("returns false for partial UUIDs", () => {
    expect(isUuid("550e8400-e29b-41d4")).toBe(false);
  });
});

describe("normalizeUuid", () => {
  it("canonicalizes uppercase hex without changing UUID identity", () => {
    expect(normalizeUuid("550E8400-E29B-41D4-A716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000"
    );
  });
});
