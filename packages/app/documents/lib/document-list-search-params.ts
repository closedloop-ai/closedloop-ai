import type {
  DocumentListPageParams,
  FindDocumentsOptions,
} from "@repo/api/src/types/document";
import type { DocumentSummaryParams } from "@repo/api/src/types/document-metric-scope";

/**
 * Serialize `FindDocumentsOptions` into the `GET /documents` query string.
 * Shared by every reader of that filter vocabulary — the bare-array list, the
 * paged list, and ISS-8936's summary band — so no two can drift on how a filter
 * is spelled. A drifted spelling would silently widen one of them, and for the
 * band that means describing a population the table beneath it was never drawn
 * from.
 *
 * Its own module rather than a private helper in one reader: it was already
 * documented as shared while only that reader could import it, which is how a
 * third consumer ends up with a second copy.
 *
 * An array-valued filter is emitted as REPEATED occurrences of its key
 * (`?status=TODO&status=IN_PROGRESS`), which is the shape `apps/api/AGENTS.md`
 * requires and the one the route parses with `searchParams.getAll`. It must not
 * fall through to the scalar branch: `Array.prototype.toString()` would comma-
 * join it, and the route rejects a comma-joined value as a single unknown
 * status (tamsinb review).
 *
 * An EMPTY array emits no occurrence at all, so a UI with nothing selected
 * sends no `status` and gets the unnarrowed list. That is the same reading the
 * service layer gives an empty array in `buildDocumentStatusFilter`, and it is
 * why the boundary can still reject a blank `?status=` as malformed: "nothing
 * selected" and "a status that failed to spell itself" are no longer the same
 * request.
 *
 * `customFieldFilters` is JSON-encoded, the spelling the list route's
 * `customFieldFilters` already takes (ISS-12600 sends it to the summary).
 */
export function buildDocumentListSearchParams(
  searchParams:
    | FindDocumentsOptions
    | DocumentListPageParams
    | DocumentSummaryParams
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined) {
      continue;
    }
    if (key === "customFieldFilters") {
      params.set(key, JSON.stringify(value));
      continue;
    }
    if (key === "artifactIds" && Array.isArray(value) && value.length === 0) {
      params.set(key, "");
      continue;
    }
    if (Array.isArray(value)) {
      for (const element of value) {
        params.append(key, String(element));
      }
      continue;
    }
    params.set(key, value.toString());
  }
  return params.toString();
}
