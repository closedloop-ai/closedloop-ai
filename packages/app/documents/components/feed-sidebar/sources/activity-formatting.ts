import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  type ActivityFeedActor,
  ActivityFeedActorKind,
  ActivityFeedItemSource,
  type ArtifactActivityFeedItem,
} from "@repo/api/src/types/artifact-activity-feed";
import type { JsonObject } from "@repo/api/src/types/common";
import { DocumentType } from "@repo/api/src/types/document";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import type { TagColor } from "@repo/api/src/types/tag";
import type { User } from "@repo/api/src/types/user";
import { DOCUMENT_TYPE_BADGE_LABELS } from "@repo/app/documents/lib/document-type-labels";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import {
  documentStatusFacet,
  sessionStatusFacet,
} from "@repo/app/shared/lib/artifact-status-adapter";
import {
  type ArtifactStatusTone,
  resolveArtifactStatusMark,
} from "@repo/app/shared/lib/artifact-status-appearance";
import {
  DOCUMENT_STATUS_LABELS,
  ISSUE_STATUS_LABELS,
} from "@repo/app/shared/lib/artifact-status-labels";
import type { ArtifactStatusFacet } from "@repo/app/shared/lib/artifact-status-view-contract";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import {
  ASSIGNMENT_FIELD,
  activityChangedFieldKey,
  asJsonObject,
  fieldLabel,
  formatDateValue,
  formatSnapshotValue,
  isBulkSurface,
  looksLikeId,
  lookupOwn,
  PROJECT_FIELD,
  readNonEmptyString,
  readScalarString,
  sentenceCase,
  TAG_FIELD,
  unwrapSnapshotScalar,
} from "./activity-snapshot";
import {
  type ActivityArtifactKind,
  ActivityArtifactKind as ActivityArtifactKindValue,
  type ActivityDirectory,
  ActivityDirectoryStatus,
} from "./activity-types";

/**
 * The activity adapter (FEA-3875, reworked for ISS-12117): turns one
 * normalized `ArtifactActivityFeedItem` (a stored event OR an on-read
 * projection) into the pieces BOTH activity looks render — the Activity tab's
 * timeline line and the Document comments rail's compact card. One adapter,
 * two looks (Nerys, 2026-10-07), so the tab and the rail cannot word the same
 * row differently.
 *
 * Pure: no React, no fetching. Everything that needs a lookup (a person, a
 * project, a tag, a related artifact, a link) arrives through
 * {@link ActivityLookups}; a lookup the host did not supply degrades the row to
 * a phrase that claims nothing it could not check, never to an id.
 *
 * ISS-5007: this module is the audit trail's whole vocabulary, so it never
 * emits an internal serialization. A snapshot it cannot resolve to a
 * human-readable value is dropped, never shown as a uuid or a
 * `key: value, key: value` dump of the stored JSON.
 */

/** The before→after pair for a row, each already collapsed to a display string. */
export type ActivityChange = {
  before: string | null;
  after: string | null;
};

// ---------------------------------------------------------------------------
// The adapter's output
// ---------------------------------------------------------------------------

export const ActivityPartKind = {
  /** Plain words of the phrase. */
  Text: "text",
  /** A person named by the row (assignee, approver, owner), in bold. */
  Person: "person",
  /** A name still being looked up: a placeholder, never a guess. */
  Pending: "pending",
  /** An artifact status, drawn as a pill in the status colours. */
  Status: "status",
  /** A priority, drawn as the shared priority pill. */
  Priority: "priority",
  /** A tag, drawn in the tag's own colour. */
  Tag: "tag",
  /** A named value in bold (a project, a name, a version, a linked artifact). */
  Value: "value",
  /** A rename: the old value struck through, then the new one in bold. */
  Rename: "rename",
  /** A code identifier, e.g. a branch name. */
  Code: "code",
} as const;
export type ActivityPartKind =
  (typeof ActivityPartKind)[keyof typeof ActivityPartKind];

