/**
 * ISS-12552 (PRD-800 "Rollout"): the golden layers run under the
 * attribution parse policy, the one their oracles, snapshots and derived
 * fixtures were written under, unless a suite selects the base policy.
 *
 * Imported by `golden-corpus.ts`, which every golden module and regeneration
 * script reaches, so this default holds before any suite registers. A suite
 * that runs under the base policy calls {@link selectGoldenParsePolicy} at its
 * top level, which runs after every import has been evaluated.
 */
import { setEffectiveParsePolicy } from "../../src/main/parse-policy/effective-parse-policy.js";
import {
  PARSE_POLICY_ATTRIBUTION,
  type ParsePolicy,
} from "../../src/main/parse-policy/parse-policy.js";

setEffectiveParsePolicy(PARSE_POLICY_ATTRIBUTION);

export function selectGoldenParsePolicy(policy: ParsePolicy): void {
  setEffectiveParsePolicy(policy);
}
