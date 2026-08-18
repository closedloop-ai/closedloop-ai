/**
 * Unit tests for agent-session-projection-utils.ts.
 * All branches in the helper module are tested directly here so the projection
 * module's coverage does not depend on end-to-end round-trips.
 */
import type { TurnItem } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  argumentText,
  clipText,
  commandDetail,
  firstNonNull,
  formatDurationMs,
  getTurnItemRow,
  getTurnItemTime,
  jsonToDisplayText,
  numberValue,
  statusDetail,
  timestampMs,
} from "./agent-session-projection-utils.ts";

// ---------------------------------------------------------------------------
// Minimal item fixtures — use the smallest TurnItem variants that exercise the
// target branches without requiring heavy projection machinery.
// ---------------------------------------------------------------------------

const EVENT_ITEM: TurnItem = {
  type: "event",
  _row: 7,
  t: "2026-01-01T00:00:01.000Z",
  tMs: 1000,
  dot: "g",
  text: "hello",
};

const IDLE_ITEM: TurnItem = { type: "idle", gap: 5 };

describe("getTurnItemTime", () => {
  it("returns tMs for items that carry it", () => {
    expect(getTurnItemTime(EVENT_ITEM)).toBe(1000);
  });

  it("returns 0 for items without tMs (e.g. idle)", () => {
    expect(getTurnItemTime(IDLE_ITEM)).toBe(0);
  });
});

describe("getTurnItemRow", () => {
  it("returns _row for items that carry it", () => {
    expect(getTurnItemRow(EVENT_ITEM)).toBe(7);
  });

  it("returns 0 for items without _row (e.g. idle)", () => {
    expect(getTurnItemRow(IDLE_ITEM)).toBe(0);
  });
});

describe("firstNonNull", () => {
  it("returns the first truthy string, skipping nulls and undefineds", () => {
    expect(firstNonNull(null, undefined, "hello", "world")).toBe("hello");
  });

  it("returns null when all values are null, undefined, or empty", () => {
    expect(firstNonNull(null, undefined)).toBeNull();
    expect(firstNonNull()).toBeNull();
  });
});

describe("timestampMs", () => {
  it("returns a finite number input directly", () => {
    expect(timestampMs(42)).toBe(42);
    expect(timestampMs(0)).toBe(0);
  });

  it("parses a valid ISO string to epoch-ms", () => {
    const isoDate = "2026-01-01T00:00:00.000Z";
    expect(timestampMs(isoDate)).toBe(Date.parse(isoDate));
  });

  it("returns undefined for an unparsable string", () => {
    expect(timestampMs("not-a-date")).toBeUndefined();
    expect(timestampMs("")).toBeUndefined();
  });

  it("returns undefined for non-string non-number inputs", () => {
    expect(timestampMs(null)).toBeUndefined();
    expect(timestampMs({})).toBeUndefined();
    expect(timestampMs([])).toBeUndefined();
  });
});

describe("jsonToDisplayText", () => {
  it("returns null for null and undefined", () => {
    expect(jsonToDisplayText(null)).toBeNull();
    expect(jsonToDisplayText(undefined)).toBeNull();
  });

  it("returns a non-empty string unchanged and collapses whitespace-only to null", () => {
    expect(jsonToDisplayText("hello")).toBe("hello");
    expect(jsonToDisplayText("  ")).toBeNull();
  });

  it("converts a number to its string representation", () => {
    expect(jsonToDisplayText(42)).toBe("42");
    expect(jsonToDisplayText(0)).toBe("0");
  });

  it("converts a boolean to its string representation", () => {
    expect(jsonToDisplayText(true)).toBe("true");
    expect(jsonToDisplayText(false)).toBe("false");
  });

  it("pretty-prints a plain object as JSON", () => {
    const result = jsonToDisplayText({ key: "value" });
    expect(result).toContain('"key"');
    expect(result).toContain('"value"');
  });

  it("returns null when JSON.stringify produces no text (e.g. a function)", () => {
    // JSON.stringify returns undefined for functions — exercises the falsy-text
    // arm of `text && text.trim().length > 0 ? text : null`.
    const notSerializable = () => 0;
    expect(jsonToDisplayText(notSerializable)).toBeNull();
  });

  it("returns null when JSON.stringify throws (e.g. circular reference)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(jsonToDisplayText(circular)).toBeNull();
  });
});

