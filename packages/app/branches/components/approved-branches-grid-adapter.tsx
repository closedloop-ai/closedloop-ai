"use client";

import {
  ArtifactStatusEditSurface,
  ArtifactStatusVocabulary,
} from "@repo/api/src/types/artifact-status-contract";
import {
  BranchDataState,
  BranchTagAvailability,
} from "@repo/api/src/types/branch";
import { RELATED_SESSIONS_DISPLAY_CAP } from "@repo/api/src/types/related-session";
import { TagEntityType } from "@repo/api/src/types/tag";
// Intentional cross-feature copy reuse: Branch chips and Session timelines need
// the same approved fallback for an owner identity that cannot be resolved.
import { UNKNOWN_OWNER_LABEL } from "@repo/app/agents/lib/session-timeline-stacks";
import { ArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { Collaborators } from "@repo/app/shared/components/collaborators";
// ISS-8972: the Related Sessions grid cell is cross-feature presentation owned
// by `shared/`, composed here with Branch domain values. A feature slice may
// import `shared/*` (packages/app/AGENTS.md); the reverse is what is forbidden.
import {
  RelatedSessionsTableCell,
  type RelatedSessionTableItem,
} from "@repo/app/shared/components/generic-artifact-surface/related-sessions-table-cell";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { artifactStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import {
  isFilterableColumn,
  isGroupableColumn,
  isSortableColumn,
} from "@repo/app/shared/lib/column-view-model";
import { BRANCHES_LINKED_SESSION_CHIPS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { getInitials } from "@repo/app/shared/lib/user-utils";
import { EntityTagsCell } from "@repo/app/tags/components/entity-tags-cell";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  CountCell,
  isCountCellEmpty,
} from "@repo/design-system/components/ui/count-cell";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import {
  PERSON_AVATAR_PRIMARY_FALLBACK_CLASS_NAME,
  PersonAvatar,
} from "@repo/design-system/components/ui/person-avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { MIN_COLUMN_WIDTH_PX } from "@repo/design-system/lib/column-order";
import {
  type ColumnDefinition,
  ColumnFieldKind,
  type ColumnRegistry,
  createColumnRegistry,
} from "@repo/design-system/lib/column-registry";
import type { CountNoun } from "@repo/design-system/lib/count-noun";
import { Link } from "@repo/navigation/link";
import {
  FolderGit2Icon,
  GitBranchIcon,
  Loader2Icon,
  MessageSquareIcon,
  UsersIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useBranchesQueryContextOptional } from "../data-source/provider";
import {
  BRANCH_COLUMN_VIEW_MODEL,
  type BRANCH_NAME_COLUMN_ID,
  BRANCH_PROJECT_COLUMN_ID,
  BRANCH_SESSIONS_COLUMN_ID,
  type BranchColumnViewModelId,
  branchColumnLabel,
} from "../lib/branch-column-view-model";
import { repositoryDisplayLabels } from "../lib/branch-repository-display-labels";
import {
  type BranchRow,
  type BranchRowSession,
  branchStatusEvidence,
  RENDER_MISSING,
  RENDER_UNATTRIBUTED,
} from "../lib/branch-row";
import { BranchChangesBar } from "./branch-changes-bar";
import { BranchPRBadge } from "./branch-pr-badge";
import { BranchPriorityCell } from "./branch-priority-cell";
import { BranchProjectValue } from "./branch-project-value";
import { renderBranchStatus } from "./branch-status";
import { BranchUnavailableValue } from "./branch-unavailable-value";

export type ApprovedBranchColumnSpec = {
  id: ApprovedBranchColumnId;
  label: string;
  width: string;
  sortable?: boolean;
  /** @see GridTableV2Column.filterable */
  filterable?: boolean;
  /** @see GridTableV2Column.groupable */
  groupable?: boolean;
  tooltip?: string;
};

/**
 * The table's own half of a column: its grid track.
 *
 * Deliberately NOT its capabilities and NOT its header wording. ISS-9676 moved
 * both to {@link BRANCH_COLUMN_VIEW_MODEL}, which the toolbar menus read too —
 * a column whose header sorts while the Sort menu does not offer it, or whose
 * header and Sort entry spell it differently, is what two declarations produce.
 * ISS-10816 keeps the canonical "Linked sessions" label in every reader while
 * the cell's own flag swaps only the count/chips presentation. The sort key
 * remains the uncapped linked-session count under either cell presentation.
 */
type ApprovedBranchColumnGeometry = {
  /**
   * A DATA column. The lead identity column is chrome with its own
   * {@link APPROVED_BRANCH_LEAD_WIDTH} track, so excluding it here is what makes
   * this array the exact set a column registry may be built from.
   */
  id: Exclude<BranchColumnViewModelId, typeof BRANCH_NAME_COLUMN_ID>;
  width: string;
  tooltip?: string;
};

export type ApprovedBranchLeadRenderInput = {
  item: BranchRow;
  className: string;
  children: ReactNode;
};

export const APPROVED_BRANCH_LEAD_WIDTH = "minmax(300px, 1fr)";

const APPROVED_BRANCH_COLUMN_GEOMETRY: readonly ApprovedBranchColumnGeometry[] =
  [
    { id: "owner", width: "180px" },
    // ISS-10332 / PLN-2086: Priority sits beside the identity columns and
    // ships SHOWN by default in new and existing views (operator ruling 5,
    // 2026-09-21) — a saved view that predates it gains it at this slot.
    { id: "priority", width: "120px" },
    { id: "collaborators", width: "150px" },
    { id: BRANCH_SESSIONS_COLUMN_ID, width: "140px" },
    { id: "changes", width: "140px" },
    { id: "status", width: "145px" },
    // ISS-8422 widened this from the 150px ISS-7362 (#6328) deliberately kept.
    // The unobserved state word needs room beside the PR number.
    { id: "pr", width: "200px" },
    { id: "lastActivity", width: "130px" },
    { id: "repo", width: "190px" },
    { id: "tags", width: "210px" },
    { id: BRANCH_PROJECT_COLUMN_ID, width: "160px" },
  ];

export const APPROVED_BRANCH_COLUMN_SPECS: readonly ApprovedBranchColumnSpec[] =
  APPROVED_BRANCH_COLUMN_GEOMETRY.map((geometry) => ({
    ...geometry,
    label: branchColumnLabel(geometry.id),
    filterable: isFilterableColumn(BRANCH_COLUMN_VIEW_MODEL, geometry.id),
    groupable: isGroupableColumn(BRANCH_COLUMN_VIEW_MODEL, geometry.id),
    sortable: isSortableColumn(BRANCH_COLUMN_VIEW_MODEL, geometry.id),
  }));

export function approvedBranchRepositoryLabels(
  rows: readonly BranchRow[]
): ReadonlyMap<string, string> {
  return repositoryDisplayLabels(rows);
}

export function renderApprovedBranchLead(
  item: BranchRow,
  getBranchHref?: (item: BranchRow) => string,
  renderBranchLink?: (input: ApprovedBranchLeadRenderInput) => ReactNode,
  { showStatusIcon = false }: { showStatusIcon?: boolean } = {}
): ReactNode {
  const icon = branchLeadIcon(item, showStatusIcon);
  const standaloneStatusIcon =
    showStatusIcon && item.dataState !== BranchDataState.AwaitingSync;
  const content = (
    <span className="flex min-w-0 items-center gap-2 font-medium text-sm">
      {standaloneStatusIcon ? null : icon}
      <span className="truncate font-mono">{item.branchName}</span>
      {renderBranchCommentCount(item.commentCount)}
    </span>
  );
  let lead: ReactNode = content;
  if (renderBranchLink) {
    lead = renderBranchLink({
      item,
      className: showStatusIcon
        ? "min-h-6 min-w-0 max-w-full self-start items-center hover:underline"
        : "min-w-0 hover:underline",
      children: content,
    });
  } else if (getBranchHref) {
    lead = (
      <Link
        className={
          showStatusIcon
            ? "inline-flex min-h-6 min-w-0 max-w-full items-center self-start hover:underline"
            : "min-w-0 hover:underline"
        }
        href={getBranchHref(item)}
      >
        {content}
      </Link>
    );
  }
  return standaloneStatusIcon ? (
    <span className="flex min-w-0 items-center gap-2">
      {icon}
      {lead}
    </span>
  ) : (
    lead
  );
}

export function renderApprovedBranchCell(
  columnId: string,
  item: BranchRow,
  repositoryLabels: ReadonlyMap<string, string>,
  getSessionsHref: ((item: BranchRow) => string) | undefined,
  tagsReadOnly: boolean,
  /**
   * The V2 surface capability, distinct from the flag this cell reads at the
   * swap. The legacy table omits it and keeps the count chip.
   */
  sessionsCell: {
    chipsSupportedBySurface?: boolean;
    getSessionHref?: (session: BranchRowSession) => string;
  } = {}
): ReactNode {
  switch (columnId) {
    case "owner":
      return item.owner === RENDER_UNATTRIBUTED ? (
        <span className="text-muted-foreground text-xs">Unattributed</span>
      ) : (
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <PersonAvatar
            avatarUrl={item.ownerAvatarUrl}
            className="size-6"
            decorative
            fallbackClassName={`${PERSON_AVATAR_PRIMARY_FALLBACK_CLASS_NAME} font-medium`}
            initials={getInitials(item.owner)}
            name={item.owner}
          />
          <span className="truncate">{item.owner}</span>
        </span>
      );
    case "collaborators":
      return <Collaborators people={item.collaborators ?? []} />;
    case BRANCH_SESSIONS_COLUMN_ID:
      return (
        <BranchLinkedSessionsCell
          getSessionHref={sessionsCell.getSessionHref}
          getSessionsHref={getSessionsHref}
          item={item}
          supportsChips={sessionsCell.chipsSupportedBySurface === true}
        />
      );
    case "changes":
      return item.additions === null || item.deletions === null ? (
        <BranchUnavailableValue />
      ) : (
        <BranchChangesBar
          additions={item.additions}
          deletions={item.deletions}
        />
      );
    case "status":
      return renderBranchStatus(item, item.artifactId ?? item.id);
    case "pr":
      return (
        <BranchPRBadge
          prNumber={item.prNumber}
          prState={item.prState}
          prTitle={item.prTitle}
          prUrl={item.prUrl}
          repoShortName={prRepoLabel(item.prRepo, repositoryLabels)}
        />
      );
    case "lastActivity":
      return item.lastActivityAt ? (
        <span className="text-muted-foreground text-xs">
          {item.lastActivityLabel}
        </span>
      ) : (
        <BranchUnavailableValue />
      );
    case "repo":
      return item.repo === RENDER_MISSING ? (
        <BranchUnavailableValue />
      ) : (
        <RepositoryLink
          displayName={repositoryLabels.get(item.repo) ?? item.repo}
          repositoryFullName={item.repo}
        />
      );
    case "tags":
      return <BranchTags item={item} readOnly={tagsReadOnly} />;
    case "priority":
      // ISS-10332: read-only under the same host condition the tag picker is
      // (an offline desktop), because both write to the same cloud artifact.
      return <BranchPriorityCell item={item} readOnly={tagsReadOnly} />;
    case BRANCH_PROJECT_COLUMN_ID:
      // ISS-12453: ABSENT is "this producer has no project concept", never
      // "filed into no project", which `null` is and which the picker exists
      // to answer. ISS-12456 then hid the whole column in Desktop single-user
      // mode, so the producer that motivated this arm no longer reaches it:
      // what remains is a version-skewed producer that offers the column and
      // omits the field on a row, which `BranchRow.projectId` being optional
      // keeps representable. Read-only under the same host condition as
      // priority/tags: all three write to the same cloud artifact.
      return item.projectId === undefined ? (
        <BranchUnavailableValue />
      ) : (
        <BranchProjectValue
          artifactId={item.artifactId ?? null}
          projectId={item.projectId}
          projectName={item.projectName ?? null}
          readOnly={tagsReadOnly}
          surface={ArtifactStatusEditSurface.InlineCell}
        />
      );
    default:
      return null;
  }
}

/** The word an unattributed Session's chip uses, so initials are never blank. */
const BRANCH_SESSION_UNATTRIBUTED_OWNER = "Unattributed";

/**
 * ISS-8972 / ISS-10816 — canonical Linked Sessions chips from the Branch list
 * projection, with the uncapped count retained as the overflow total.
 */
function BranchLinkedSessionsCell({
  getSessionHref,
  getSessionsHref,
  item,
  supportsChips,
}: {
  getSessionHref?: (session: BranchRowSession) => string;
  getSessionsHref?: (item: BranchRow) => string;
  item: BranchRow;
  supportsChips: boolean;
}) {
  const chipsEnabled = useFeatureFlagEnabledOptional(
    BRANCHES_LINKED_SESSION_CHIPS_FEATURE_FLAG_KEY
  );
  if (chipsEnabled && supportsChips && item.sessions?.length) {
    return (
      <RelatedSessionsTableCell
        items={item.sessions
          .slice(0, RELATED_SESSIONS_DISPLAY_CAP)
          .map((session) => toRelatedSessionItem(session, getSessionHref))}
        total={item.sessionCount}
      />
    );
  }
  return renderSessionCount(item, getSessionsHref);
}

/**
 * Project one Branch-domain Session row into the shared cell's item contract.
 *
 * A chip names a destination OR an action, never both, so the href is spread in
 * only when the host supplied a builder — a host with no Session route yields a
 * read-only chip rather than a dead link.
 */
function toRelatedSessionItem(
  session: BranchRowSession,
  getSessionHref?: (session: BranchRowSession) => string
): RelatedSessionTableItem {
  const identity = {
    id: session.id,
    occurredAt: session.occurredAt,
    ...(session.ownerAvatarUrl
      ? { ownerAvatarUrl: session.ownerAvatarUrl }
      : {}),
    ownerName:
      session.ownerName ??
      (session.ownerUnavailable
        ? UNKNOWN_OWNER_LABEL
        : BRANCH_SESSION_UNATTRIBUTED_OWNER),
    relationshipLabel: session.relationshipLabel,
    ...(session.rawStatus === undefined
      ? {}
      : { rawStatus: session.rawStatus }),
    sessionSlug: session.slug,
    status: session.status,
  };
  const href = getSessionHref?.(session);
  return href ? { ...identity, href } : identity;
}

const LINKED_SESSION_COUNT_NOUN = "linked session";

function sessionCountLabel(item: BranchRow, count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"} for ${item.branchName}`;
}

/**
 * The linked-session count chip, linked to the Branch Sessions tab that renders
 * the same canonical membership population.
 */
function renderSessionCount(
  item: BranchRow,
  getSessionsHref?: (item: BranchRow) => string
): ReactNode {
  if (item.sessionCount === 0) {
    return <GridEmptyValue />;
  }
  const content = (
    <Chip className="gap-1" size="sm" variant="muted">
      <UsersIcon aria-hidden className="size-3 shrink-0" />
      {item.sessionCount}
    </Chip>
  );
  return getSessionsHref ? (
    <Chip asChild className="gap-1" size="sm" variant="muted">
      <Link
        aria-label={sessionCountLabel(
          item,
          item.sessionCount,
          LINKED_SESSION_COUNT_NOUN
        )}
        href={getSessionsHref(item)}
      >
        <UsersIcon aria-hidden className="size-3 shrink-0" />
        {item.sessionCount}
      </Link>
    </Chip>
  ) : (
    content
  );
}

function BranchTags({
  item,
  readOnly,
}: {
  item: BranchRow;
  readOnly: boolean;
}) {
  // ISS-12452: this row is cached in the Branch-owned query client on
  // desktop, distinct from the ambient one the tag mutations default to —
  // without threading it through, an apply or remove invalidates a cache
  // nothing here reads from. The OPTIONAL resolution (never throws) because
  // this cell mounts in grid-alignment tests and Storybook with no
  // `QueryClientProvider` ancestor at all; resolved ahead of the early
  // return below so hook order never depends on availability.
  const { queryClient } = useBranchesQueryContextOptional();
  if (item.tagAvailability === BranchTagAvailability.Unavailable) {
    return <BranchUnavailableValue />;
  }
  // ISS-9215: this cell's rendering IS `EntityTagsCell` — it was the reference
  // the shared cell was extracted from, so only the branch-specific
  // availability vocabulary and row shape stay here.
  return (
    <EntityTagsCell
      canApply={Boolean(!readOnly && item.tagPermissions?.canApply)}
      canRemove={Boolean(!readOnly && item.tagPermissions?.canRemove)}
      editLabel={`Edit tags for ${item.branchName}`}
      entityId={item.artifactId ?? null}
      entityType={TagEntityType.Artifact}
      queryClient={queryClient ?? undefined}
      surface={ArtifactStatusEditSurface.InlineCell}
      tags={item.tags ?? []}
    />
  );
}

function RepositoryLink({
  displayName,
  repositoryFullName,
}: {
  displayName: string;
  repositoryFullName: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          aria-label={`${repositoryFullName} repository on GitHub`}
          className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground hover:underline"
          href={repositoryUrl(repositoryFullName)}
          rel="noreferrer"
          target="_blank"
          title={repositoryFullName}
        >
          <FolderGit2Icon aria-hidden className="size-3.5 shrink-0" />
          <span aria-hidden className="truncate">
            {displayName}
          </span>
        </a>
      </TooltipTrigger>
      <TooltipContent>{repositoryFullName}</TooltipContent>
    </Tooltip>
  );
}

function repositoryUrl(repositoryFullName: string): string {
  return `https://github.com/${repositoryFullName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function prRepoLabel(
  prRepo: string | null | undefined,
  repositoryLabels: ReadonlyMap<string, string>
): string | null {
  if (!prRepo) {
    return null;
  }
  return repositoryLabels.get(prRepo) ?? prRepo;
}

type ApprovedBranchColumnId = ApprovedBranchColumnGeometry["id"];

/**
 * What SHAPE each Branches data column holds — the one fact the geometry and the
 * view model between them do not state, and the one the registry keys its
 * capability rules and its default alignment off.
 *
 * Exhaustive over the geometry, so a tenth column fails `tsc` here until someone
 * says what it is rather than falling through to a permissive default.
 *
 * `changes` is {@link ColumnFieldKind.Custom} and not `Number`: the cell is a
 * proportion bar this surface renders itself, not a figure. `Number` resolves
 * to {@link ColumnAlignment.End}, which would put `justify-end` on the whole
 * cell — moving both the `Unavailable` string and the `+N −N` block with its
 * bar to the trailing edge, since {@link BranchChangesBar}'s root is a
 * `min-w-0 flex-col`, not a filled `w-full` track.
 */
const APPROVED_BRANCH_COLUMN_KINDS = {
  changes: ColumnFieldKind.Custom,
  collaborators: ColumnFieldKind.PersonList,
  lastActivity: ColumnFieldKind.Date,
  owner: ColumnFieldKind.Person,
  pr: ColumnFieldKind.Reference,
  priority: ColumnFieldKind.Choice,
  project: ColumnFieldKind.Reference,
  repo: ColumnFieldKind.Reference,
  sessions: ColumnFieldKind.Reference,
  status: ColumnFieldKind.Choice,
  tags: ColumnFieldKind.ChoiceList,
} as const satisfies Record<ApprovedBranchColumnId, ColumnFieldKind>;

// Above {@link APPROVED_BRANCH_COLUMN_DEFINITIONS}, which is the one thing here
// that calls the parser during module evaluation.
const PIXEL_WIDTH_SUFFIX = "px";

/** The px number behind a geometry track, or the shared floor when unparseable. */
export function approvedBranchColumnPixelWidth(width: string): number {
  const parsed = width.endsWith(PIXEL_WIDTH_SUFFIX)
    ? Number.parseFloat(width.slice(0, -PIXEL_WIDTH_SUFFIX.length))
    : Number.NaN;
  return Number.isFinite(parsed) ? parsed : MIN_COLUMN_WIDTH_PX;
}

/**
 * Turn one rendered spec set into the declarations a registry is built from.
 *
 * Takes the specs rather than reading {@link APPROVED_BRANCH_COLUMN_SPECS}
 * directly so a host-provided registry remains derived from the same column
 * labels and capabilities the surface renders. ISS-10816 keeps the sessions
 * label canonical while changing only the cell presentation.
 */
function approvedBranchColumnDefinitions(
  specs: readonly ApprovedBranchColumnSpec[]
): readonly ColumnDefinition[] {
  return specs.map(({ width, ...spec }) => ({
    ...spec,
    kind: APPROVED_BRANCH_COLUMN_KINDS[spec.id],
    width: { default: approvedBranchColumnPixelWidth(width) },
  }));
}

/**
 * The declarations behind the DEFAULT spec set, exported so a test can hold them
 * to `validateColumnDefinitions` and name the offending column — the one read
 * that is eager, and the reason a refusal is a named test failure before it is a
 * render-time throw.
 */
export const APPROVED_BRANCH_COLUMN_DEFINITIONS: readonly ColumnDefinition[] =
  approvedBranchColumnDefinitions(APPROVED_BRANCH_COLUMN_SPECS);

/**
 * ISS-9316 / PRD-716 phase 06 — the Branches data columns as ONE declaration
 * set, so `resolveColumnLayout` can derive the columns, the track string, the
 * visible order and the widths together instead of this surface deriving each
 * beside the others.
 *
 * Mapped from the rendered specs rather than re-derived from the geometry: the
 * specs already resolve every column's wording and its three capabilities, so
 * reading them here means the registry path and the path it replaces cannot come
 * to describe one column two ways while both ship. This adds only the two facts
 * a spec has no room for — the column's `kind`, and its track restated as a
 * width bound.
 *
 * No column declares `movable`, `resizable` or `hideable`, which is the
 * declaration this surface actually makes: every ordered column is the reader's
 * to move and every measured one is theirs to resize, exactly as today.
 *
 * Built on FIRST USE, not at module scope, and that is what makes
 * `branches-column-registry` a real rollback: `createColumnRegistry` throws on a
 * refused declaration, and at module scope that throw travels with the import —
 * taking the Branches list down on the very arm the gate exists to fall back to.
 * Behind this accessor a refusal reaches only the OPEN arm, mid-render, and the
 * closed arm never constructs a registry at all.
 *
 * Memoized per spec set, keyed on the array's identity: the two sets a surface
 * can hand down are both module constants, and a `WeakMap` cannot outlive them.
 *
 * The pair that has to keep agreeing is a column's `groupable`, which the view
 * model decides, and its `kind`, which the record above does; no type links
 * them, so `approved-branch-column-registry.test.ts` runs the same validation
 * eagerly and names the offending column before CI goes green.
 */
export function approvedBranchColumnRegistry(
  specs: readonly ApprovedBranchColumnSpec[]
): ColumnRegistry {
  const cached = branchColumnRegistries.get(specs);
  if (cached) {
    return cached;
  }
  const registry = createColumnRegistry(approvedBranchColumnDefinitions(specs));
  branchColumnRegistries.set(specs, registry);
  return registry;
}

const branchColumnRegistries = new WeakMap<
  readonly ApprovedBranchColumnSpec[],
  ColumnRegistry
>();

const BRANCH_COMMENTS_NOUN: CountNoun = { one: "comment", other: "comments" };

function renderBranchCommentCount(count: BranchRow["commentCount"]): ReactNode {
  if (isCountCellEmpty(count, false)) {
    return null;
  }
  return (
    <CountCell
      count={count}
      icon={<MessageSquareIcon aria-hidden className="size-3.5 shrink-0" />}
      noun={BRANCH_COMMENTS_NOUN}
    />
  );
}

function branchLeadIcon(item: BranchRow, showStatusIcon: boolean): ReactNode {
  if (item.dataState === BranchDataState.AwaitingSync) {
    return (
      <>
        <Loader2Icon
          aria-hidden
          className="size-3.5 shrink-0 animate-spin text-muted-foreground"
        />
        <span className="sr-only">Syncing branch data. </span>
      </>
    );
  }
  if (showStatusIcon) {
    return (
      <ArtifactStatus
        variant={ArtifactStatusVariant.Icon}
        view={artifactStatusView(
          item.artifactId ?? item.id,
          ArtifactStatusVocabulary.Branch,
          branchStatusEvidence(item)
        )}
      />
    );
  }
  return (
    <GitBranchIcon
      aria-hidden
      className="size-3.5 shrink-0 text-muted-foreground"
    />
  );
}
