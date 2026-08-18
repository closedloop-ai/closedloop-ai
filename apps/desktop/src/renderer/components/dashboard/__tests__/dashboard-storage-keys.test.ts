/**
 * The first-run flags degrade rather than throw.
 *
 * A present `localStorage` whose `getItem`/`setItem` throws is a real state —
 * Safari private browsing, a blocked or quota-exhausted store — and these flags
 * are read during the render of the landing gate and the first-launch dashboard.
 * An exception there takes the whole renderer down, which is why the guard has
 * to cover the operation and not only the property access.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import {
  dashboardOnboardedStorageKey,
  readFlag,
  writeFlag,
} from "../dashboard-storage-keys";

function stubThrowingLocalStorage(): void {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("localStorage read blocked");
    },
    setItem: () => {
      throw new Error("localStorage write blocked");
    },
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("first-run storage flags", () => {
  it("reads a blocked store as unset instead of throwing", () => {
    stubThrowingLocalStorage();

    expect(readFlag(dashboardOnboardedStorageKey)).toBe(false);
  });

  it("swallows a blocked write instead of throwing", () => {
    stubThrowingLocalStorage();

    expect(() => writeFlag(dashboardOnboardedStorageKey)).not.toThrow();
  });

  it("still round-trips through a working store", () => {
    // The degradation must not have been bought by swallowing the happy path
    // too: a guard that returned false unconditionally would pass both cases
    // above.
    stubLocalStorage();

    expect(readFlag(dashboardOnboardedStorageKey)).toBe(false);
    writeFlag(dashboardOnboardedStorageKey);
    expect(readFlag(dashboardOnboardedStorageKey)).toBe(true);
  });
});
