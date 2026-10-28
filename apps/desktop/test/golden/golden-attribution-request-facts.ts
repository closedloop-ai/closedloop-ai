/**
 * ISS-12552 (PRD-800 "Proving usage"): Layer 1 holds the signed
 * per-request facts against the parse, so the facts proven totals are derived
 * from cannot drift from what the production chain reads.
 *
 * - Each usage row's `tokens` equals the parsed usage record's tokens.
 * - A Codex row's `request_id` is the response id the parsed record names
 *   (`requestKeyFor(codexResponseIdScheme, request_id)`).
 * - One `request_id` names one parsed usage record.
 * - An operation's `request_id` names the usage row whose parsed record holds
 *   the request key the production claim carries.
 */
import { codexResponseIdScheme } from "@repo/lib/harness/codex/codex-request-binding";
import { requestKeyFor } from "@repo/lib/harness/request-key";
import { Harness } from "@repo/lib/harness/types";
import { z } from "zod";
import type { AttributionBlock } from "./golden-attribution-facts.js";

/** One parsed usage record as Layer 1 compares it. */
export type ActualUsageRow = {
  key: string;
  tokens: number;
  requestKeys: readonly string[];
};

/** The production operation fields this comparison reads. */
type ProducedOperation = {
  providerId: string;
  evidence: { anchors: unknown };
};

type UsageRow = Extract<
  NonNullable<AttributionBlock["usage"]>,
  readonly unknown[]
>[number];

export function requestFactFailures(
  block: AttributionBlock,
  actual: readonly ActualUsageRow[],
  operations: readonly ProducedOperation[],
  harness: Harness,
  usageKeyOf: (row: UsageRow) => string
): string[] {
  const rows = Array.isArray(block.usage) ? block.usage : [];
  const byKey = new Map(actual.map((row) => [row.key, row]));
  const failures: string[] = [];
  const keysByRequest = new Map<string, Set<string>>();
  const recordsByRequest = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = usageKeyOf(row);
    const parsed = byKey.get(key);
    if (!parsed) {
      continue;
    }
    if (parsed.tokens !== row.tokens) {
      failures.push(
        `usage[${key}].tokens expected ${row.tokens}, got ${parsed.tokens}`
      );
    }
    if (
      harness === Harness.Codex &&
      !parsed.requestKeys.includes(
        requestKeyFor(codexResponseIdScheme, row.request_id)
      )
    ) {
      failures.push(
        `usage[${key}].request_id ${row.request_id} is not the parsed record's response id`
      );
    }
    keysByRequest.set(
      row.request_id,
      new Set([
        ...(keysByRequest.get(row.request_id) ?? []),
        ...parsed.requestKeys,
      ])
    );
    recordsByRequest.set(
      row.request_id,
      (recordsByRequest.get(row.request_id) ?? new Set()).add(parsed.key)
    );
  }
  for (const [request, records] of recordsByRequest) {
    if (records.size > 1) {
      failures.push(
        `usage request_id ${request} names ${records.size} parsed usage records`
      );
    }
  }
  return [
    ...failures,
    ...operationRequestFailures(block, operations, keysByRequest),
  ];
}

function operationRequestFailures(
  block: AttributionBlock,
  operations: readonly ProducedOperation[],
  keysByRequest: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  const expected = Array.isArray(block.operations) ? block.operations : [];
  const producedKey = new Map(
    operations.map((op) => [op.providerId, requestKeyOf(op.evidence.anchors)])
  );
  const failures: string[] = [];
  for (const op of expected) {
    const key = producedKey.get(op.provider_id);
    if (key === undefined) {
      continue;
    }
    if (!keysByRequest.get(op.request_id)?.has(key)) {
      failures.push(
        `operations[${op.provider_id}].request_id ${op.request_id} does not hold the claim's request ${key}`
      );
    }
  }
  return failures;
}

const requestAnchorSchema = z.object({ requestKey: z.string().min(1) }).loose();

function requestKeyOf(anchors: unknown): string | undefined {
  return requestAnchorSchema.safeParse(anchors).data?.requestKey;
}