export type ActivityPart =
  | { kind: typeof ActivityPartKind.Text; text: string }
  | { kind: typeof ActivityPartKind.Person; id: string; name: string }
  | { kind: typeof ActivityPartKind.Pending; id: string }
  | {
      kind: typeof ActivityPartKind.Status;
      raw: string;
      label: string;
      tone: ArtifactStatusTone;
    }
  | { kind: typeof ActivityPartKind.Priority; value: string; label: string }
  | {
      kind: typeof ActivityPartKind.Tag;
      id: string;
      name: string;
      color: TagColor;
    }
  | { kind: typeof ActivityPartKind.Value; text: string; href?: string }
  | { kind: typeof ActivityPartKind.Rename; before: string; after: string }
  | { kind: typeof ActivityPartKind.Code; text: string };

/** A badge the actor carries beside the name. */
export const ActivityActorBadge = {
  /**
   * The row was written through an API key. The actor is the KEY OWNER, so
   * without this the row would read as that person's own edit.
   */
  Api: "api",
} as const;
export type ActivityActorBadge =
  (typeof ActivityActorBadge)[keyof typeof ActivityActorBadge];

/** Who acted, resolved as far as the user directory allows. */
export type ActivityActorDescription = {
  kind: ActivityFeedActor["kind"];
  /** The org user behind a human row, or behind an agent row's API key. */
  user: User | null;
  /** Null only while `pending`. */
  name: string | null;
  pending: boolean;
};

export type ActivityDescription = {
  actor: ActivityActorDescription;
  badge?: ActivityActorBadge;
  /** The action phrase, in reading order, after the actor's name. */
  parts: ActivityPart[];
  /** Muted context after the phrase ("bulk update", "from desktop sync"). */
  suffix?: string;
  timestamp: Date;
  /** Where the row's subject lives, when the host can link it. */
  href?: string;
};

/** A related artifact, resolved for a derivation row. */
export type ActivityRelatedArtifact = {
  /** The artifact key, e.g. "PRD-751". */
  key: string;
  title: string;
  href?: string;
};

/**
 * Everything the adapter cannot know from the row itself. Every field is
 * optional: a host that cannot resolve something leaves it out and the row
 * degrades to a phrase that does not need it.
 */
export type ActivityLookups = {
  users?: ActivityDirectory<User>;
  projects?: ActivityDirectory<{ id: string; name: string }>;
  tags?: ActivityDirectory<{ id: string; name: string; color: TagColor }>;
  /** `payload.relatedArtifactId` on a derivation row → its key and title. */
  relatedArtifact?: (id: string) => ActivityRelatedArtifact | null;
  /** A version number on a `version_created` row → that version's page. */
  versionHref?: (version: number) => string | null;
  /** An evaluation row's payload → the report. */
  reportHref?: (report: { reportType: string }) => string | null;
  /** Whose feed this is; a Session words its statuses and moves its own way. */
  artifactKind?: ActivityArtifactKind;
  /** The Document subtype, for the "created this …" noun and status words. */
  documentType?: DocumentType;
  /** ISS-9560's universal status words are on (`UNIVERSAL_ARTIFACT_STATUS`). */
  universalStatus?: boolean;
  /**
   * Called once per unknown action, field or source (e.g. `field:storyPoints`)
   * when a row falls back to the generic wording. Optional; a dev host or a
   * test passes one to hear about wording this build lacks.
   */
  onUnknown?: (key: string) => void;
};

/**
 * The lookups only the HOST can answer (where a version, a report or a related
 * artifact lives). The Activity timeline takes them as one optional
 * prop and passes them to every row; a host that has none yet leaves it out
 * and those rows degrade to phrases that name nothing.
 */
export type ActivityLinkLookups = Pick<
  ActivityLookups,
  "relatedArtifact" | "versionHref" | "reportHref"
>;

// ---------------------------------------------------------------------------
// Context suffixes. One action per row: the suffix says HOW it happened.
// ---------------------------------------------------------------------------

const SUFFIX = {
  BulkUpdate: "bulk update",
  BulkMove: "bulk move",
  Automatically: "automatically",
  DesktopSync: "from desktop sync",
  NotLinkedYet: "not linked yet",
} as const;

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * The structured description of one row: who, the phrase in parts, the muted
 * context, when, and where it links. Never throws; an action or field this
 * build has no wording for reads "updated {field}" and is reported once
 * through `lookups.onUnknown`.
 */
