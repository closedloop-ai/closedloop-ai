import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBrowserTimeZone } from "../browser-time-zone";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveBrowserTimeZone", () => {
  it("returns the zone the browser reports", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({ timeZone: "America/New_York" }),
    } as unknown as Intl.DateTimeFormat);

    expect(resolveBrowserTimeZone()).toBe("America/New_York");
  });

  it("resolves a real zone with no stubbing in place", () => {
    // Guards the success path against a fix that only works under the mock:
    // the unstubbed environment must still hand back a usable IANA zone.
    const zone = resolveBrowserTimeZone();
    expect(typeof zone).toBe("string");
    expect(zone).not.toBe("");
  });

  it("falls back to undefined when Intl throws", () => {
    // The caller then stays on the server's UTC bucketing rather than
    // propagating the throw into a render.
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new RangeError("Intl unavailable");
    });

    expect(resolveBrowserTimeZone()).toBeUndefined();
  });

  it("falls back to undefined when resolvedOptions throws", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => {
        throw new TypeError("no resolved options");
      },
    } as unknown as Intl.DateTimeFormat);

    expect(resolveBrowserTimeZone()).toBeUndefined();
  });

  it.each([
    ["an empty string", ""],
    ["undefined", undefined],
  ])(
    "falls back to undefined when the reported zone is %s",
    (_label, timeZone) => {
      vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
        resolvedOptions: () => ({ timeZone }),
      } as unknown as Intl.DateTimeFormat);

      expect(resolveBrowserTimeZone()).toBeUndefined();
    }
  );
});
