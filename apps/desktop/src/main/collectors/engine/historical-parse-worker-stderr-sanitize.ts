/**
 * Diagnostic-text sanitization for the historical-parse worker boundary
 * (extracted from `historical-parse-worker-protocol.ts`, FEA-4093, to keep that
 * module under the file-size ceiling). This is a self-contained responsibility:
 * strip ANSI/control bytes, collapse line breaks, redact absolute paths and
 * credentials, and bound the result — before any worker stderr or validation
 * diagnostic is surfaced in a response, a log, or a thrown error.
 *
 * The redaction helpers protect ONLY the derived diagnostic sink (the bounded,
 * sanitized preview/message strings that cross the response boundary); raw
 * worker stderr may still be logged upstream by the runner, so callers must not
 * treat a sanitized summary as complete source-log redaction.
 */
import { truncateUtf8 } from "@closedloop-ai/loops-api/observability";
import { HistoricalParseWorkerLimits } from "./historical-parse-worker-limits.js";

const MAX_LONG_TEXT_LENGTH = HistoricalParseWorkerLimits.maxLongTextLength;
const MAX_WORKER_STDERR_PREVIEW_BYTES =
  HistoricalParseWorkerLimits.maxWorkerStderrPreviewBytes;
const TRUNCATED_STDERR_PREVIEW_SUFFIX = "...";
const REDACTED_PATH_SEGMENT = "[redacted-path]";
const REDACTED_SECRET_SEGMENT = "[redacted-secret]";
const REDACTED_TOKEN_SEGMENT = "[redacted-token]";
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
const CREDENTIAL_URL_RE =
  /\bhttps:\/\/[^:\s/@]+:[^@\s/]+@([^/\s]+\/[^\s"'<>]+)/gi;
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA|AROA)[A-Z0-9]{16}\b/g;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const SK_KEY_RE = /\bsk-[A-Za-z0-9\-_]{8,}/gi;
const GITHUB_TOKEN_RE = /\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/gi;
const SLACK_TOKEN_RE = /\bxox[abprs]-[A-Za-z0-9-]{8,}/gi;
const SECRET_ASSIGNMENT_RE =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|AUTH|CREDENTIAL)[A-Z0-9_]*|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[:=]\s*["']?[^,\s"'`&]+/gi;
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
 * Return a bounded diagnostic preview for worker stderr, or null when the chunk
 * is only ignorable Node/Electron noise (SQLite experimental warning,
 * trace-warnings hint). This protects the log sink that records
 * utility-process warnings/errors, not the raw stderr stream itself.
 */
export function summarizeHistoricalWorkerStderr(chunk: Buffer): string | null {
  const text = chunk.toString("utf8");
  if (isIgnorableHistoricalWorkerStderr(text)) {
    return null;
  }
  const preview = summarizeHistoricalWorkerStderrPreview(text);
  return `historical parse worker stderr (${chunk.byteLength} bytes): ${preview}`;
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

function sanitizeHistoricalWorkerDiagnosticText(text: string): string {
  return redactHistoricalWorkerStderrPaths(
    redactHistoricalWorkerStderrSecrets(
      text
        .replaceAll(ANSI_ESCAPE_RE, "")
        .replaceAll(CONTROL_CHARACTERS_RE, "")
        .replaceAll(LINE_BREAKS_RE, " | ")
        .replaceAll(REPEATED_WHITESPACE_RE, " ")
        .trim()
    )
  );
}

function isIgnorableHistoricalWorkerStderr(text: string): boolean {
  const lines = text
    .replaceAll(ANSI_ESCAPE_RE, "")
    .replaceAll(CONTROL_CHARACTERS_RE, "")
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

function redactHistoricalWorkerStderrSecrets(text: string): string {
  return text
    .replaceAll(CREDENTIAL_URL_RE, `https://${REDACTED_SECRET_SEGMENT}@$1`)
    .replaceAll(AWS_ACCESS_KEY_RE, REDACTED_TOKEN_SEGMENT)
    .replaceAll(BEARER_TOKEN_RE, `Bearer ${REDACTED_TOKEN_SEGMENT}`)
    .replaceAll(SK_KEY_RE, REDACTED_TOKEN_SEGMENT)
    .replaceAll(GITHUB_TOKEN_RE, REDACTED_TOKEN_SEGMENT)
    .replaceAll(SLACK_TOKEN_RE, REDACTED_TOKEN_SEGMENT)
    .replaceAll(SECRET_ASSIGNMENT_RE, `$1=${REDACTED_SECRET_SEGMENT}`);
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
