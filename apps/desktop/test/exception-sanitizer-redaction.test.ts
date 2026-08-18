/**
 * @file exception-sanitizer-redaction.test.ts
 * @description ISS-6228 / ISS-6229 — the redaction corpus for
 * `src/shared/exception-sanitizer.ts`.
 *
 * Two defects with one root cause: the sensitivity check had no email arm at
 * all (ISS-6228), and its path/URL arms could not see the forms desktop main
 * actually produces — `file://` ESM frames and `(`-wrapped V8 locations
 * (ISS-6229). The fix also changed the SHAPE of redaction: a bounded sensitive
 * value is now replaced in place by its own marker instead of blanking the
 * whole field, so a stack that only carried install paths still reports its
 * frames. This suite drives that corpus through the public entry point.
 *
 * The owning suite for everything else about this module is
 * `exception-sanitizer.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  EMAIL_VALUE_PATTERN,
  sanitizeDesktopExceptionAttributes,
  sanitizeExceptionTextField,
} from "../src/shared/exception-sanitizer.js";

const REDACTED_PATH = "[redacted-path]";
const REDACTED_URL = "[redacted-url]";
const REDACTED_EMAIL = "[redacted-email]";
const TEXT_FIELD_MAX = 8192;
const ANY_REDACTION_MARKER = /\[redacted/;

/** Drive the real entry point and read back the emitted message attribute. */
function emittedMessage(message: string): string | undefined {
  return sanitizeDesktopExceptionAttributes({
    type: "Error",
    origin: AppExceptionOrigin.Main,
    message,
  })[TelemetryAttribute.ExceptionMessage];
}

test("an email address is replaced in place (ISS-6228)", () => {
  const cases: [string, string][] = [
    [
      "Cloud rejected hello for peter@acme.com",
      `Cloud rejected hello for ${REDACTED_EMAIL}`,
    ],
    [
      "invite failed: a.b+tag@sub.example.co.uk",
      "invite failed: [redacted-email]",
    ],
    [
      "seat conflict between one@a.test and two@b.test",
      `seat conflict between ${REDACTED_EMAIL} and ${REDACTED_EMAIL}`,
    ],
  ];

  for (const [message, expected] of cases) {
    assert.equal(
      emittedMessage(message),
      expected,
      `an email must not reach telemetry: ${message}`
    );
  }
});

test("a file:// stack frame is redacted in both its forms (ISS-6229)", () => {
  // Desktop main is ESM, so essentially every real frame is one of these two.
  const cases: [string, string][] = [
    [
      "at start (file:///Users/name/Closedloop.app/Contents/main.js:12:9)",
      `at start (${REDACTED_PATH})`,
    ],
    [
      "at file:///Users/name/Closedloop.app/Contents/main.js:12:9",
      `at ${REDACTED_PATH}`,
    ],
    [
      "at load (file:///C:/Users/name/AppData/main.js:1:1)",
      `at load (${REDACTED_PATH})`,
    ],
  ];

  for (const [stacktrace, expected] of cases) {
    assert.equal(
      sanitizeDesktopExceptionAttributes({
        type: "Error",
        origin: AppExceptionOrigin.Main,
        stacktrace,
      })[TelemetryAttribute.ExceptionStacktrace],
      expected,
      `a file:// frame must not reach telemetry: ${stacktrace}`
    );
  }
});

test("a parenthesised path is redacted on both platforms (ISS-6229)", () => {
  const cases: [string, string][] = [
    ["at fn (/Users/alice/app/main.js:1:1)", `at fn (${REDACTED_PATH})`],
    [
      String.raw`at fn (C:\Users\alice\app\main.js:1:1)`,
      `at fn (${REDACTED_PATH})`,
    ],
    ["at fn (~/app/main.js:1:1)", `at fn (${REDACTED_PATH})`],
    ["at fn (./relative/main.js:1:1)", `at fn (${REDACTED_PATH})`],
    // The pre-fix delimiters (start / whitespace / quote) must still work.
    [
      "boot failed at fn /Users/alice/app/main.js:1:1",
      `boot failed at fn ${REDACTED_PATH}`,
    ],
  ];

  for (const [message, expected] of cases) {
    assert.equal(
      emittedMessage(message),
      expected,
      `a path must not reach telemetry: ${message}`
    );
  }
});

