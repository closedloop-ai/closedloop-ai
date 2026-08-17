/**
 * @file golden-layer2-fixture-targets.ts
 * @description Dossier selection for the FEA-1839 hook/import convergence
 * fixture.
 *
 * Extracted from `golden-layer2.ts` (ISS-5105), which is on the `biome.jsonc`
 * shrink-only grandfather list — so the rationale below lives here rather than
 * growing that file.
 */
import type { GoldenDossier } from "./golden-corpus.js";

/** The plain (no-subagent) claude dossier the fixture has always used. */
const PLAIN_SESSION_ID = "c8dcfab8-3de1-46ea-bf8d-84d319242759";

/**
 * The subagent-bearing claude dossier, PINNED rather than discovered.
 *
 * This used to be `find(harness === "claude" && subagents.count > 0)`, i.e. the
 * FIRST such dossier — so any corpus intake sorting ahead of it silently
 * re-targeted the fixture. That is the same "silently shrink coverage" failure
 * the fixture's own assertion warns about, arriving from the other side.
 * `3b820c31` is the dossier that predicate has always resolved to.
 *
 * The target is load-bearing, not incidental. The fixture replays a live `Stop`
 * hook over an already-imported session, and that replay rewrites `token_usage`
 * from the MAIN transcript alone. A dossier survives it only when its sidecar
 * subagents use a DIFFERENT model from the parent, because then the rewritten
 * per-model row and the subagents' rows are disjoint. Where parent and
 * subagents share ONE model, the rewrite drops the sidecar tokens from the
 * shared row — measured on the ISS-5105 dossier `00005105-…`, whose parent and
 * all four subagents are `claude-opus-4-8`: 44 → 28 input tokens after the
 * replay.
 *
 * That divergence is a real finding tracked on its own ticket. Do NOT paper
 * over it by re-pointing this fixture at whichever dossier happens to pass.
 */
const WITH_SUBAGENTS_SESSION_ID = "3b820c31-7ca8-4096-9f46-913cd580d38e";

export type HookConvergenceTargets = {
  plain: GoldenDossier | undefined;
  withSubagents: GoldenDossier | undefined;
};

/** Resolve the two dossiers the FEA-1839 fixture covers. */
export function selectHookConvergenceTargets(
  nonNull: readonly GoldenDossier[]
): HookConvergenceTargets {
  return {
    plain: nonNull.find((d) => d.sessionId === PLAIN_SESSION_ID),
    withSubagents: nonNull.find(
      (d) => d.sessionId === WITH_SUBAGENTS_SESSION_ID
    ),
  };
}

export const HOOK_CONVERGENCE_PLAIN_MISSING = `FEA-1839 fixture dossier ${PLAIN_SESSION_ID} missing`;

export const HOOK_CONVERGENCE_SUBAGENTS_MISSING = `FEA-1839 fixture requires its pinned subagent-bearing claude dossier ${WITH_SUBAGENTS_SESSION_ID} — if it was removed, pick a replacement DELIBERATELY (one whose subagents' model differs from the parent's, per this module's header), don't silently shrink coverage`;
