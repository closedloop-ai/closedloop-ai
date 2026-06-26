import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatRelativeTime,
  formatTime,
} from "../date-utils";

const TZ_EXPECTATIONS = {
  "America/New_York": {
    date: "Dec 31, 2025",
    dateTime: "Dec 31, 2025 at 8:30 PM",
    time: "8:30 PM",
    timeWithSeconds: "8:30:05 PM",
  },
  "Asia/Tokyo": {
    date: "Jan 1, 2026",
    dateTime: "Jan 1, 2026 at 10:30 AM",
    time: "10:30 AM",
    timeWithSeconds: "10:30:05 AM",
  },
} as const;

const tzProcessTestExplicitlyRequested = process.argv.some((arg) =>
  arg.includes("date-utils-tz-process.test.ts")
);
const processTimeZone = process.env.TZ;
const supportedProcessTimeZone =
  processTimeZone === "America/New_York" || processTimeZone === "Asia/Tokyo";

if (tzProcessTestExplicitlyRequested && !supportedProcessTimeZone) {
  throw new Error(
    `date-utils-tz-process.test.ts must be launched with an explicit supported TZ; received ${processTimeZone ?? "<unset>"}`
  );
}

describe.runIf(supportedProcessTimeZone)(
  "viewer-local timestamp formatting in an explicit TZ process",
  () => {
    it("formats the canonical UTC instant for the launched process time zone", () => {
      const expectation = expectationForProcessTimeZone();

      expect(formatDate("2026-01-01T01:30:00.000Z")).toBe(expectation.date);
      expect(formatDateTime("2026-01-01T01:30:00.000Z")).toBe(
        expectation.dateTime
      );
      expect(
        formatRelativeTime("2026-01-01T01:30:00.000Z", {
          now: new Date("2026-01-10T12:00:00.000Z"),
        })
      ).toBe(expectation.date);
      expect(formatTime("2026-01-01T01:30:45.000Z")).toBe(expectation.time);
      expect(
        formatTime("2026-01-01T01:30:05.000Z", {
          includeSeconds: true,
        })
      ).toBe(expectation.timeWithSeconds);
    });
  }
);

function expectationForProcessTimeZone(): (typeof TZ_EXPECTATIONS)[keyof typeof TZ_EXPECTATIONS] {
  return TZ_EXPECTATIONS[processTimeZone as keyof typeof TZ_EXPECTATIONS];
}
