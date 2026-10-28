import { ArtifactType } from "@repo/api/src/types/artifact";
import type {
  ArtifactLinkedRecord,
  LinkedArtifactTableGroup,
} from "../components/artifact-linked-artifacts-table";
import {
  LINKED_ARTIFACT_GROUP_ORDER,
  LINKED_ARTIFACT_ISSUES_GROUP,
  linkedArtifactGroupHeading,
} from "../components/linked-artifact-groups";
import {
  DetailsAvailability,
  type DetailsConfig,
  type DetailsField,
  DetailsFieldId,
  type DetailsReadOnlyReason,
} from "./details-design-model";

/**
 * ISS-12252, the Details tab. Production's Session and Branch Details tabs
 * draw it since ISS-12412 (`shippedDetailsTabConfig`).
 *
 * The same rows as the shipped Details model (`DetailsConfig`, ISS-12197's
 * fields), laid out from the Details tab requirements meeting (Kerensa, Nerys, Ottilie, 2026-10-07):
 *
 * - Every attribute of the artifact, grouped into sections, in the order
 *   common fields -> the artifact type's fields -> custom fields, with
 *   Asana's field panel as the model.
 * - Editability is shown the Asana way: every value is assumed editable, and
 *   the hover background and pointer cursor are the only cues. No pencil, no
 *   lock, no badge.
 * - Associated artifacts is a read-only list of direct links with a
 *   relationship column, one section per type (ISS-12403); an artifact may
 *   have several parents.
 * - No version history and no activity: version history is a dropdown on
 *   the canvas, and Activity is its own tab.
 */

/**
 * Fields the Details tab adds; the shipped ids are kept as they are. Beside ISS-12197's list,
 * these come from Kerensa's Details tab reconciliation (2026-10-07, "See also" on
 * ISS-12197):
 * - Session: the Properties-panel rows the live app shows today that the list
 *   left out (prompt source, cache write TTL, turns and steers from Work, and
 *   the Codex runtime rows, which his default is to keep).
 * - Branch: the candidates already on the branch-detail payload, which pass
 *   the design's rule ("any field the live app shows for that type today").
 * - Document: Current version only. Document type and Approver left the
 *   group with PRD-799 (ISS-12586): a document page shows no type and has no
 *   approval step.
 * - Repositories (ISS-12572): PRD-799 lists it with the artifact's own fields.
 *   It is the document's repository snapshot, so it is its own id, not a
 *   Session's or Branch's Repository, and no type group draws it twice.
 * - Issue (ISS-12586): the issue's own delivery fields. Issue status and
 *   Parent issue are their own ids, not the common Status and Parent, so the
 *   Issue group can hold them without the common group drawing them twice.
 */
export const DetailsTabFieldId = {
  ...DetailsFieldId,
  // Session. Sync and Lines changed left the shipped ids when ISS-12197 (#8585)
  // dropped them from the shipped Session Details; the Details tab keeps both rows
  // (Kerensa's reconciliation, approved by Nerys 2026-10-08).
  CacheWriteTtl: "cache-write-ttl",
  LinesChanged: "lines-changed",
  Sync: "sync",
  ContextWindow: "context-window",
  LatestTurnTokens: "latest-turn-tokens",
  PromptSource: "prompt-source",
  RateLimitPrimary: "rate-limit-primary",
  RateLimitSecondary: "rate-limit-secondary",
  SteerCount: "steer-count",
  TurnCount: "turn-count",
  // Branch
  BaseBranch: "base-branch",
  FilesChanged: "files-changed",
  HeadSha: "head-sha",
  IdleTime: "idle-time",
  LeadTime: "lead-time",
  MergeCommit: "merge-commit",
  Origin: "origin",
  PrMergedAt: "pr-merged-at",
  PrOpenedAt: "pr-opened-at",
  ReviewDecision: "review-decision",
  Reviewers: "reviewers",
  // Document and Issue
  CurrentVersion: "current-version",
  Repositories: "repositories",
  // Issue
  ClosedReason: "closed-reason",
  ExternalLinks: "external-links",
  IssueStatus: "issue-status",
  ParentIssue: "parent-issue",
  SubIssues: "sub-issues",
} as const;
export type DetailsTabFieldId =
  (typeof DetailsTabFieldId)[keyof typeof DetailsTabFieldId];

/**
 * How a linked artifact relates to this one, read from the link's type and
 * which end this artifact is on:
 * - PRODUCES, this artifact is the target: a Parent (there may be several).
 * - PRODUCES, this artifact is the source: a Child.
 * - BLOCKS, this artifact is the target: Blocked by.
 * - BLOCKS, this artifact is the source: Blocking.
 * - RELATES_TO, either end: Related.
 */
