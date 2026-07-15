import { describe, expect, it } from "vitest";
import { isHeadlessSession } from "./headless.js";

describe("FEA-2870: isHeadlessSession", () => {
  it("flags SDK-launched sessions as headless", () => {
    expect(isHeadlessSession({ entrypoint: "sdk-ts" })).toBe(true);
  });

  it("flags bypassPermissions sessions as headless", () => {
    expect(isHeadlessSession({ permissionMode: "bypassPermissions" })).toBe(
      true
    );
  });

  it("treats interactive CLI / default permissions as NOT headless", () => {
    expect(
      isHeadlessSession({ entrypoint: "cli", permissionMode: "default" })
    ).toBe(false);
    expect(isHeadlessSession({ entrypoint: "codex" })).toBe(false);
    expect(
      isHeadlessSession({ entrypoint: "cli", permissionMode: "plan" })
    ).toBe(false);
  });

  it("handles null/undefined signals without throwing", () => {
    expect(isHeadlessSession({})).toBe(false);
    expect(isHeadlessSession({ entrypoint: null, permissionMode: null })).toBe(
      false
    );
  });
});
