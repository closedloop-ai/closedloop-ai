import {
  SECRET_VALUE_PATTERN,
  UNBOUNDED_SECRET_VALUE_PATTERN,
} from "@closedloop-ai/loops-api/secret-value-pattern";
import type { AppTelemetrySchema } from "@closedloop-ai/telemetry-contract/app";
import type {
  AppBootFailureKind,
  AppBootFailureOutcome,
} from "@closedloop-ai/telemetry-contract/app-boot-failure-kind";
import type { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";

export type DesktopExceptionTelemetryInput = {
  error: unknown;
  origin: AppExceptionOrigin;
  componentStack?: string;
  /**
   * ISS-8907: why an Agent Monitor boot failure happened. Set only by the boot
   * path; every other exception producer omits it, and omission is what an older
   * installed build also sends — so a consumer must read absence as "not
   * classified", never as `unknown`.
   */
  bootFailureKind?: AppBootFailureKind;
  /**
   * ISS-9259: whether that boot failure ended the boot or cleared on a retry.
   * Set alongside `bootFailureKind` by the boot path and omitted everywhere
   * else, so a consumer reads absence as "not classified" — never as `failed`,
   * which would count an older build's RECOVERED timeout as a dead install.
   */
  bootFailureOutcome?: AppBootFailureOutcome;
};

export type DesktopExceptionTelemetryAttributesInput = {
  type: string;
  origin: AppExceptionOrigin;
  message?: string;
  stacktrace?: string;
  bootFailureKind?: AppBootFailureKind;
  bootFailureOutcome?: AppBootFailureOutcome;
};

export type SanitizedDesktopExceptionAttributes = {
  [TelemetryAttribute.ExceptionType]: string;
  [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin;
  [TelemetryAttribute.ExceptionMessage]?: string;
  [TelemetryAttribute.ExceptionStacktrace]?: string;
  [TelemetryAttribute.AppBootFailureKind]?: AppBootFailureKind;
  [TelemetryAttribute.AppBootFailureOutcome]?: AppBootFailureOutcome;
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
/**
 * Whole-field replacement for a value too large to scan at all (ISS-6330).
 *
 * Distinct from {@link REDACTED_EXCEPTION_TEXT} on purpose: that marker means
 * "a sensitive marker matched", this one means "we declined to look". Reusing
 * the first would make a reader believe a secret was found here.
 */
const REDACTED_OVERLONG_EXCEPTION_TEXT = "[redacted-overlong]";
const REDACTED_PATH_TEXT = "[redacted-path]";
const REDACTED_URL_TEXT = "[redacted-url]";
const REDACTED_EMAIL_TEXT = "[redacted-email]";
const MAX_EXCEPTION_TYPE_LENGTH = 128;
const MAX_EXCEPTION_MESSAGE_LENGTH = 1024;
const MAX_EXCEPTION_STACKTRACE_LENGTH = 8192;
/**
 * Ceiling on what this module will scan at all (ISS-6330). Past it the field is
 * replaced wholesale, before normalization, the marker tests, or substitution.
 *
 * Every pass below is a full-string walk — a per-codepoint normalize, two
 * control scans, three marker tests, five global substitutions, and finally an
 * `Array.from` that allocates one array element per codepoint — and the length
 * caps above are applied only at the END of that. On the pre-init crash path
 * this runs synchronously on Electron's main thread with an `error.stack` that
 * no one bounds, so a multi-megabyte value stalls or OOMs the very startup it
 * was trying to report on.
 *
 * The overlong field is redacted WHOLE rather than truncated and then scanned:
 * a cut can land mid-token, and a half of a secret no longer matches
 * `SECRET_VALUE_PATTERN`, which would ship the surviving prefix as clean text.
 *
 * 8x the largest field cap, so no legitimate report is affected — a V8 stack is
 * bounded by `Error.stackTraceLimit` and is orders of magnitude under this —
 * while everything above it is pathological by construction.
 */
const MAX_SANITIZABLE_EXCEPTION_TEXT_LENGTH =
  MAX_EXCEPTION_STACKTRACE_LENGTH * 8;
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
  bootFailureKind,
  bootFailureOutcome,
}: DesktopExceptionTelemetryInput): SanitizedDesktopExceptionAttributes {
  const normalized = normalizeUnknownExceptionReason(error);
  return sanitizeDesktopExceptionAttributes({
    type: normalized.type,
    origin,
    message: normalized.message,
    stacktrace: componentStack ?? normalized.stack,
    ...(bootFailureKind ? { bootFailureKind } : {}),
    ...(bootFailureOutcome ? { bootFailureOutcome } : {}),
  });
}

export function sanitizeDesktopExceptionAttributes({
  type,
  origin,
  message,
  stacktrace,
  bootFailureKind,
  bootFailureOutcome,
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
    // A closed enum, so it bypasses the text passes above by construction —
    // there is no value of it that could carry a path, a specifier, or a secret.
    // Spread-omitted rather than set to undefined: this record crosses a
    // `.strict()` parse and an OTLP encode, and an absent optional field must
    // stay absent (cross-repo contract), not become a null.
    ...(bootFailureKind
      ? { [TelemetryAttribute.AppBootFailureKind]: bootFailureKind }
      : {}),
    ...(bootFailureOutcome
      ? { [TelemetryAttribute.AppBootFailureOutcome]: bootFailureOutcome }
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
  // Before any full-string pass. `trim` runs first so a field that is only
  // whitespace still returns undefined rather than a marker for no content.
  if (trimmed.length > MAX_SANITIZABLE_EXCEPTION_TEXT_LENGTH) {
    return REDACTED_OVERLONG_EXCEPTION_TEXT;
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
 * after `request_body:` or an `org_id:` prefix, and any secret-shaped token whose
 * extent the vocabulary cannot determine. There is no safe substring to keep, so
 * the caller blanks the whole field.
 *
 * `UNBOUNDED_SECRET_VALUE_PATTERN` and not `SECRET_VALUE_PATTERN` (ISS-6993):
 * the vocabulary now also carries BOUNDED families, and a bounded value is by
 * definition one this module can substitute in place instead — which is the
 * ISS-6228/ISS-6229 contract that a stack carrying only bounded values keeps its
 * frames. `scheme://user:pass@host` is the case: `URL_VALUE_PATTERN` below
 * already replaces the whole URL with `[redacted-url]`, so blanking the field on
 * it would destroy the message and stack to re-remove a credential that was
 * already gone.
 */
function containsUnparseableSensitiveText(value: string): boolean {
  return (
    BODY_MARKER_PATTERN.test(value) ||
    IDENTITY_MARKER_PATTERN.test(value) ||
    matchesPattern(UNBOUNDED_SECRET_VALUE_PATTERN, value)
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

/** Every attribute key the `.strict()` app schema declares. */
type AppTelemetryAttributeKey = keyof (typeof AppTelemetrySchema)["shape"];

/**
 * ISS-8907: the forcing function for this module's half of the app-exception
 * wire contract, in BOTH directions.
 *
 * `emitExceptionSpan` hands what this module returns to `AppTelemetrySchema`,
 * which is `.strict()`. A key the schema does not declare therefore does not
 * drop that ATTRIBUTE — it fails the parse and drops the WHOLE span, silently,
 * and re-drops it on every retry. The in-process callers never see it because
 * they read the object rather than the parse.
 *
 * The ANNOTATION fails typecheck when a key is added to the emitted shape and
 * not listed here; the `satisfies` fails when a listed key is not one the schema
 * declares, which is the rename case. They are deliberately two separate
 * constraints and not one intersection: excess-property checking against an
 * intersection passes a key that ANY constituent allows, so `satisfies A & B`
 * here silently accepted a key the schema had dropped — verified by removing it
 * from `AppTelemetrySchema` and watching `tsc` stay green. A plain array of key
 * literals would have caught neither direction; it is a side inventory, and a
 * side inventory is what stays green while the set it mirrors moves.
 */
export const SANITIZED_EXCEPTION_ATTRIBUTE_KEY_PRESENCE: Record<
  keyof SanitizedDesktopExceptionAttributes,
  true
> = {
  [TelemetryAttribute.ExceptionType]: true,
  [TelemetryAttribute.AppExceptionOrigin]: true,
  [TelemetryAttribute.ExceptionMessage]: true,
  [TelemetryAttribute.ExceptionStacktrace]: true,
  [TelemetryAttribute.AppBootFailureKind]: true,
  [TelemetryAttribute.AppBootFailureOutcome]: true,
} satisfies Partial<Record<AppTelemetryAttributeKey, true>>;
