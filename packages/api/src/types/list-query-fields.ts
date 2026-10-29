// ISS-9476: the field ids a list query expression may name, one const object
// per list, and the canonical rank consts a semantic sort orders by.
//
// Field ids reuse the lists' existing wire spellings — the sort key where a
// field has one, the filter param otherwise — so no field gains a second name.
// Scope and auth axes (organization, team, `viewerScope`) are never fields.
import {
  BranchListFilterFacet,
  BranchListSortKey,
} from "./branch-list-contract.ts";
import { branchStatusOrderingFor } from "./branch-status-order.ts";
import { ListSortRank } from "./list-query-expression.ts";
import { PRIORITY_ORDINAL } from "./search-query.ts";

/**
 * Sessions list fields. The first twelve and `Assignee` are the
 * `AGENT_SESSION_SORT_COLUMNS` spellings
 * (`apps/api/app/agent-sessions/validators.ts`); `apps/api` cannot be imported
 * from here, so `list-query-session-registry.test.ts` in `apps/api` pins the two
 * sets equal at compile time. The rest are filter-only axes named by their
 * `AgentSessionListQuery` param.
 */
export const SessionListField = {
  User: "user",
  Status: "status",
  Repo: "repo",
  Harness: "harness",
  Model: "model",
  Autonomy: "autonomy",
  Duration: "duration",
  Cost: "cost",
  Started: "started",
  Priority: "priority",
  Updated: "updated",
  LastActivity: "lastActivity",
  ChangePresence: "changePresence",
  PrAssociation: "prAssociation",
  Quality: "quality",
  ProjectIds: "projectIds",
  /**
   * ISS-12251 (PLN-2176 T-3.1): the Owner sort's own name. `User` is the alias
   * every existing client sorts by, with the same meaning (the assignee).
   */
  Assignee: "assignee",
} as const;
export type SessionListField =
  (typeof SessionListField)[keyof typeof SessionListField];

/**
 * Branches list fields: every {@link BranchListSortKey}, DERIVED so a new sort
 * key is a new field and the registry's exhaustive `Record` fails `tsc` until
 * it is specified, plus the two {@link BranchListFilterFacet} members that have
 * no sort key.
 */
export const BranchListField = {
  ...BranchListSortKey,
  Collaborators: BranchListFilterFacet.Collaborators,
  Tags: BranchListFilterFacet.Tags,
} as const;
export type BranchListField =
  (typeof BranchListField)[keyof typeof BranchListField];

/**
 * The field each Branches filter facet narrows. Three facet ids spell the axis
 * differently from its sort key (`pullRequest`/`pr`, `lastActive`/
 * `lastActivity`, `repository`/`repo`); a field id is the sort-key spelling,
 * and this is the one place the facet spelling maps to it. Exhaustive, so a new
 * facet fails `tsc` until it names its field.
 *
 * Reserved for the first Branches consumer, which receives facet ids from the Branches toolbar.
 */
export const BRANCH_LIST_FIELD_BY_FILTER_FACET = {
  [BranchListFilterFacet.Name]: BranchListField.Name,
  [BranchListFilterFacet.Owner]: BranchListField.Owner,
  [BranchListFilterFacet.Collaborators]: BranchListField.Collaborators,
  [BranchListFilterFacet.Changes]: BranchListField.Changes,
  [BranchListFilterFacet.Status]: BranchListField.Status,
  [BranchListFilterFacet.PullRequest]: BranchListField.PullRequest,
  [BranchListFilterFacet.LastActive]: BranchListField.LastActivity,
  [BranchListFilterFacet.Repository]: BranchListField.Repo,
  [BranchListFilterFacet.Tags]: BranchListField.Tags,
  [BranchListFilterFacet.Priority]: BranchListField.Priority,
} as const satisfies Record<BranchListFilterFacet, BranchListField>;

/**
 * A custom field's id in an expression: `customField:<fieldId>`.
 *
 * Reserved for the first host that serves a custom-field filter; both Sessions declarations refuse such ids today.
 */
export const LIST_QUERY_CUSTOM_FIELD_PREFIX = "customField:";

/**
 * The canonical rank each semantic {@link ListSortRank} orders by, imported
 * rather than restated so a compiler cannot rank a value differently from the
 * rest of the product.
 *
 * `PRIORITY_ORDINAL` runs LOW=0 → URGENT=3. The design system's own
 * `PRIORITY_ORDINAL`
 * (`packages/design-system/lib/vocabulary/priority-order.ts`) runs the
 * opposite way; the two are NOT reconciled here. Branches status ordering is a
 * function because the ordering depends on the ISS-9437 flag, which the
 * compiler resolves for the principal.
 *
 * Reserved for the ISS-9477 cloud compiler and the ISS-9479 desktop compiler, which order by it.
 */
export const LIST_QUERY_SEMANTIC_SORT_RANKS = {
  [ListSortRank.PriorityOrdinal]: PRIORITY_ORDINAL,
  [ListSortRank.BranchStatusOrdering]: branchStatusOrderingFor,
} as const satisfies Record<
  Exclude<ListSortRank, typeof ListSortRank.Value>,
  unknown
>;
