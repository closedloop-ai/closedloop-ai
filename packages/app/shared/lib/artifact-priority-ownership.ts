/**
 * ISS-9306 — the ownership half of the artifact-priority contract: which layer
 * owns what, and which surfaces the field applies to at all.
 *
 * The VALUE half is `@repo/api/src/types/priority-contract` (vocabulary and the
 * fold from an untrusted value); the SORT RANK is
 * `@repo/design-system/lib/priority-order`; the WIRE ordinal is
 * `@repo/api/src/types/search-query`. No vocabulary, rank or label is re-spelled
 * here — but the SUPPORT map below does restate, in surface terms, the fact
 * `PRIORITY_BEARING_ENTITY_TYPES` states in entity-kind terms, and the two are
 * held together by this module's test rather than by a shared declaration: the
 * vocabularies spell the same thing differently (`artifact` vs `document`), so
 * neither can import the other's members.
 *
 * This module is the contract the phase-03 champion component is built to. It
 * enumerates the approved variants and states as one vocabulary so that surface
 * is built as one component with variants rather than a parallel component per
 * context — which is how the four label maps and two rank maps inventoried by
 * ISS-9439 came to exist.
 */

/** The approved rendering contexts. One component, nine variants, no forks. */
export const ArtifactPriorityVariant = {
  IconOnly: "icon-only",
  Label: "label",
  Badge: "badge",
  CompactCell: "compact-cell",
  Editor: "editor",
  Filter: "filter",
  BulkAction: "bulk-action",
  BoardCard: "board-card",
  DetailField: "detail-field",
} as const;
export type ArtifactPriorityVariant =
  (typeof ArtifactPriorityVariant)[keyof typeof ArtifactPriorityVariant];

/**
 * The states a variant may be in. `None` is a VALUE the field can hold, not an
 * absence of one, which is why it sits beside `Loading` and `Error` rather than
 * being represented by their blank.
 *
 * `Unknown` is separate from `None` because the product already separates them:
 * `priorityLabel` renders `PRIORITY_LABEL_UNKNOWN` for a member only a newer
 * peer knows and `PRIORITY_LABEL_NONE` for an artifact nobody prioritized.
 * Omitting it here would let the champion collapse a skewed peer's value into
 * "No priority" and state, as fact, that an artifact carries none.
 */
export const ArtifactPriorityState = {
  Loading: "loading",
  None: "none",
  Unknown: "unknown",
  Error: "error",
  Disabled: "disabled",
  ReadOnly: "read-only",
  Selected: "selected",
  FocusVisible: "focus-visible",
  Hover: "hover",
  Editing: "editing",
  MutationActivity: "mutation-activity",
} as const;
export type ArtifactPriorityState =
  (typeof ArtifactPriorityState)[keyof typeof ArtifactPriorityState];

export const ArtifactPriorityLayer = {
  Presentation: "presentation",
  DomainMapping: "domain-mapping",
  DataAccess: "data-access",
  Mutation: "mutation",
  RolloutFlag: "rollout-flag",
} as const;
export type ArtifactPriorityLayer =
  (typeof ArtifactPriorityLayer)[keyof typeof ArtifactPriorityLayer];

export type ArtifactPriorityLayerOwner = {
  /**
   * Every module in this package graph that owns part of the layer. The test
   * imports a named export from each, so a DELETED module or a deleted export
   * fails the suite rather than leaving a name that points at nothing. A MOVED
   * module is not caught — the specifier is a string on both sides. Empty when
   * the owner is a server route this package cannot import.
   */
  modules: readonly string[];
  owner: string;
};

/**
 * Exhaustive by type: a layer added to the vocabulary fails typecheck until it
 * names an owner, so the contract cannot acquire an unowned layer.
 */
export const ARTIFACT_PRIORITY_OWNERSHIP: Readonly<
  Record<ArtifactPriorityLayer, ArtifactPriorityLayerOwner>
