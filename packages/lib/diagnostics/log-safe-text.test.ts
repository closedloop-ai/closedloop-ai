import { describe, expect, it } from "vitest";
import { boundMessage, renderDiagnosticName } from "./log-safe-text.js";

/**
 * ISS-6576's hardening, asserted directly on the shared module rather than only
 * through the report paths that consume it. The escape set is the whole point of
 * the helper, so each character class it exists to neutralize is pinned here; a
 * caller's fixture happening to cover one of them is not the same guarantee.
 *
 * The raw inputs are written as `\uXXXX` escapes, not literal control characters,
 * so this file stays readable and greppable in a terminal.
 */
describe("renderDiagnosticName", () => {
  it("quotes an ordinary name and leaves it otherwise intact", () => {
    expect(renderDiagnosticName("codex_sdk_ts")).toBe('"codex_sdk_ts"');
  });

  it.each([
    ["newline", "\u000A", "\\x0a"],
    ["carriage return", "\u000D", "\\x0d"],
    ["null", "\u0000", "\\x00"],
    ["DEL", "\u007F", "\\x7f"],
    ["C1 control", "\u0085", "\\x85"],
    ["line separator U+2028", "\u2028", "\\u2028"],
    ["paragraph separator U+2029", "\u2029", "\\u2029"],
    ["bidi override U+202E", "\u202E", "\\u202e"],
    ["bidi isolate U+2066", "\u2066", "\\u2066"],
  ])("escapes a %s so it cannot forge a log line", (_label, raw, escaped) => {
    const rendered = renderDiagnosticName(`a${raw}b`);
    expect(rendered).toBe(`"a${escaped}b"`);
  });

  it("escapes the double quote so a name cannot close its own quoting", () => {
    expect(renderDiagnosticName('a"b')).toBe('"a\\x22b"');
  });

  it("truncates past the per-name ceiling and says how much it dropped", () => {
    // 130 characters against the 120-char ceiling: the kept prefix is exactly
    // 120 and the suffix reports the remaining 10.
    expect(renderDiagnosticName("z".repeat(130))).toBe(
      `"${"z".repeat(120)}\u2026(+10 chars)"`
    );
  });

  it("leaves a name exactly at the ceiling untruncated", () => {
    // The boundary the `<=` guards; an off-by-one here would mark a perfectly
    // recordable name as clipped.
    expect(renderDiagnosticName("z".repeat(120))).toBe(`"${"z".repeat(120)}"`);
  });

  it("truncates before quoting, so the closing quote survives", () => {
    const rendered = renderDiagnosticName("z".repeat(5000));
    expect(rendered.startsWith('"')).toBe(true);
    expect(rendered.endsWith('"')).toBe(true);
  });

  it("counts the ceiling in ESCAPED characters, not raw ones", () => {
    // An escape expands one character to four, so a 40-character run of
    // newlines renders as 160 and must clip. Measuring the raw length instead
    // would let a hostile name through at four times the ceiling.
    const rendered = renderDiagnosticName("\u000A".repeat(40));
    expect(rendered).toBe(`"${"\\x0a".repeat(30)}\u2026(+40 chars)"`);
  });
});

describe("boundMessage", () => {
  it("returns a short message unchanged", () => {
    expect(boundMessage('Unknown record types: "x" (1)')).toBe(
      'Unknown record types: "x" (1)'
    );
  });

  it("returns a message exactly at the ceiling unchanged", () => {
    const exact = "y".repeat(2000);
    expect(boundMessage(exact)).toBe(exact);
  });

  it("truncates a longer message and reports the dropped count", () => {
    expect(boundMessage("y".repeat(2050))).toBe(
      `${"y".repeat(2000)}\u2026(+50 chars truncated)`
    );
  });
});
