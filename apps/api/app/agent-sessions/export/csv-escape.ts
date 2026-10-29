/**
 * The field escape for the CSV bytes `GET /agent-sessions/export` streams.
 *
 * PROTECTED BOUNDARY — the downloaded file, and nothing else. The same user,
 * team, and project names travel unescaped through the JSON list/usage
 * responses, the desktop store, and every log line, and must keep doing so:
 * nothing on those paths interprets a leading `=`, and an apostrophe injected
 * into a JSON name would corrupt the value everywhere it is read. This helper
 * exists because a spreadsheet is the one consumer that executes what it is
 * handed, so it is applied at the byte boundary of that consumer only.
 *
 * Two independent hazards, escaped separately because they have different
 * trigger sets:
 *
 * 1. FORMULA INJECTION. Excel, LibreOffice Calc, and Google Sheets evaluate a
 *    cell whose content opens with `=`, `+`, `-`, or `@`. They also skip TAB
 *    (U+0009) and CR (U+000D) before making that decision, so those two open a
 *    formula as surely as `=` does, and any run of leading whitespace before a
 *    trigger defeats a bare first-character test — `" =cmd|' /c calc'!A0"` is
 *    the payload a `^[=+\-@]` check waves through. The mitigation is the
 *    standard one: prefix a single apostrophe so the cell imports as text.
 * 2. RECORD/FIELD STRUCTURE. A field carrying `"`, `,`, LF, or CR must be
 *    quoted. CR belongs in that set and was the gap: RFC 4180 names CRLF, but a
 *    bare CR is a record separator to Excel's classic-Mac line handling and to
 *    several CSV parsers, so an unquoted CR inside a display name splits one row
 *    into two and shifts every later column of that row into the wrong header.
 *
 * The apostrophe is emitted only when a trigger actually matched, so an ordinary
 * name is byte-identical to its input and the marker always means something.
 */

/**
 * A formula trigger at the head of the field, past any leading whitespace.
 *
 * `\s` already covers TAB, CR, LF, NBSP, and the Unicode space separators, so
 * the whitespace run and the two whitespace triggers are one expression: the
 * class still matches a field that is nothing but a TAB, because `\s*`
 * backtracks to empty.
 */
const CSV_FORMULA_PREFIX_PATTERN = /^\s*[=+\-@\t\r]/;

/** A field that cannot be emitted bare: quote, delimiter, or either newline. */
const CSV_QUOTED_VALUE_PATTERN = /[",\r\n]/;

/** One CSV field, safe to concatenate into a row of the exported file. */
export function escapeCsvValue(value: string | number): string {
  let text = String(value);
  if (CSV_FORMULA_PREFIX_PATTERN.test(text)) {
    text = `'${text}`;
  }
  if (CSV_QUOTED_VALUE_PATTERN.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}
