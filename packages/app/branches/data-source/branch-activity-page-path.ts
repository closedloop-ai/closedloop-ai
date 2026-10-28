/**
 * ISS-10980: the `GET /branches/[id]/activity` URL the HTTP Branches source
 * reads one Activity page from.
 *
 * Its own module rather than another entry in `branches-data-source.ts`, which
 * is within a few dozen lines of the 1,000-line ceiling (root `AGENTS.md` →
 * File Size and Organization).
 */

export type BranchActivityPageRequest = {
  branchId: string;
  /** The previous page's `nextCursor`; omitted for the first page. */
  cursor?: string;
  limit: number;
};

export function branchActivityPagePath(
  request: BranchActivityPageRequest
): string {
  const params = new URLSearchParams({ limit: String(request.limit) });
  if (request.cursor) {
    params.set("cursor", request.cursor);
  }
  return `/branches/${encodeURIComponent(request.branchId)}/activity?${params.toString()}`;
}
