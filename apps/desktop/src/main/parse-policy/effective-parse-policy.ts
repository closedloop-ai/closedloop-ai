/**
 * ISS-12552 (PRD-800 "Rollout"): this process's current parse policy.
 * Process-local on purpose: main sets it from its resolver, the db host from
 * the policy main hands it at boot and on a settled flip, and a process
 * nothing sets (the historical parse worker, a test) reads the base policy,
 * which parses as Desktop did before PRD-800. Outside `collectors/` so the
 * boot graph may read it; the revision it stamps is
 * `collectors/engine/effective-data-revision.ts`.
 */
import { PARSE_POLICY_BASE, type ParsePolicy } from "./parse-policy.js";

let effective: ParsePolicy = PARSE_POLICY_BASE;

export function effectiveParsePolicy(): ParsePolicy {
  return effective;
}

export function setEffectiveParsePolicy(policy: ParsePolicy): void {
  effective = policy;
}
