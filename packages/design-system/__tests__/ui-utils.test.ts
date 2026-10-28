import { TONE } from "@closedloop-ai/design-system/components/ui/types";
import {
  formatCompactNumber,
  formatCurrency,
  formatDateTime,
  formatDurationSeconds,
  formatLocalTime,
  formatRelativeLabel,
  formatTokenCount,
  getBadgeVariant,
  lastPathSegment,
  truncateMiddle,
} from "@closedloop-ai/design-system/components/ui/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const AP_PATTERN = /^\d{1,2}:\d{2}:\d{2}\s?[AP]M$/;
const AP_2_PATTERN = /^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M$/;

/**
 * ISS-7349. `components/ui/utils.ts` is the package's shared value-formatting
 * layer — every one of these functions decides what a reader SEES for a value
 * the caller could not vet. The story sweep runs each of them exactly once,
 * down the happy path, which is the path that was never in doubt. What is in
 * doubt is the other side of each guard: an unparseable date, a non-finite
 * duration, a width too small to hold an ellipsis, a token count sitting on a
 * rounding boundary. Those are the branches that decide between a correct
 * string and a confidently wrong one, so they are what this suite pins.
 *
 * Every assertion here pins CURRENT merged behavior; nothing below is a claim
 * about what the formatters ought to do.
 */

// 2026-08-20T12:00:00Z. Fixed so the relative-label boundaries are arithmetic
// rather than a race with the wall clock.
const NOW = new Date("2026-08-20T12:00:00.000Z");

describe("getBadgeVariant", () => {
  it.each([
    [TONE.SUCCESS, "success"],
    [TONE.WARNING, "warning"],
    [TONE.DANGER, "destructive"],
    [TONE.INFO, "info"],
    [TONE.ACCENT, "accent"],
    [TONE.DEFAULT, "outline"],
    [TONE.MUTED, "muted"],
  ])("maps tone %s to the %s badge variant", (tone, expected) => {
    expect(getBadgeVariant(tone)).toBe(expected);
  });

  it("defaults to the muted variant when no tone is supplied", () => {
    // The parameter default, not the trailing fallback — an omitted tone is a
    // caller that has no opinion, and muted is the non-committal render.
    expect(getBadgeVariant()).toBe("muted");
  });

  it("falls back to muted for a tone outside the union", () => {
    // Types do not constrain a runtime value arriving from persisted state or a
    // version-skewed caller; the trailing `return "muted"` is that floor.
    expect(getBadgeVariant("not-a-tone" as never)).toBe("muted");
  });
});

describe("formatCurrency", () => {
  it("renders whole dollars with the currency symbol", () => {
    expect(formatCurrency(1234.5)).toBe("$1,234.50");
  });

  it("caps at two fraction digits rather than showing full precision", () => {
    expect(formatCurrency(0.129)).toBe("$0.13");
  });

  it("renders a negative amount with a leading minus", () => {
    expect(formatCurrency(-42)).toBe("-$42.00");
  });
});

describe("formatRelativeLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the input unchanged when it is not a parseable date", () => {
    // The no-op fallback matters more than the happy path: it is what stops a
    // malformed timestamp rendering as "Invalid Date" in a table cell.
    expect(formatRelativeLabel("not-a-date")).toBe("not-a-date");
  });

  it.each([
    ["exactly now", 0, "just now"],
    ["29 seconds ago", -29_000, "just now"],
    ["29 seconds ahead", 29_000, "just now"],
  ])("renders %s as 'just now'", (_label, offsetMs, expected) => {
    const iso = new Date(NOW.getTime() + offsetMs).toISOString();

    expect(formatRelativeLabel(iso)).toBe(expected);
  });

  it("renders sub-hour past offsets in minutes with an 'ago' suffix", () => {
    const iso = new Date(NOW.getTime() - 45 * 60_000).toISOString();

    expect(formatRelativeLabel(iso)).toBe("45m ago");
  });

  it("renders sub-hour future offsets in minutes with a 'from now' suffix", () => {
    const iso = new Date(NOW.getTime() + 45 * 60_000).toISOString();

    expect(formatRelativeLabel(iso)).toBe("45m from now");
  });

  it("switches to hours once the offset reaches an hour", () => {
    const iso = new Date(NOW.getTime() - 5 * 3_600_000).toISOString();

    expect(formatRelativeLabel(iso)).toBe("5h ago");
  });

  it("switches to days once the rounded hour count reaches 24", () => {
    const iso = new Date(NOW.getTime() - 3 * 24 * 3_600_000).toISOString();

    expect(formatRelativeLabel(iso)).toBe("3d ago");
  });

  it("renders a future day offset with a 'from now' suffix", () => {
    const iso = new Date(NOW.getTime() + 3 * 24 * 3_600_000).toISOString();

    expect(formatRelativeLabel(iso)).toBe("3d from now");
  });

  it("rounds the half-minute boundary asymmetrically between past and future", () => {
    // Pins current behavior; looks odd because the rounding is applied to the
    // SIGNED minute delta. `Math.round` breaks ties toward +Infinity, so a
    // 30s-ago offset rounds -0.5 to -0 ("just now") while an identical 30s-ahead
    // offset rounds 0.5 to 1 ("1m from now"). The same distance from now reads
    // as two different labels depending on which side it falls.
    const past = new Date(NOW.getTime() - 30_000).toISOString();
    const future = new Date(NOW.getTime() + 30_000).toISOString();

    expect(formatRelativeLabel(past)).toBe("just now");
    expect(formatRelativeLabel(future)).toBe("1m from now");
  });
});

