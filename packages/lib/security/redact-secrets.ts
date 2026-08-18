/**
 * @file redact-secrets.ts
 * @description FEAT 019f881c-99f3 ([Security] Redact easily-identifiable secrets
 * in session transcripts). Single source of truth for pattern-based secret
 * redaction, shared by BOTH the desktop sync producer
 * (`apps/desktop/src/main/agent-sync/agent-session-sync-payload.ts`
 * `compactSessionMetadataForSync`) and the server-side persist sanitizer
 * (`apps/api/app/agent-sessions/service/metadata-sanitizer.ts`
 * `sanitizeMetadataForPersist`).
 *
 * A live `sk_live_…` API key was rendered UNREDACTED in a session transcript.
 * The `metadata.messages[].text` preview is the DISPLAY source for the branch
 * merged trace and session-detail timeline (`agent-session-detail-projection.ts`
 * `metadataMessages()` → `messageToTimelineEvent` `detail`), and it is the one
 * place conversation text still crosses to the cloud DB and UI. Redacting here —
 * at the SAME normalization boundary that already length-caps that preview —
 * guarantees a recognizable secret never persists to server storage nor reaches
 * the UI, on both the desktop-capture and non-desktop (direct API / MCP / test
 * harness) lanes. Extracting the pattern list + redactor into this one module is
 * what keeps the two lanes from drifting.
 *
 * Design constraints:
 * - Redact by matching real secret PREFIXES/SHAPES + a length/entropy guard, so
 *   ordinary prose (any word with an underscore, a short `sk-` fragment, a bare
 *   `Bearer` with no token) is never touched. See `redactSecrets` guards.
 * - Replace each secret span with a stable, byte-free marker of the form
 *   `[REDACTED:<label>]` (e.g. `[REDACTED:sk_live]`). The marker preserves the
 *   KIND of secret so a redaction is recognizable without leaking any bytes.
 * - Browser-safe (no `node:*` / `Buffer` / `process`) so it typechecks under the
 *   `@repo/lib` `types: []` guard and runs identically on desktop and cloud.
 * - Hot sync path: all patterns are module-level pre-compiled regexes and
 *   `redactSecrets` is a single `String.prototype.replace` pass per pattern with
 *   no allocation when the input is clean (early `SECRET_PRETEST` bail).
 */

/** Redaction marker for a secret of the given label — no secret bytes leak. */
function marker(label: string): string {
  return `[REDACTED:${label}]`;
}

type SecretPattern = {
  /** Compiled matcher. MUST be global (`g`) for `replace`-all semantics. */
  readonly regex: RegExp;
  /**
   * Produce the replacement for a single match. Receives the full match and any
   * capture groups so a pattern can preserve a non-secret prefix (e.g. keep the
   * `Authorization:` header name, redact only its value).
   */
  readonly replace: (match: string, ...groups: string[]) => string;
};

