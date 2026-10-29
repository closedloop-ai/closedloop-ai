import type { ComponentProps } from "react";
import {
  HOST_CAPABILITY,
  PRESENTATION,
  type SurfaceCapabilityKinds,
} from "../../shared/lib/surface-capability-kind";
import type { BranchesListSurfaceV2 } from "./branches-list-surface-v2";

/**
 * ISS-9218 — the {@link BranchesListSurfaceV2} half of the capability-kind
 * declaration; see `surface-capability-kind.ts` for what the two kinds mean and
 * why the map lives beside the prop type rather than in the parity ledger.
 *
 * The surface types its props inline, so the keys are read off
 * `ComponentProps` — a type-only import, so this module still carries no
 * runtime dependency on the component.
 *
 * ISS-9216 then retired `footerClassName` and `paginationDisabled` along with
 * the readout and visibility props: the surface owns its footer's class, its
 * disabled state and its sentence, so no host has one to pass and there is no
 * kind left to declare for them.
 */
export const BRANCHES_LIST_SURFACE_V2_CAPABILITY_KINDS = {
  bulkActions: HOST_CAPABILITY,
  className: HOST_CAPABILITY,
  // ISS-9582: band collapse is saved-view and link state beside `grouping`.
  collapsedGroups: HOST_CAPABILITY,
  columnOrder: HOST_CAPABILITY,
  columnWidths: HOST_CAPABILITY,
  // ISS-12663: whether the host's SOURCE serves custom-field values (the
  // desktop local store does not), and whether it may create a field.
  customFields: HOST_CAPABILITY,
  getBranchHref: HOST_CAPABILITY,
  getSessionHref: HOST_CAPABILITY,
  getSessionsHref: HOST_CAPABILITY,
  // ISS-9676: the grouping axis is persisted view state a host captures into
  // and applies from its saved views, so it is the host's to supply.
  grouping: HOST_CAPABILITY,
  hasCompletePopulation: HOST_CAPABILITY,
  historyListTestId: PRESENTATION,
  // ISS-10332: whether the host's SOURCE serves priority, which only it knows.
  includePriorityColumn: HOST_CAPABILITY,
  // ISS-12456: whether the host's SOURCE serves project, same reason as tags.
  includeProjectColumn: HOST_CAPABILITY,
  // ISS-12456: whether the host's SOURCE serves tags, same reason as priority.
  includeTagsColumn: HOST_CAPABILITY,
  // ISS-12638: whether this shell can offer the connect ask, which only its
  // own auth and GitHub status can say.
  githubConnect: HOST_CAPABILITY,
  // ISS-12638: the outcome of that ask's handoff, which settles in the host's
  // own renderer and nowhere this surface can see.
  githubConnectOutcome: HOST_CAPABILITY,
  githubReturnStatus: HOST_CAPABILITY,
  onColumnOrderChange: HOST_CAPABILITY,
  onColumnWidthChange: HOST_CAPABILITY,
  onCollapsedGroupsChange: HOST_CAPABILITY,
  onGroupingChange: HOST_CAPABILITY,
  renderBranchLink: HOST_CAPABILITY,
  renderBranchStatus: PRESENTATION,
  // ISS-10645: what this shell observed about the reader, plus the sign-up and
  // connect controls only that shell can build.
  stallCta: HOST_CAPABILITY,
  // ISS-10645: the host's own read state — only a shell whose list read has no
  // query-level timeout runs a stall detector to produce it.
  stallPhase: HOST_CAPABILITY,
  tableScrollAttributes: HOST_CAPABILITY,
  tableScrollRef: HOST_CAPABILITY,
  tableScrollTestId: PRESENTATION,
  tagsReadOnly: HOST_CAPABILITY,
  // ISS-10544: the answer differs per shell — web graduated the key, desktop
  // still resolves it — so the surface can only carry what the host decided.
  trendSparkline: HOST_CAPABILITY,
} as const satisfies SurfaceCapabilityKinds<
  ComponentProps<typeof BranchesListSurfaceV2>
>;
