/**
 * @file synthetic-model-keys.ts
 * @description Canonical synthetic ("*-default") model-attribution keys shared
 * by the harness parsers and the desktop tests that assert on them.
 *
 * A harness whose transcript carries token usage with no resolvable model id
 * attributes that usage under a synthetic `<harness>-default` key rather than
 * dropping it. `isSyntheticModelKey` (parser-utils) recognizes the `*-default`
 * convention, and the cost engine's unknown-model fallback (FEA-3546) prices a
 * `*-default` model at the Opus-standard tier so the session still yields a
 * non-zero cost instead of collapsing to $0/null.
 *
 * This module is intentionally a lightweight, dependency-free leaf (no Zod, no
 * Node built-ins) so bundle-sensitive consumers — and the desktop `test:node`
 * slice — can import the constant without pulling in a parser runtime. Keep it
 * that way. Sibling harness parsers currently inline `cursor-default` /
 * `copilot-default`; centralize those here in the same pattern if/when a second
 * owner appears (out of scope for FEA-4183, which only owns `opencode-default`).
 */

/** OpenCode's synthetic fallback model key. */
export const OpencodeDefaultModel = "opencode-default";