export const DetailsRelationship = {
  Parent: "parent",
  Child: "child",
  BlockedBy: "blocked-by",
  Blocking: "blocking",
  Related: "related",
} as const;
export type DetailsRelationship =
  (typeof DetailsRelationship)[keyof typeof DetailsRelationship];

/** The relationship column's words, and the list's order. */
export const DETAILS_RELATIONSHIP_LABELS: Readonly<
  Record<DetailsRelationship, string>
> = {
  parent: "Parent",
  child: "Child",
  "blocked-by": "Blocked by",
  blocking: "Blocking",
  related: "Related",
};
const RELATIONSHIP_ORDER = Object.keys(
  DETAILS_RELATIONSHIP_LABELS
) as DetailsRelationship[];

export const DetailsLinkType = {
  Produces: "PRODUCES",
  Blocks: "BLOCKS",
  RelatesTo: "RELATES_TO",
} as const;
export type DetailsLinkType =
  (typeof DetailsLinkType)[keyof typeof DetailsLinkType];

/** Which end of the link this artifact is on. */
export const DetailsLinkEnd = {
  Source: "source",
  Target: "target",
} as const;
export type DetailsLinkEnd =
  (typeof DetailsLinkEnd)[keyof typeof DetailsLinkEnd];

export function detailsRelationship(
  linkType: DetailsLinkType,
  end: DetailsLinkEnd
): DetailsRelationship {
  switch (linkType) {
    case DetailsLinkType.Produces:
      return end === DetailsLinkEnd.Target
        ? DetailsRelationship.Parent
        : DetailsRelationship.Child;
    case DetailsLinkType.Blocks:
      return end === DetailsLinkEnd.Target
        ? DetailsRelationship.BlockedBy
        : DetailsRelationship.Blocking;
    case DetailsLinkType.RelatesTo:
      return DetailsRelationship.Related;
    default: {
      const unhandled: never = linkType;
      return unhandled;
    }
  }
}

/** One direct link, as the Associated artifacts list draws it. */
export type DetailsAssociatedRecord = Omit<
  ArtifactLinkedRecord,
  "relationship"
> & {
  href: string | null;
  relationship: DetailsRelationship;
};

/** Parents first, then children, blockers, blocked work and related peers. */
export function sortAssociated(
  records: readonly DetailsAssociatedRecord[]
): DetailsAssociatedRecord[] {
  return [...records].sort(
    (a, b) =>
      RELATIONSHIP_ORDER.indexOf(a.relationship) -
      RELATIONSHIP_ORDER.indexOf(b.relationship)
  );
}

/**
 * ISS-12403 (Oct 9 sync, Ottilie): Associated artifacts is one section per
 * type, with any other type after them by name. A branch and its pull requests
 * share one section. The order and headings are production's grouped table's
 * (`LINKED_ARTIFACT_GROUP_ORDER`, ISS-12412), so this page cannot drift from
 * the live one; this maps a fixture record's kind onto those groups.
 */
const ASSOCIATED_RECORD_TYPES: Readonly<Record<string, readonly string[]>> = {
  [ArtifactType.Document]: ["Document"],
  [ArtifactType.Session]: ["Session"],
  [LINKED_ARTIFACT_ISSUES_GROUP.key]: ["Issue"],
  [ArtifactType.Branch]: ["Branch", "Pull request"],
};
const ASSOCIATED_GROUPS = LINKED_ARTIFACT_GROUP_ORDER.flatMap((key) => {
  const types = ASSOCIATED_RECORD_TYPES[key];
  return types
    ? [{ heading: linkedArtifactGroupHeading(key), key, types }]
    : [];
});

/**
 * The records as production's grouped linked-artifacts table reads them: one
 * group per type (`ASSOCIATED_GROUPS`), rows in relationship order, and no
 * Type column, since the heading names it.
 */
export function associatedTableGroups(
  records: readonly DetailsAssociatedRecord[]
): LinkedArtifactTableGroup[] {
  const sorted = sortAssociated(records);
  const known = new Set(ASSOCIATED_GROUPS.flatMap((group) => group.types));
  const others = [
    ...new Set(
      sorted.map((record) => record.type).filter((type) => !known.has(type))
    ),
  ].sort((a, b) => a.localeCompare(b));
  const groups = [
    ...ASSOCIATED_GROUPS,
    ...others.map((type) => ({ heading: type, key: type, types: [type] })),
  ];
  return groups
    .map((group) => ({
      heading: group.heading,
      key: group.key,
      rows: sorted
        .filter((record) => group.types.includes(record.type))
        .map((record) => ({
          href: record.href,
          icon: record.icon,
          key: `${record.slug}:${record.relationship}`,
          name: record.name,
          relationship: DETAILS_RELATIONSHIP_LABELS[record.relationship],
          slug: record.slug,
        })),
    }))
    .filter((group) => group.rows.length > 0);
}

