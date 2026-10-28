/**
 * Bounded worker stderr and diagnostic rendering for the historical parse worker.
 * This module redacts derived diagnostic strings and bounded stderr summaries
 * before they reach response envelopes or utility-process warning/error logs.
 * Raw worker stderr may still be logged upstream by the runner; callers must
 * not treat these sanitized summaries as complete source-log redaction.
 */
import { truncateUtf8 } from "@closedloop-ai/loops-api/observability/truncate-utf8";
import {
  PEM_PRIVATE_KEY_BODY_LINE_SOURCE,
  PEM_PRIVATE_KEY_FOOTER_SOURCE,
  PEM_PRIVATE_KEY_HEADER_SOURCE,
  SECRET_VALUE_REPLACE_PATTERN,
} from "@closedloop-ai/loops-api/secret-value-pattern";
import type { z } from "zod";
import { HistoricalParseWorkerLimits } from "./historical-parse-worker-limits-and-clamping.js";

const MAX_LONG_TEXT_LENGTH = HistoricalParseWorkerLimits.maxLongTextLength;
const MAX_WORKER_STDERR_PREVIEW_BYTES =
  HistoricalParseWorkerLimits.maxWorkerStderrPreviewBytes;
const MAX_WORKER_STDERR_CARRY_BYTES =
  HistoricalParseWorkerLimits.maxWorkerStderrCarryBytes;