export function describeActivityParts(
  item: ArtifactActivityFeedItem,
  lookups: ActivityLookups = {}
): ActivityDescription {
  const phrase =
    item.source === ActivityFeedItemSource.Event
      ? describeEvent(item, lookups)
      : describeProjection(item, lookups);
  const actor = resolveActivityActor(item.actor, lookups.users);
  const description: ActivityDescription = {
    actor,
    parts: phrase.parts,
    timestamp: item.createdAt,
  };
  // The API badge says whose key wrote it; only meaningful beside the owner's
  // name. An unresolved agent already reads "Agent" with the robot glyph, so
  // a badge there would state the machine kind a third time.
  if (item.actor.kind === ActivityFeedActorKind.Agent && actor.user !== null) {
    description.badge = ActivityActorBadge.Api;
  }
  if (phrase.suffix !== undefined) {
    description.suffix = phrase.suffix;
  }
  if (phrase.href !== undefined) {
    description.href = phrase.href;
  }
  return description;
}

/**
 * The plain-text action phrase for a row (no actor, no time): the same parts
 * both looks render, joined, so text and pills cannot drift. Used where a
 * string is needed (an accessible name, a test).
 */
export function describeActivity(
  item: ArtifactActivityFeedItem,
  lookups: ActivityLookups = {}
): string {
  const { parts, suffix } = describeActivityParts(item, lookups);
  return activityPartsToText(parts, suffix);
}

/** Join parts (and an optional suffix) into the row's plain-text phrase. */
export function activityPartsToText(
  parts: readonly ActivityPart[],
  suffix?: string
): string {
  const joined = parts.map(partText).join(" ");
  return suffix ? `${joined} · ${suffix}` : joined;
}

function partText(part: ActivityPart): string {
  switch (part.kind) {
    case ActivityPartKind.Text:
    case ActivityPartKind.Value:
    case ActivityPartKind.Code:
      return part.text;
    case ActivityPartKind.Person:
    case ActivityPartKind.Tag:
      return part.name;
    case ActivityPartKind.Pending:
      return "…";
    case ActivityPartKind.Status:
    case ActivityPartKind.Priority:
      return part.label;
    case ActivityPartKind.Rename:
      return `${part.before} → ${part.after}`;
    default: {
      const unhandled: never = part;
      return unhandled;
    }
  }
}

// ---------------------------------------------------------------------------
// The actor
// ---------------------------------------------------------------------------

/**
 * Resolve the actor against the user directory.
 *
 * - human: the person.
 * - agent: the API-key OWNER (the feed's `actor.id` is the owner's user id,
 *   ISS-10994). The row also carries the API badge, so it never reads as the
 *   owner's own edit.
 * - system: never a person.
 *
 * "Unknown user" is a claim — that we looked the id up and nobody is there —
 * so it is reserved for a settled directory. When the directory is unavailable
 * the row says only what it actually knows.
 */
export function resolveActivityActor(
  actor: ActivityFeedActor,
  users: ActivityDirectory<User> | undefined
): ActivityActorDescription {
  const status = users?.status ?? ActivityDirectoryStatus.Unavailable;
  const base = { kind: actor.kind, user: null, pending: false };
  if (actor.kind === ActivityFeedActorKind.System || actor.id === null) {
    return { ...base, name: actorFallbackName(actor.kind, status) };
  }
  if (status === ActivityDirectoryStatus.Pending) {
    return { ...base, name: null, pending: true };
  }
  const user =
    status === ActivityDirectoryStatus.Ready ? users?.find(actor.id) : null;
  if (user) {
    return { ...base, user, name: getUserDisplayName(user) };
  }
  return { ...base, name: actorFallbackName(actor.kind, status) };
}

function actorFallbackName(
  kind: ActivityFeedActor["kind"],
  status: ActivityDirectoryStatus
): string {
  if (kind === ActivityFeedActorKind.System) {
    return "System";
  }
  if (kind === ActivityFeedActorKind.Agent) {
    return "Agent";
  }
  return status === ActivityDirectoryStatus.Ready ? "Unknown user" : "Member";
}

// ---------------------------------------------------------------------------
// Stored events
// ---------------------------------------------------------------------------

type Phrase = { parts: ActivityPart[]; suffix?: string; href?: string };

