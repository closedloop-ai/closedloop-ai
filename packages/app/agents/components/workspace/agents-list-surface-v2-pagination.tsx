"use client";

import { TablePagination } from "@repo/design-system/components/ui/table-pagination-v2";
import type { AgentsListSurfaceV2ViewModel } from "../../hooks/use-agents-list-surface-v2-view-model";

/**
 * `AgentsListSurfaceV2`'s paginator (ISS-9398, closing ISS-9216 for this
 * surface).
 *
 * Everything about paging is decided inside the surface: the page size
 * (`AGENTS_PAGE_SIZE`, one constant the read and this control share), the
 * visibility rule ({@link AgentsListSurfaceV2ViewModel.paginationVisible}), and
 * the footer component. No host prop reaches any of the three, so the two shells
 * cannot render different pagination for the same data — which is what ISS-9216
 * found they did on Sessions and Branches, where an optional `pageSizeOptions`,
 * a host-computed `showPagination` and a directly-imported footer each let one
 * host answer differently.
 *
 * Returns `null` rather than rendering a disabled control: there is nothing to
 * page through, so there is no affordance to show. The v2 pager (ISS-11412)
 * holds no visibility rule of its own (it stays mounted on any page count), so
 * `paginationVisible` is the only thing that decides.
 */
export function AgentsListSurfaceV2Pagination({
  model,
}: {
  model: AgentsListSurfaceV2ViewModel;
}) {
  if (!model.paginationVisible) {
    return null;
  }
  return (
    <TablePagination
      className="px-4 py-3"
      onPageChange={model.onPageChange}
      page={model.page}
      totalPages={model.totalPages}
    />
  );
}
