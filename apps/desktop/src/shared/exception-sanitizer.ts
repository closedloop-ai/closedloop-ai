import type { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { SECRET_VALUE_PATTERN } from "@closedloop-ai/loops-api/secret-value-pattern";

export type DesktopExceptionTelemetryInput = {
  error: unknown;
  origin: AppExceptionOrigin;
  componentStack?: string;
};

export type DesktopExceptionTelemetryAttributesInput = {
  type: string;
  origin: AppExceptionOrigin;
  message?: string;
  stacktrace?: string;
};

export type SanitizedDesktopExceptionAttributes = {
  [TelemetryAttribute.ExceptionType]: string;
  [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin;
  [TelemetryAttribute.ExceptionMessage]?: string;
  [TelemetryAttribute.ExceptionStacktrace]?: string;
};

const NON_ERROR_EXCEPTION_TYPE = "NonErrorRejection";
const EMPTY_EXCEPTION_TYPE = "UnknownException";
/**
 * Whole-field replacement, reserved for the marker/secret classes: what follows
 * such a marker is unbounded and unparseable, so nothing in the field can be
 * trusted. Bounded values — paths, URLs, emails — are substituted in place with
 * the markers below instead, so a stack keeps its frame structure.
 */
const REDACTED_EXCEPTION_TEXT = "[redacted]";
const REDACTED_PATH_TEXT = "[redacted-path]";
const REDACTED_URL_TEXT = "[redacted-url]";
const REDACTED_EMAIL_TEXT = "[redacted-email]";
const MAX_EXCEPTION_TYPE_LENGTH = 128;
const MAX_EXCEPTION_MESSAGE_LENGTH = 1024;
const MAX_EXCEPTION_STACKTRACE_LENGTH = 8192;
const LAST_ASCII_CONTROL_CHARACTER_CODE = 31;
const DELETE_CONTROL_CHARACTER_CODE = 127;
const HORIZONTAL_TAB_CHARACTER_CODE = 9;
const LINE_FEED_CHARACTER_CODE = 10;
const FORM_FEED_CHARACTER_CODE = 12;
const CARRIAGE_RETURN_CHARACTER_CODE = 13;

const BODY_MARKER_PATTERN =
  /\b(?:body|payload|prompt|content|transcript|message_body|request_body|response_body)\b\s*[:=]/i;
const IDENTITY_MARKER_PATTERN =
  /\b(?:org(?:anization)?|user|session|install(?:ation)?|device)[_-]?(?:id|uuid)\b\s*[:=]\s*[A-Za-z0-9._:-]{6,}/i;
// The body of a path or URL value. A `)` terminates it because every V8 frame
// wraps its location in parentheses (`at fn (/Users/alice/…)`) and that closing
// paren must survive the substitution — but ISS-6229: a path may legitimately
// CONTAIN a pair (`/Users/alice/Acme(Client)/secret.js`), and a body that simply
// stopped at the first `(` emitted `[redacted-path](Client)/secret.js`, a marker
// sitting beside the tail it claimed to have scrubbed. Matching a balanced group
// keeps both readings. The two alternatives are mutually exclusive at every
// position — one cannot match `(`, the other matches only `(` — so the engine
// has no ambiguity to backtrack over.
const VALUE_BODY_SOURCE = String.raw`(?:[^\s"'()]|\([^\s"'()]*\)?)`;
// The delimiter that must precede a path. It is CAPTURED rather than consumed,
// so the substitution can put it back and replace only the value.
// `(` is load-bearing for V8 frames; `=` for the key/value shapes a diagnostic
// actually carries (`cwd=/Users/alice/private`, `file=relative/private.txt`),
// which start/whitespace/quote alone let through. `:` is deliberately NOT a
// delimiter: it would swallow `node:internal/…`, the builtin frames this module
// keeps on purpose. No delimiter may overlap the value class, or a run of them
// would give the engine one match attempt per offset.
const VALUE_DELIMITER_SOURCE = String.raw`(^|[\s"'(=])`;
const FILE_PATH_VALUE_PATTERN = new RegExp(
  `${VALUE_DELIMITER_SOURCE}(?:\\/(?!\\/)${VALUE_BODY_SOURCE}+|\\\\+${VALUE_BODY_SOURCE}*|[A-Za-z]:[\\\\/]${VALUE_BODY_SOURCE}*|~\\/${VALUE_BODY_SOURCE}*)`,
  "g"
);
const RELATIVE_PATH_VALUE_PATTERN = new RegExp(
  `${VALUE_DELIMITER_SOURCE}(?:\\.{1,2}[\\\\/]|[A-Za-z0-9._-]+[\\\\/])${VALUE_BODY_SOURCE}*`,
  "g"
);
// Desktop main is ESM, so its stack frames are `file://` URLs rather than bare
// paths — matched first, and as a PATH, because that is what they are.
const FILE_URL_VALUE_PATTERN = new RegExp(
  String.raw`\bfile:\/\/${VALUE_BODY_SOURCE}*`,
  "gi"
);
// Any scheme, not just http(s): a `vscode://` or `ws://` value leaks the same
// way, and over-matching a redactor is the safe direction.
const URL_VALUE_PATTERN = new RegExp(
  String.raw`\b(?:[a-z][a-z0-9+.-]*:\/\/|localhost\b|127\.0\.0\.1\b)${VALUE_BODY_SOURCE}*`,
  "gi"
);
// The local part is the RFC 5322 dot-atom set — `'` included, because
// `department'alice@example.com` is a valid address and a class without it
// redacted only the tail, emitting `department'[redacted-email]`: a marker that
// reads as scrubbed while part of the address still reached Datadog (ISS-6228).
//
// The leading class is that set's exact complement, and it is what keeps this
// linear. Without it the local-part run overlapped its own start: on a long run
// of allowed characters carrying no `@`, the engine rescanned the whole
// remaining suffix from every offset — 2.7s on a 40KB string, on the crash path,
// where `error.stack` is unbounded and the length caps are applied only AFTER
// this substitution runs. With it, a run has exactly one offset that can begin a
// match and every other fails on its first character.
const EMAIL_VALUE_SOURCE = String.raw`(^|[^A-Za-z0-9!#$%&'*+\/=?^_{|}~.-])[A-Za-z0-9!#$%&'*+\/=?^_{|}~.-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+`;
/**
 * The canonical email pattern. Declared non-global so a caller may `.test()` it
 * without inheriting a stale `lastIndex`; substitution uses the global twin.
 */
export const EMAIL_VALUE_PATTERN = new RegExp(EMAIL_VALUE_SOURCE);
const EMAIL_VALUE_REPLACE_PATTERN = new RegExp(EMAIL_VALUE_SOURCE, "g");
/** Any marker this module emits, used to reject a redacted value as a type tag. */
const REDACTION_MARKER_PATTERN = /\[redacted(?:-[a-z]+)?\]/;

export function sanitizeDesktopException({
  error,
  origin,
  componentStack,
}: DesktopExceptionTelemetryInput): SanitizedDesktopExceptionAttributes {
  const normalized = normalizeUnknownExceptionReason(error);
  return sanitizeDesktopExceptionAttributes({
    type: normalized.type,
    origin,
    message: normalized.message,
    stacktrace: componentStack ?? normalized.stack,
  });
}

export function sanitizeDesktopExceptionAttributes({
  type,
  origin,
  message,
  stacktrace,
}: DesktopExceptionTelemetryAttributesInput): SanitizedDesktopExceptionAttributes {
  const safeMessage = sanitizeExceptionTextField(
    message,
    MAX_EXCEPTION_MESSAGE_LENGTH
  );
  const safeStacktrace = sanitizeExceptionTextField(
    stacktrace,
    MAX_EXCEPTION_STACKTRACE_LENGTH
  );

  return {
    [TelemetryAttribute.ExceptionType]: sanitizeExceptionType(type),
    [TelemetryAttribute.AppExceptionOrigin]: origin,
    ...(safeMessage
      ? { [TelemetryAttribute.ExceptionMessage]: safeMessage }
      : {}),
    ...(safeStacktrace
      ? { [TelemetryAttribute.ExceptionStacktrace]: safeStacktrace }
      : {}),
  };
}

export function sanitizeExceptionTextField(
  value: string | undefined,
  maxLength: number
): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = normalizeControlWhitespace(trimmed);
  if (containsUnsafeControlCharacter(normalized)) {
    return undefined;
  }
  if (containsUnparseableSensitiveText(normalized)) {
    return REDACTED_EXCEPTION_TEXT;
  }
  const redacted = redactSensitiveExceptionValues(normalized);
  return Array.from(redacted).slice(0, maxLength).join("");
}

export function normalizeUnknownExceptionReason(error: unknown): {
  type: string;
  message?: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      type: error.name || error.constructor.name || EMPTY_EXCEPTION_TYPE,
      ...(error.message ? { message: error.message } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }

  if (typeof error === "string") {
    return {
      type: NON_ERROR_EXCEPTION_TYPE,
      message: error,
    };
  }

  if (
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint"
  ) {
    return {
      type: NON_ERROR_EXCEPTION_TYPE,
      message: String(error),
    };
  }

  return {
    type: NON_ERROR_EXCEPTION_TYPE,
  };
}

function sanitizeExceptionType(value: string | undefined): string {
  const type = sanitizeExceptionTextField(value, MAX_EXCEPTION_TYPE_LENGTH);
  // A type tag carrying any redaction marker is neither the real type nor a
  // useful low-cardinality label, so it collapses to the stable placeholder.
  if (!type || REDACTION_MARKER_PATTERN.test(type)) {
    return EMPTY_EXCEPTION_TYPE;
  }
  return type;
}

/**
 * True when the field carries a marker whose VALUE is unbounded — everything
 * after `request_body:` or an `org_id:` prefix, and any secret-shaped token.
 * There is no safe substring to keep, so the caller blanks the whole field.
 */
function containsUnparseableSensitiveText(value: string): boolean {
  return (
    BODY_MARKER_PATTERN.test(value) ||
    IDENTITY_MARKER_PATTERN.test(value) ||
    matchesPattern(SECRET_VALUE_PATTERN, value)
  );
}

/**
 * Replace each bounded sensitive value with its own marker, leaving everything
 * else byte-identical — a stack that only carried install paths still reports
 * its frame order, function names, and line structure. Order matters: URL forms
 * are consumed before the bare-path patterns can bite into them, and no pattern
 * can match a marker this function already inserted (all of them require a
 * start/whitespace/quote/paren/`=` delimiter or an `@`, and `[` is none of
 * those).
 */
function redactSensitiveExceptionValues(value: string): string {
  return value
    .replace(FILE_URL_VALUE_PATTERN, REDACTED_PATH_TEXT)
    .replace(URL_VALUE_PATTERN, REDACTED_URL_TEXT)
    .replace(EMAIL_VALUE_REPLACE_PATTERN, `$1${REDACTED_EMAIL_TEXT}`)
    .replace(FILE_PATH_VALUE_PATTERN, `$1${REDACTED_PATH_TEXT}`)
    .replace(RELATIVE_PATH_VALUE_PATTERN, `$1${REDACTED_PATH_TEXT}`);
}

function normalizeControlWhitespace(value: string): string {
  let normalized = "";
  let previousWasSpace = false;

  for (const character of value) {
    const code = character.charCodeAt(0);
    if (isControlWhitespaceCode(code)) {
      if (!previousWasSpace) {
        normalized += " ";
        previousWasSpace = true;
      }
      continue;
    }
    if (character === " " && previousWasSpace) {
      continue;
    }

    normalized += character;
    previousWasSpace = character === " ";
  }

  return normalized.trim();
}

function containsUnsafeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code <= LAST_ASCII_CONTROL_CHARACTER_CODE &&
        !isControlWhitespaceCode(code)) ||
      code === DELETE_CONTROL_CHARACTER_CODE
    ) {
      return true;
    }
  }
  return false;
}