function text(content: string): ActivityPart {
  return { kind: ActivityPartKind.Text, text: content };
}

function value(content: string, href?: string | null): ActivityPart {
  return href
    ? { kind: ActivityPartKind.Value, text: content, href }
    : { kind: ActivityPartKind.Value, text: content };
}

function withSuffix(parts: ActivityPart[], suffix: string | undefined): Phrase {
  return suffix === undefined ? { parts } : { parts, suffix };
}

function withHref(parts: ActivityPart[], href: string | null): Phrase {
  return href ? { parts, href } : { parts };
}

function describeEvent(
  item: ArtifactActivityFeedItem,
  lookups: ActivityLookups
): Phrase {
  switch (item.action) {
    case ArtifactActivityAction.Creation:
      return describeCreation(item, lookups);
    case ArtifactActivityAction.StatusChange:
      return describeStatusChange(item, lookups);
    case ArtifactActivityAction.Assignment:
      return describeAssignment(item, lookups);
    case ArtifactActivityAction.FieldChange:
      return describeFieldChange(item, lookups);
    case ArtifactActivityAction.MonitoredActivityRetained:
      return describeMonitoredActivity(item);
    default:
      reportUnknownOnce(lookups, `action:${String(item.action)}`);
      return { parts: [text("made a change")] };
  }
}

/** C01: "created this issue [Draft]". */
function describeCreation(
  item: ArtifactActivityFeedItem,
  lookups: ActivityLookups
): Phrase {
  const after = asJsonObject(item.after);
  const status = after ? readNonEmptyString(after, "status") : null;
  const parts = [text(`created this ${createdNoun(lookups)}`)];
  if (status !== null) {
    parts.push(statusPart(status, lookups));
  }
  return { parts };
}

/**
 * The "created this …" noun, from the canonical badge labels ("Issue", "PRD",
 * "Plan", "Doc", "Template"): lower-case unless it is an acronym.
 */
function createdNoun(lookups: ActivityLookups): string {
  const kind = lookups.artifactKind ?? ActivityArtifactKindValue.Document;
  if (kind !== ActivityArtifactKindValue.Document) {
    return "artifact";
  }
  // A host that does not say which subtype names no subtype: "document",
  // never a guessed "PRD" on an issue.
  const label = lookups.documentType
    ? lookupOwn(DOCUMENT_TYPE_BADGE_LABELS, lookups.documentType)
    : null;
  if (label === null) {
    return "document";
  }
  return label === label.toUpperCase() ? label : label.toLowerCase();
}

/**
 * C02–C07. A System status row on a Session states no cause: the stale-session
 * reaper (C07) and desktop ingest (C06) store identical rows (System,
 * `status_change`, bare strings), so "from desktop sync" or "inactive too
 * long" could be false. Engineering follow-up: record the source.
 */
function describeStatusChange(
  item: ArtifactActivityFeedItem,
  lookups: ActivityLookups
): Phrase {
  const before = readScalarString(item.before);
  const after = readScalarString(item.after);
  const suffix = statusSuffix(item, lookups);
  // A status stored as an id is not a status a reader can use (ISS-5007).
  if ([before, after].some((v) => v !== null && looksLikeId(v))) {
    return withSuffix([text("changed the status")], suffix);
  }

  let parts: ActivityPart[];
  if (after === null) {
    parts = [text("changed the status")];
  } else if (before === null) {
    parts = [text("changed status to"), statusPart(after, lookups)];
  } else {
    parts = [
      text("changed status from"),
      statusPart(before, lookups),
      text("to"),
      statusPart(after, lookups),
    ];
  }
  return withSuffix(parts, suffix);
}

function statusSuffix(
  item: ArtifactActivityFeedItem,
  lookups: ActivityLookups
): string | undefined {
  if (isBulkSurface(item)) {
    return SUFFIX.BulkUpdate;
  }
  if (item.actor.kind !== ActivityFeedActorKind.System) {
    return;
  }
  // On a Document the only System status writer is the blocker-resolution
  // unblock (C04). On a Session the cause is not recorded (see above).
  return lookups.artifactKind === ActivityArtifactKindValue.Session
    ? undefined
    : SUFFIX.Automatically;
}

