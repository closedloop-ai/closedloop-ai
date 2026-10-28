import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreTimeZone } from "../../../shared/test-fixtures/tz-utils";
import {
  formatSessionCustomDateWindow,
  fromLocalCalendarDate,
  MAX_SESSION_CUSTOM_WINDOW_DAYS,
  parseSessionCustomDateWindowParams,
  resolveSessionDateWindow,
  SESSION_DATE_FROM_PARAM,
  SESSION_DATE_TO_PARAM,
  sessionCustomDateWindowBounds,
  sessionCustomDateWindowDays,
  toLocalCalendarDate,
  writeSessionCustomDateWindowParams,
} from "../session-custom-date-window";

describe("parseSessionCustomDateWindowParams", () => {
  it("reads an explicit inclusive window from both params", () => {
    expect(
      parseSessionCustomDateWindowParams(
        new URLSearchParams("from=2026-01-01&to=2026-01-08")
      )
    ).toEqual({ from: "2026-01-01", to: "2026-01-08" });
  });

  it("reads a single-day window (both bounds the same day)", () => {
    expect(
      parseSessionCustomDateWindowParams(
        new URLSearchParams("from=2026-01-01&to=2026-01-01")
      )
    ).toEqual({ from: "2026-01-01", to: "2026-01-01" });
  });

  it.each([
    ["no params at all", ""],
    ["only a lower bound", "from=2026-01-01"],
    ["only an upper bound", "to=2026-01-08"],
    ["an empty lower bound", "from=&to=2026-01-08"],
    ["a non-date lower bound", "from=yesterday&to=2026-01-08"],
    ["a bare year", "from=2026&to=2026-01-08"],
    [
      "an ISO instant rather than a day",
      "from=2026-01-01T00:00:00Z&to=2026-01-08",
    ],
    ["a day that does not exist", "from=2026-02-30&to=2026-03-08"],
    ["a month that does not exist", "from=2026-13-01&to=2026-13-08"],
    ["an inverted window", "from=2026-01-08&to=2026-01-01"],
    ["a span wider than the maximum", "from=1970-01-01&to=2026-01-10"],
  ])("returns null for %s, leaving the preset in charge", (_label, query) => {
    expect(
      parseSessionCustomDateWindowParams(new URLSearchParams(query))
    ).toBeNull();
  });

  /**
   * An over-wide span is REJECTED, not narrowed. Review found the previous
   * forward clamp made a repaired request indistinguishable from an exact one —
   * the control stated the clamped days with full confidence while the address
   * bar still carried what was asked for. Asserting the exact clamped pair is
   * absent is what stops that silent repair coming back.
   */
  it("does not narrow an over-wide span to the maximum", () => {
    // 366 inclusive days ending 2026-01-10 would have started on 2025-01-10.
    expect(
      parseSessionCustomDateWindowParams(
        new URLSearchParams("from=1970-01-01&to=2026-01-10")
      )
    ).not.toEqual({ from: "2025-01-10", to: "2026-01-10" });
  });

  it("accepts a span of exactly the maximum", () => {
    expect(MAX_SESSION_CUSTOM_WINDOW_DAYS).toBe(366);
    expect(
      parseSessionCustomDateWindowParams(
        new URLSearchParams("from=2025-01-10&to=2026-01-10")
      )
    ).toEqual({ from: "2025-01-10", to: "2026-01-10" });
  });
});

describe("sessionCustomDateWindowBounds", () => {
  it("bounds a single day at BOTH ends, covering the whole UTC day", () => {
    expect(
      sessionCustomDateWindowBounds({ from: "2026-01-01", to: "2026-01-01" })
    ).toEqual({
      endDate: "2026-01-01T23:59:59.999Z",
      startDate: "2026-01-01T00:00:00.000Z",
    });
  });

  it("ends on the last millisecond of the upper-bound day, not its midnight", () => {
    const { endDate } = sessionCustomDateWindowBounds({
      from: "2026-01-01",
      to: "2026-01-08",
    });

    expect(endDate).toBe("2026-01-08T23:59:59.999Z");
  });
});

describe("writeSessionCustomDateWindowParams", () => {
  it("writes both bounds", () => {
    const params = new URLSearchParams("page=3");

    writeSessionCustomDateWindowParams(params, {
      from: "2026-01-01",
      to: "2026-01-01",
    });

    expect(params.get(SESSION_DATE_FROM_PARAM)).toBe("2026-01-01");
    expect(params.get(SESSION_DATE_TO_PARAM)).toBe("2026-01-01");
    expect(params.get("page")).toBe("3");
  });

  it("deletes BOTH bounds when the window is cleared", () => {
    const params = new URLSearchParams("from=2026-01-01&to=2026-01-08&page=3");

    writeSessionCustomDateWindowParams(params, null);

    expect(params.has(SESSION_DATE_FROM_PARAM)).toBe(false);
    expect(params.has(SESSION_DATE_TO_PARAM)).toBe(false);
    expect(params.get("page")).toBe("3");
  });

  it("round-trips through the parser", () => {
    const params = new URLSearchParams();

    writeSessionCustomDateWindowParams(params, {
      from: "2026-01-01",
      to: "2026-01-08",
    });

    expect(parseSessionCustomDateWindowParams(params)).toEqual({
      from: "2026-01-01",
      to: "2026-01-08",
    });
  });
});