> = {
  [ArtifactPriorityLayer.Presentation]: {
    modules: [
      "@repo/design-system/lib/priority-order",
      "@repo/app/shared/components/artifact-priority/artifact-priority",
      "@repo/app/documents/components/artifact-priority/artifact-priority-editor",
      "@repo/app/shared/components/status-badge",
      "@repo/app/shared/components/generic-artifact-surface/semantic-cells",
    ],
    owner:
      "@repo/design-system owns the project-agnostic primitives and the rank/label model, and may not import a domain package. ISS-9307 collapsed the fork onto the champion: `ArtifactPriority` is the one mark, in the shared slice so search results and the projects grid can paint a priority without depending on the documents slice, and `ArtifactPriorityEditor` is the one control, in the documents slice beside the `ArtifactPriorityMenu` it opens. `IssuePriorityBadge` is still named here because it is still the search results' entry point, but it now holds only the `artifact-priority-surfaces` swap and the flag-OFF badge it shipped with. `semantic-cells` is named to say what it is NOT: `EditablePriorityTableCell` is a second priority editor with its own menu and its own geometry, and it is reachable only from the `GenericArtifactTable` Storybook demo, so it is not a shipped fork. It sits in this slice, which is where the next reader greps, so leaving it unnamed would read as an omission.",
  },
  [ArtifactPriorityLayer.DomainMapping]: {
    modules: [
      "@repo/app/shared/lib/priority-constants",
      "@repo/app/documents/lib/artifact-row-adapter",
      "@repo/app/documents/lib/group-by",
      "@repo/app/agents/lib/session-table-row",
      "@repo/app/branches/lib/branch-row-adapter",
    ],
    owner:
      "@repo/app binds the design-system vocabulary to the Priority enum, maps a wire artifact onto a row model (the artifact row adapter, and since ISS-10332 the Sessions and Branches row mappers, which carry the wire value through absence included), and owns the grouping descriptor.",
  },
  [ArtifactPriorityLayer.DataAccess]: {
    modules: [
      "@repo/app/agents/data-source/agent-sessions-data-source",
      "@repo/app/branches/data-source/branches-data-source",
    ],
    owner:
      "apps/api — /documents, /search, /artifact-links/resolved, the project tree, and since ISS-10332 the /agent-sessions and /branches list and detail reads (PLN-2086 Milestone 1) serve it; the Sessions and Branches data-source ports carry it to both shells, and since Milestone 3 the local Desktop store serves its own (sessions.priority and artifacts.priority, read and written in local mode only). apps/app must not reach the database.",
  },
  [ArtifactPriorityLayer.Mutation]: {
    modules: [
      "@repo/app/agents/hooks/use-update-session-priority",
      "@repo/app/branches/hooks/use-update-branch-priority",
    ],
    owner:
      "apps/api — PUT /documents/[id] and PUT /projects/[id] both accept an explicit null that CLEARS the priority (ISS-9665 for artifacts, ISS-9441 for projects); on either route an omitted key leaves the stored value alone. Neither create route accepts a null, because omitting the field already stores none. decompose-handler writes new feature priority through documentService.create. ISS-10332 added PATCH /agent-sessions/[id] and PATCH /branches/[id], both org-member scoped and both through the one canonical writer, reached from the grids through the data-source ports' updatePriority seam (useUpdateSessionPriority / useUpdateBranchPriority). Authorization and org scope are enforced there, never by UI visibility. PLN-2086 Milestone 3 added the desktop local-mode writer behind the same seam (the desktop:db:set-session-priority / desktop:db:set-branch-priority IPC), whose value reaches the cloud through sync only while the cloud artifact holds none. Installed pre-PRD-797 Desktop builds can also create TRIAGE issues through the retired Audit Bot's crewd client, which defaults their priority to MEDIUM.",
  },
  [ArtifactPriorityLayer.RolloutFlag]: {
    modules: ["@repo/app/documents/lib/artifact-priority-unset-flag"],
    owner:
      "One PostHog key, default off, gating the unset affordances. Both shells: the Sessions and Branches grids render and edit artifact priority on web and on the desktop renderer in cloud and local mode (ISS-10332, PLN-2086 Milestone 3), so the key is the gate of record on both.",
  },
};

export const ArtifactPrioritySurface = {
  Artifact: "artifact",
  Project: "project",
  Branch: "branch",
  Session: "session",
} as const;
export type ArtifactPrioritySurface =
  (typeof ArtifactPrioritySurface)[keyof typeof ArtifactPrioritySurface];

export type ArtifactPrioritySupport =
  | { supported: true; adapter: string; allowsUnset: boolean }
  | { supported: false; adapter: string; reason: string };

/**
 * Whether a surface carries priority at all. Exhaustive by type so a surface
 * cannot be added silently, and an unsupported one states its reason rather
 * than leaving a reader to infer it from an absent column. Priority is an
 * ARTIFACT field (operator ruling 2026-09-11), and ISS-10332 (operator ruling
 * 2026-09-21, superseding the 09-11 "unsupported" declarations for these two)
 * made Branches and Sessions carry it: every member below is supported today,
 * and the shape still admits an unsupported declaration for the next surface.
 */
export const ARTIFACT_PRIORITY_SUPPORT: Readonly<
  Record<ArtifactPrioritySurface, ArtifactPrioritySupport>
> = {
  [ArtifactPrioritySurface.Artifact]: {
    supported: true,
    adapter: "@repo/app/documents/lib/artifact-row-adapter",
    // `Artifact.priority` is nullable with no default, so an artifact created
    // without one genuinely holds none.
    allowsUnset: true,
  },
  [ArtifactPrioritySurface.Project]: {
    supported: true,
    adapter: "@repo/app/projects/hooks/use-projects",
    // ISS-9833 (ruled 2026-09-14) makes a project's priority the same field as
    // an artifact's, and ISS-9441 dropped the column's NOT NULL and DEFAULT and
    // taught `updateProjectValidator` the clear. This value is the single switch
    // that turns the affordance on: `documentRowPrioritySupport` routes the
    // grid's cell through it and `ArtifactPriorityEditor` reads it for the
    // project overview.
    allowsUnset: true,
  },
  [ArtifactPrioritySurface.Branch]: {
    supported: true,
    adapter: "@repo/app/branches/components/approved-branches-grid-adapter",
    // ISS-10332 (PLN-2086, ruling 1): a Branch is an `Artifact` row, so
    // `Artifact.priority` already applied to it; Milestone 1 made the list read
    // serve it and `PATCH /branches/[id]` write it, `null` clearing.
    allowsUnset: true,
  },
  [ArtifactPrioritySurface.Session]: {
    supported: true,
    adapter: "@repo/app/agents/lib/sessions-table-columns",
    // ISS-10332, the same way: a Session is an `Artifact` row; the list read
    // serves the value and `PATCH /agent-sessions/[id]` writes it, `null`
    // clearing. Ingest never rewrites the column, so it survives a re-sync.
    allowsUnset: true,
  },
};
