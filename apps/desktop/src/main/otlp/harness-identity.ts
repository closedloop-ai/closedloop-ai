/**
 * Which harness a set of OTLP identity-bearing values belongs to.
 *
 * Extracted from `otlp-http-receiver.ts` so the receiver (which classifies a
 * whole export) and the Claude normalizer (which must classify EACH resource
 * container — ISS-7352 review, cross-attribution) share one definition of what
 * "this is Claude Code" means. Two copies would drift into two answers for the
 * same bytes.
 */

/**
 * The lowercased values a harness can stamp its identity on: resource-attribute
 * keys AND their stringified values, plus any metric/span names in scope.
 *
 * Keys are included because a producer can identify itself with a namespaced
 * key whose value is opaque.
 */
export function otlpIdentityValues(input: {
  resourceAttributes?: Record<string, unknown>[];
  names?: string[];
}): string[] {
  const values: string[] = [];
  for (const name of input.names ?? []) {
    values.push(name);
  }
  for (const attributes of input.resourceAttributes ?? []) {
    for (const [key, value] of Object.entries(attributes)) {
      values.push(key, String(value));
    }
  }
  return values.map((value) => value.toLowerCase());
}

export function identifiesClaude(values: string[]): boolean {
  return values.some(isClaudeIdentifier);
}

export function identifiesCodex(values: string[]): boolean {
  return values.some(isCodexIdentifier);
}

function isClaudeIdentifier(value: string): boolean {
  return (
    value === "claude-code" ||
    value === "claude_code" ||
    value.startsWith("claude-code.") ||
    value.startsWith("claude_code.")
  );
}

function isCodexIdentifier(value: string): boolean {
  // The Codex product family stamps its identity with a "codex-"/"codex_"
  // prefix (e.g. service.name "codex-cli", "codex-app-server"; scope
  // "codex_otel.log_only"). Anchoring at the start — rather than a substring
  // match — keeps incidental names like "my_codex_cli_helper" unclassified.
  return (
    value === "codex" ||
    value.startsWith("codex-") ||
    value.startsWith("codex_")
  );
}