/** C08–C11. */
function describeAssignment(
  item: ArtifactActivityFeedItem,
  lookups: ActivityLookups
): Phrase {
  const role = activityChangedFieldKey(item) ?? ASSIGNMENT_FIELD;
  const suffix = isBulkSurface(item) ? SUFFIX.BulkUpdate : undefined;
  const generic = withSuffix(
    [
      text(
        role === ASSIGNMENT_FIELD
          ? "updated the assignment"
          : `updated the ${fieldLabel(role)}`
      ),
    ],
    suffix
  );
  const users = lookups.users;
  if (
    users === undefined ||
    users.status === ActivityDirectoryStatus.Unavailable
  ) {
    // We could not look anyone up; say what changed, name nobody.
    return generic;
  }
  const beforeId = readScalarString(item.before);
  const afterId = readScalarString(item.after);
  const parts = assignmentParts(
    role,
    beforeId === null ? null : personPart(beforeId, users),
    afterId === null ? null : personPart(afterId, users)
  );
  return parts === null ? generic : withSuffix(parts, suffix);
}

function assignmentParts(
  role: string,
  before: ActivityPart | null,
  after: ActivityPart | null
): ActivityPart[] | null {
  if (role === "approverId") {
    if (before !== null && after !== null) {
      return [text("changed approver from"), before, text("to"), after];
    }
    return after === null ? null : [text("set"), after, text("as approver")];
  }
  if (role === "ownerUserId") {
    if (before !== null && after !== null) {
      return [text("changed owner from"), before, text("to"), after];
    }
    return after === null ? null : [text("set owner to"), after];
  }
  // assigneeId, and a legacy bare-id row (always an assignee).
  if (before !== null && after !== null) {
    return [text("reassigned from"), before, text("to"), after];
  }
  if (after !== null) {
    return [text("assigned"), after];
  }
  return before === null ? null : [text("unassigned"), before];
}

function personPart(id: string, users: ActivityDirectory<User>): ActivityPart {
  if (users.status === ActivityDirectoryStatus.Pending) {
    return { kind: ActivityPartKind.Pending, id };
  }
  const user = users.find(id);
  return {
    kind: ActivityPartKind.Person,
    id,
    name: user ? getUserDisplayName(user) : UNKNOWN_USER_LABEL,
  };
}

/** Only ever shown for a settled directory, where a miss is a real absence. */
const UNKNOWN_USER_LABEL = "Unknown user";
const UNKNOWN_PROJECT_LABEL = "Unknown project";

/** C12–C29. */
function describeFieldChange(
  item: ArtifactActivityFeedItem,
  lookups: ActivityLookups
): Phrase {
  const field = activityChangedFieldKey(item);
  switch (field) {
    case null:
      return { parts: [text("updated a field")] };
    case TAG_FIELD:
      return describeTagChange(item, lookups);
    case "title":
      return describeRename(item, "changed the title");
    case SESSION_NAME_FIELD:
      return describeSessionName(item, lookups);
    case "dueDate":
      return describeDueDate(item);
    case "priority":
      return describePriority(item, lookups);
    case PROJECT_FIELD:
      return describeProjectMove(item, lookups);
    default:
      reportUnknownOnce(lookups, `field:${field}`);
      return { parts: [text(`updated ${fieldLabel(field)}`)] };
  }
}

/**
 * C25–C29. The batch writer omits `before` entirely (C25), which is the one
 * bulk signal a tag row carries; a single add stores `{field:'tag', value:null}`.
 */
