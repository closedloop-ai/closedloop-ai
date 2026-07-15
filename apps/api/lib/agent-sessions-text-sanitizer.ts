/**
 * @file agent-sessions-text-sanitizer.ts
 * @description Strip text that Postgres cannot store from synced agent-session
 * payloads before they reach the database (FEA-2258).
 *
 * Two character classes deterministically break the `upsertSessions`
 * transaction, which the handler reports to the desktop as an opaque
 * `ingestion_failed` (and the desktop dead-letters after five identical
 * retries):
 *
 *  - U+0000 (NUL): illegal in Postgres `text` columns and rejected by `jsonb`
 *    ("unsupported Unicode escape sequence ... cannot be converted to text").
 *    Agent tool/terminal output regularly contains NULs.
 *  - Lone UTF-16 surrogates (a high surrogate not followed by a low one, or a
 *    low surrogate not preceded by a high one): rejected by `jsonb` as an
 *    invalid escape. These show up when raw binary output is decoded as text.
 *
 * NULs are removed; lone surrogates are replaced with U+FFFD (the Unicode
 * replacement character) so the rest of the content survives. Valid surrogate
 * PAIRS (real emoji/astral characters) are left untouched.
 */

// Module-level (Biome useTopLevelRegex). Matches a high surrogate NOT followed
// by a low surrogate, or a low surrogate NOT preceded by a high surrogate.
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// Built via fromCharCode so no literal NUL / replacement byte lives in source.
const NUL_CHAR = String.fromCharCode(0);
const UNICODE_REPLACEMENT_CHAR = String.fromCharCode(0xff_fd);

// Recursion bound for sanitizePostgresJson. Real agent-session JSON (event
// `data`, metadata) nests only a handful of levels; anything deeper is
// pathological — an abusive target trying to exhaust the call stack — and is
// rejected by the caller (parseDesktopAgentSessionsPayload) before any DB write
// rather than sanitized. Generous relative to realistic nesting.
const MAX_SANITIZE_JSON_DEPTH = 200;

/** Remove NULs and replace lone surrogates so a single string is Postgres-safe. */
export function sanitizePostgresText(value: string): string {
  return value
    .replaceAll(NUL_CHAR, "")
    .replace(LONE_SURROGATE_RE, UNICODE_REPLACEMENT_CHAR);
}

/**
 * Thrown by {@link sanitizePostgresJson} when a value nests deeper than
 * {@link MAX_SANITIZE_JSON_DEPTH}. The caller converts it into a payload
 * rejection so a deeply nested blob cannot exhaust the call stack on the way to
 * the database.
 */
export class PostgresJsonDepthExceededError extends Error {
  constructor() {
    super("agent_sessions_payload_nested_too_deeply");
    this.name = "PostgresJsonDepthExceededError";
  }
}

/**
 * Thrown by {@link sanitizePostgresJson} (only when `rejectKeyCollisions` is
 * enabled) if two distinct object keys collapse to the same key after
 * sanitization (e.g. `"a\0b"` and `"ab"`, or keys that differ only by a lone
 * surrogate). A plain assignment would let the later key silently overwrite the
 * earlier one, dropping a field from the persisted payload. The caller converts
 * this into a payload rejection so the desktop gets a clean validation failure
 * instead of quietly losing data.
 *
 * Collision rejection is deliberately opt-in and scoped by the caller to the
 * free-form jsonb blobs that are actually persisted (session `metadata`, event
 * `data`). Enabling it for the whole raw sync payload would reject collisions in
 * desktop-local / forward-compat fields that the schema strips before any DB
 * write — turning a non-persisted compatibility field into a spurious
 * validation failure even though no stored JSON would lose data.
 */
export class PostgresJsonKeyCollisionError extends Error {
  constructor() {
    super("agent_sessions_payload_sanitized_key_collision");
    this.name = "PostgresJsonKeyCollisionError";
  }
}

/** Options for {@link sanitizePostgresJson}. */
type SanitizePostgresJsonOptions = {
  /**
   * When true, throw {@link PostgresJsonKeyCollisionError} if two distinct
   * object keys collapse to the same sanitized key (a silent field-loss risk).
   * Off by default: only enable it for subtrees whose keys are actually
   * persisted, so a collision in a to-be-stripped field can't reject the
   * payload. See {@link PostgresJsonKeyCollisionError}.
   */
  rejectKeyCollisions?: boolean;
};

/**
 * Recursively sanitize every string (and object key) reachable from a
 * JSON-shaped value so nothing carrying a NUL or lone surrogate reaches a
 * Postgres `text`/`jsonb` column. Preserves the input's shape and type.
 *
 * Bounded to {@link MAX_SANITIZE_JSON_DEPTH} levels: a deeper value throws
 * {@link PostgresJsonDepthExceededError} instead of recursing without limit.
 *
 * When {@link SanitizePostgresJsonOptions.rejectKeyCollisions} is set, colliding
 * sanitized keys throw {@link PostgresJsonKeyCollisionError} instead of the
 * later value silently overwriting the earlier one.
 */
export function sanitizePostgresJson<T>(
  value: T,
  options?: SanitizePostgresJsonOptions
): T {
  return sanitizeJsonValue(
    value,
    0,
    options?.rejectKeyCollisions ?? false
  ) as T;
}

function sanitizeJsonValue(
  value: unknown,
  depth: number,
  rejectKeyCollisions: boolean
): unknown {
  if (typeof value === "string") {
    return sanitizePostgresText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_SANITIZE_JSON_DEPTH) {
    throw new PostgresJsonDepthExceededError();
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeJsonValue(item, depth + 1, rejectKeyCollisions)
    );
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    // Object keys land in jsonb too, so a key with a NUL would fail the same
    // way the values do.
    const safeKey = sanitizePostgresText(key);
    // Object.entries keys are already distinct, so an own-key hit here means two
    // different original keys collapsed to the same key after sanitization
    // (e.g. differing only by a NUL or lone surrogate). Reject rather than let
    // the later assignment silently overwrite the earlier field — but only when
    // the caller opted in for a subtree whose keys are actually persisted.
    if (rejectKeyCollisions && Object.hasOwn(sanitized, safeKey)) {
      throw new PostgresJsonKeyCollisionError();
    }
    const safeValue = sanitizeJsonValue(nested, depth + 1, rejectKeyCollisions);
    if (safeKey === "__proto__") {
      // A literal `__proto__` key (valid JSON from arbitrary tool output) must
      // become an OWN data property. A plain assignment would hit
      // Object.prototype's `__proto__` setter and silently drop the key,
      // losing payload shape before persistence.
      Object.defineProperty(sanitized, safeKey, {
        value: safeValue,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      sanitized[safeKey] = safeValue;
    }
  }
  return sanitized;
}
