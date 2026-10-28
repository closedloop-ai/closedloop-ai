import type {
  ArtifactStatusRawValue,
  ArtifactStatusStructuralReadOnlyReason,
} from "@repo/api/src/types/artifact-status-contract";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import type { Priority } from "@repo/api/src/types/common";
import { ONE_LABEL_PER_METRIC_FLAG_KEY } from "@repo/api/src/types/one-label-per-metric-flag";
import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag";
import type { CollaboratorPerson } from "@repo/app/shared/components/collaborators";
import type { ArtifactPrioritySupport } from "@repo/app/shared/lib/artifact-priority-ownership";
import type { ArtifactStatusView } from "@repo/app/shared/lib/artifact-status-view-contract";
import { SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { ComponentType, ReactNode } from "react";
import type { LinkedArtifactTableGroup } from "../components/artifact-linked-artifacts-table";

/**
 * ISS-10792 DESIGN PROPOSAL -- not a production contract yet.
 *
 * The shape a shared Details tab would take, laid out as the web-master
 * generic-artifact prototype's Details tab (Nerys, 2026-10-02): one label /
 * value table of typed core rows, then "Custom fields" and "Linked
 * artifacts". The artifact type's host supplies the rows; one renderer draws
 * every type, and no type adds its own section renderer (ISS-10792 AC).
 * Ottilie approves the layout before any of this is implemented for real; the
 * save contract itself is ISS-10995's. The fixtures live in
 * `details-design-fixtures.ts`.
 */

/** The same blocks, in the same order, for every artifact type. */
export const DetailsSectionId = {
  Core: "core",
  CustomFields: "custom-fields",
  Links: "links",
} as const;
export type DetailsSectionId =
  (typeof DetailsSectionId)[keyof typeof DetailsSectionId];

/** The prototype's section headings; the core table has none. */
export const DETAILS_SECTION_TITLES: Readonly<
  Record<Exclude<DetailsSectionId, "core">, string>
> = {
  "custom-fields": "Custom fields",
  links: "Linked artifacts",
};

/** Every row id any type may carry. Which ids a type carries is a test. */
export const DetailsFieldId = {
  AgentRole: "agent-role",
  Assignee: "assignee",
  Autonomy: "autonomy",
  Branch: "branch",
  CacheReadTokens: "cache-read-tokens",
  CacheWriteTokens: "cache-write-tokens",
  Changes: "changes",
  ChecksStatus: "checks-status",
  Collaborators: "collaborators",
  CommitCount: "commit-count",
  Cost: "cost",
  CreatedAt: "created-at",
  CreatedBy: "created-by",
  DueDate: "due-date",
  Duration: "duration",
  ErrorCount: "error-count",
  FirstSkill: "first-skill",
  Harness: "harness",
  InputTokens: "input-tokens",
  IssueId: "issue-id",
  LastActive: "last-active",
  LinkedArtifacts: "linked-artifacts",
  LinkedSessions: "linked-sessions",
  LocPerDollar: "loc-per-dollar",
  Model: "model",
  Name: "name",
  OtherRepositories: "other-repositories",
  OutputTokens: "output-tokens",
  Owner: "owner",
  Parent: "parent",
  Priority: "priority",
  Project: "project",
  PullRequests: "pull-requests",
  Repository: "repository",
  SessionId: "session-id",
  Slug: "slug",
  Started: "started",
  Status: "status",
  SubagentCount: "subagent-count",
  Sync: "sync",
  Tags: "tags",
  Thread: "thread",
  ToolUseCount: "tool-use-count",
  Updated: "updated",
} as const;
export type DetailsFieldId =
  (typeof DetailsFieldId)[keyof typeof DetailsFieldId];

/**
 * The producer's evidence state for a people list. Branch and Session use the
 * one production type (ISS-10992 supplies Session's through the host).
 */
export type DetailsPeopleAvailability = BranchIdentityAvailability;

/** Value kinds. Each has exactly one shared cell; types never draw their own. */
export type DetailsFieldValue =
  | { kind: "text"; mono?: boolean; text: string }
  | {
      kind: "status";
      /**
       * Why the VOCABULARY has no human-writable status, when it has none.
       * `ArtifactStatusStructuralReadOnlyReason` excludes `not_permitted` and
       * `unrecognized_status` on purpose — both are runtime narrowings, not
       * structural ones (`artifact-status-contract.ts`).
       */
      reason?: ArtifactStatusStructuralReadOnlyReason;
      /** Present only where a human writes the status; opens the editor. */
      allowedTargets?: readonly ArtifactStatusRawValue[];
      view: ArtifactStatusView;
    }
  | {
      kind: "priority";
      /**
       * `null` is "no priority"; the row is omitted upstream when the producer
       * did not serve one (`priority-contract.ts` forbids folding the two). The
       * vocabulary, not `string`, because ISS-10995's editable row hands this
       * straight to the write and a widened member would reach it uncaught.
       */
      priority: Priority | null;
      support: ArtifactPrioritySupport;
    }
  /** One person (owner, assignee); edited through the prototype's menu. */
  | {
      avatarUrl?: string;
      choices: readonly string[];
      kind: "person";
      name: string;
    }
  | {
      /**
       * ISS-12273 dropped the partial-list note (operator ruling, 2026-10-08),
       * so `incomplete` no longer needs a variant of its own. The value is kept
       * because a row still reads differently when the producer could not read
       * the list in full: an empty one draws the unknown glyph, not an empty
       * stack.
       */
      availability?: DetailsPeopleAvailability;
      kind: "people";
      /**
       * Carries a per-person KEY, not just names — see
       * {@link CollaboratorPerson}. Two users who share a display name must
       * stay two people (PR #8461).
       */
      people: readonly CollaboratorPerson[];
    }
  | { kind: "tags"; tags: readonly string[] }
  /** ISO `yyyy-mm-dd`, or null when unset. */
  | { date: string | null; kind: "date" }
  | { additions: number; deletions: number; kind: "changes" }
  /**
   * A read-only row the host draws itself (Daveth, 2026-09-23): cost with its
   * breakdown, pills with `+N more`, a copyable ID, duration with evidence.
   * `empty` is the host's answer to the ISS-12197 empty-row rule, because the
   * renderer cannot see inside the cell; absent means the row has a value.
   */
  | { empty?: boolean; kind: "custom"; render: () => ReactNode };

/**
 * A row whose cell owns its own write, rollback and errors (ISS-12302's
 * custom-field editors), so nothing goes through `onSave`. `render(true)` is
 * the editor, `render(false)` the read-only value. Kept out of
 * {@link DetailsFieldValue} because `onSave` and the accepted-value state never
 * carry it.
 */
export type DetailsSelfSavingValue = {
  empty: boolean;
  /**
   * The cell takes the row's width rather than its own content's. A cell that
   * fits its items to its measured width (a multi-value chip list) needs it:
   * sized to its content, it only ever has room for what it already shows.
   */
  fill?: boolean;
  kind: "self-saving";
  render: (editable: boolean) => ReactNode;
};

export type DetailsRowValue = DetailsFieldValue | DetailsSelfSavingValue;

/** Why a field cannot change right now (Daveth's contract, 2026-09-23). */
export const DetailsReadOnlyKind = {
  /** Production never writes this field. */
  NotEditable: "not-editable",
  DesktopOffline: "desktop-offline",
  NoPermission: "no-permission",
} as const;
export type DetailsReadOnlyKind =
  (typeof DetailsReadOnlyKind)[keyof typeof DetailsReadOnlyKind];

/**
 * The wording is the host's; the renderer ships none of its own. A
 * never-written field may carry the kind alone: the empty-row rule reads the
 * kind, and a host with no wording for it draws no lock (ISS-12197).
 */
export type DetailsReadOnlyReason =
  | { kind: DetailsReadOnlyKind; text: string }
  | { kind: typeof DetailsReadOnlyKind.NotEditable; text?: undefined };

/** Value kinds no field may edit, whatever the viewer's situation. */
const DETAILS_READ_ONLY_VALUE_KINDS = ["changes", "custom", "people"] as const;
export type DetailsReadOnlyValueKind =
  (typeof DETAILS_READ_ONLY_VALUE_KINDS)[number];
export type DetailsReadOnlyValue = Extract<
  DetailsFieldValue,
  { kind: DetailsReadOnlyValueKind }
>;

export function isReadOnlyOnlyValue(
  value: DetailsFieldValue
): value is DetailsReadOnlyValue {
  return DETAILS_READ_ONLY_VALUE_KINDS.some((kind) => kind === value.kind);
}
export type DetailsEditableValue = Exclude<
  DetailsFieldValue,
  { kind: DetailsReadOnlyValueKind }
>;

/**
 * Per field: a save callback (ISS-10995's write; a rejected save keeps the
 * draft) or a read-only reason. Editable only where production writes it.
 */
export type DetailsFieldEdit =
  // `reason` is OPTIONAL: a host whose whole tab is read-only has no editable
  // row to contrast a per-row lock against, and a reason it cannot state truly
  // is worse than none (operator ruling, 2026-10-06 — ISS-10796 ships Session
  // Details read-only and ISS-10995 adds the writes). The renderer already
  // draws nothing when it is absent.
  | { mode: "read-only"; reason?: DetailsReadOnlyReason }
  | { mode: "editable"; onSave: (next: DetailsFieldValue) => Promise<void> };

export type DetailsSelfSavingEdit =
  | { mode: "read-only"; reason?: DetailsReadOnlyReason }
  | { mode: "self-saving" };

/** The production flags a Details row may ship behind. */
export const DetailsRowFlag = {
  LaunchAttribution: SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY,
  OneLabelPerMetric: ONE_LABEL_PER_METRIC_FLAG_KEY,
  SessionsTags: SESSIONS_ARTIFACT_TAGS_FLAG_KEY,
} as const;
export type DetailsRowFlag =
  (typeof DetailsRowFlag)[keyof typeof DetailsRowFlag];

type DetailsFieldBase<Id extends string> = {
  /** Production's other label for the row, used while its flag is on. */
  flaggedLabel?: {
    flag: typeof DetailsRowFlag.OneLabelPerMetric;
    label: string;
  };
  /**
   * The production flag the row ships behind, read at the row (the leaf).
   * Absent: the row is ungated.
   */
  flag?: DetailsRowFlag;
  id: Id;
  label: string;
};

/**
 * A field. A never-editable value kind can only carry a not-editable reason —
 * or none at all — so no viewer situation can stamp offline or no-permission on
 * it. See {@link DetailsFieldEdit} for why the reason is optional.
 */
export type DetailsField<Id extends string = string> = DetailsFieldBase<Id> &
  (
    | {
        edit: {
          mode: "read-only";
          reason?: DetailsReadOnlyReason & {
            kind: typeof DetailsReadOnlyKind.NotEditable;
          };
        };
        value: DetailsReadOnlyValue;
      }
    | { edit: DetailsFieldEdit; value: DetailsEditableValue }
    | { edit: DetailsSelfSavingEdit; value: DetailsSelfSavingValue }
  );

export type DetailsEditableField<Id extends string = string> = Extract<
  DetailsField<Id>,
  { value: DetailsEditableValue }
>;

function isEditableField<Id extends string>(
  field: DetailsField<Id>
): field is DetailsEditableField<Id> {
  return field.edit.mode === "editable";
}

export type DetailsSelfSavingField<Id extends string = string> = Extract<
  DetailsField<Id>,
  { value: DetailsSelfSavingValue }
>;

export function isSelfSavingField<Id extends string>(
  field: DetailsField<Id>
): field is DetailsSelfSavingField<Id> {
  return field.value.kind === "self-saving";
}

/** An empty block is omitted, never drawn as a placeholder. */
export type DetailsConfig = {
  /** The prototype's order where the type has the field. */
  core: readonly DetailsField<DetailsFieldId>[];
  customFields: readonly DetailsField[];
  /** Relationship rows a type draws as pills (Session), in Linked artifacts. */
  linkRows: readonly DetailsField<DetailsFieldId>[];
  /** Linked artifacts, grouped by type; each row links to its production route. */
  linked: readonly LinkedArtifactTableGroup[];
  /**
   * The host's word for a linked-artifacts read that failed, drawn in place of
   * the table so a failed read never passes for a complete one (Kerensa Whitlock
   * 2026-10-09, PR #8666).
   */
  linkedUnavailable?: string;
  /** The host's wording for a viewer who cannot edit anything right now. */
  viewerReasons: Readonly<
    Record<Exclude<DetailsReadOnlyKind, "not-editable">, string>
  >;
  /** The host's wording when a write is refused. */
  saveErrorLabel: string;
  /** The host's accessible name for a row that cannot change. */
  readOnlyName: (label: string, reason: string) => string;
};

/**
 * The canonical priority control, injected: `shared/` may not import the
 * documents slice that owns `ArtifactPriorityEditor`, so the host supplies it,
 * as a production Details host would have to.
 */
export type DetailsPriorityEditorProps = {
  mutationActivity: boolean;
  onSelect: (priority: Priority | null) => void;
  priority: string | null;
  support: ArtifactPrioritySupport;
};
export type DetailsPriorityEditor = ComponentType<DetailsPriorityEditorProps>;

/**
 * What the host injects for the fixtures: the canonical href builders, and
 * production value cells that live in feature slices.
 */
export type DetailsDesignHost = {
  artifact: (slug: string) => string | null;
  branch: (branchId: string) => string;
  pullRequest: (num: number, repositoryFullName: string) => string | null;
  /** Production's Cost value and its disclosures, read at the leaf. */
  sessionCost: () => ReactNode;
};

/**
 * The viewer situations the harness switches between. Offline and no
 * permission turn every editable field read-only, each with the host's
 * per-field reason.
 */
export const DetailsAvailability = {
  CanEdit: "can-edit",
  Offline: DetailsReadOnlyKind.DesktopOffline,
  NoPermission: DetailsReadOnlyKind.NoPermission,
} as const;
export type DetailsAvailability =
  (typeof DetailsAvailability)[keyof typeof DetailsAvailability];

/**
 * ISS-12197's empty-row rule, the value half: whether a value is empty. The
 * renderer leaves out a row production never writes (`NotEditable`) whose
 * value is empty, and draws every other row. A people list is empty only when
 * read in full (an unavailable or partial list is unknown, never empty); a
 * custom cell is whatever the host says, because the renderer cannot see
 * inside it.
 */
export function isDetailsValueEmpty(value: DetailsRowValue): boolean {
  switch (value.kind) {
    case "text":
      return value.text.trim() === "";
    case "tags":
      return value.tags.length === 0;
    case "people":
      return (
        value.people.length === 0 &&
        (value.availability ?? BranchIdentityAvailability.Complete) ===
          BranchIdentityAvailability.Complete
      );
    case "date":
      return value.date === null;
    case "priority":
      return value.priority === null;
    case "person":
      return value.name.trim() === "";
    case "custom":
      return value.empty === true;
    case "self-saving":
      return value.empty;
    case "changes":
    case "status":
      return false;
    default: {
      const unhandled: never = value;
      return unhandled;
    }
  }
}

/** What a host does before rendering: lock each editable field with a reason. */
export function forViewer(
  config: DetailsConfig,
  availability: DetailsAvailability
): DetailsConfig {
  if (availability === DetailsAvailability.CanEdit) {
    return config;
  }
  const reason: DetailsReadOnlyReason = {
    kind: availability,
    text: config.viewerReasons[availability],
  };
  const lock = <Id extends string>(
    field: DetailsField<Id>
  ): DetailsField<Id> => {
    if (isSelfSavingField(field)) {
      return field.edit.mode === "self-saving"
        ? { ...field, edit: { mode: "read-only", reason } }
        : field;
    }
    return isEditableField(field)
      ? { ...field, edit: { mode: "read-only", reason } }
      : field;
  };
  return {
    ...config,
    core: config.core.map(lock),
    customFields: config.customFields.map(lock),
    linkRows: config.linkRows.map(lock),
  };
}
