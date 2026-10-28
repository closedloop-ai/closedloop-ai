/**
 * ISS-12394: `rulingFlag` with an OWN key whose value is undefined, the arm
 * after the `Object.hasOwn` guard.
 */
import { describe, expect, it } from "vitest";
import { rulingFlag } from "../scripts/fea3597-identity-probe-lib.js";

describe("rulingFlag", () => {
  it("leaves a dossier unflagged when its own ruling entry is undefined", () => {
    const expected: Record<string, number> = {};
    Object.defineProperty(expected, "abcd1234", {
      value: undefined,
      enumerable: true,
    });
    expect(rulingFlag("abcd1234", 0, expected)).toEqual({
      label: "",
      mismatch: false,
    });
  });
});
