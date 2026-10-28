import { describe, expect, it } from "vitest";
import { formatBytes } from "../format-utils";

describe("formatBytes", () => {
  it("carries to the next unit when rounding reaches 1024", () => {
    // The regression whitlockk caught on ISS-8678, and a signature this repo had
    // already recorded once (audit-characters/chrisc/metrics-mira.md): the
    // divide loop stops below 1024, then `Math.round(value * 10) / 10` pushes
    // the remainder back up onto an invalid figure for the unit.
    expect(formatBytes(1_048_535)).toBe("1 MB");
    expect(formatBytes(1_048_575)).toBe("1 MB");
    expect(formatBytes(1_073_741_823)).toBe("1 GB");
  });

  it("keeps the exact unit boundaries", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1_048_576)).toBe("1 MB");
    expect(formatBytes(1_073_741_824)).toBe("1 GB");
  });

  it("does not round a value that is genuinely below the carry", () => {
    // The carry must not fire on an ordinary value, or every size would climb
    // a unit. 1.5 KB and 2.4 GB are the figures the onboarding wizard shows.
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(2_576_980_378)).toBe("2.4 GB");
  });

  it("reports an absent size as unknown rather than a fabricated zero", () => {
    // The honesty half of the contract: a caller that never measured a size
    // must not be able to render one, and "0 B" is a measurement.
    expect(formatBytes(null)).toBe("an unknown size");
    expect(formatBytes(null)).not.toBe("0 B");
  });
});