test("a network URL keeps its own marker, distinct from a path", () => {
  const cases: [string, string][] = [
    [
      "failed calling http://localhost:4318/v1/traces",
      `failed calling ${REDACTED_URL}`,
    ],
    ["https://example.test/path failed", `${REDACTED_URL} failed`],
    ["relay at 127.0.0.1:3020 refused", `relay at ${REDACTED_URL} refused`],
    // Any scheme, not just http(s) — a deep link leaks the same way.
    ["open closedloop://session/abc failed", `open ${REDACTED_URL} failed`],
  ];

  for (const [message, expected] of cases) {
    assert.equal(emittedMessage(message), expected, `URL leak: ${message}`);
  }
});

test("a multi-frame stack keeps its structure while every location goes", () => {
  const stacktrace = [
    "Error: boot failed",
    "at start (file:///Users/name/app/main.js:12:9)",
    "at boot (/Users/name/app/boot.js:3:1)",
    "at run (node:internal/main:1:1)",
  ].join("\n");

  assert.equal(
    sanitizeDesktopExceptionAttributes({
      type: "Error",
      origin: AppExceptionOrigin.Main,
      stacktrace,
    })[TelemetryAttribute.ExceptionStacktrace],
    `Error: boot failed at start (${REDACTED_PATH}) at boot (${REDACTED_PATH}) at run (node:internal/main:1:1)`,
    "frame order and function names survive; only the locations are replaced"
  );
});

test("a node: builtin frame is kept — it carries no install path", () => {
  // The point of in-place substitution: the frames that are actually useful for
  // triage and carry nothing user-specific must still reach Datadog. Whole-field
  // blanking took these out along with the leak.
  assert.equal(
    emittedMessage("failed in node:internal/modules/esm/loader"),
    "failed in node:internal/modules/esm/loader"
  );
});

test("clean text passes through byte-identical, with no marker emitted", () => {
  // The counterpart the repo rule demands: a redaction marker may only appear
  // when sensitive content was actually matched.
  const clean = [
    "render failed",
    "in RendererBoundary",
    "Cannot read properties of undefined (reading 'session')",
    "at RendererBoundary",
    "Maximum update depth exceeded",
    "boot failed after 3 attempts",
  ];

  for (const message of clean) {
    const emitted = sanitizeExceptionTextField(message, TEXT_FIELD_MAX);
    assert.equal(
      emitted,
      message,
      `clean text must survive unchanged: ${message}`
    );
    assert.equal(
      ANY_REDACTION_MARKER.test(emitted ?? ""),
      false,
      `no marker may be emitted without a match: ${message}`
    );
  }
});

test("a path adjacent to key/value punctuation is redacted (ISS-6229)", () => {
  // `cwd=…` and `file=…` are ordinary diagnostic shapes, and a delimiter class
  // of start/whitespace/quote/paren passed both through untouched.
  const cases: [string, string][] = [
    ["cwd=/Users/alice/private", `cwd=${REDACTED_PATH}`],
    ["file=relative/private.txt", `file=${REDACTED_PATH}`],
    [String.raw`drive=C:\Users\alice\private`, `drive=${REDACTED_PATH}`],
    ["home=~/private/keys", `home=${REDACTED_PATH}`],
    [
      "spawn failed cwd=/Users/alice/w err=2",
      `spawn failed cwd=${REDACTED_PATH} err=2`,
    ],
  ];

  for (const [message, expected] of cases) {
    assert.equal(
      emittedMessage(message),
      expected,
      `a path beside punctuation must not reach telemetry: ${message}`
    );
  }
});