function describeTagChange(
  item: ArtifactActivityFeedItem,
  lookups: ActivityLookups
): Phrase {
  const before = readScalarString(item.before);
  const after = readScalarString(item.after);
  const suffix =
    item.before === null || isBulkSurface(item) ? SUFFIX.BulkUpdate : undefined;
  let verb: string;
  let tagId: string;
  if (after !== null && before === null) {
    verb = "added";
    tagId = after;
  } else if (before !== null && after === null) {
    verb = "removed";
    tagId = before;
  } else {
    return withSuffix([text("updated the tag")], suffix);
  }
  if (lookups.tags?.status === ActivityDirectoryStatus.Pending) {
    // Hold the tag's place while the directory reads, like a pending name.
    return withSuffix(
      [
        text(`${verb} the`),
        { kind: ActivityPartKind.Pending, id: tagId },
        text("tag"),
      ],
      suffix
    );
  }
  const tag =
    lookups.tags?.status === ActivityDirectoryStatus.Ready
      ? lookups.tags.find(tagId)
      : null;
  if (!tag) {
    // Not resolvable: say which way it went, name nothing.
    return withSuffix([text(`${verb} a tag`)], suffix);
  }
  return withSuffix(
    [
      text(`${verb} the`),
      {
        kind: ActivityPartKind.Tag,
        id: tag.id,
        name: tag.name,
        color: tag.color,
      },
      text("tag"),
    ],
    suffix
  );
}

/** C12 / C23: the old value struck through, the new one in bold. */
function describeRename(item: ArtifactActivityFeedItem, verb: string): Phrase {
  const before = formatSnapshotValue(item.before);
  const after = formatSnapshotValue(item.after);
  const parts: ActivityPart[] = [text(verb)];
  if (before !== null && after !== null) {
    parts.push({ kind: ActivityPartKind.Rename, before, after });
  } else if (after !== null) {
    parts.push(value(after));
  }
  return { parts };
}

const SESSION_NAME_FIELD = "name";

/** C23 / C24. */
function describeSessionName(
  item: ArtifactActivityFeedItem,
  lookups: ActivityLookups
): Phrase {
  if (item.actor.kind === ActivityFeedActorKind.System) {
    const after = formatSnapshotValue(item.after);
    const parts = [text("named this session")];
    if (after !== null) {
      parts.push(value(after));
    }
    return { parts, suffix: SUFFIX.DesktopSync };
  }
  return describeRename(
    item,
    lookups.artifactKind === ActivityArtifactKindValue.Session
      ? "renamed this session"
      : "renamed this"
  );
}

/** C13. */
function describeDueDate(item: ArtifactActivityFeedItem): Phrase {
  const rawBefore = unwrapSnapshotScalar(item.before);
  const rawAfter = unwrapSnapshotScalar(item.after);
  const before = formatDateValue(rawBefore);
  const after = formatDateValue(rawAfter);
  // A side that holds something we cannot read as a date is not "no date":
  // say the date changed and name no value, never an epoch or JSON.
  const unreadable =
    (rawBefore !== null && before === null) ||
    (rawAfter !== null && after === null);
  if (unreadable) {
    return { parts: [text("changed the due date")] };
  }
  if (before !== null && after !== null) {
    return { parts: [text(`changed due date from ${before} to ${after}`)] };
  }
  if (after !== null) {
    return { parts: [text(`set due date to ${after}`)] };
  }
  return { parts: [text("removed the due date")] };
}

/** C14–C18. */
function describePriority(
  item: ArtifactActivityFeedItem,
  lookups: ActivityLookups
): Phrase {
  const before = readScalarString(item.before);
  const after = readScalarString(item.after);
  const suffix = fieldSuffix(item, lookups, SUFFIX.BulkUpdate);
  if ([before, after].some((v) => v !== null && looksLikeId(v))) {
    return withSuffix([text("updated the priority")], suffix);
  }
  let parts: ActivityPart[];
  if (after === null) {
    parts = [text("cleared priority")];
  } else if (before === null) {
    parts = [text("set priority"), priorityPart(after)];
  } else {
    parts = [
      text("changed priority from"),
      priorityPart(before),
      text("to"),
      priorityPart(after),
    ];
  }
  return withSuffix(parts, suffix);
}

/** C19–C22. */
function describeProjectMove(
  item: ArtifactActivityFeedItem,
  lookups: ActivityLookups
): Phrase {
  const suffix = fieldSuffix(item, lookups, SUFFIX.BulkMove);
  const generic = withSuffix([text("updated the project")], suffix);
  const projects = lookups.projects;
  const afterId = readScalarString(item.after);
  if (
    projects === undefined ||
    projects.status === ActivityDirectoryStatus.Unavailable ||
    afterId === null
  ) {
    return generic;
  }
  const beforeId = readScalarString(item.before);
  const subject =
    lookups.artifactKind === ActivityArtifactKindValue.Session &&
    !isBulkSurface(item)
      ? "this session"
      : "this";
  const after = projectPart(afterId, projects);
  const parts =
    beforeId === null
      ? [text(`moved ${subject} to`), after]
      : [
          text(`moved ${subject} from`),
          projectPart(beforeId, projects),
          text("to"),
          after,
        ];
  return withSuffix(parts, suffix);
}

