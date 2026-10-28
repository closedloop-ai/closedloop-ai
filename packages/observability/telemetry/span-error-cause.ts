// ---------------------------------------------------------------------------
// Deriving a SAFE error cause for a request span (ISS-7217).
//
// A 5xx span used to record the status code and nothing about why, which is
// what made the sync 500s un-diagnosable. Attaching a cause to a keyless
// telemetry lane is also the classic place user content escapes, so this module
// exists to answer exactly one question — "what CLASS of failure was this?" —
// and to be structurally incapable of answering any wider one.
//
// The rules, in order:
//
//   1. NO FREE TEXT. `error.message` is never derived here. A message can carry
//      a query string, a filesystem path, a prompt fragment, or a row value,
//      and no bound makes a truncated one of those safe. The RCA need is the
//      failure class, and the class is what a type plus a code answers.
//   2. Reuse the existing sanitizer. `redactSensitiveText` is the SSOT for what
//      counts as secret-shaped (`packages/observability/redact.ts`, sharing
//      `SECRET_VALUE_REPLACE_PATTERN` with the desktop exception-sanitizer).
//      A credential family is added THERE, not here.
//   3. A candidate the sanitizer touched is DROPPED, not shipped redacted. A
//      partially-redacted string still carries whatever the pattern did not
//      recognize; emitting nothing is strictly better than emitting a leak with
//      a `[redacted]` in it.
//   4. Whatever survives must still satisfy the contract's
//      `SpanErrorTypeSchema`, whose identifier shape rejects every character a
//      path, an address, or a sentence needs.
// ---------------------------------------------------------------------------

import { SpanErrorTypeSchema } from "@closedloop-ai/telemetry-contract/span";
import { redactSensitiveText } from "../redact";

/**
 * Short, stable, machine-set failure codes worth appending to the class name:
 * Prisma's `P2002`, Node's `ECONNREFUSED`, undici's `UND_ERR_CONNECT_TIMEOUT`.
 * The bound is deliberately tighter than the class-name pattern — a `code` is
 * a field name libraries also use for looser things, so only an unmistakably
 * code-shaped value is allowed to widen the type.
 */
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const ERROR_TYPE_SEPARATOR = ".";
const ANONYMOUS_CONSTRUCTOR_NAMES: ReadonlySet<string> = new Set([
  "Object",
  "Function",
]);

/**
 * Derive the span's `error.type` from a caught value, or `undefined` when no
 * class can be named without risking content.
 *
 * `undefined` is a real answer, not a failure: paired with `app.error.source`
 * it reads as "a layer caught something it could not safely name", which stays
 * distinguishable from a 5xx nothing attributed at all.
 */
export function resolveSpanErrorType(error: unknown): string | undefined {
  const className = errorClassName(error);
  if (!className) {
    return undefined;
  }

  const code = errorCode(error);
  const candidate = code
    ? `${className}${ERROR_TYPE_SEPARATOR}${code}`
    : className;

  // Rule 3: the sanitizer is a detector here, not a transform. If it would have
  // changed anything, the candidate is not a class name and is dropped whole.
  if (redactSensitiveText(candidate) !== candidate) {
    return undefined;
  }

  const validated = SpanErrorTypeSchema.safeParse(candidate);
  return validated.success ? validated.data : undefined;
}

function errorClassName(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") {
    return undefined;
  }

  // An OWN `name` is a deliberate declaration by whoever threw — `this.name =`
  // in a constructor, a class field, or an assignment on the instance — so it
  // wins. An INHERITED one is not: `Error.prototype.name` is the reason a
  // custom subclass that never assigns `this.name` would otherwise report as a
  // bare `Error` and lose the failure class this attribute promises. So the
  // non-anonymous constructor name is preferred over an inherited `name`, and
  // the inherited one is kept only as the last resort — it is still better than
  // nothing when the constructor is anonymous or unnamed.
  const declared = nonEmptyString(
    safeRead(() =>
      safeRead(() => Object.hasOwn(error, "name"))
        ? (error as { name?: unknown }).name
        : undefined
    )
  );
  if (declared) {
    return declared;
  }

  const constructorName = nonEmptyString(
    safeRead(
      () => (error as { constructor?: { name?: unknown } }).constructor?.name
    )
  );
  if (constructorName && !ANONYMOUS_CONSTRUCTOR_NAMES.has(constructorName)) {
    return constructorName;
  }

  return nonEmptyString(safeRead(() => (error as { name?: unknown }).name));
}

function errorCode(error: unknown): string | undefined {
  const code = safeRead(() => (error as { code?: unknown }).code);
  if (typeof code !== "string") {
    return undefined;
  }
  return ERROR_CODE_PATTERN.test(code) ? code : undefined;
}

/**
 * Read one field off a caught value without ever throwing.
 *
 * This reducer runs inside `errorResponse` and every auth wrapper's `catch`, so
 * it has to be TOTAL: a Proxy, or any thrown value with a throwing `name`,
 * `constructor`, or `code` getter, would otherwise make the attribution path
 * itself throw and replace the intended JSON 500 with a rejected handler. A
 * field that cannot be read safely is simply a field this span does not carry.
 */
function safeRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}
