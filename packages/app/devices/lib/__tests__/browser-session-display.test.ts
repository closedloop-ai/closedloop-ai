import type { BrowserSessionActivity } from "@repo/api/src/types/browser-session";
import { describe, expect, it } from "vitest";
import {
  BROWSER_SESSION_MOBILE_DEVICE_LABEL,
  BROWSER_SESSION_UNKNOWN_BROWSER_LABEL,
  BROWSER_SESSION_UNKNOWN_DEVICE_LABEL,
  BROWSER_SESSION_UNKNOWN_LOCATION_LABEL,
  BrowserSessionPageCompleteness,
  describeBrowserSession,
  describeBrowserSessionPage,
  formatBrowserVersionMajor,
} from "../browser-session-display";

describe("formatBrowserVersionMajor", () => {
  it.each([
    ["148.0.7778.96", "148"],
    ["148", "148"],
    ["  148.0  ", "148"],
  ])("reduces %s to its major component", (version, expected) => {
    expect(formatBrowserVersionMajor(version)).toBe(expected);
  });

  it.each([[undefined], [""], ["   "], ["beta"], [".1"]])(
    "reports %s as unreadable rather than guessing",
    (version) => {
      expect(
        formatBrowserVersionMajor(version as string | undefined)
      ).toBeNull();
    }
  );
});

describe("describeBrowserSession browser label", () => {
  it("pairs the name with the major version only", () => {
    expect(
      describeBrowserSession({
        browserName: "Chrome",
        browserVersion: "148.0.7778.96",
      }).browserLabel
    ).toBe("Chrome 148");
  });

  it("renders the name alone when the version is unreadable", () => {
    expect(
      describeBrowserSession({ browserName: "Chrome", browserVersion: "beta" })
        .browserLabel
    ).toBe("Chrome");
  });

  it("never renders a bare version without a name", () => {
    expect(
      describeBrowserSession({ browserVersion: "148.0.7778.96" }).browserLabel
    ).toBe(BROWSER_SESSION_UNKNOWN_BROWSER_LABEL);
  });
});

describe("describeBrowserSession device label", () => {
  it.each([
    ["Macintosh", "Mac"],
    ["X11", "Linux"],
    ["CrOS", "Chromebook"],
  ])("maps the UA platform token %s to %s", (deviceType, expected) => {
    expect(describeBrowserSession({ deviceType }).deviceLabel).toBe(expected);
  });

  it("echoes an unmapped platform token instead of inventing a class", () => {
    expect(
      describeBrowserSession({ deviceType: "SymbianOS" }).deviceLabel
    ).toBe("SymbianOS");
  });

  it("falls back to mobile only when no platform was reported at all", () => {
    expect(describeBrowserSession({ isMobile: true }).deviceLabel).toBe(
      BROWSER_SESSION_MOBILE_DEVICE_LABEL
    );
    expect(describeBrowserSession({ isMobile: false }).deviceLabel).toBe(
      BROWSER_SESSION_UNKNOWN_DEVICE_LABEL
    );
  });

  it("does not read a prototype key as a device label", () => {
    expect(
      describeBrowserSession({ deviceType: "constructor" }).deviceLabel
    ).toBe("constructor");
  });
});

describe("describeBrowserSession location label", () => {
  it.each([
    [{ city: "Berlin", country: "Germany" }, "Berlin, Germany"],
    [{ city: "Berlin" }, "Berlin"],
    [{ country: "Germany" }, "Germany"],
    [{}, BROWSER_SESSION_UNKNOWN_LOCATION_LABEL],
  ])("renders %o distinctly", (activity, expected) => {
    expect(
      describeBrowserSession(activity as BrowserSessionActivity).locationLabel
    ).toBe(expected);
  });

  it("treats a blank city beside a real country as absent, not as a prefix", () => {
    expect(
      describeBrowserSession({ city: "   ", country: "Germany" }).locationLabel
    ).toBe("Germany");
  });
});

describe("describeBrowserSession with no activity at all", () => {
  it("renders every field unknown rather than a plausible default", () => {
    expect(describeBrowserSession(null)).toEqual({
      browserLabel: BROWSER_SESSION_UNKNOWN_BROWSER_LABEL,
      deviceLabel: BROWSER_SESSION_UNKNOWN_DEVICE_LABEL,
      locationLabel: BROWSER_SESSION_UNKNOWN_LOCATION_LABEL,
    });
  });
});

describe("describeBrowserSessionPage", () => {
  it("reports a bounded page as truncated against the provider total", () => {
    expect(
      describeBrowserSessionPage({ sessions: [1, 2], totalCount: 7 })
    ).toEqual({
      shownCount: 2,
      totalCount: 7,
      completeness: BrowserSessionPageCompleteness.Truncated,
    });
  });

  it("reports a complete page as complete", () => {
    expect(
      describeBrowserSessionPage({ sessions: [1, 2], totalCount: 2 })
    ).toEqual({
      shownCount: 2,
      totalCount: 2,
      completeness: BrowserSessionPageCompleteness.Complete,
    });
  });

  it.each([
    [1],
    [-3],
    [2.5],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.MAX_SAFE_INTEGER + 1],
    [Number.MAX_SAFE_INTEGER * 2],
  ])(
    "withholds a total of %s that cannot be reconciled with the page",
    (totalCount) => {
      expect(
        describeBrowserSessionPage({ sessions: [1, 2], totalCount })
      ).toEqual({
        shownCount: 2,
        totalCount: null,
        completeness: BrowserSessionPageCompleteness.Unknown,
      });
    }
  );

  it("still reconciles the largest total that has not lost precision", () => {
    // The boundary itself is exact, so it is a real total and is reported.
    // One past it is not the number the provider sent, and the case above
    // withholds it rather than present a rounded total as measured.
    expect(
      describeBrowserSessionPage({
        sessions: [1, 2],
        totalCount: Number.MAX_SAFE_INTEGER,
      })
    ).toEqual({
      shownCount: 2,
      totalCount: Number.MAX_SAFE_INTEGER,
      completeness: BrowserSessionPageCompleteness.Truncated,
    });
  });

  it("keeps an unknown total distinguishable from a complete page", () => {
    const unknown = describeBrowserSessionPage({
      sessions: [1, 2],
      totalCount: 2.5,
    });
    const complete = describeBrowserSessionPage({
      sessions: [1, 2],
      totalCount: 2,
    });

    // The collapse this replaced: a boolean `isTruncated` answered false for
    // both, so a consumer could not say "showing 2, total unknown" and
    // rendered an unreconcilable page as the whole set. Folding the three
    // members back into two makes these two answers equal and fails here.
    expect(unknown.completeness).toBe(BrowserSessionPageCompleteness.Unknown);
    expect(complete.completeness).toBe(BrowserSessionPageCompleteness.Complete);
    expect(unknown.completeness).not.toBe(complete.completeness);
  });
});
