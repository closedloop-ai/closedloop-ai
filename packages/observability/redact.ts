// ---------------------------------------------------------------------------
// Centralized redaction for structured log metadata.
//
// Every `log.info("msg", { … })` meta object is serialized — both into the
// agentless Datadog HTTP intake body and into the structured-console JSON line
// the platform log drain (Vercel → Datadog) parses into facets. Without a
// chokepoint, any caller that puts an apiKey, token, password, authorization
// header, credential, or user email in `meta` leaks it to Datadog as-is. The
// desktop-only exception-sanitizer / sanitizeDesktopTelemetryDiagnostics cover
// narrow paths and never see general logger meta.
//
// `redactLogValue` is wired into log.ts's JSON.stringify replacer, so it runs
// for every serialized meta field with no opt-in at each call site.
//
// Protected sink (AGENTS.md): this only redacts the JSON-serialized output —
// the Datadog HTTP intake body and the structured-console JSON line that the
// platform drain ships to Datadog. It does NOT touch the human-readable
// local-dev console line (that path skips JSON.stringify), which is by design
// (dev logs stay readable) but means raw meta can still appear in a developer's
// local terminal; it is not a complete source-log redactor for non-drain sinks.
//
// Two complementary rules:
//   1. Key-based — fields whose NAME signals a secret/PII (apiKey, accessToken,
//      password, authorization, cookie, email, …) have their value replaced
//      wholesale. This is the reliable control for structured meta.
//   2. Value-based — secret-shaped tokens (bearer, gh*_, sk_live/test, glpat-,
//      xox*, github_pat_) and email addresses are scrubbed out of any string
//      value, catching secrets embedded in messages, stacks, or file paths
//      even under an innocent-looking key.
// ---------------------------------------------------------------------------

const REDACTED = "[redacted]";

// Normalized key fragments whose value is inherently sensitive. The key is
// lower-cased with separators (_ - space) removed before matching, so apiKey,
// api_key, and API-KEY all collapse to "apikey". Substring (includes) matching
// catches the fragment wherever it sits in the key name — datadogApiKey,
// userAccessToken, and setCookieHeader all match — without a hand-maintained
// exact list. Every fragment is a multi-character secret/PII word that is
// vanishingly unlikely to appear inside a benign field name, so substring
// matching stays low-false-positive (the bare word "token" is handled
// separately below to spare token-count metrics).
const SENSITIVE_KEY_FRAGMENTS = [
  "apikey",
  "apisecret",
  "apitoken",
  "accesskey",
  "secretkey",
  "privatekey",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "idtoken",
  "authtoken",
  "bearertoken",
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "secret",
  "credential",
  "authorization",
  "cookie",
  "email",
] as const;

// Secret-shaped token values — mirrors the desktop exception-sanitizer's
// SECRET_VALUE_PATTERN so the two redaction paths agree on what a secret looks
// like. Global + case-insensitive so every occurrence in a string is scrubbed.
const SECRET_VALUE_RE =
  /\b(?:bearer\s+[A-Za-z0-9._~+/-]{12,}=*|github_pat_[A-Za-z0-9_]{20,}|gh[opsu]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{10,}|sk-(?:proj-)?[A-Za-z0-9_-]{6,}|sk_(?:live|test)_[A-Za-z0-9]{6,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/gi;

const EMAIL_VALUE_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

/**
 * True when the (raw) meta key names a field whose value should never be
 * shipped to Datadog. Token-count fields (inputTokens, outputTokens,
 * tokenUsage, …) are intentionally NOT matched — they are metrics, not
 * secrets — by only treating a key as a token field when it ends in the
 * singular "token" (not the plural "tokens").
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (!normalized) {
    return false;
  }
  if (normalized.endsWith("token") && !normalized.endsWith("tokens")) {
    return true;
  }
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment)
  );
}

/**
 * Scrub secret-shaped tokens and email addresses out of a free-text string,
 * leaving the rest intact (so messages/stacks stay useful).
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(SECRET_VALUE_RE, REDACTED)
    .replace(EMAIL_VALUE_RE, REDACTED);
}

/**
 * Per-key transform for a JSON.stringify replacer. Returns the value to
 * serialize after redaction. Wired into log.ts's `jsonReplacer` so it runs for
 * every field of every log meta object.
 *
 * Per AGENTS.md, a redaction marker is emitted only when there is actual
 * sensitive content: null/undefined and empty/blank strings under a sensitive
 * key pass through unchanged rather than being replaced with "[redacted]".
 */
export function redactLogValue(key: string, value: unknown): unknown {
  if (key && hasRedactableContent(value) && isSensitiveKey(key)) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  return value;
}

function hasRedactableContent(value: unknown): boolean {
  if (value == null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  return true;
}
