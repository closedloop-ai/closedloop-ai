/**
 * @file exception-sanitizer.test.ts
 * @description ISS-5302 — owning suite for `src/shared/exception-sanitizer.ts`.
 *
 * The module's whole job is that a RAW throwable — an Error with a real stack,
 * a rejected string carrying a URL, a React component stack full of filesystem
 * paths — becomes a bounded, low-cardinality attribute bag with nothing
 * sensitive left in it. These tests drive the two public entry points
 * (`sanitizeDesktopException`, `sanitizeDesktopExceptionAttributes`) plus the
 * two exported helpers, and assert on the EMITTED attributes: what survives,
 * what is replaced by `[redacted]`, and what is omitted entirely.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  normalizeUnknownExceptionReason,
  sanitizeDesktopException,
  sanitizeDesktopExceptionAttributes,
  sanitizeExceptionTextField,
} from "../src/shared/exception-sanitizer.js";

const REDACTED = "[redacted]";
const REDACTED_PATH = "[redacted-path]";
const REDACTED_URL = "[redacted-url]";
const UNKNOWN_EXCEPTION_TYPE = "UnknownException";
const NON_ERROR_EXCEPTION_TYPE = "NonErrorRejection";
const TEXT_FIELD_MAX = 1024;

test("a raw component stack never reaches the emitted attributes", () => {
  const attributes = sanitizeDesktopException({
    error: new Error("render failed"),
    origin: AppExceptionOrigin.Renderer,
    componentStack:
      "    at RendererBoundary /home/someone/app/src/boundary.tsx:12:3",
  });

  assert.equal(
    attributes[TelemetryAttribute.ExceptionStacktrace],
    `at RendererBoundary ${REDACTED_PATH}`,
    "the path is replaced in place; the frame around it survives"
  );
  // Read the whole emitted bag untyped: no attribute may carry the path, not
  // just the stacktrace slot we happen to assert above.
  assert.equal(
    JSON.stringify(attributes).includes("/home/someone"),
    false,
    "no emitted attribute may carry the raw filesystem path"
  );
  assert.equal(
    attributes[TelemetryAttribute.ExceptionMessage],
    "render failed"
  );
  assert.equal(
    attributes[TelemetryAttribute.AppExceptionOrigin],
    AppExceptionOrigin.Renderer
  );
});

test("a safe component stack wins over the error's own stack", () => {
  const error = new Error("render failed");
  // Every real `error.stack` carries filesystem paths, so it would redact.
  // A surviving, non-redacted stacktrace proves the componentStack was used.
  assert.ok(error.stack, "the fixture error must carry a stack to displace");

  const attributes = sanitizeDesktopException({
    error,
    origin: AppExceptionOrigin.Renderer,
    componentStack: "in RendererBoundary",
  });

  assert.equal(
    attributes[TelemetryAttribute.ExceptionStacktrace],
    "in RendererBoundary"
  );
});

test("a real V8 stack has every frame location redacted (ISS-6229)", () => {
  // ISS-5302 reported, and ISS-6229 fixed, the leak this pins: both path
  // detectors used to anchor on start-of-string, whitespace, or a quote, so the
  // "(" every V8 frame puts before its location — `at fn (/Users/alice/...)` —
  // defeated them and the install path (which carries the OS account name on
  // macOS and Windows per-user installs) shipped verbatim. This drives a REAL
  // stack from this process, so it also covers the ESM `file://` frame form
  // desktop main actually produces.
  const attributes = sanitizeDesktopException({
    error: new Error("boot failed"),
    origin: AppExceptionOrigin.Main,
  });

  const stacktrace = attributes[TelemetryAttribute.ExceptionStacktrace] ?? "";
  assert.ok(
    stacktrace.includes(REDACTED_PATH),
    `every frame location must be replaced by a marker: ${stacktrace}`
  );
  assert.equal(
    stacktrace.includes("exception-sanitizer.test.ts"),
    false,
    "no raw frame location may reach the emitted attribute"
  );
  assert.ok(
    stacktrace.startsWith("Error: boot failed"),
    "the surrounding stack structure survives the substitution"
  );
});

test("an Error with a blanked name falls back to its constructor name", () => {
  const error = new RendererBoundaryError("kaboom");
  error.name = "";

  const attributes = sanitizeDesktopException({
    error,
    origin: AppExceptionOrigin.Renderer,
  });

  assert.equal(
    attributes[TelemetryAttribute.ExceptionType],
    "RendererBoundaryError"
  );
});

test("an anonymous Error subclass with no usable name reports UnknownException", () => {
  // A class expression inside an array literal gets no NamedEvaluation, so its
  // `.name` is "" — the shape minified/bundled renderer code routinely throws.
  // With `name` blanked too, neither fallback yields a type tag, and the emitted
  // attribute must be the stable placeholder rather than "" or undefined.
  const anonymousErrors = [class extends Error {}];
  assert.equal(
    anonymousErrors[0]?.name,
    "",
    "the fixture class must be anonymous"
  );

  const error = new anonymousErrors[0]("kaboom");
  error.name = "";

  const attributes = sanitizeDesktopException({
    error,
    origin: AppExceptionOrigin.Renderer,
  });

  assert.equal(
    attributes[TelemetryAttribute.ExceptionType],
    UNKNOWN_EXCEPTION_TYPE
  );
  assert.equal(attributes[TelemetryAttribute.ExceptionMessage], "kaboom");
});

test("an Error with an empty message emits no message attribute", () => {
  const attributes = sanitizeDesktopException({
    error: new RendererBoundaryError(""),
    origin: AppExceptionOrigin.Renderer,
  });

  assert.equal(
    Object.hasOwn(attributes, TelemetryAttribute.ExceptionMessage),
    false,
    "an absent message is omitted, never emitted as an empty string"
  );
  // `name` is inherited from Error.prototype, so the subclass still reports
  // "Error" — the constructor-name fallback only fires when `name` is blanked.
  assert.equal(attributes[TelemetryAttribute.ExceptionType], "Error");
});

test("a string rejection becomes a NonErrorRejection carrying the string", () => {
  const attributes = sanitizeDesktopException({
    error: "renderer blew up",
    origin: AppExceptionOrigin.Renderer,
  });

  assert.equal(
    attributes[TelemetryAttribute.ExceptionType],
    NON_ERROR_EXCEPTION_TYPE
  );
  assert.equal(
    attributes[TelemetryAttribute.ExceptionMessage],
    "renderer blew up"
  );
  assert.equal(
    Object.hasOwn(attributes, TelemetryAttribute.ExceptionStacktrace),
    false,
    "a non-Error rejection has no stack to report"
  );
});

test("a string rejection carrying a URL is redacted, not dropped", () => {
  const attributes = sanitizeDesktopException({
    error: "failed calling http://localhost:4318/v1/traces",
    origin: AppExceptionOrigin.Renderer,
  });

  assert.equal(
    attributes[TelemetryAttribute.ExceptionMessage],
    `failed calling ${REDACTED_URL}`
  );
});

test("primitive rejections stringify into the message", () => {
  const cases: { error: unknown; message: string }[] = [
    { error: 42, message: "42" },
    { error: true, message: "true" },
    { error: 10n, message: "10" },
  ];

  for (const { error, message } of cases) {
    const attributes = sanitizeDesktopException({
      error,
      origin: AppExceptionOrigin.Renderer,
    });
    assert.equal(
      attributes[TelemetryAttribute.ExceptionType],
      NON_ERROR_EXCEPTION_TYPE
    );
    assert.equal(attributes[TelemetryAttribute.ExceptionMessage], message);
  }
});

test("an opaque rejection reports the type with no fabricated message", () => {
  for (const error of [null, undefined, {}, Symbol("nope")]) {
    const attributes = sanitizeDesktopException({
      error,
      origin: AppExceptionOrigin.Renderer,
    });
    assert.equal(
      attributes[TelemetryAttribute.ExceptionType],
      NON_ERROR_EXCEPTION_TYPE
    );
    assert.equal(
      Object.hasOwn(attributes, TelemetryAttribute.ExceptionMessage),
      false,
      "an unreadable reason must not be given an invented message"
    );
  }
});

test("normalizeUnknownExceptionReason keeps an Error's own name and stack", () => {
  const error = new RendererBoundaryError("kaboom");

  assert.deepEqual(normalizeUnknownExceptionReason(error), {
    type: "Error",
    message: "kaboom",
    stack: error.stack,
  });
});

test("a whitespace-only message is omitted rather than emitted blank", () => {
  const attributes = sanitizeDesktopException({
    error: "   \t  ",
    origin: AppExceptionOrigin.Renderer,
  });

  assert.equal(
    Object.hasOwn(attributes, TelemetryAttribute.ExceptionMessage),
    false
  );
  assert.equal(
    sanitizeExceptionTextField("   \t  ", TEXT_FIELD_MAX),
    undefined
  );
  assert.equal(sanitizeExceptionTextField("", TEXT_FIELD_MAX), undefined);
  assert.equal(
    sanitizeExceptionTextField(undefined, TEXT_FIELD_MAX),
    undefined
  );
});

test("unsafe control characters drop the field, whitespace controls do not", () => {
  for (const unsafe of ["boom\u0000null", "boom\u007fdel", "boom\u0007bell"]) {
    assert.equal(
      sanitizeExceptionTextField(unsafe, TEXT_FIELD_MAX),
      undefined,
      `a non-whitespace control character must drop the field: ${JSON.stringify(unsafe)}`
    );
  }

  // Tab / LF / FF / CR are the sanctioned exceptions: they collapse to a single
  // space instead of nuking the field, so multi-line messages still report.
  assert.equal(
    sanitizeExceptionTextField("boom\tagain", TEXT_FIELD_MAX),
    "boom again"
  );
  assert.equal(
    sanitizeExceptionTextField("boom\n\n  again", TEXT_FIELD_MAX),
    "boom again"
  );
  assert.equal(
    sanitizeExceptionTextField("\r\n boom \f", TEXT_FIELD_MAX),
    "boom"
  );
});

test("a control character in a message drops it from the emitted attributes", () => {
  const attributes = sanitizeDesktopException({
    error: "boom\u0000null",
    origin: AppExceptionOrigin.Renderer,
  });

  assert.equal(
    Object.hasOwn(attributes, TelemetryAttribute.ExceptionMessage),
    false
  );
});

test("text fields truncate by code point, not UTF-16 unit", () => {
  assert.equal(sanitizeExceptionTextField("ab".repeat(10), 5), "ababa");

  const truncated = sanitizeExceptionTextField("\u{1F600}".repeat(6), 3);
  assert.equal(truncated, "\u{1F600}\u{1F600}\u{1F600}");
  assert.equal(
    Array.from(truncated ?? "").length,
    3,
    "the cap counts code points, so an astral character costs one slot"
  );
});

test("an unusable exception type collapses to UnknownException", () => {
  const unusable = [
    // Redacted by the path filter, so it cannot be used as a type tag.
    "/Users/someone/app/Boom",
    "   ",
    "",
    "boom\u0000null",
  ];

  for (const type of unusable) {
    const attributes = sanitizeDesktopExceptionAttributes({
      type,
      origin: AppExceptionOrigin.Renderer,
    });
    assert.equal(
      attributes[TelemetryAttribute.ExceptionType],
      UNKNOWN_EXCEPTION_TYPE,
      `an unusable type must not be emitted verbatim: ${JSON.stringify(type)}`
    );
  }
});

test("the type is bounded independently of the message", () => {
  const attributes = sanitizeDesktopExceptionAttributes({
    type: "T".repeat(200),
    origin: AppExceptionOrigin.Main,
    message: "m".repeat(2000),
  });

  // 128 for the type, 1024 for the message — separate caps, both enforced.
  assert.equal(attributes[TelemetryAttribute.ExceptionType]?.length, 128);
  assert.equal(attributes[TelemetryAttribute.ExceptionMessage]?.length, 1024);
});

test("an unbounded sensitive marker blanks that field only", () => {
  // These three classes keep WHOLE-field replacement: what follows the marker
  // is arbitrary, so there is no bounded span to substitute (unlike the paths,
  // URLs, and emails covered in exception-sanitizer-redaction.test.ts).
  const sensitive = [
    "request_body: {secret}",
    "org_id: 0192abcd-ef01",
    "bearer abcdefghijklmnop1234",
  ];

  for (const message of sensitive) {
    const attributes = sanitizeDesktopExceptionAttributes({
      type: "Error",
      origin: AppExceptionOrigin.Renderer,
      message,
      stacktrace: "in RendererBoundary",
    });
    assert.equal(
      attributes[TelemetryAttribute.ExceptionMessage],
      REDACTED,
      `sensitive message must redact: ${message}`
    );
    assert.equal(
      attributes[TelemetryAttribute.ExceptionType],
      "Error",
      "redacting one field must not disturb the type tag"
    );
    assert.equal(
      attributes[TelemetryAttribute.ExceptionStacktrace],
      "in RendererBoundary",
      "a safe stacktrace survives alongside a redacted message"
    );
  }
});

test("google oauth token shapes redact on their own, not via a path match", () => {
  // Both fixtures are shaped so ONLY the ya29./1// secret alternatives can
  // match them: no whitespace or quote precedes `1//`, which would otherwise
  // let RELATIVE_PATH_VALUE_PATTERN redact it and leave the token alternative
  // untested.
  const googleCredentials = [
    "Google auth failed with access token=ya29.a0AfB1234567890abcdefghijklmn",
    "Google auth failed with refreshed=1//0gABCDEFGHIJKLMNOPQRSTUVWX1234",
  ];

  for (const message of googleCredentials) {
    const attributes = sanitizeDesktopExceptionAttributes({
      type: "Error",
      origin: AppExceptionOrigin.Renderer,
      message,
    });
    assert.equal(
      attributes[TelemetryAttribute.ExceptionMessage],
      REDACTED,
      `a google credential must redact: ${message}`
    );
  }
});

test("the origin is passed through verbatim for every closed origin value", () => {
  for (const origin of Object.values(AppExceptionOrigin)) {
    const attributes = sanitizeDesktopExceptionAttributes({
      type: "Error",
      origin,
    });
    assert.equal(attributes[TelemetryAttribute.AppExceptionOrigin], origin);
  }
});

/** A named Error subclass, so `constructor.name` is distinguishable from "Error". */
class RendererBoundaryError extends Error {}
