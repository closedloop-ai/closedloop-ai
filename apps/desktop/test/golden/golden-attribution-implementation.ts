/**
 * ISS-12552 (PRD-800 "Proving usage"): the write-to-commit join the
 * production chain computes for a dossier, in the signed block's own request
 * ids, beside the joins the block signs. Shared by the implementation-join
 * check and the accuracy report.
 *
 * Production: `extractOperationClaims` runs `implementationRequestsByBranch`
 * over the session's file writes and commits and emits one
 * `implementationJoin` claim per branch with request keys. Those keys are
 * mapped to the block's `request_id` through its usage rows: a Claude row's
 * transcript entry uuids, a Codex row's response id.
 */
import { OperationClaimSource } from "@repo/api/src/types/operation-claims";
import { extractOperationClaims } from "@repo/lib/attribution/extract-operation-claims";
import { codexResponseIdScheme } from "@repo/lib/harness/codex/codex-request-binding";
import { requestKeyFor } from "@repo/lib/harness/request-key";
import { Harness, type NormalizedSession } from "@repo/lib/harness/types";
import { claudeTranscriptEntryUuidScheme } from "@repo/lib/harness/usage-dedup";
import type { AttributionBlock } from "./golden-attribution-facts.js";

/** Request ids per branch name. */
export type BranchJoins = Map<string, Set<string>>;

export async function producedImplementationJoins(
  block: AttributionBlock,
  session: NormalizedSession,
  harness: Harness
): Promise<BranchJoins> {
  const requestOfKey = requestIdsByKey(block, harness);
  const { claims } = await extractOperationClaims(session, harness);
  const joins: BranchJoins = new Map();
  for (const claim of claims) {
    if (
      claim.source !== OperationClaimSource.ImplementationJoin ||
      !claim.branch
    ) {
      continue;
    }
    const requests = joins.get(claim.branch) ?? new Set<string>();
    for (const key of claim.requestKeys ?? []) {
      requests.add(requestOfKey.get(key) ?? key);
    }
    joins.set(claim.branch, requests);
  }
  return joins;
}

/** The joins the block signs, by branch name. */
export function signedImplementationJoins(
  block: AttributionBlock
): BranchJoins {
  const joins: BranchJoins = new Map();
  for (const join of Array.isArray(block.implementation_joins)
    ? block.implementation_joins
    : []) {
    const branch = join.recipient.slug;
    if (branch) {
      joins.set(
        branch,
        new Set([...(joins.get(branch) ?? []), ...join.request_ids])
      );
    }
  }
  return joins;
}

/** Joined (branch, request) pairs found, missed and extra. */
export function joinAgreement(
  signed: BranchJoins,
  produced: BranchJoins
): { matched: number; missed: number; extra: number } {
  const pairs = (joins: BranchJoins) =>
    new Set(
      [...joins].flatMap(([branch, requests]) =>
        [...requests].map((request) => `${branch}\u0000${request}`)
      )
    );
  const want = pairs(signed);
  const got = pairs(produced);
  const matched = [...want].filter((pair) => got.has(pair)).length;
  return { matched, missed: want.size - matched, extra: got.size - matched };
}

function requestIdsByKey(
  block: AttributionBlock,
  harness: Harness
): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const row of Array.isArray(block.usage) ? block.usage : []) {
    if (harness === Harness.Codex) {
      byKey.set(
        requestKeyFor(codexResponseIdScheme, row.request_id),
        row.request_id
      );
      continue;
    }
    for (const id of row.source_usage_ids) {
      byKey.set(
        requestKeyFor(claudeTranscriptEntryUuidScheme, id),
        row.request_id
      );
    }
  }
  return byKey;
}
