import { describe, expect, it } from "vitest";
import { errorCode } from "../storage/error-code";

describe("errorCode", () => {
  it("is the error's string code when it has one", () => {
    expect(errorCode(Object.assign(new Error("dup"), { code: "23505" }))).toBe(
      "23505"
    );
  });

  it("is the class name when the code is not a string", () => {
    expect(errorCode(Object.assign(new TypeError("x"), { code: 42 }))).toBe(
      "TypeError"
    );
  });

  it("is the class name when there is no code", () => {
    expect(errorCode(new RangeError("x"))).toBe("RangeError");
  });

  it("is unknown for a thrown non-Error, never its text", () => {
    expect(errorCode("secret value")).toBe("unknown");
  });
});
