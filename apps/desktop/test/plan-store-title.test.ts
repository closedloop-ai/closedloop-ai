import { describe, expect, it } from "vitest";
import { titleFromMarkdown } from "../src/main/plans/plan-store";

const OLD_HEADING_RE = /^\s{0,3}#\s+(.+?)\s*#*\s*$/;

function oldTitleFromMarkdown(
  markdown: string | null | undefined,
  fallback: string
): string {
  if (typeof markdown === "string") {
    for (const rawLine of markdown.split("\n", 40)) {
      const m = OLD_HEADING_RE.exec(rawLine);
      if (m?.[1].trim()) {
        return m[1].trim().slice(0, 200);
      }
    }
  }
  return fallback;
}

const FB = "fallback";

describe("titleFromMarkdown", () => {
  describe("identity with old regex on short inputs", () => {
    const cases: [string, string][] = [
      ["# Plan ##", "# Plan ##"],
      ["   #   Title  ", "   #   Title  "],
      ["# ###", "# ###"],
      ["# a #b", "# a #b"],
      ["# a\r", "# a\r"],
      ["# Hello World", "# Hello World"],
    ];

    for (const [label, input] of cases) {
      it(`"${label.replace(/\r/g, "\\r")}" matches the old regex`, () => {
        const oldResult = oldTitleFromMarkdown(input, FB);
        const newResult = titleFromMarkdown(input, FB);
        expect(newResult).toBe(oldResult);
      });
    }
  });

  it('"# Plan ##" returns "Plan"', () => {
    expect(titleFromMarkdown("# Plan ##", FB)).toBe("Plan");
  });

  it('"   #   Title  " returns "Title"', () => {
    expect(titleFromMarkdown("   #   Title  ", FB)).toBe("Title");
  });

  it('"# ###" returns "#"', () => {
    expect(titleFromMarkdown("# ###", FB)).toBe("#");
  });

  it('"# a #b" returns "a #b"', () => {
    expect(titleFromMarkdown("# a #b", FB)).toBe("a #b");
  });

  it('"# a\\r" returns "a"', () => {
    expect(titleFromMarkdown("# a\r", FB)).toBe("a");
  });

  it('"# a\\rb" falls back (line terminator in head)', () => {
    expect(titleFromMarkdown("# a\rb", FB)).toBe(FB);
  });

  it('"#nospace" falls back', () => {
    expect(titleFromMarkdown("#nospace", FB)).toBe(FB);
  });

  it('"## Second level" falls back (only a single-# heading matches)', () => {
    expect(titleFromMarkdown("## Second level", FB)).toBe(FB);
  });

  it('"### Third level" falls back (only a single-# heading matches)', () => {
    expect(titleFromMarkdown("### Third level", FB)).toBe(FB);
  });

  it('"####### nope" falls back', () => {
    expect(titleFromMarkdown("####### nope", FB)).toBe(FB);
  });

  it('"#   " then "# real" on next line returns "real"', () => {
    expect(titleFromMarkdown("#   \n# real", FB)).toBe("real");
  });

  it("no heading returns fallback", () => {
    expect(titleFromMarkdown("just some text\nno heading here", FB)).toBe(FB);
  });

  it("null input returns fallback", () => {
    expect(titleFromMarkdown(null, FB)).toBe(FB);
  });

  it("undefined input returns fallback", () => {
    expect(titleFromMarkdown(undefined, FB)).toBe(FB);
  });

  it("empty string returns fallback", () => {
    expect(titleFromMarkdown("", FB)).toBe(FB);
  });

  it("50_000-space heading returns truncated title", () => {
    const spaces = " ".repeat(50_000);
    const input = `# Plan${spaces}x`;
    const expected = `Plan${spaces}x`.slice(0, 200);
    expect(titleFromMarkdown(input, FB)).toBe(expected);
  });

  it("CRLF file with 40 unmatchable lines returns fallback", () => {
    const longSpaces = " ".repeat(1000);
    const line = `# a${longSpaces}\rx`;
    const lines = Array.from({ length: 40 }, () => line);
    const input = lines.join("\n");
    expect(titleFromMarkdown(input, FB)).toBe(FB);
  });
});
