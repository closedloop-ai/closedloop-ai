import { describe, expect, it } from "vitest";
import {
  canonicalCopy,
  isCanonicalComputeTarget,
  isSameSession,
} from "./transcript-copies";

const LOW = "01a15c00-0000-7000-8000-00000000000a";
const HIGH = "01a15c00-0000-7000-8000-0000000000b0";

describe("session copies", () => {
  it("names copies by harness and external session id", () => {
    const copy = { harness: "claude", externalSessionId: "s-1" };

    expect(isSameSession(copy, { ...copy })).toBe(true);
    expect(isSameSession(copy, { ...copy, externalSessionId: "s-2" })).toBe(
      false
    );
    expect(isSameSession(copy, { ...copy, harness: "codex" })).toBe(false);
  });

  it("makes the lowest compute target id canonical, as Postgres orders a uuid", () => {
    expect(isCanonicalComputeTarget(LOW, HIGH)).toBe(true);
    expect(isCanonicalComputeTarget(HIGH, LOW)).toBe(false);
    expect(isCanonicalComputeTarget(LOW, LOW)).toBe(false);
    expect(isCanonicalComputeTarget(LOW.toUpperCase(), HIGH)).toBe(true);
  });

  it("picks the canonical copy whatever order the copies arrive in", () => {
    const copies = [{ target: HIGH }, { target: LOW }];

    expect(canonicalCopy(copies, (c) => c.target)).toEqual({ target: LOW });
    expect(canonicalCopy([...copies].reverse(), (c) => c.target)).toEqual({
      target: LOW,
    });
    expect(canonicalCopy([], (c: { target: string }) => c.target)).toBe(
      undefined
    );
  });
});
