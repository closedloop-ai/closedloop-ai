/**
 * ISS-5303 — the pure decision logic behind `scripts/fea3597-identity-probe.mts`.
 *
 * The probe itself is a top-level-await script: importing it PARSES the whole
 * golden corpus, prints a table, and can `process.exit(1)`. Nothing in it is
 * reachable from a test. This module is the half that is: no I/O, no console,
 * no module-scope mutable state, nothing that runs on import. The probe keeps
 * the corpus walk, the tallies, and the exit codes.
 */

/** The PRE-FEA-3597 human/agent split, per session metadata. */
export type OldRuleCounts = {
  human: number;
  agent: number;
};

/**
 * Reference agent-unit counts from the FEA-3597 operator ruling, keyed by the
 * first 8 characters of the dossier's session id. Only the dossiers the ruling
 * actually names appear here; every other dossier is unflagged.
 */
export const RULING_AGENT_COUNTS: Readonly<Record<string, number>> =
  Object.freeze({
    b50de790: 82,
    "3b820c31": 65,
    "019ea892": 25,
  });

/** One dossier's ruling verdict: the row suffix, plus whether it disagreed. */
export type RulingFlag = {
  /** Suffix appended to the probe's table row. Empty when unflagged. */
  label: string;
  /** True only when the ruling names this dossier AND the count disagrees. */
  mismatch: boolean;
};

/**
 * The PRE-FEA-3597 rule, kept verbatim so the probe compares against a real
 * oracle rather than a paraphrase of one.
 *
 * A "headless" session (SDK entrypoint, an exec-style entrypoint, or
 * `bypassPermissions`) has no human at the keyboard, so its `human` messages
 * are counted as agent turns. Messages that are not objects, carry neither the
 * `human` nor the `assistant` role, or lack a usable timestamp are skipped —
 * this reads a JSON round-trip of stored metadata TEXT, so every field is
 * genuinely `unknown` and malformed shapes are reachable.
 */
export function oldRule(meta: Record<string, unknown>): OldRuleCounts {
  const messages = Array.isArray(meta.messages) ? meta.messages : [];
  const entrypoint =
    typeof meta.entrypoint === "string" ? meta.entrypoint.toLowerCase() : "";
  const permissionMode =
    typeof meta.permissionMode === "string" ? meta.permissionMode : "";
  const headless =
    entrypoint.startsWith("sdk-") ||
    entrypoint.includes("exec") ||
    permissionMode === "bypassPermissions";
  let human = 0;
  let agent = 0;
  for (const el of messages) {
    if (typeof el !== "object" || el === null || Array.isArray(el)) {
      continue;
    }
    const { role, timestamp } = el as { role?: unknown; timestamp?: unknown };
    if (role !== "human" && role !== "assistant") {
      continue;
    }
    if (typeof timestamp !== "string" && typeof timestamp !== "number") {
      continue;
    }
    if (role === "human" && !headless) {
      human += 1;
    } else {
      agent += 1;
    }
  }
  return { human, agent };
}

/**
 * Check one dossier's new agent count against the operator ruling.
 *
 * Returns the mismatch as data rather than incrementing a counter: the probe
 * owns its tallies, and a lib that mutated module state on call could not be
 * driven twice from one test process.
 *
 * `Object.hasOwn` rather than a bare index read — the short id is derived from
 * data, and an inherited `Object.prototype` key must not resolve to a
 * "expectation" that no ruling ever made.
 */
export function rulingFlag(
  shortId: string,
  newAgent: number,
  expectedByShortId: Readonly<Record<string, number>> = RULING_AGENT_COUNTS
): RulingFlag {
  if (!Object.hasOwn(expectedByShortId, shortId)) {
    return { label: "", mismatch: false };
  }
  const expected = expectedByShortId[shortId];
  if (expected === undefined) {
    return { label: "", mismatch: false };
  }
  if (expected === newAgent) {
    return { label: `  ✓ ruling ${expected}`, mismatch: false };
  }
  return { label: `  ✗ ruling expected ${expected} — FAIL`, mismatch: true };
}
