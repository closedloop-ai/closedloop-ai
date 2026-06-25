// Scrub credential-shaped substrings (API keys, bearer tokens) before any
// coaching evidence leaves local generation. The local desktop fallback never
// ships this payload off-device, but the LLM seam is pluggable and may point at
// an external provider — so every evidence string (repeated commands AND the
// raw event summaries that feed the request) is redacted from one place.
const SECRET_PATTERNS = [
  /sk_live_[a-zA-Z0-9]+/g,
  /sk_test_[a-zA-Z0-9]+/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
];

/** Replace API keys and bearer tokens with a stable placeholder. */
export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED_SECRET]"),
    value
  );
}
