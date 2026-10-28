import type { DocumentsIndexPagination } from "@repo/app/documents/components/documents-index-pagination";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import type { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";

/**
 * Everything a Documents index body needs to render, and nothing about which
 * body is rendering.
 *
 * Shared by both bodies on purpose (ISS-8940): the container fetches once and
 * hands the SAME raw read to whichever body the flag selects, so neither body
 * can be handed a value the other could not have been handed. Deliberately
 * carries no flag boolean — a body that could ask which one it is would start
 * branching inside its own derivations, which is exactly the threading the
 * Sessions v2 rollout paid for.
 *
 * {@link DocumentsIndexBodyProps.searchAppliedUpstream} is not that boolean
 * (ISS-9762). It describes the ROWS — whether they arrived already searched —
 * and is false for a blank term and for a term held back from the wire even
 * with server search switched on, so it cannot stand in for "which body am I".
 */
export type DocumentsIndexBodyProps = {
  documents: DocumentRowData[];
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  refetch: () => void;
  filterText: string;
  /** Whether `documents` already had `filterText` applied to it by the server. */
  searchAppliedUpstream: boolean;
  editHandlers: RowEditHandlers;
  onDelete: (item: DocumentRowItem) => Promise<boolean>;
  onReorderColumns: (nextVisibleOrder: string[]) => void;
  visibleColumns: DocumentColumn[];
  setScrollContainer: (element: HTMLElement | null) => void;
  /**
   * ISS-9726: resolved by the container, not read from
   * `documents-index-keys.ts` here. Those literals are now BASE keys that the
   * organization namespace is applied to, and a body resolving them itself
   * would address the un-namespaced key while the container addressed the
   * namespaced one. `null` means "hold it in memory" — the organization has
   * not resolved yet.
   */
  sortPersistenceKey: string | null;
  storageKey: string | null;
  /**
   * ISS-9157: present only when the container read ONE server page. The body
   * renders the pager from it on its table branch and nowhere else, so the
   * strip can never state a total over an error or an empty state — the body
   * is the module that classifies those, and it owns that decision once.
   */
  pagination?: DocumentsIndexPagination;
  /**
   * ISS-9157: `DocumentsView`'s paged-caller signal — whether rows exist behind
   * the page it was handed. The container derives it from the envelope's
   * `total`, which is counted AFTER the server search; that is safe here only
   * because both bodies classify a settled, searched, empty read themselves
   * (`isNoResults` in v1, `resolveDocumentsIndexState` in v2) before the view
   * could read it as an empty corpus. `undefined` on the unbounded arm, where
   * the view derives emptiness from the rows it holds, as it always has.
   */
  hasUnpagedItems?: boolean;
};