/** A titled group of fields, in `fieldIds`' order. */
export type DetailsTabGroup = {
  id: string;
  title: string;
  fieldIds: readonly string[];
};

/** The ids a section's `data-details-group` carries, for hosts and tests. */
export const DetailsTabGroupId = {
  ArtifactDetails: "artifact-details",
  CustomFields: "custom-fields",
  Associated: "associated",
} as const;

/** A section's element, by its `DetailsTabGroupId`. */
export function detailsTabGroupSelector(id: DetailsTabGroupId): string {
  return `[data-details-group="${id}"]`;
}
export type DetailsTabGroupId =
  (typeof DetailsTabGroupId)[keyof typeof DetailsTabGroupId];

/** Every field section (Artifact details, "<Type> details", More). */
export const DETAILS_TAB_FIELD_GROUPS_SELECTOR = `[data-details-group]:not(${detailsTabGroupSelector(DetailsTabGroupId.CustomFields)}):not(${detailsTabGroupSelector(DetailsTabGroupId.Associated)})`;

/**
 * ISS-12403 (Oct 9 sync): every artifact type's Details tab has the same four
 * sections, in this order, mirroring the database (Ottilie: no made-up
 * groupings):
 * 1. "Artifact details": the artifact table's fields, the same on every type
 * 2. "<Type> details": the type table's fields, one section, no sub-headers
 * 3. Custom fields
 * 4. Associated artifacts
 */
export const DETAILS_TAB_COMMON_GROUP: DetailsTabGroup = {
  id: DetailsTabGroupId.ArtifactDetails,
  title: "Artifact details",
  fieldIds: [
    DetailsTabFieldId.Name,
    DetailsTabFieldId.Slug,
    DetailsTabFieldId.IssueId,
    DetailsTabFieldId.Owner,
    DetailsTabFieldId.Assignee,
    DetailsTabFieldId.Collaborators,
    DetailsTabFieldId.Status,
    DetailsTabFieldId.Priority,
    DetailsTabFieldId.DueDate,
    DetailsTabFieldId.CreatedAt,
    DetailsTabFieldId.CreatedBy,
    DetailsTabFieldId.Updated,
    DetailsTabFieldId.Project,
    DetailsTabFieldId.Parent,
    DetailsTabFieldId.Tags,
    DetailsTabFieldId.Repositories,
  ],
};

/** The artifact types the Details tab mocks cover. */
export const DetailsTabArtifactType = {
  Session: "session",
  Branch: "branch",
  Document: "document",
  Issue: "issue",
} as const;
export type DetailsTabArtifactType =
  (typeof DetailsTabArtifactType)[keyof typeof DetailsTabArtifactType];

const F = DetailsTabFieldId;

/**
 * Each type's own fields: one "<Type> details" section after the common one.
 *
 * Session (ISS-12403): the old Usage rows are session attributes, so they sit
 * here with no sub-header, and so do the Codex runtime rows (only a Codex
 * session reports them). The old Code section is gone: Repository, the
 * working directory the session was launched in, is a session attribute;
 * Lines changed is the branch's and stays on the canvas; branches and pull
 * requests are only in Associated artifacts.
 *
 * Branch: by the same rule, the sessions that worked the branch are only in
 * Associated artifacts (and the Sessions tab), not a row here.
 *
 * Document (PRD-799): Current version only; no Document type, no Approver.
 *
 * Issue (ISS-12586): status and why it closed, where it sits in the issue
 * tree, the branch that implements it and links outside Closedloop. The
 * Linked branch row reuses the shipped Branch id.
 */
export const DETAILS_TAB_TYPE_GROUPS: Readonly<
  Record<DetailsTabArtifactType, readonly DetailsTabGroup[]>
