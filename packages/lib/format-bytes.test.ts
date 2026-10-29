import { describe, expect, it } from "vitest";
import {
  formatBinaryBytes,
  formatBinaryBytesWithDecimalLabels,
  UNKNOWN_BYTE_SIZE_LABEL,
} from "./format-bytes";

describe("formatBinaryBytesWithDecimalLabels", () => {
  it("keeps the exact unit boundaries", () => {
    expect(formatBinaryBytesWithDecimalLabels(0)).toBe("0 B");
    expect(formatBinaryBytesWithDecimalLabels(1023)).toBe("1023 B");
    expect(formatBinaryBytesWithDecimalLabels(1024)).toBe("1 KB");
    expect(formatBinaryBytesWithDecimalLabels(1_048_576)).toBe("1 MB");
    expect(formatBinaryBytesWithDecimalLabels(1_073_741_824)).toBe("1 GB");
  });

  it("carries to the next unit when rounding reaches 1024", () => {
    // The loop stops below 1024, then the rounding pushes the remainder back
    // onto a figure that is invalid for the unit. Without the carry these read
    // "1024 KB" and "1024 MB".
    expect(formatBinaryBytesWithDecimalLabels(1_048_535)).toBe("1 MB");
    expect(formatBinaryBytesWithDecimalLabels(1_048_575)).toBe("1 MB");
    expect(formatBinaryBytesWithDecimalLabels(1_073_741_823)).toBe("1 GB");
  });

  it("does not carry a value that is genuinely below the boundary", () => {
    expect(formatBinaryBytesWithDecimalLabels(1536)).toBe("1.5 KB");
    expect(formatBinaryBytesWithDecimalLabels(2_576_980_378)).toBe("2.4 GB");
  });

  it("stays in GB above the top tier rather than inventing a TB label", () => {
    expect(formatBinaryBytesWithDecimalLabels(1024 ** 4)).toBe("1024 GB");
  });

  it("reports an absent size as unknown rather than a fabricated zero", () => {
    expect(formatBinaryBytesWithDecimalLabels(null)).toBe(
      UNKNOWN_BYTE_SIZE_LABEL
    );
    expect(formatBinaryBytesWithDecimalLabels(null)).not.toBe("0 B");
  });
});

describe("formatBinaryBytes", () => {
  it("formats byte boundaries with binary units matching the divisor", () => {
    // These four are the assertions already pinned in
    // `apps/desktop/test/agent-session-sync-service-helpers.test.ts`; the
    // desktop delegation must keep them byte-identical.
    expect(formatBinaryBytes(0)).toBe("0 B");
    expect(formatBinaryBytes(1023)).toBe("1023 B");
    expect(formatBinaryBytes(1024)).toBe("1.0 KiB");
    expect(formatBinaryBytes(1024 * 1024 - 1)).toBe("1024.0 KiB");
    expect(formatBinaryBytes(1024 * 1024)).toBe("1.0 MiB");
  });

  it("stays in MiB above the top tier", () => {
    expect(formatBinaryBytes(1024 ** 3)).toBe("1024.0 MiB");
  });

  it("labels differently from the decimal variant at the same size", () => {
    // The reason both exist: one is user copy, one is a log line, and they do
    // not agree on units. Collapsing them would change one of the two outputs.
    expect(formatBinaryBytes(1024)).not.toBe(
      formatBinaryBytesWithDecimalLabels(1024)
    );
  });
});
