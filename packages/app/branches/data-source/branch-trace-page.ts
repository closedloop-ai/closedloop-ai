import { BranchViewerScope } from "@repo/api/src/types/branch";
import { normalizeBranchTracePage } from "@repo/api/src/types/branch-trace";
import {
  BranchTracePageMode,
  type BranchTracePageResult,
  branchTracePagingSchema,
} from "@repo/api/src/types/branch-trace-paging";
import { ApiError } from "../../shared/api/api-error";
import type {
  BranchesDataSource,
  BranchTracePageOptions,
} from "./branches-data-source";

export async function readBranchTracePage(
  get: <T>(path: string, options?: RequestInit) => Promise<T>,
  complete: BranchesDataSource["trace"],
  id: string,
  options?: BranchTracePageOptions
): Promise<BranchTracePageResult> {
  const params = new URLSearchParams({
    pageMode: BranchTracePageMode.Cursor,
    limit: "100",
  });
  if (options?.cursor) {
    params.set("cursor", options.cursor);
  }
  let raw: unknown;
  try {
    raw = await get<unknown>(
      `/branches/${encodeURIComponent(id)}/trace?${params}`,
      {
        signal: options?.signal,
      }
    );
  } catch (error) {
    options?.signal?.throwIfAborted();
    if (!options?.cursor && error instanceof ApiError && error.status === 400) {
      return complete(id, options);
    }
    throw error;
  }
  const page = normalizeBranchTracePage(raw);
  const paging = branchTracePagingSchema.safeParse(raw);
  if (
    !(page && paging.success) ||
    page.branchId !== id ||
    page.viewerScope !== BranchViewerScope.Organization ||
    page.metadataReason ||
    !page.traceState
  ) {
    if (!options?.cursor) {
      return complete(id, options);
    }
    throw new Error("Failed to fetch branch trace");
  }
  if (
    page.hasMore !== Boolean(paging.data.nextCursor) ||
    (page.hasMore && page.items.length === 0) ||
    !(options?.cursor || paging.data.overviewItems)
  ) {
    if (!options?.cursor) {
      return complete(id, options);
    }
    throw new Error("Failed to fetch branch trace");
  }
  return { ...page.traceState, items: page.items, ...paging.data };
}
