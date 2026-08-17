import { BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES } from "./branch-analytics-cohort.ts";

/** Builds unique, individually valid branch IDs whose request is one byte over budget. */
export function makeOversizedBranchIds() {
  const ids = Array.from({ length: 129 }, (_, index) => `${index}-`);
  const baseBytes = new TextEncoder().encode(
    JSON.stringify({ branchIds: ids })
  ).byteLength;
  let remainingBytes =
    BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES + 1 - baseBytes;
  for (const [index, id] of ids.entries()) {
    const addedBytes = Math.min(remainingBytes, 512 - id.length);
    ids[index] = `${id}${"x".repeat(addedBytes)}`;
    remainingBytes -= addedBytes;
    if (remainingBytes === 0) {
      break;
    }
  }
  return ids;
}
