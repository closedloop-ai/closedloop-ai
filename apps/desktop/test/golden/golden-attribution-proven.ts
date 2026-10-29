/**
 * ISS-12552 (PRD-800 version 28 "Proving usage", version id
 * 01a15b24-f666-747b-8411-3c903c77793b, updatedAt 2026-10-20T21:08:31.475Z):
 * the proven tokens a signed
 * attribution block implies under the pinned policy, derived from its signed
 * request facts rather than signed as totals. Stated here from the ruling, not
 * imported from the code under test, so the oracle cannot inherit its bugs:
 * a request's usage is proven for an artifact when the request's receipted,
 * committed creations and revisions, and the implementation joins that name
 * it (the write-to-commit join), name that artifact and no other. A request
 * with no receipted write and no captured file write proves nothing.
 */
import { AttributionRelationshipKind } from "@repo/api/src/types/attribution-evidence";
import type { AttributionBlock } from "./golden-attribution-facts.js";

type TargetIdentity = { slug?: string; uuid?: string };

const RECEIPTED_WRITES: ReadonlySet<string> = new Set([
  AttributionRelationshipKind.Creation,
  AttributionRelationshipKind.Revision,
]);

/** Proven tokens per artifact id, from the block's request facts. */
export function receiptProvenTokens(
  block: AttributionBlock | undefined,
  idOf: (target: TargetIdentity | undefined) => string | undefined
): Map<string, number> {
  const tokensByRequest = requestTokens(block);
  const proven = new Map<string, number>();
  for (const [request, ids] of namedByRequest(block, idOf)) {
    const [only] = ids;
    if (ids.size === 1 && only !== undefined) {
      proven.set(
        only,
        (proven.get(only) ?? 0) + (tokensByRequest.get(request) ?? 0)
      );
    }
  }
  return proven;
}

function requestTokens(
  block: AttributionBlock | undefined
): Map<string, number> {
  const usage = Array.isArray(block?.usage) ? block.usage : [];
  const tokensByRequest = new Map<string, number>();
  for (const entry of usage) {
    tokensByRequest.set(
      entry.request_id,
      (tokensByRequest.get(entry.request_id) ?? 0) + entry.tokens
    );
  }
  return tokensByRequest;
}

/** The artifacts each request's receipted writes and implementation joins name. */
function namedByRequest(
  block: AttributionBlock | undefined,
  idOf: (target: TargetIdentity | undefined) => string | undefined
): Map<string, Set<string>> {
  const named = new Map<string, Set<string>>();
  const add = (request: string, id: string | undefined) => {
    if (id) {
      named.set(request, (named.get(request) ?? new Set()).add(id));
    }
  };
  const operations = Array.isArray(block?.operations) ? block.operations : [];
  for (const op of operations) {
    if (
      op.request_id !== undefined &&
      op.operation_id !== undefined &&
      op.committed &&
      RECEIPTED_WRITES.has(op.relationship)
    ) {
      add(op.request_id, idOf(op.target));
    }
  }
  const joins = Array.isArray(block?.implementation_joins)
    ? block.implementation_joins
    : [];
  for (const join of joins) {
    for (const request of join.request_ids) {
      add(request, idOf(join.recipient));
    }
  }
  return named;
}
