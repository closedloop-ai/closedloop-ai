import { describe, expect, it } from "vitest";
import {
  isReadSource,
  ReadSource,
  readSourceSchema,
  readSourceValues,
} from "../read-source.js";

describe("ReadSource", () => {
  it("exposes exactly the three explicit provenance values", () => {
    expect([...readSourceValues].sort()).toEqual([
      "cloud",
      "fallback",
      "local",
    ]);
    expect(ReadSource.Local).toBe("local");
    expect(ReadSource.Cloud).toBe("cloud");
    expect(ReadSource.Fallback).toBe("fallback");
  });

  it("isReadSource accepts known sources and rejects everything else", () => {
    for (const source of readSourceValues) {
      expect(isReadSource(source)).toBe(true);
    }
    expect(isReadSource("remote")).toBe(false);
    expect(isReadSource("")).toBe(false);
    expect(isReadSource(undefined)).toBe(false);
    expect(isReadSource(null)).toBe(false);
    expect(isReadSource(1)).toBe(false);
  });

  it("readSourceSchema parses valid sources and rejects unknown strings", () => {
    expect(readSourceSchema.parse("local")).toBe("local");
    expect(readSourceSchema.safeParse("mixed").success).toBe(false);
  });
});
