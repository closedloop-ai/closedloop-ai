import type { BranchTraceResponse } from "../../packages/api/src/types/branch-trace";
import { traceResponse } from "./branch-details-comprehensive-comments-trace";

export const tracePageCursor = `v1:${"a".repeat(64)}:60`;
export const lastPagedTraceText = "Paged trace final row";

export function createPagedTraceFixture() {
  const base = traceResponse();
  const items: BranchTraceResponse["items"] = Array.from(
    { length: 120 },
    (_, index) => ({
      type: "say",
      sessionId: "session-build",
      actorName: "Ada Lovelace",
      t: new Date(
        Date.parse("2026-08-01T10:00:00Z") + index * 1000
      ).toISOString(),
      tMs: index * 1000,
      cumCostUsd: 2,
      text: index === 119 ? lastPagedTraceText : `Paged trace row ${index + 1}`,
    })
  );
  let reads = 0;
  return {
    next(): BranchTraceResponse {
      reads += 1;
      if (reads === 1) {
        return {
          ...base,
          items: items.slice(0, 60),
          hasMore: true,
          nextCursor: tracePageCursor,
          overviewItems: items,
        };
      }
      return { ...base, items: items.slice(60), hasMore: false };
    },
    get reads() {
      return reads;
    },
  };
}