test("a parenthesis INSIDE a path does not end the value (ISS-6229)", () => {
  // The nastier half: stopping at the interior `(` emitted the marker AND the
  // tail it claimed to have scrubbed, so the record read as redacted while the
  // account name was still in it.
  const cases: [string, string][] = [
    ["file:///Users/alice/Acme(Client)/secret.js", REDACTED_PATH],
    [
      "at fn (/Users/alice/Acme(Client)/secret.js:1:2)",
      `at fn (${REDACTED_PATH})`,
    ],
    ["/Users/alice/Acme(Client)(Other)/secret.js", REDACTED_PATH],
    // An unbalanced `(` must not leave the rest of the segment behind either.
    ["/Users/alice/Acme(Client/secret.js", REDACTED_PATH],
  ];

  for (const [message, expected] of cases) {
    const emitted = emittedMessage(message);
    assert.equal(
      emitted,
      expected,
      `a path's tail must not survive its own marker: ${message}`
    );
    assert.equal(
      (emitted ?? "").includes("Client"),
      false,
      `no path segment may sit beside the marker: ${message}`
    );
  }
});

test("an apostrophe local part is redacted whole (ISS-6228)", () => {
  // `'` is valid in an RFC 5322 local part. Redacting only the tail emitted
  // `department'[redacted-email]` — a marker that reads as scrubbed while part
  // of the address still reached Datadog.
  const cases: [string, string][] = [
    ["department'alice@example.com", REDACTED_EMAIL],
    ["o'brien@example.com bounced", `${REDACTED_EMAIL} bounced`],
    ["notify d'arcy.o'neill@sub.example.co.uk", `notify ${REDACTED_EMAIL}`],
    ["!#$%&'*+/=?^_{|}~test@example.com", REDACTED_EMAIL],
  ];

  for (const [message, expected] of cases) {
    const emitted = emittedMessage(message);
    assert.equal(
      emitted,
      expected,
      `the whole address must go, not just its tail: ${message}`
    );
    assert.equal(
      (emitted ?? "").includes("'"),
      false,
      `no local-part fragment may survive: ${message}`
    );
  }
});

test("the email pattern can start a match at only one offset per run", () => {
  // ISS-6228 thread: the quadratic MISS case. With no leading guard, a run of
  // allowed local-part characters carrying no `@` was rescanned from every
  // offset, and the length caps are applied only AFTER substitution, so an
  // oversized `error.stack` stalled the crash path before they could help.
  //
  // Asserted structurally rather than on the clock: exactly one offset in the
  // run may begin a match, so the remaining offsets fail on their first
  // character and the scan stays linear. Under the unguarded pattern every
  // offset matches and this goes red.
  const runLength = 64;
  const subject = `${"a".repeat(runLength)}@example.com`;
  const stickyEmail = new RegExp(EMAIL_VALUE_PATTERN.source, "y");

  const startOffsets: number[] = [];
  for (let offset = 0; offset < runLength; offset += 1) {
    stickyEmail.lastIndex = offset;
    if (stickyEmail.test(subject)) {
      startOffsets.push(offset);
    }
  }

  assert.deepEqual(
    startOffsets,
    [0],
    "only the offset at the head of the run may begin a match"
  );

  // The miss case itself: a long run with no `@` must produce no marker at all.
  const missed = "a".repeat(4096);
  assert.equal(sanitizeExceptionTextField(missed, TEXT_FIELD_MAX), missed);
});

test("a redacted value can never be promoted to the type tag", () => {
  // The type slot runs through the same sanitizer, so a path-shaped or
  // email-shaped type must collapse to the stable placeholder rather than be
  // emitted as the literal marker.
  for (const type of [
    "/Users/someone/app/Boom",
    "file:///Users/someone/app/Boom",
    "peter@acme.com",
  ]) {
    assert.equal(
      sanitizeDesktopExceptionAttributes({
        type,
        origin: AppExceptionOrigin.Main,
      })[TelemetryAttribute.ExceptionType],
      "UnknownException",
      `a redacted type must not be emitted as a marker: ${type}`
    );
  }
});