/**
 * The `[a-z]` in `sk-`/`sk_` etc. is intentionally case-INSENSITIVE only where
 * the real token grammar allows it; provider tokens (`sk_live_`, `ghp_`, `AKIA`)
 * are matched at their documented casing to avoid catching prose. Character
 * classes use the base64url / token alphabet the providers actually emit.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  // Stripe-style keyed secrets: sk_live_, sk_test_, rk_live_, pk_live_,
  // pk_test_. `pk_` publishable keys are technically public, but the AC lists
  // pk_live_ and redacting them is harmless. Require >= 8 chars of key body so
  // `pk_test_` alone in prose (rare) still needs a real-looking body to match.
  // The captured `<prefix>_<live|test>` becomes the label (e.g. `sk_live`).
  {
    regex: /\b((?:sk|rk|pk)_(?:live|test))_[A-Za-z0-9]{8,}/g,
    replace: (_match, label: string) => marker(label),
  },
  // Stripe webhook signing secret: whsec_<body>. Single-underscore prefix, so
  // it is matched separately from the two-underscore keyed secrets above.
  {
    regex: /\bwhsec_[A-Za-z0-9]{8,}/g,
    replace: () => marker("whsec"),
  },
  // GitHub tokens: ghp_ (PAT), gho_ (OAuth), ghu_ (user-to-server),
  // ghs_ (server-to-server), ghr_ (refresh). 36+ base62 chars in the real
  // format; require >= 20 to stay well clear of prose while tolerating variants.
  {
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    replace: (match) => marker(match.slice(0, 3)),
  },
  // GitHub fine-grained PAT: github_pat_<22>_<59>.
  {
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replace: () => marker("github_pat"),
  },
  // AWS access key id: AKIA / ASIA + 16 uppercase-alphanumeric.
  {
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replace: () => marker("aws_akia"),
  },
  // Google API key: AIza + 35 url-safe chars.
  {
    regex: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    replace: () => marker("google_api_key"),
  },
  // Slack token: xox[baprs]-<digits/hex ...>.
  {
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    replace: () => marker("slack_token"),
  },
  // Anthropic + OpenAI long high-entropy API keys: sk-ant-… and sk-…. Anchor
  // the sk-ant- variant first so its more specific label wins. Require a long,
  // high-entropy body (>= 32 token chars) so a short `sk-foo` in prose or a
  // kebab-case identifier like `sk-config-value` is NOT redacted.
  {
    regex: /\bsk-ant-[A-Za-z0-9_-]{32,}/g,
    replace: () => marker("sk-ant"),
  },
  {
    regex: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,}/g,
    replace: () => marker("sk-openai"),
  },
  {
    regex: /\bsk-[A-Za-z0-9]{32,}/g,
    replace: () => marker("sk"),
  },
  // Bearer <token> and `Authorization: <scheme> <token>` header values. Keep the
  // header name / scheme, redact only the credential. Require a real token body
  // (>= 16 non-space chars) so a bare "Bearer" or "Authorization:" with no
  // credential — or a sentence like "the Authorization: pending" — is left as
  // prose. Case-insensitive on the scheme word only.
  {
    regex: /\b(Authorization\s*:\s*)([A-Za-z]+\s+)?([A-Za-z0-9._~+/=-]{16,})/gi,
    // `scheme` is an optional capture group — it is `undefined` at runtime when
    // the header carries a bare credential with no scheme word. The `replace`
    // contract types it `string`, so coerce with `|| ""`.
    replace: (_match, header: string, scheme: string) =>
      `${header}${scheme || ""}${marker("authorization")}`,
  },
  {
    // Case-insensitive on the scheme word (`Bearer` / `bearer`) — HTTP header
    // dumps and curl `-H` args commonly emit it lowercase, and the standalone
    // `Bearer <token>` form must redact regardless of casing (the
    // `Authorization:` pattern above is already `i` for the same reason). The
    // captured scheme keeps its ORIGINAL casing in the output.
    regex: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi,
    replace: (_match, scheme: string) => `${scheme}${marker("bearer")}`,
  },
];

/**
 * Cheap pre-test: a single combined regex of the cheapest anchors. When it does
 * NOT match, the input has no secret-shaped substring and we return it
 * unchanged without running the full pattern loop — keeping the hot sync path
 * allocation-free for the overwhelmingly common clean message.
 */
const SECRET_PRETEST =
  /(?:sk|rk|pk)_(?:live|test)_|whsec_|gh[pousr]_|github_pat_|AKIA|ASIA|AIza|xox[baprs]-|sk-[A-Za-z0-9]|Bearer\s|Authorization\s*:/i;

/**
 * Redact recognizable secrets from a single string, replacing each with a
 * shape-preserving `[REDACTED:<label>]` marker. Returns the input unchanged when
 * it contains no secret-shaped substring (the common case). Non-string / empty
 * input is returned as-is. Idempotent: re-running over already-redacted text is a
 * no-op (markers contain no secret-shaped substrings).
 */
export function redactSecrets(value: string): string {
  if (!(value && SECRET_PRETEST.test(value))) {
    return value;
  }
  let out = value;
  for (const { regex, replace } of SECRET_PATTERNS) {
    // regex is stateful (global flag) — reset before reuse across calls.
    regex.lastIndex = 0;
    out = out.replace(
      regex,
      replace as (substring: string, ...args: unknown[]) => string
    );
  }
  return out;
}
