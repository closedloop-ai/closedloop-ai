/**
 * @file log-safe-text.ts
 * @description Rendering harness-controlled text safe to interpolate into an
 * operator log line.
 *
 * Extracted from `harness/claude/parse-claude-drift.ts` (ISS-7260), unchanged.
 * It was written there for transcript record types and object keys, but nothing
 * about it is Claude-specific and it is not Claude-only any more: the entrypoint
 * drift report reads a string the harness stamps, on the same desktop main
 * process, into the same log. Re-deriving the escape set for the second caller
 * is how two hardenings drift apart, so both import this one.
 */

// Matching these characters is the point here — they are what forge a second,
// fabricated log entry out of one harness-controlled name. Beyond C0/C1:
// ISS-6576 adds U+2028/U+2029, which terminate a line for many log viewers and
// JS parsers, the bidi overrides U+202A-U+202E and isolates U+2066-U+2069,
// which can visually reorder a name so it reads as different text than it is,
// and the double quote, so a name cannot close the quoting added below.
const UNSAFE_NAME_CHARACTERS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: see above
  /["\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

/** Per-name ceiling in a rendered report; a key can be arbitrarily long. */
const MAX_DIAGNOSTIC_NAME_CHARS = 120;
/** Whole-message ceiling, so one report line cannot become a durable log flood. */
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 2000;

/**
 * Render one harness-controlled name safe to interpolate into a log line.
 *
 * JSON permits a newline inside a record type or an object key, so an unescaped
 * name can forge a second log entry that reads as the collector's own — and can
 * be arbitrarily long. Control characters become a visible escape rather than
 * being stripped, so the report still shows that something odd arrived.
 *
 * ISS-6576: apply at INSERTION, not at report. The retention caps callers use
 * bound how many names are kept, not how large each one is, so bounding only at
 * render leaves an arbitrarily long name pinned in the desktop main process for
 * the whole scan — where a logger is always attached. Store names
 * already-rendered and interpolate them as-is; rendering twice would re-truncate
 * a name whose suffix pushed it past the ceiling.
 */
export function renderDiagnosticName(name: string): string {
  const escaped = name.replace(UNSAFE_NAME_CHARACTERS, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
  const bounded =
    escaped.length <= MAX_DIAGNOSTIC_NAME_CHARS
      ? escaped
      : `${escaped.slice(0, MAX_DIAGNOSTIC_NAME_CHARS)}…(+${escaped.length - MAX_DIAGNOSTIC_NAME_CHARS} chars)`;
  // ISS-6576: quoted, because a report's OWN list grammar is forgeable without
  // it — a record type named `x (1), aws_secret_access_key` renders as a second
  // list member with no newline required. Quoting after bounding means the
  // closing quote is never the character that gets truncated away.
  return `"${bounded}"`;
}

/** Bound a fully-rendered report line, saying how much it dropped. */
export function boundMessage(message: string): string {
  if (message.length <= MAX_DIAGNOSTIC_MESSAGE_CHARS) {
    return message;
  }
  return `${message.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS)}…(+${message.length - MAX_DIAGNOSTIC_MESSAGE_CHARS} chars truncated)`;
}
