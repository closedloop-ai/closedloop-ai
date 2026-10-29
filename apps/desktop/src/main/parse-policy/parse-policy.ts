/**
 * ISS-12552 (PRD-800 "Rollout"): how this Desktop parses and imports
 * transcripts, as data. The `attribution-evidence-policy` flag is read in one
 * place, the main process's resolver (`parse-policy-resolver.ts`, beside this);
 * everything else receives the policy it computes: the historical parse worker
 * on each request, the db host at boot and on a settled flip, and the import
 * and rebuild invokes. With `attributionEvidence` off, Desktop parses, imports,
 * stamps revisions and syncs as it did before PRD-800.
 */
import { z } from "zod";

export type ParsePolicy = {
  readonly attributionEvidence: boolean;
};

/** The policy before any answer arrives, and the one a pre-policy peer means. */
export const PARSE_POLICY_BASE: ParsePolicy = Object.freeze({
  attributionEvidence: false,
});

export const PARSE_POLICY_ATTRIBUTION: ParsePolicy = Object.freeze({
  attributionEvidence: true,
});

/**
 * The wire shape. A plain `z.object`, never `.strict()`, so a field a later
 * build adds is stripped by an older receiver rather than failing the request.
 */
export const parsePolicySchema = z.object({
  attributionEvidence: z.boolean(),
} satisfies Record<keyof ParsePolicy, z.ZodTypeAny>);

export function parsePolicyFor(attributionEvidence: boolean): ParsePolicy {
  return attributionEvidence ? PARSE_POLICY_ATTRIBUTION : PARSE_POLICY_BASE;
}

/** A policy read off a wire or a store, with anything unreadable read as base. */
export function readParsePolicy(value: unknown): ParsePolicy {
  const parsed = parsePolicySchema.safeParse(value);
  return parsed.success
    ? parsePolicyFor(parsed.data.attributionEvidence)
    : PARSE_POLICY_BASE;
}

export function sameParsePolicy(
  left: ParsePolicy,
  right: ParsePolicy
): boolean {
  return left.attributionEvidence === right.attributionEvidence;
}

/** ISS-12552: the db-host store op main sends a settled flip through. */
export const PARSE_POLICY_SET_STORE_OP = "parsePolicy.set" as const;
