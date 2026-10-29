import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ resolved: undefined as unknown }));

vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    ...original,
    createRequire: () => () => fake.resolved,
  };
});

import { resolveElectronBinary } from "../scripts/vibe-profile/launch-env";

const NOT_A_BINARY_RE = /did not resolve to a binary path/;

afterEach(() => {
  fake.resolved = undefined;
});

describe("resolveElectronBinary", () => {
  it("returns the path the electron package resolves to", () => {
    fake.resolved = "/synthetic/electron";
    expect(resolveElectronBinary()).toBe("/synthetic/electron");
  });

  it.each([
    ["an object", { default: "/synthetic/electron" }],
    ["undefined", undefined],
  ])("throws when the package resolves to %s", (_label, value) => {
    fake.resolved = value;
    expect(() => resolveElectronBinary()).toThrow(NOT_A_BINARY_RE);
  });
});