function isControlWhitespaceCode(code: number): boolean {
  return (
    code === HORIZONTAL_TAB_CHARACTER_CODE ||
    code === LINE_FEED_CHARACTER_CODE ||
    code === FORM_FEED_CHARACTER_CODE ||
    code === CARRIAGE_RETURN_CHARACTER_CODE
  );
}

/** Most patterns here are global, whose `lastIndex` survives a bare `.test()`. */
function matchesPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

/**
 * True when the value carries a URL in any scheme, including `file://`.
 *
 * Exported as the canonical check so `renderer-otel-bridge.ts` can reject on the
 * same shapes this module redacts, rather than keeping its own copies of these
 * patterns and drifting from them (ISS-6229).
 */
export function containsSensitiveUrlValue(value: string): boolean {
  return (
    matchesPattern(FILE_URL_VALUE_PATTERN, value) ||
    matchesPattern(URL_VALUE_PATTERN, value)
  );
}

/** True when the value carries a path, a URL, or an email address. */
export function containsSensitivePathOrUrlValue(value: string): boolean {
  return (
    containsSensitiveUrlValue(value) ||
    matchesPattern(FILE_PATH_VALUE_PATTERN, value) ||
    matchesPattern(RELATIVE_PATH_VALUE_PATTERN, value) ||
    matchesPattern(EMAIL_VALUE_PATTERN, value)
  );
}

/** True when the value carries a secret-shaped token. */
export function containsSensitiveSecretValue(value: string): boolean {
  return matchesPattern(SECRET_VALUE_PATTERN, value);
}