describe("clipText", () => {
  it("returns text unchanged and truncated=false when within max", () => {
    expect(clipText("hello", 10)).toEqual({ text: "hello", truncated: false });
  });

  it("does not truncate when length equals max exactly", () => {
    expect(clipText("hello", 5)).toEqual({ text: "hello", truncated: false });
  });

  it("slices to max chars and sets truncated=true when over max", () => {
    expect(clipText("hello world", 5)).toEqual({
      text: "hello",
      truncated: true,
    });
  });
});

describe("formatDurationMs", () => {
  it("formats sub-minute durations in whole seconds", () => {
    expect(formatDurationMs(30_000)).toBe("30s");
    expect(formatDurationMs(0)).toBe("0s");
  });

  it("formats exact minute durations without trailing seconds", () => {
    expect(formatDurationMs(120_000)).toBe("2m");
  });

  it("formats minute durations with remaining seconds", () => {
    expect(formatDurationMs(90_000)).toBe("1m 30s");
  });

  it("formats exact hour durations without remaining minutes", () => {
    expect(formatDurationMs(3_600_000)).toBe("1h");
  });

  it("formats hour durations with remaining minutes", () => {
    expect(formatDurationMs(3_660_000)).toBe("1h 1m");
    expect(formatDurationMs(7_260_000)).toBe("2h 1m");
  });
});

describe("argumentText", () => {
  it("returns a non-empty string directly (early-return path)", () => {
    expect(argumentText("git commit")).toBe("git commit");
  });

  it("joins array elements into a space-separated string", () => {
    expect(argumentText(["diff", "--stat"])).toBe("diff --stat");
  });

  it("skips non-string/non-number array elements", () => {
    expect(argumentText(["--flag", 42, null, "--other"])).toBe(
      "--flag 42 --other"
    );
  });

  it("returns null for a non-string non-array input", () => {
    expect(argumentText(null)).toBeNull();
    expect(argumentText(42)).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(argumentText([])).toBeNull();
  });
});

describe("numberValue", () => {
  it("returns the value for a finite number", () => {
    expect(numberValue(3)).toBe(3);
    expect(numberValue(0)).toBe(0);
  });

  it("returns 0 for non-finite or non-number inputs", () => {
    expect(numberValue(Number.NaN)).toBe(0);
    expect(numberValue(Number.POSITIVE_INFINITY)).toBe(0);
    expect(numberValue("42")).toBe(0);
    expect(numberValue(null)).toBe(0);
  });
});

describe("commandDetail", () => {
  it("concatenates command and args when args is not already part of command", () => {
    expect(commandDetail({ command: "git", args: "commit" }, null)).toBe(
      "git commit"
    );
  });

  it("returns just the command when command already contains args", () => {
    expect(
      commandDetail({ command: "git diff --stat", args: "--stat" }, null)
    ).toBe("git diff --stat");
  });

  it("returns just args when command is absent", () => {
    expect(commandDetail({ args: "--flag" }, null)).toBe("--flag");
  });

  it("returns null when neither command nor args resolves to a value", () => {
    expect(commandDetail({}, null)).toBeNull();
  });

  it("falls back to toolInput for command/args when data fields are absent", () => {
    expect(
      commandDetail({}, { executable: "npx", arguments: ["tsc", "--noEmit"] })
    ).toBe("npx tsc --noEmit");
  });
});

describe("statusDetail", () => {
  it("returns a numeric exit code as 'exit N'", () => {
    expect(statusDetail({ exitCode: 0 }, null)).toBe("exit 0");
    expect(statusDetail({ exit_code: 1 }, null)).toBe("exit 1");
  });

  it("prefers an explicit status string over an exit code", () => {
    expect(statusDetail({ status: "passed", exitCode: 0 }, null)).toBe(
      "passed"
    );
  });

  it("returns undefined when no exit code or status is present", () => {
    expect(statusDetail({}, null)).toBeUndefined();
  });
});