> = {
  session: [
    {
      id: "session-details",
      title: "Session details",
      fieldIds: [
        F.SessionId,
        F.Autonomy,
        F.Harness,
        F.Model,
        F.Repository,
        F.OtherRepositories,
        // Launch attribution: production shows these behind its flag.
        F.Thread,
        F.AgentRole,
        F.FirstSkill,
        F.PromptSource,
        F.Sync,
        F.Started,
        F.LastActive,
        F.Duration,
        F.InputTokens,
        F.OutputTokens,
        F.CacheReadTokens,
        F.CacheWriteTokens,
        F.CacheWriteTtl,
        F.Cost,
        F.LocPerDollar,
        F.TurnCount,
        F.SubagentCount,
        F.ToolUseCount,
        F.SteerCount,
        F.ErrorCount,
        F.ContextWindow,
        F.LatestTurnTokens,
        F.RateLimitPrimary,
        F.RateLimitSecondary,
      ],
    },
  ],
  branch: [
    {
      id: "branch-details",
      title: "Branch details",
      fieldIds: [
        F.Repository,
        F.BaseBranch,
        F.HeadSha,
        F.Origin,
        F.Changes,
        F.FilesChanged,
        F.CommitCount,
        F.PullRequests,
        F.ReviewDecision,
        F.Reviewers,
        F.ChecksStatus,
        F.PrOpenedAt,
        F.PrMergedAt,
        F.MergeCommit,
        F.Cost,
        F.LocPerDollar,
        F.InputTokens,
        F.OutputTokens,
        F.CacheReadTokens,
        F.CacheWriteTokens,
        F.LeadTime,
        F.IdleTime,
      ],
    },
  ],
  document: [
    {
      id: "document-details",
      title: "Document details",
      fieldIds: [F.CurrentVersion],
    },
  ],
  issue: [
    {
      id: "issue-details",
      title: "Issue details",
      fieldIds: [
        F.IssueStatus,
        F.ClosedReason,
        F.ParentIssue,
        F.SubIssues,
        F.Branch,
        F.ExternalLinks,
      ],
    },
  ],
};

/**
 * Rows a type's config may carry that its Details tab leaves out on purpose
 * (ISS-12403), so they do not fall into the "More" group: each is an
 * associated artifact, or another type's attribute.
 */
export const DETAILS_TAB_LEFT_OUT: Readonly<
  Record<DetailsTabArtifactType, readonly string[]>
> = {
  session: [F.Branch, F.PullRequests, F.LinesChanged],
  branch: [F.LinkedSessions],
  document: [],
  issue: [],
};

/** The title of the group a field no group names lands in, so none is lost. */
export const DETAILS_TAB_OTHER_GROUP_TITLE = "More";

/** What the Details tab is handed: the shipped Details rows plus its additions. */
export type DetailsTabConfig = {
  type: DetailsTabArtifactType;
  /**
   * The shipped Details rows; `core` may carry the ids the Details tab adds.
   * `linked` (or `linkedUnavailable`) is Associated artifacts; `linkRows` is
   * not drawn, since every link is a row of `linked`.
   */
  base: Omit<DetailsConfig, "core"> & { core: readonly DetailsField[] };
  /** Custom fields belong to a project; the section names it. */
  customFieldsProject: string | null;
};

/**
 * A production host's shipped `DetailsConfig` as the Details tab reads it.
 * Production's custom fields are not project-scoped (ISS-12302), so the
 * section names no project.
 */
export function shippedDetailsTabConfig(
  type: DetailsTabArtifactType,
  base: DetailsConfig
): DetailsTabConfig {
  return { type, base, customFieldsProject: null };
}

export type DetailsTabResolvedGroup = {
  id: string;
  title: string;
  fields: DetailsField[];
};

/**
 * The config's core rows in their groups: common first, then the type's own,
 * then any row no group names. A group is in the result even when empty; the
 * renderer drops one with no drawn rows.
 */
export function groupDetailsTabFields(
  config: DetailsTabConfig
): DetailsTabResolvedGroup[] {
  const groups = [
    DETAILS_TAB_COMMON_GROUP,
    ...DETAILS_TAB_TYPE_GROUPS[config.type],
  ];
  const placed = new Set([
    ...groups.flatMap((group) => group.fieldIds),
    ...DETAILS_TAB_LEFT_OUT[config.type],
  ]);
  const pick = (ids: readonly string[]) =>
    ids.flatMap((id) => config.base.core.filter((field) => field.id === id));
  const resolved = groups.map((group) => ({
    id: group.id,
    title: group.title,
    fields: pick(group.fieldIds),
  }));
  const rest = config.base.core.filter((field) => !placed.has(field.id));
  return rest.length > 0
    ? [
        ...resolved,
        { id: "more", title: DETAILS_TAB_OTHER_GROUP_TITLE, fields: rest },
      ]
    : resolved;
}

/**
 * The shipped `forViewer` for a Details tab config: a viewer who cannot edit right now
 * (offline, no permission) gets every editable row read-only, with the
 * host's reason.
 */
export function forDetailsTabViewer(
  config: DetailsTabConfig,
  availability: DetailsAvailability
): DetailsTabConfig {
  if (availability === DetailsAvailability.CanEdit) {
    return config;
  }
  const reason: DetailsReadOnlyReason = {
    kind: availability,
    text: config.base.viewerReasons[availability],
  };
  const lock = (field: DetailsField): DetailsField =>
    field.edit.mode === "editable" || field.edit.mode === "self-saving"
      ? ({ ...field, edit: { mode: "read-only", reason } } as DetailsField)
      : field;
  return {
    ...config,
    base: {
      ...config.base,
      core: config.base.core.map(lock),
      customFields: config.base.customFields.map(lock),
    },
  };
}