function projectPart(
  id: string,
  projects: ActivityDirectory<{ id: string; name: string }>
): ActivityPart {
  if (projects.status === ActivityDirectoryStatus.Pending) {
    return { kind: ActivityPartKind.Pending, id };
  }
  return value(projects.find(id)?.name ?? UNKNOWN_PROJECT_LABEL);
}

/**
 * The context of a field write: a bulk write first (the receipt's `surface`),
 * then a System write, which on a Session is always desktop sync (C18, C22).
 */
function fieldSuffix(
  item: ArtifactActivityFeedItem,
  lookups: ActivityLookups,
  bulkSuffix: string
): string | undefined {
  if (isBulkSurface(item)) {
    return bulkSuffix;
  }
  if (
    item.actor.kind === ActivityFeedActorKind.System &&
    lookups.artifactKind === ActivityArtifactKindValue.Session
  ) {
    return SUFFIX.DesktopSync;
  }
  return;
}

/**
 * C30 / C31: Session sync retained evidence about a branch or pull request it
 * could not link. Stored on Sessions, excluded from the V1 feed today.
 */
function describeMonitoredActivity(item: ArtifactActivityFeedItem): Phrase {
  const after = asJsonObject(item.after);
  const kind = after ? readNonEmptyString(after, "kind") : null;
  const branch = after ? readNonEmptyString(after, "branchName") : null;
  const prNumber =
    after && Object.hasOwn(after, "prNumber") ? after.prNumber : null;
  if (kind === "branch" && branch !== null) {
    return {
      parts: [
        text("recorded activity on branch"),
        { kind: ActivityPartKind.Code, text: branch },
      ],
      suffix: SUFFIX.NotLinkedYet,
    };
  }
  if (kind === "pull_request" && typeof prNumber === "number") {
    return {
      parts: [text("recorded activity on PR"), value(`#${prNumber}`)],
      suffix: SUFFIX.NotLinkedYet,
    };
  }
  return { parts: [text("recorded activity")], suffix: SUFFIX.NotLinkedYet };
}

// ---------------------------------------------------------------------------
// On-read projections (Document feed only)
// ---------------------------------------------------------------------------

function describeProjection(
  item: ArtifactActivityFeedItem,
  lookups: ActivityLookups
): Phrase {
  const payload = asJsonObject(item.payload);
  switch (item.source) {
    case ActivityFeedItemSource.VersionCreated:
      return describeVersion(payload, lookups);
    case ActivityFeedItemSource.Derivation:
      return describeDerivation(payload, lookups);
    case ActivityFeedItemSource.Evaluation:
      return describeEvaluation(payload, lookups);
    default:
      reportUnknownOnce(lookups, `source:${String(item.source)}`);
      return { parts: [text("updated this artifact")] };
  }
}

/** P1: "edited the document · v2", the version linking to that version. */
function describeVersion(
  payload: JsonObject | null,
  lookups: ActivityLookups
): Phrase {
  const version = payload?.version;
  if (typeof version !== "number") {
    return { parts: [text("edited the document")] };
  }
  const href = lookups.versionHref?.(version) ?? null;
  return withHref(
    [text("edited the document ·"), value(`v${version}`, href)],
    href
  );
}

/** P2: "produced PRD-751 Title" / "was produced from ISS-10843 Title". */
function describeDerivation(
  payload: JsonObject | null,
  lookups: ActivityLookups
): Phrase {
  const producedFrom =
    payload !== null &&
    readNonEmptyString(payload, "direction") === "produced_from";
  const relatedId = payload
    ? readNonEmptyString(payload, "relatedArtifactId")
    : null;
  const related =
    relatedId === null ? null : (lookups.relatedArtifact?.(relatedId) ?? null);
  if (related === null) {
    // No lookup for the related artifact: say which way it went, name nothing.
    return {
      parts: [
        text(
          producedFrom
            ? "was derived from another artifact"
            : "produced a related artifact"
        ),
      ],
    };
  }
  const href = related.href ?? null;
  return withHref(
    [
      text(producedFrom ? "was produced from" : "produced"),
      value(`${related.key} ${related.title}`, href),
    ],
    href
  );
}

