import { describe, expect, it } from "vitest";
import { formatSessionDateRange } from "../format-session-date-range";

declare const process: {
  argv: string[];
  env: {
    TZ?: string;
  };
};

const TZ_EXPECTATIONS = {
  "America/New_York": {
    collapsedRange: "Dec 31, 2025",
    spanningRange: "Jan 1, 2026",
  },
  "Asia/Tokyo": {
    collapsedRange: "Jan 1, 2026",
    spanningRange: "Jan 1 – Jan 2, 2026",
  },
} as const;

const tzProcessTestExplicitlyRequested = process.argv.some((arg) =>
  arg.includes("format-session-date-range-tz-process.test.ts")
);
const processTimeZone = process.env.TZ;
const supportedProcessTimeZone =
  processTimeZone === "America/New_York" || processTimeZone === "Asia/Tokyo";

if (tzProcessTestExplicitlyRequested && !supportedProcessTimeZone) {
  throw new Error(
    `format-session-date-range-tz-process.test.ts must be launched with an explicit supported TZ; received ${processTimeZone ?? "<unset>"}`
  );
}

describe.runIf(supportedProcessTimeZone)(
  "desktop session date range formatting in an explicit TZ process",
  () => {
    it("classifies near-midnight UTC bounds by the launched process time zone", () => {
      const expectation = expectationForProcessTimeZone();

      expect(
        formatSessionDateRange(
          "2026-01-01T01:00:00.000Z",
          "2026-01-01T03:00:00.000Z"
        )
      ).toBe(expectation.collapsedRange);
      expect(
        formatSessionDateRange(
          "2026-01-01T14:00:00.000Z",
          "2026-01-01T16:00:00.000Z"
        )
      ).toBe(expectation.spanningRange);
    });
  }
);

function expectationForProcessTimeZone(): (typeof TZ_EXPECTATIONS)[keyof typeof TZ_EXPECTATIONS] {
  return TZ_EXPECTATIONS[processTimeZone as keyof typeof TZ_EXPECTATIONS];
}
