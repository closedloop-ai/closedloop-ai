import { describe, expect, it } from "vitest";
import { normalizeDesktopBuildCommit } from "./desktop-build-commit";

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";

describe("normalizeDesktopBuildCommit", () => {
  it("returns a full lowercase 40-hex sha unchanged", () => {
    expect(normalizeDesktopBuildCommit(FULL_SHA)).toBe(FULL_SHA);
  });

  it.each([
    ["abbreviated", FULL_SHA.slice(0, 7)],
    ["uppercase", FULL_SHA.toUpperCase()],
    ["41 chars", `${FULL_SHA}0`],
    ["non-hex", `${FULL_SHA.slice(0, 39)}g`],
    ["embedded in text", ` ${FULL_SHA}`],
    ["empty", ""],
  ])("omits a %s string", (_label, value) => {
    expect(normalizeDesktopBuildCommit(value)).toBeUndefined();
  });

  it.each([null, undefined, 42, { sha: FULL_SHA }])(
    "omits a non-string %j",
    (value) => {
      expect(normalizeDesktopBuildCommit(value)).toBeUndefined();
    }
  );
});
