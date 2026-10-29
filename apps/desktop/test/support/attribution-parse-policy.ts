/**
 * ISS-12552 (PRD-800 "Rollout"): imported first by a suite that exercises
 * what Desktop does with the attribution parse policy on, which a process that
 * nothing sets does not have, with owners already derived under it. Each suite
 * runs in its own process (`isolate`), so this reaches no other file. A case that needs the policy off sets it with
 * {@link withParsePolicy}, which restores this default afterwards.
 */
import { beginAttributionOwnersRebuild } from "../../src/main/parse-policy/attribution-owners-derived.js";
import {
  effectiveParsePolicy,
  setEffectiveParsePolicy,
} from "../../src/main/parse-policy/effective-parse-policy.js";
import {
  PARSE_POLICY_ATTRIBUTION,
  type ParsePolicy,
} from "../../src/main/parse-policy/parse-policy.js";

setEffectiveParsePolicy(PARSE_POLICY_ATTRIBUTION);
// As if this process's rebuild had completed under it, so owners are synced.
beginAttributionOwnersRebuild()();

export async function withParsePolicy<T>(
  policy: ParsePolicy,
  run: () => Promise<T> | T
): Promise<T> {
  const previous = effectiveParsePolicy();
  setEffectiveParsePolicy(policy);
  try {
    return await run();
  } finally {
    setEffectiveParsePolicy(previous);
  }
}