/** P4: "added a Plan evaluation report", linking to the report. */
function describeEvaluation(
  payload: JsonObject | null,
  lookups: ActivityLookups
): Phrase {
  const reportType = payload ? readNonEmptyString(payload, "reportType") : null;
  if (reportType === null) {
    return { parts: [text("ran an evaluation")] };
  }
  const href = lookups.reportHref?.({ reportType }) ?? null;
  return withHref(
    [
      text("added a"),
      value(sentenceCase(reportType), href),
      text("evaluation report"),
    ],
    href
  );
}

// ---------------------------------------------------------------------------
// Pills
// ---------------------------------------------------------------------------

/**
 * One status, worded in the vocabulary of the artifact it belongs to and
 * coloured from the champion status registry (`resolveArtifactStatusMark`),
 * so the pill carries the same tone as the status badge everywhere else.
 */
function statusPart(raw: string, lookups: ActivityLookups): ActivityPart {
  const facet =
    lookups.artifactKind === ActivityArtifactKindValue.Session
      ? sessionStatusFacet(raw)
      : documentStatusFacet(documentTypeFor(raw, lookups), raw);
  return {
    kind: ActivityPartKind.Status,
    raw,
    label: statusLabel(raw, facet, lookups),
    tone: resolveArtifactStatusMark(facet).tone,
  };
}

function statusLabel(
  raw: string,
  facet: ArtifactStatusFacet,
  lookups: ActivityLookups
): string {
  if (lookups.universalStatus) {
    return artifactStatusLabel(facet);
  }
  if (lookups.artifactKind === ActivityArtifactKindValue.Session) {
    return lookupOwn(SESSION_STATUS_LABELS, raw) ?? raw;
  }
  return (
    lookupOwn(DOCUMENT_STATUS_LABELS, raw) ??
    lookupOwn(ISSUE_STATUS_LABELS, raw) ??
    raw
  );
}

/**
 * The subtype whose vocabulary colours a status: the host's when it owns the
 * value, otherwise whichever vocabulary does (the two overlap only on
 * IN_REVIEW, identically).
 */
function documentTypeFor(raw: string, lookups: ActivityLookups): DocumentType {
  const owner = Object.hasOwn(ISSUE_STATUS_LABELS, raw)
    ? DocumentType.Feature
    : DocumentType.Prd;
  const host = lookups.documentType;
  if (host === undefined) {
    return owner;
  }
  // The host's vocabulary when it owns the value; a value only the other
  // vocabulary owns (an Issue row carrying a Document status) keeps its colour.
  const hostIsIssue = host === DocumentType.Feature;
  const ownedByHost = hostIsIssue
    ? Object.hasOwn(ISSUE_STATUS_LABELS, raw)
    : Object.hasOwn(DOCUMENT_STATUS_LABELS, raw);
  return ownedByHost ? host : owner;
}

function priorityPart(raw: string): ActivityPart {
  return {
    kind: ActivityPartKind.Priority,
    value: raw,
    label: lookupOwn(PRIORITY_LABELS, raw) ?? raw,
  };
}

// ---------------------------------------------------------------------------
// Unknown rows
// ---------------------------------------------------------------------------

const reportedKeys = new WeakMap<(key: string) => void, Set<string>>();

/**
 * A row this build has no wording for still renders (the generic fallback),
 * and the host hears about it once per key through `onUnknown`. Not a
 * `console.warn`: client-bundled code may not log
 * (`scripts/lint/rules/no-client-debug-logging.ts`), so a dev host or a test
 * passes a reporter instead.
 */
function reportUnknownOnce(lookups: ActivityLookups, key: string): void {
  const report = lookups.onUnknown;
  if (report === undefined) {
    return;
  }
  const seen = reportedKeys.get(report) ?? new Set<string>();
  reportedKeys.set(report, seen);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  report(key);
}
