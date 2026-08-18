/**
 * Tolerance profile for the PRD-538 R3 golden cost oracle.
 *
 * Deliberately a standalone, dependency-light module: `golden-cost-oracle.ts`
 * pulls in the claude/codex/opencode parsers, `node:sqlite`, `yaml`, and `zod`
 * through `golden-corpus.ts`, and `usage-reconciliation.test.ts` — a pure unit
 * suite over `reconcileSessionCost` — needs the constant without any of that.
 */
import type { ReconciliationTolerance } from "../../src/main/cost/usage-reconciliation.js";

/**
 * Tolerance for the CORPUS-ANCHORED comparison only.
 *
 * The runtime profile (`HARNESS_RECONCILIATION_TOLERANCE`: max($0.01, 2%)) is
 * calibrated for a genuinely asymmetric comparison — Claude Code's total
 * includes auxiliary API calls that never reach the transcript, so a correct
 * derived number legitimately sits slightly below it. NONE of that applies to
 * the corpus comparison. Both sides there are priced by the SAME engine from
 * token counts of the SAME session, so the only difference physics permits is
 * IEEE-754 summation order.
 *
 * Reusing the 2% band here would be the muted-oracle failure PRD-538 warns
 * about: on the corpus's $60.95 dossier (b50de790) it would swallow a $1.20
 * regression without a word.
 *
 * The value is measured, not guessed. Across all 22 priced dossiers the
 * observed |delta| is exactly 0 on 21 of them and 3.55e-15 USD on one
 * (3b820c31, a $30.95 session — one unit in the last place, 2^-48). $1e-9 sits
 * ~5 orders of magnitude above that noise floor and ~7 orders below a single
 * cent, so it can neither false-positive on float noise nor mask a cost
 * regression anyone would care about. `relative: 0` because a proportional
 * band has no justification when the expected delta is zero.
 */
export const CORPUS_ORACLE_TOLERANCE: ReconciliationTolerance = {
  absoluteUsd: 1e-9,
  relative: 0,
};