/**
 * The mutation these pin is `fromLocalCalendarDate` reading the instant through
 * `toISOString()` instead of the LOCAL Y/M/D fields. Under the default UTC test
 * runner the two are byte-identical — and so are they WEST of UTC, where local
 * midnight lands later the same UTC day (Jan 5 00:00 in Los Angeles is Jan 5
 * 08:00Z) and the day name survives. Only EAST of UTC does local midnight fall
 * back across the date line (Jan 5 00:00 in Tokyo is Jan 4 15:00Z), so the Tokyo
 * pin is the only one that can observe the mutation at all; the Los Angeles pin
 * is the control that has to stay green beside it.
 */
describe.each(["America/Los_Angeles", "Asia/Tokyo"])(
  "fromLocalCalendarDate / toLocalCalendarDate under %s",
  (timeZone) => {
    const previousTimeZone = process.env.TZ;

    beforeEach(() => {
      process.env.TZ = timeZone;
    });

    afterEach(() => {
      restoreTimeZone(previousTimeZone);
    });

    it("names the day the viewer actually pressed", () => {
      expect(fromLocalCalendarDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    });

    it("round-trips a day through the calendar's own Date and back", () => {
      const asDate = toLocalCalendarDate("2026-01-05");

      expect(asDate).toBeDefined();
      expect(fromLocalCalendarDate(asDate as Date)).toBe("2026-01-05");
    });
  }
);

describe("formatSessionCustomDateWindow", () => {
  it("states a single day once", () => {
    expect(
      formatSessionCustomDateWindow({ from: "2026-01-01", to: "2026-01-01" })
    ).toBe("Jan 1, 2026");
  });

  it("states the shared year once", () => {
    expect(
      formatSessionCustomDateWindow({ from: "2026-01-01", to: "2026-01-08" })
    ).toBe("Jan 1 - Jan 8, 2026");
  });

  it("states both years when the window crosses a year boundary", () => {
    expect(
      formatSessionCustomDateWindow({ from: "2025-12-28", to: "2026-01-03" })
    ).toBe("Dec 28, 2025 - Jan 3, 2026");
  });
});

describe("formatSessionCustomDateWindow with a non-calendar day", () => {
  it("falls back to the raw string for an upper bound that is not a real day", () => {
    expect(
      formatSessionCustomDateWindow({ from: "2025-12-28", to: "2026-02-30" })
    ).toBe("Dec 28, 2025 - 2026-02-30");
  });
});

describe("sessionCustomDateWindowDays", () => {
  it("is undefined when a preset is in charge", () => {
    expect(sessionCustomDateWindowDays(null)).toBeUndefined();
  });

  it("counts both ends inclusively", () => {
    expect(
      sessionCustomDateWindowDays({ from: "2026-01-01", to: "2026-01-08" })
    ).toBe(8);
    expect(
      sessionCustomDateWindowDays({ from: "2026-01-01", to: "2026-01-01" })
    ).toBe(1);
  });

  it.each([
    ["a lower bound", { from: "2026-02-30", to: "2026-03-05" }],
    ["an upper bound", { from: "2026-02-01", to: "2026-02-30" }],
  ])("is undefined when %s is not a real calendar day", (_label, window) => {
    expect(sessionCustomDateWindowDays(window)).toBeUndefined();
  });
});

describe("resolveSessionDateWindow", () => {
  const presetWindow = {
    startDate: "2025-12-01T00:00:00.000Z",
    endDate: "2026-01-01T00:00:00.000Z",
  };

  it("returns the preset window when there is no explicit window", () => {
    expect(resolveSessionDateWindow(null, presetWindow)).toBe(presetWindow);
  });

  it("lets the explicit window override the preset", () => {
    expect(
      resolveSessionDateWindow(
        { from: "2026-01-01", to: "2026-01-02" },
        presetWindow
      )
    ).toEqual({
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-01-02T23:59:59.999Z",
    });
  });
});

describe("toLocalCalendarDate with malformed input", () => {
  it.each([["2026-01"], ["2026-xx-05"], ["2026-01-05-01"]])(
    "returns undefined for %s",
    (day) => {
      expect(toLocalCalendarDate(day)).toBeUndefined();
    }
  );
});