/** `\n`. Line endings are normalized downstream; the CR of a CRLF rides along. */
const LINE_FEED_BYTE = 0x0a;
const TRUNCATED_STDERR_PREVIEW_SUFFIX = "...";
const REDACTED_PATH_SEGMENT = "[redacted-path]";
const REDACTED_SECRET_SEGMENT = "[redacted-secret]";
const REDACTED_TOKEN_SEGMENT = "[redacted-token]";
const MAX_RESPONSE_ISSUE_COUNT = 5;
const MAX_RESPONSE_ISSUE_TEXT_LENGTH = 160;
const MAX_RESPONSE_ISSUE_UNION_DEPTH = 4;
// biome-ignore lint/complexity/useRegexLiterals: Control characters are clearer via escaped raw text here.
const ANSI_ESCAPE_RE = new RegExp(
  String.raw`[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g"
);
// biome-ignore lint/complexity/useRegexLiterals: Control characters are clearer via escaped raw text here.
const CONTROL_CHARACTERS_RE = new RegExp(
  String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]`,
  "g"
);
const LINE_BREAKS_RE = /\r\n?|\n/g;
const REPEATED_WHITESPACE_RE = /\s{2,}/g;
const FILE_URL_ABSOLUTE_PATH_RE =
  /\bfile:\/\/\/(?:[^\s"'`<>:]+\/)*([^\s"'`<>:]+)/g;
const POSIX_ABSOLUTE_PATH_RE =
  /(^|[\s"'`(=])\/(?:[^\s"'`<>:]+\/)*([^\s"'`<>:]+)(?=$|[\s"'`<>)]|:\d)/g;
const WINDOWS_ABSOLUTE_PATH_RE =
  /\b[A-Za-z]:\\(?:[^\s"'`<>:]+\\)*([^\s"'`<>:]+)/g;
// ISS-6898: AWS is the ONE family this sink keeps a local rule for. The shared
// telemetry vocabulary deliberately does not carry `AKIA`/`ASIA` (its header says
// so, and `packages/lib/security/redact-secrets` owns them for the transcript
// sink), so folding this into the shared pattern would DELETE coverage this sink
// already had. `AROA` is likewise local. Everything else — bearer, `sk-`, `sk_`,
// GitHub, Slack, credentialed URLs, and the seven families that were escaping —
// comes from the SSOT above.
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA|AROA)[A-Z0-9]{16}\b/g;
// The optional `(?:bearer|basic)\s+` is what makes this rule reach an
// `Authorization:` header's actual credential. Without it the value class stops
// at the space after the scheme word, so `Authorization: Bearer tok90123`
// redacted the word `Bearer` and left the token — the SSOT's 12-character
// bearer floor means the value pass does not catch that one either. The group is
// OPTIONAL and only ever extends a match rightward, so it can add
// over-redaction (one prose word after `AUTH_MODE: basic`) but never remove
// coverage.
const SECRET_ASSIGNMENT_RE =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|AUTH|CREDENTIAL)[A-Z0-9_]*|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[:=]\s*["']?(?:(?:bearer|basic)\s+)?[^,\s"'`&]+/gi;
// ISS-6898 (review of PR #6476). Whether a PEM private-key block is still OPEN
// is a framing question, not a vocabulary one, so both armor lines are DERIVED
// from the SSOT rather than spelled again here — the same rule the rest of this
// file follows. Capturing group 1 is the header, so the LAST armor line in a run
// decides the state: a header opens the block, a footer closes it.
//
// Global, and therefore only ever handed to `matchAll`, which reads `lastIndex`
// but does not write it — never `.test()`/`.exec()`, which would.
const PEM_PRIVATE_KEY_ARMOR_RE = new RegExp(
  `(${PEM_PRIVATE_KEY_HEADER_SOURCE})|${PEM_PRIVATE_KEY_FOOTER_SOURCE}`,
  "gi"
);
// The context a continuation run is sanitized WITH when the previous run left a
// block open. It is a literal header line, so the shared vocabulary's own
// truncated-block fallback consumes the base64 lines that follow it; the header
// is inside the match it creates, so it is replaced along with them and never
// reaches the log itself.
const PEM_CONTINUATION_CONTEXT = "-----BEGIN PRIVATE KEY-----\n";
// A whole line of PEM body, derived from the same SSOT so the window this file
// holds open cannot outlive the lines the shared fallback would consume.
// `(?: … )` is not decoration: a future top-level alternation in the SSOT
// fragment would otherwise bind looser than the anchors and turn this whole-line
// test into a substring one.
const PEM_BODY_LINE_RE = new RegExp(
  `^(?:${PEM_PRIVATE_KEY_BODY_LINE_SOURCE})$`
);
const NODE_SQLITE_EXPERIMENTAL_WARNING_RE =
  /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time$/;
const NODE_TRACE_WARNINGS_HINT_RE =
  /^\(Use `?Electron Helper --trace-warnings \.\.\.`? to show where the warning was created\)$/;

/**
 * Sanitize and bound one diagnostic string (validation message, thrown-error
 * text) for the worker response, capped at the long-text limit.
 */
export function boundedDiagnosticText(text: string): string {
  const sanitized = sanitizeHistoricalWorkerDiagnosticText(text);
  if (Buffer.byteLength(sanitized, "utf8") <= MAX_LONG_TEXT_LENGTH) {
    return sanitized;
  }
  return truncateUtf8(sanitized, MAX_LONG_TEXT_LENGTH);
}

/**
 * Return bounded schema diagnostics without echoing raw transcript payloads.
 *
 * Keep `flatIssues` named as-is: the `no-terminal-cap` source gate keys its
 * diagnostic-cap exemption on this exact local identifier and file path.
 */
export function summarizeHistoricalWorkerResponseIssues(
  error: z.ZodError
): string {
  const flatIssues = flattenZodIssues(error.issues);
  const issues = flatIssues.slice(0, MAX_RESPONSE_ISSUE_COUNT).map((issue) => {
    const path = issue.path.map(String).join(".") || "<root>";
    const message = truncateResponseIssueText(issue.message);
    return `${path}:${issue.code}:${message}`;
  });
  const suffix =
    flatIssues.length > MAX_RESPONSE_ISSUE_COUNT
      ? `; +${flatIssues.length - MAX_RESPONSE_ISSUE_COUNT} more`
      : "";
  return `${issues.join("; ")}${suffix}`;
}

function truncateResponseIssueText(message: string): string {
  if (message.length <= MAX_RESPONSE_ISSUE_TEXT_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAX_RESPONSE_ISSUE_TEXT_LENGTH)}...`;
}

function flattenZodIssues(issues: z.ZodIssue[], depth = 0): z.ZodIssue[] {
  const flattened: z.ZodIssue[] = [];
  for (const issue of issues) {
    if (issue.code === "invalid_union") {
      if (depth >= MAX_RESPONSE_ISSUE_UNION_DEPTH) {
        flattened.push(issue);
        continue;
      }
      let nestedIssueCount = 0;
      for (const nested of issue.errors) {
        const nestedIssues = flattenZodIssues(nested, depth + 1);
        nestedIssueCount += nestedIssues.length;
        flattened.push(...nestedIssues);
      }
      if (nestedIssueCount === 0) {
        flattened.push(issue);
      }
      continue;
    }
    flattened.push(issue);
  }
  return flattened;
}

/**
 * A bounded diagnostic preview for ONE run of worker stderr, or null when the
 * run is only ignorable Node/Electron noise (SQLite experimental warning,
 * trace-warnings hint). This protects the log sink that records utility-process
 * warnings/errors, not the raw stderr stream itself.
 *
 * Reached only through {@link createHistoricalWorkerStderrSummarizer}, which is
 * what the runner's stderr pipe calls: a lone `data` event is not a record
 * boundary, so summarizing one directly is the leak the accumulator exists to
 * close. The run is sanitized as if an open PEM header preceded it when
 * `pemBlockOpen` says the previous run left one (review of PR #6476).
 *
 * `text` is the run already decoded and already stripped of control bytes — the
 * caller holds both, and stripping is idempotent, so this neither re-decodes
 * 64 KiB on the main thread nor lets the framing state and the redaction read
 * two different strings. `byteLength` is the RUN's, never the prefixed text's:
 * the prefix is redaction context, not stderr the worker wrote, and a count that
 * included it would be a lie about the stream.
 */
function summarizeHistoricalWorkerStderrRun(
  text: string,
  byteLength: number,
  pemBlockOpen: boolean
): string | null {
  // Checked on the RUN, not on the prefixed text: the prefix is never ignorable
  // noise, so prefixing first would defeat the SQLite-warning suppression.
  if (isIgnorableHistoricalWorkerStderr(text)) {
    return null;
  }
  const preview = summarizeHistoricalWorkerStderrPreview(
    pemBlockOpen ? `${PEM_CONTINUATION_CONTEXT}${text}` : text
  );
  return `historical parse worker stderr (${byteLength} bytes): ${preview}`;
}

/**
 * Whether a PEM private-key block is still open once `text` has been emitted,
 * given whether one was open before it. A run with no armor line at all cannot
 * answer on its own — that is the continuation case, and it is why this takes
 * the previous state.
 *
 * The window closes on a `-----END` armor line and ALSO on the first line that
 * is not key material, which is not belt-and-braces: a truncated block never
 * sends a footer, so an END-only rule would latch the context on for the rest of
 * a resident worker's life and destroy every later base64-shaped diagnostic
 * word. Ending at the first non-body line is exactly where the shared
 * vocabulary's own truncated-block fallback stops WITHIN a run, so the split
 * case and the whole-chunk case now agree.
 */
function isPemBlockOpenAfter(text: string, wasOpen: boolean): boolean {
  const armor = [...text.matchAll(PEM_PRIVATE_KEY_ARMOR_RE)].at(-1);
  if (armor === undefined) {
    return wasOpen && isPemBodyRun(runLines(text));
  }
  // Group 1 is the header alternative; a footer closed the block outright.
  if (armor[1] === undefined) {
    return false;
  }
  // `slice(1)` drops the rest of the HEADER's own line, which the fallback
  // consumes whatever it says. A run that ENDS on the header line leaves no
  // lines at all, and an empty run is vacuously still key material.
  const afterHeader = text.slice(armor.index + armor[0].length);
  return isPemBodyRun(runLines(afterHeader).slice(1));
}

/**
 * The lines of a run, WITHOUT the empty string a trailing terminator leaves. A
 * run ending in `\n` is a complete last line, not a blank one — and the
 * difference decides whether the block stays open, because a genuinely BLANK
 * line ends the fallback's body walk (`[A-Za-z0-9+/=]+` needs a character).
 */
function runLines(text: string): string[] {
  const lines = text.split(LINE_BREAKS_RE);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/** Whether every one of `lines` is still PEM body, the fallback's own test. */
function isPemBodyRun(lines: readonly string[]): boolean {
  return lines.every((line) => PEM_BODY_LINE_RE.test(line));
}

/**
 * Whether a run OPENS on key material. Only such a run inherits the carried
 * header: prefix one that does not and the summary gains a `[redacted-token]`
 * standing for nothing, on stderr that held no credential.
 */
function startsPemBody(text: string): boolean {
  const first = runLines(text).at(0);
  return first !== undefined && PEM_BODY_LINE_RE.test(first);
}

/**
 * A stderr `data` event is not a record boundary — it is whatever the pipe had
 * ready — so summarizing each chunk on its own
 * lets a credential that straddles two events miss BOTH patterns and reach the
 * log as two halves that reconstruct it (review of PR #6476). Every family in
 * this sink's vocabulary but two matches inside a single line, and a completed
 * run keeps its own newlines, so a LINE is a boundary a token does not straddle:
 * this accumulator summarizes only the complete lines it holds and keeps the
 * remainder for the next event.
 *
 * `flush()` is not optional. A worker's last line often has no terminator, and
 * without a flush at end-of-stream that line — the one that usually says why the
 * worker died — would be silently dropped rather than merely deferred. It clears
 * the carry, so calling it twice is a no-op.
 *
 * Bounded on purpose: stderr is under no obligation to ever send a newline, so
 * once the REMAINDER — what would be held, not what is about to be logged —
 * passes `maxWorkerStderrCarryBytes`, everything buffered is summarized at once
 * and the carry is dropped. The cap is measured on the remainder specifically so
 * an over-long line cannot cost the line guarantee for the complete lines in
 * front of it, and the whole buffer goes out in ONE summary so the over-long
 * line is not itself logged in halves. The cap is a whole pipe read, so no
 * ordinary diagnostic line reaches it.
 *
 * A LINE boundary is not enough for the one shared family whose match spans
 * lines, so this also carries PEM CONTEXT across emissions (review of PR #6476).
 * Send `-----BEGIN PRIVATE KEY-----\n` as one `data` event and each base64 body
 * line in later events and the line rule alone redacts only the header, then
 * logs the key body in clear — chunking, not content, decided whether the key
 * leaked. So a run that leaves a block OPEN makes the next run sanitize as if
 * that header were in front of it. The armor lines and the body-line shape are
 * derived from the SSOT, so this adds framing state, not a second copy of the
 * vocabulary's grammar.
 *
 * The window closes on a `-----END` armor line, on the first line that is not
 * key material, and on a run that does not OPEN on key material — the same place
 * the shared fallback's own line walk stops within a single chunk. A footer-only
 * rule would latch a truncated block on for the rest of a resident worker's
 * life, since a truncated block never sends one.
 *
 * KNOWN BLIND SPOTS, stated so a green here is not over-read.
 *
 * The cap flush above is a cut like any other, so a credential straddling it is
 * logged in halves exactly as one straddling a `data` event was. Cutting at the
 * last WHITESPACE instead looks like the fix and is not: `SECRET_ASSIGNMENT_RE`
 * and the SSOT's `bearerToken` both SPAN whitespace, so a whitespace cut leaves
 * `OPENAI_API_KEY =` in one record and its value bare in the next — trading a
 * value-shaped leak for a key-named one that redacts today. Closing it needs a
 * boundary rule those two rules agree with, which is a decision about the shared
 * vocabulary rather than a patch here, so it is stated. It takes a 64 KiB
 * newline-free run to reach.
 *
 * The other is `bearerToken`, whose
 * `bearer\s+` spans whitespace including a newline, on the narrow shape of a
 * wrapped log line whose `Bearer` happens to end the run's last COMPLETE line
 * while its token starts the carried remainder. Unlike the PEM case that shape
 * has no armor to track — closing it needs the vocabulary's grammar HERE, which
 * is the re-declaration ISS-6898 exists to remove — so it is stated rather than
 * half-fixed. It is also the benign direction for a reader: the token half that
 * reaches the log carries no `Bearer` naming it.
 */
export type HistoricalWorkerStderrSummarizer = {
  /** Summarize the complete lines this chunk finished, or null if none did. */
  push(chunk: Buffer): string | null;
  /** Summarize an unterminated trailing line at end-of-stream, if any. */
  flush(): string | null;
};

export function createHistoricalWorkerStderrSummarizer(): HistoricalWorkerStderrSummarizer {
  // Annotated: the carry takes either a `Buffer.concat` result or the caller's
  // own chunk, and those two do not share an `ArrayBuffer` type parameter.
  let carry: Buffer = Buffer.alloc(0);
  let pemBlockOpen = false;

  /**
   * Summarize one run WITH the carried PEM context, then advance that context by
   * the run's own armor lines. The state is read before the run and written
   * after it, so the run that carries `-----BEGIN` is redacted by its own header
   * and only what follows inherits the context.
   */
  function summarizeRun(run: Buffer): string | null {
    const text = stripHistoricalWorkerStderrControlBytes(run.toString("utf8"));
    const summary = summarizeHistoricalWorkerStderrRun(
      text,
      run.byteLength,
      pemBlockOpen && startsPemBody(text)
    );
    // A SUPPRESSED run emitted nothing, so it says nothing about the framing:
    // advancing on it would close the window over an ignorable Node warning that
    // happened to land between a header and its body, and log the body in clear.
    if (summary !== null) {
      pemBlockOpen = isPemBlockOpenAfter(text, pemBlockOpen);
    }
    return summary;
  }

  return {
    push(chunk: Buffer): string | null {
      const buffered =
        carry.byteLength === 0 ? chunk : Buffer.concat([carry, chunk]);
      const lastBreak = buffered.lastIndexOf(LINE_FEED_BYTE);
      // `lastBreak + 1` is 0 when there is no break at all, so this is the whole
      // buffer in that case — which is exactly what would be carried.
      const remainder = buffered.subarray(lastBreak + 1);
      if (remainder.byteLength > MAX_WORKER_STDERR_CARRY_BYTES) {
        carry = Buffer.alloc(0);
        return summarizeRun(buffered);
      }
      if (lastBreak === -1) {
        // `Buffer.concat` above already returned a buffer this closure owns; a
        // chunk that arrived with an empty carry never went through it, so only
        // that one is copied rather than retained.
        carry = buffered === chunk ? Buffer.from(chunk) : buffered;
        return null;
      }
      // A `subarray` is a VIEW: retaining it as the carry would pin the whole
      // buffered run, cap or no cap.
      carry = Buffer.from(remainder);
      return summarizeRun(buffered.subarray(0, lastBreak + 1));
    },
    flush(): string | null {
      if (carry.byteLength === 0) {
        return null;
      }
      const pending = carry;
      carry = Buffer.alloc(0);
      return summarizeRun(pending);
    },
  };
}

function summarizeHistoricalWorkerStderrPreview(text: string): string {
  const sanitized = sanitizeHistoricalWorkerDiagnosticText(text);
  const preview =
    Buffer.byteLength(sanitized, "utf8") <= MAX_WORKER_STDERR_PREVIEW_BYTES
      ? sanitized
      : `${truncateUtf8(
          sanitized,
          MAX_WORKER_STDERR_PREVIEW_BYTES -
            Buffer.byteLength(TRUNCATED_STDERR_PREVIEW_SUFFIX, "utf8")
        )}${TRUNCATED_STDERR_PREVIEW_SUFFIX}`;
  return preview || "<empty>";
}

/**
 * The two redaction passes sit on OPPOSITE sides of the line-break collapse, and
 * which side each one takes is load-bearing (ISS-6898).
 *
 * VALUE-shaped redaction runs BEFORE the collapse, because the shared
 * vocabulary's PEM private-key family has a line-oriented truncated-block
 * fallback: it consumes the header's own line plus any WHOLE base64 lines after
 * it, so prose on the next line survives. Run it once `\n` has already become
 * `" | "` and that fallback has nothing left to stop at, so an unterminated
 * `-----BEGIN PRIVATE KEY-----` header swallows every remaining diagnostic in
 * the chunk.
 *
 * That fallback is written against `\n` specifically — its per-line lookahead is
 * `(?=\n|$)` — so line endings are NORMALIZED to `\n` before it runs. Without
 * that, a Windows worker's `\r\n` stderr defeats the lookahead on every base64
 * line and only the `-----BEGIN` header itself is redacted, leaving the key body
 * in the log. Electron ships this app on Windows and `LINE_BREAKS_RE` already
 * says CRLF is expected input here.
 *
 * KEY-shaped redaction runs AFTER it, because `SECRET_ASSIGNMENT_RE`'s `\s*`
 * spans a newline: on the line-broken text, a bare `access_token:` at end of
 * line reaches onto the NEXT line and destroys its first word. Post-collapse it
 * consumes the `" | "` separator instead, which is what this sink already did
 * before ISS-6898.
 *
 * One residual, stated rather than hidden: the SSOT's `bearerToken` also spans
 * whitespace (`bearer\s+`), so a `Bearer` ending a line joins the next line's
 * first word when that word is 12+ token characters. That direction is
 * over-redaction, not a leak, and it is the correct answer for a wrapped log
 * line — unlike the assignment rule's, whose common shape is prose.
 */
function sanitizeHistoricalWorkerDiagnosticText(text: string): string {
  const stripped = stripHistoricalWorkerStderrControlBytes(text).replaceAll(
    LINE_BREAKS_RE,
    "\n"
  );
  return redactHistoricalWorkerStderrPaths(
    redactHistoricalWorkerStderrSecretAssignments(
      collapseHistoricalWorkerStderrWhitespace(
        redactHistoricalWorkerStderrSecretValues(stripped)
      )
    )
  );
}

/**
 * ANSI escapes and control bytes off, line endings untouched. Idempotent, and
 * the FIRST thing every other pass here sees — including the PEM framing state,
 * which has to read the same text the redaction does or a colourised body line
 * silently drops the carried header.
 */
function stripHistoricalWorkerStderrControlBytes(text: string): string {
  return text
    .replaceAll(ANSI_ESCAPE_RE, "")
    .replaceAll(CONTROL_CHARACTERS_RE, "");
}

function collapseHistoricalWorkerStderrWhitespace(text: string): string {
  return text
    .replaceAll(LINE_BREAKS_RE, " | ")
    .replaceAll(REPEATED_WHITESPACE_RE, " ")
    .trim();
}

function isIgnorableHistoricalWorkerStderr(text: string): boolean {
  const lines = stripHistoricalWorkerStderrControlBytes(text)
    .split(LINE_BREAKS_RE)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return (
    lines.length > 0 &&
    lines.every(
      (line) =>
        NODE_SQLITE_EXPERIMENTAL_WARNING_RE.test(line) ||
        NODE_TRACE_WARNINGS_HINT_RE.test(line)
    )
  );
}

/**
 * Token-SHAPED redaction: everything that is recognizable as a credential on its
 * own, with no `KEY=` prefix to announce it — the shape googleapis and the npm
 * registry actually emit.
 *
 * `SECRET_VALUE_REPLACE_PATTERN` is global, so it is only ever handed to
 * `replaceAll` here — never `.test()`/`.exec()`, which would advance its
 * `lastIndex` and let every other call miss.
 */
function redactHistoricalWorkerStderrSecretValues(text: string): string {
  return text
    .replaceAll(SECRET_VALUE_REPLACE_PATTERN, REDACTED_TOKEN_SEGMENT)
    .replaceAll(AWS_ACCESS_KEY_RE, REDACTED_TOKEN_SEGMENT);
}

/**
 * Key-NAMED redaction: a value whose own shape says nothing, sitting behind a
 * name that does. Runs last, so a value that was ALSO token-shaped is already
 * gone — the marker the first pass left satisfies this rule's value class, so
 * such a field still ends up keyed over rather than half-redacted.
 */
function redactHistoricalWorkerStderrSecretAssignments(text: string): string {
  return text.replaceAll(SECRET_ASSIGNMENT_RE, `$1=${REDACTED_SECRET_SEGMENT}`);
}

function redactHistoricalWorkerStderrPaths(text: string): string {
  return text
    .replaceAll(
      FILE_URL_ABSOLUTE_PATH_RE,
      `file:///${REDACTED_PATH_SEGMENT}/$1`
    )
    .replaceAll(POSIX_ABSOLUTE_PATH_RE, `$1${REDACTED_PATH_SEGMENT}/$2`)
    .replaceAll(WINDOWS_ABSOLUTE_PATH_RE, `${REDACTED_PATH_SEGMENT}\\$1`);
}
