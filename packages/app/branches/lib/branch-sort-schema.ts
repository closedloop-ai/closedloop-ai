import { z } from "zod";
import { persistedEnumValues } from "../../shared/lib/view-state-axes";
import { normalizeStoredBranchSortKey } from "./branch-column-renames";
import {
  DEFAULT_BRANCH_SORT_DIR,
  DEFAULT_BRANCH_SORT_KEY,
  BranchSortDir as SortDir,
  BranchSortKey as SortKey,
} from "./branch-sort-group";

/**
 * How a STORED Branches sort pair degrades, for both persisted stores.
 *
 * The live view (`branch-saved-view.ts`) and the named-view collection
 * (`branch-saved-views.ts`) are siblings that must not drift, and this chain is
 * a design decision rather than a shape: the rename alias runs in FRONT of the
 * closed enum so a renamed sortable column resolves to the column the reader
 * chose, and the fallback sits behind it so a value this build cannot spell
 * degrades to the default sort instead of failing the whole object parse and
 * costing the reader their columns, window and grouping too.
 *
 * Shared here for the same reason the two stores already share
 * `PERSISTED_STRING_ARRAY_SCHEMA`: written out twice, a later change to the
 * fallback value or to the alias ordering has to be made by hand in two files
 * and can silently be made in only one.
 *
 * Its own module rather than an export of `branch-column-renames.ts` so the
 * alias stays a plain function there and this stays the composed schema — and
 * so the alias is still resolved through a module boundary, which is what lets
 * the rename-wiring suite fabricate a rename and watch it reach both stores.
 */
export const BRANCH_STORED_SORT_KEY_SCHEMA = z
  .preprocess(
    normalizeStoredBranchSortKey,
    z.enum(persistedEnumValues(SortKey))
  )
  .catch(DEFAULT_BRANCH_SORT_KEY)
  .default(DEFAULT_BRANCH_SORT_KEY);

/** The direction half of the same pair: closed enum, then the same fallback. */
export const BRANCH_STORED_SORT_DIR_SCHEMA = z
  .enum(persistedEnumValues(SortDir))
  .catch(DEFAULT_BRANCH_SORT_DIR)
  .default(DEFAULT_BRANCH_SORT_DIR);
