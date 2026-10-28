import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readCheckedFeatureFlags,
  recordCheckedFeatureFlags,
  recordServerCheckedFeatureFlags,
  registerMountedCheckedFeatureFlag,
  resetCheckedFeatureFlags,
  setPersistentCheckedFeatureFlags,
  subscribeToCheckedFeatureFlags,
} from "../checked-feature-flags-store";

afterEach(() => {
  resetCheckedFeatureFlags();
});

describe("checked feature flags store (ISS-12048)", () => {
  it("records new keys once, ignores blanks, and notifies only on change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToCheckedFeatureFlags(listener);

    recordCheckedFeatureFlags(["alpha", "", "beta", "alpha"]);
    const first = readCheckedFeatureFlags();
    recordCheckedFeatureFlags(["beta"]);

    expect([...first]).toEqual(["alpha", "beta"]);
    expect(readCheckedFeatureFlags()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("stops growing at its bound", () => {
    recordCheckedFeatureFlags(
      Array.from({ length: 1200 }, (_, index) => `flag-${index}`)
    );

    expect(readCheckedFeatureFlags().size).toBe(1000);
  });

  it("clears on reset", () => {
    recordCheckedFeatureFlags(["alpha"]);
    resetCheckedFeatureFlags();

    expect(readCheckedFeatureFlags().size).toBe(0);
  });

  it("keeps mounted shell flags and restores each page's server keys on navigation", () => {
    const unmountShell = registerMountedCheckedFeatureFlag("shell-flag");
    const unmountFirstPage = registerMountedCheckedFeatureFlag("first-page");
    recordServerCheckedFeatureFlags("/first", ["first-server"]);
    resetCheckedFeatureFlags("/first");
    expect([...readCheckedFeatureFlags()]).toEqual([
      "shell-flag",
      "first-page",
      "first-server",
    ]);

    unmountFirstPage();
    resetCheckedFeatureFlags("/second");
    recordServerCheckedFeatureFlags("/second", ["second-server"]);
    expect([...readCheckedFeatureFlags()]).toEqual([
      "shell-flag",
      "second-server",
    ]);

    resetCheckedFeatureFlags("/first");
    expect([...readCheckedFeatureFlags()]).toEqual([
      "shell-flag",
      "first-server",
    ]);
    unmountShell();
  });

  it("keeps Desktop main keys across navigation and removes them on account exit", () => {
    setPersistentCheckedFeatureFlags(["main-flag"]);
    resetCheckedFeatureFlags("/first");
    resetCheckedFeatureFlags("/second");
    expect([...readCheckedFeatureFlags()]).toEqual(["main-flag"]);

    setPersistentCheckedFeatureFlags([]);
    expect(readCheckedFeatureFlags().size).toBe(0);
  });
});
