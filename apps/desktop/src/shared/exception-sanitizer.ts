import type { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";

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
const REDACTED_EXCEPTION_TEXT = "[redacted]";
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
const FILE_PATH_VALUE_PATTERN =
  /(?:^|[\s"'])((?:\/(?!\/)[^\s"']+|\\+[^\s"']*|[A-Za-z]:[\\/][^\s"']*|~\/[^\s"']*))/;
const RELATIVE_PATH_VALUE_PATTERN =
  /(?:^|[\s"'])((?:\.{1,2}[\\/]|[A-Za-z0-9._-]+[\\/])[^\s"']*)/;
const URL_VALUE_PATTERN = /\b(?:https?:\/\/|localhost\b|127\.0\.0\.1\b)/i;
const SECRET_VALUE_PATTERN =
  /\b(?:bearer\s+[A-Za-z0-9._~+/-]{12,}=*|github_pat_[A-Za-z0-9_]{20,}|gh[opsu]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{10,}|sk-(?:proj-)?[A-Za-z0-9_-]{6,}|sk_(?:live|test)_[A-Za-z0-9]{6,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/i;

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
  if (containsSensitiveExceptionText(normalized)) {
    return REDACTED_EXCEPTION_TEXT;
  }
  return Array.from(normalized).slice(0, maxLength).join("");
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
  if (!type || type === REDACTED_EXCEPTION_TEXT) {
    return EMPTY_EXCEPTION_TYPE;
  }
  return type;
}

function containsSensitiveExceptionText(value: string): boolean {
  return (
    BODY_MARKER_PATTERN.test(value) ||
    IDENTITY_MARKER_PATTERN.test(value) ||
    FILE_PATH_VALUE_PATTERN.test(value) ||
    RELATIVE_PATH_VALUE_PATTERN.test(value) ||
    URL_VALUE_PATTERN.test(value) ||
    SECRET_VALUE_PATTERN.test(value)
  );
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
