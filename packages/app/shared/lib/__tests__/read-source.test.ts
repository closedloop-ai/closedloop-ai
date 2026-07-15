import { ReadSource } from "@repo/api/src/types/read-source";
import { describe, expect, it } from "vitest";
import { withReadSource } from "../read-source";

describe("withReadSource", () => {
  it("stamps the default source when the envelope has none", () => {
    const response: { items: number[]; readSource?: ReadSource } = {
      items: [1, 2, 3],
    };
    expect(withReadSource(response, ReadSource.Local)).toEqual({
      items: [1, 2, 3],
      readSource: ReadSource.Local,
    });
  });

  it("preserves a more specific value the boundary already reported", () => {
    const response = { items: [], readSource: ReadSource.Fallback };
    // Returns the SAME object (no copy) so an authoritative value is untouched.
    expect(withReadSource(response, ReadSource.Local)).toBe(response);
  });
});
