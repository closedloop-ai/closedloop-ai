/**
 * ISS-12552: the artifacts a ClosedLoop call names, read only from the
 * parameters its semantics designate. A slug elsewhere in the input is a
 * mention, never the call's target.
 */
import type { OperationClaimTarget } from "@repo/api/src/types/operation-claims";
import { buildSlugPrefixAlternation } from "@repo/api/src/types/slug-prefix";
import { z } from "zod";

const TARGET_SLUG_RE = new RegExp(
  String.raw`^(?:${buildSlugPrefixAlternation()})-\d+$`,
  "i"
);
const TARGET_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const callInputSchema = z.record(z.string(), z.unknown());

/** The slug or UUID each designated key holds, in key order. */
export function readClaimTargets(
  input: unknown,
  keys: readonly string[]
): OperationClaimTarget[] {
  const record = callInputSchema.safeParse(input).data;
  if (!record) {
    return [];
  }
  const targets: OperationClaimTarget[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (TARGET_UUID_RE.test(trimmed)) {
      targets.push({ key, uuid: trimmed.toLowerCase() });
    } else if (TARGET_SLUG_RE.test(trimmed)) {
      targets.push({ key, slug: trimmed.toUpperCase() });
    }
  }
  return targets;
}