describe("formatDateTime", () => {
  it("returns the input unchanged when it is not a parseable date", () => {
    expect(formatDateTime("garbage")).toBe("garbage");
  });

  it("renders a parseable timestamp as month/day plus a wall time", () => {
    const rendered = formatDateTime("2026-08-20T12:00:00.000Z");

    // Formatted in the runner's zone, so assert the SHAPE rather than a fixed
    // clock reading — a date part and a time part, never the raw ISO string.
    expect(rendered).not.toBe("2026-08-20T12:00:00.000Z");
    expect(rendered).toMatch(AP_2_PATTERN);
  });
});

describe("truncateMiddle", () => {
  it("returns a string at the limit unchanged", () => {
    const exact = "a".repeat(32);

    expect(truncateMiddle(exact)).toBe(exact);
  });

  it("elides the middle of an over-length string and keeps both ends", () => {
    const long = `${"a".repeat(20)}${"b".repeat(20)}`;

    const result = truncateMiddle(long);

    expect(result).toHaveLength(32);
    expect(result.startsWith("a")).toBe(true);
    expect(result.endsWith("b")).toBe(true);
    expect(result).toContain("...");
  });

  it("returns just the ellipsis when the budget cannot hold any characters", () => {
    // max <= 3 leaves nothing visible after the ellipsis; the guard returns the
    // ellipsis alone rather than slicing with a negative length.
    expect(truncateMiddle("abcdefgh", 3)).toBe("...");
    expect(truncateMiddle("abcdefgh", 1)).toBe("...");
  });

  it("keeps a head-only slice when the budget rounds the tail to zero", () => {
    // visible = 1 -> head 1, tail 0, so the suffix branch yields "".
    expect(truncateMiddle("abcdefgh", 4)).toBe("a...");
  });
});

describe("formatDurationSeconds", () => {
  it.each([
    ["zero", 0],
    ["negative", -5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("renders %s as 0s", (_label, value) => {
    // Pins current behavior. It looks odd because NaN/Infinity mean "no
    // duration known", and folding them into the same "0s" that a real zero
    // produces renders an unknown as a measurement — the shape AGENTS.md's
    // bad-data contract argues against. Main does it anyway, and a
    // coverage PR does not change behavior in either direction; the assertion
    // is the tripwire, so whoever rules on this sees the test go red.
    expect(formatDurationSeconds(value)).toBe("0s");
  });

  it("renders a sub-minute duration in seconds", () => {
    expect(formatDurationSeconds(42)).toBe("42s");
  });

  it("renders minutes plus seconds when both are non-zero", () => {
    expect(formatDurationSeconds(125)).toBe("2m 5s");
  });

  it("drops the seconds component when it rounds to zero", () => {
    expect(formatDurationSeconds(120)).toBe("2m");
  });

  it("renders hours plus minutes and drops seconds entirely", () => {
    expect(formatDurationSeconds(3725)).toBe("1h 2m");
  });
});

describe("formatCompactNumber", () => {
  it("renders a small number verbatim", () => {
    expect(formatCompactNumber(42)).toBe("42");
  });

  it("compacts thousands to a single fraction digit", () => {
    expect(formatCompactNumber(12_400)).toBe("12.4K");
  });
});

describe("formatTokenCount", () => {
  it.each([
    ["below a thousand", 999, "999"],
    ["at a thousand", 1000, "1.00k"],
    ["at a million", 1_000_000, "1.00M"],
    ["at a billion", 1_000_000_000, "1.00B"],
  ])("renders %s as %s", (_label, count, expected) => {
    expect(formatTokenCount(count)).toBe(expected);
  });

  it("promotes to M when the thousands figure would round to 1000k", () => {
    // 999_995 / 1000 = 999.995, which `toFixed(2)` would print as "1000.00k".
    // The guard promotes the unit instead, so the mantissa stays under 1000.
    expect(formatTokenCount(999_995)).toBe("1.00M");
  });

  it("promotes to B when the millions figure would round to 1000M", () => {
    expect(formatTokenCount(999_995_000)).toBe("1.00B");
  });

  it("keeps the k unit just below the promotion boundary", () => {
    expect(formatTokenCount(999_994)).toBe("999.99k");
  });
});

describe("formatLocalTime", () => {
  it("returns an empty string for an unparseable timestamp", () => {
    // Unlike the other two parsers this one does NOT echo its input back; it
    // renders nothing at all. Pins current behavior — the asymmetry with
    // formatDateTime/formatRelativeLabel looks odd but is what main does.
    expect(formatLocalTime("nope")).toBe("");
  });

  it("renders a parseable timestamp as an hour/minute/second wall time", () => {
    expect(formatLocalTime("2026-08-20T12:00:00.000Z")).toMatch(AP_PATTERN);
  });
});

describe("lastPathSegment", () => {
  it.each([
    ["null", null],
    ["empty string", ""],
  ])("returns null for %s", (_label, path) => {
    expect(lastPathSegment(path)).toBeNull();
  });

  it("returns the last segment of a POSIX path", () => {
    expect(lastPathSegment("/home/ada/repo/file.ts")).toBe("file.ts");
  });

  it("returns the last segment of a Windows path", () => {
    expect(lastPathSegment(String.raw`C:\Users\ada\file.ts`)).toBe("file.ts");
  });

  it("ignores a trailing separator rather than returning an empty segment", () => {
    // The `.filter(Boolean)` is what makes this true; without it the trailing
    // slash would yield "".
    expect(lastPathSegment("/home/ada/repo/")).toBe("repo");
  });

  it("returns the input when it carries no separator", () => {
    expect(lastPathSegment("file.ts")).toBe("file.ts");
  });

  it("returns the input when it is nothing but separators", () => {
    // Every segment filters out, so `.at(-1)` is undefined and the `?? path`
    // fallback echoes the original.
    expect(lastPathSegment("///")).toBe("///");
  });
});
