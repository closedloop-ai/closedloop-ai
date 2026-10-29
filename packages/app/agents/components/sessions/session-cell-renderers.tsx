"use client";

import { SessionStatusBadge } from "@repo/app/agents/components/session-status-badges";
import {
  AutonomyChip,
  HarnessChip,
  ModelChip,
} from "@repo/app/agents/components/sessions/session-cell-chips";
import { SessionCostCell } from "@repo/app/agents/components/sessions/session-cost-cell";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { sessionRowOwner } from "@repo/app/agents/lib/session-owner";
import {
  SESSION_REPOSITORY_MALFORMED_TOOLTIP,
  SESSION_REPOSITORY_UNKNOWN_LABEL,
  type SessionRepositoryDisplay,
  SessionRepositoryDisplayKind,
} from "@repo/app/agents/lib/session-repository-label";
import {
  SESSIONS_AUTONOMY_COLUMN_ID,
  SESSIONS_BRANCHES_COLUMN_ID,
  SESSIONS_COST_COLUMN_ID,
  SESSIONS_HARNESS_COLUMN_ID,
  SESSIONS_ISSUES_COLUMN_ID,
  SESSIONS_MERGE_COLUMN_ID,
  SESSIONS_MODEL_COLUMN_ID,
  SESSIONS_OWNER_COLUMN_ID,
  SESSIONS_PR_COLUMN_ID,
  SESSIONS_PRIORITY_COLUMN_ID,
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_REPO_COLUMN_ID,
  SESSIONS_STATUS_COLUMN_ID,
  SESSIONS_TAGS_COLUMN_ID,
  SESSIONS_UPDATED_COLUMN_ID,
  type SessionsColumnId,
} from "@repo/app/agents/lib/sessions-table-columns";
import { CommentAvatar } from "@repo/app/shared/components/comment-avatar";
import { Chip } from "@repo/design-system/components/ui/chip";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import {
  FolderGit2Icon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { CostAvailability } from "../../lib/cost-availability";

/**
 * ISS-7902 / FEA-4206 root cause: the Sessions cells rendered TWICE.
 *
 * `SessionsTable` owned this switch over all 14 non-seam columns while
 * `sessions-list-surface-rows.tsx` re-implemented four of them and dropped the
 * other ten through a generic text cell. Every "v2 column X diverges" ticket —
 * Autonomy (FEA-4206), Harness and Status (ISS-7902), sort-by-display-label —
 * was one column of that gap found by hand, and ten columns were still queued
 * to be discovered the same way.
 *
 * 14 is the count `SESSIONS_COLUMN_SPECS` minus `SESSIONS_SEAM_REQUIRED_COLUMN_IDS`
 * yields, and `session-cell-renderer-parity.test.tsx` pins it, so this sentence
 * cannot drift away from the switch below without a red test.
 *
 * One renderer, keyed by the canonical `SESSIONS_COLUMN_SPECS` id, is what makes
 * that class of ticket unfileable rather than fixable one at a time. It is a
 * pure function of `(columnId, row)` — it closes over no component state, which
 * is why it could move here unchanged.
 *
 * Host-specific concerns stay OUT: the linked-entity seams and the empty-cell
 * text fallback belong to the caller, because they answer "what can THIS mount
 * supply", not "how does this column look".
 */

type SessionFieldRenderer = (row: SessionTableRow) => ReactNode;

/**
 * Exhaustive field adapter registry for both Sessions hosts. `null` marks a
 * field supplied by a host-specific seam; all other entries retain the existing
 * renderer. A new canonical column fails typecheck until its adapter is chosen.
 */
export const SESSION_FIELD_ADAPTERS = {
  [SESSIONS_STATUS_COLUMN_ID]: (row) => (
    <SessionStatusBadge
      artifactId={row.id}
      status={row.status}
      syncPresentation={row.syncPresentation}
    />
  ),
  [SESSIONS_PRIORITY_COLUMN_ID]: null,
  [SESSIONS_TAGS_COLUMN_ID]: null,
  [SESSIONS_OWNER_COLUMN_ID]: (row) => renderOwnerCell(sessionRowOwner(row)),
  [SESSIONS_AUTONOMY_COLUMN_ID]: (row) =>
    row.autonomy == null ? (
      <GridEmptyValue />
    ) : (
      <AutonomyChip autonomy={row.autonomy} />
    ),
  [SESSIONS_PROJECTS_COLUMN_ID]: null,
  [SESSIONS_REPO_COLUMN_ID]: (row) =>
    renderRepoChip(row.repo ?? null, row.repositoryDisplay),
  [SESSIONS_BRANCHES_COLUMN_ID]: renderLinkedBranchesCell,
  [SESSIONS_ISSUES_COLUMN_ID]: null,
  [SESSIONS_HARNESS_COLUMN_ID]: (row) => <HarnessChip harness={row.harness} />,
  [SESSIONS_MODEL_COLUMN_ID]: (row) =>
    row.model ? <ModelChip model={row.model} /> : <GridEmptyValue />,
  duration: (row) =>
    row.durationLabel ? (
      <span className="text-muted-foreground text-sm tabular-nums">
        {row.durationLabel}
      </span>
    ) : (
      <GridEmptyValue />
    ),
  [SESSIONS_COST_COLUMN_ID]: (row) =>
    row.costAvailability === CostAvailability.NoUsage ? (
      <GridEmptyValue />
    ) : (
      <SessionCostCell
        availability={row.costAvailability}
        label={row.costLabel}
        tooltip={row.costTooltip}
      />
    ),
  started: (row) => renderTimestampCell(row.startedLabel),
  [SESSIONS_UPDATED_COLUMN_ID]: (row) =>
    renderTimestampCell(row.updatedLabel ?? null),
  lastActivity: (row) => renderTimestampCell(row.lastActivityLabel),
  [SESSIONS_PR_COLUMN_ID]: renderPullRequestChip,
  [SESSIONS_MERGE_COLUMN_ID]: (row) => renderMergeStatus(row.mergeStatusLabel),
} satisfies Readonly<Record<SessionsColumnId, SessionFieldRenderer | null>>;

/** Renders a canonical field, or leaves host-owned and unknown fields to their seams. */
export function renderSessionCell(
  columnId: string,
  row: SessionTableRow
): ReactNode {
  if (!Object.hasOwn(SESSION_FIELD_ADAPTERS, columnId)) {
    return null;
  }
  const render = SESSION_FIELD_ADAPTERS[columnId as SessionsColumnId];
  return render?.(row) ?? null;
}

function renderOwnerCell(owner: SessionTableRow["owner"]): ReactNode {
  if (!owner) {
    return <GridEmptyValue />;
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <CommentAvatar
        author={owner.name}
        authorAvatar={owner.avatarUrl}
        size="xs"
      />
      <span className="truncate text-sm" title={owner.name}>
        {owner.name}
      </span>
    </span>
  );
}

/**
 * FEA-3644: the shared truncate-with-tooltip chip used by the repo/branch/PR/model
 * cells. Each of those columns can carry a long value that must clip to an
 * ellipsis inside a fixed grid track and surface the full value on hover/focus.
 * Centralizing the Tooltip → Chip scaffold keeps the focus ring, sizing, and
 * a11y wiring (interactive + keyboard-reachable tooltip) identical across cells;
 * per-cell variation is limited to the optional leading icon, the mono span, and
 * the tooltip's own class (e.g. PR's pre-line multi-line list).
 */
function renderTooltipChip({
  icon,
  label,
  tooltip,
  mono = false,
  tooltipClassName = "max-w-xs break-words",
}: {
  icon?: ReactNode;
  label: ReactNode;
  tooltip: ReactNode;
  mono?: boolean;
  tooltipClassName?: string;
}): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Chip
          className={icon ? "min-w-0 gap-1" : "min-w-0"}
          interactive
          tabIndex={0}
          variant="outline"
        >
          {icon}
          <span className={mono ? "truncate font-mono" : "truncate"}>
            {label}
          </span>
        </Chip>
      </TooltipTrigger>
      <TooltipContent className={tooltipClassName}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function renderRepoChip(
  label: string | null,
  display?: SessionRepositoryDisplay
): ReactNode {
  if (!label) {
    // ISS-4996: an ABSENT repository is the same fact as an absent branch, so it
    // gets the same shared empty glyph the Branch column right beside it uses.
    // Rendering the word "Unknown" here made one condition wear two glyphs in
    // adjacent columns, and put a value-shaped label in a column whose facet has
    // no "Unknown" option to select it back — a label the filter can never
    // reach. A MALFORMED value (stored, but carrying no identity) is a different
    // fact and keeps the distinct word, because that row is a data-quality
    // signal that should stay visible rather than disappear into the em dash.
    //
    // FEA-4274 chose "Unknown" partly to keep the Repository row present in the
    // narrow-width card layout, where `isEmptyCellValue` drops em-dash rows.
    // Dropping it there is now the intended behavior: it is exactly what the
    // Branch, Model, and PR cells already do for the same condition, so the card
    // stops listing a row whose only content is "we have nothing".
    //
    // This deliberately does NOT change the session-detail Properties row, which
    // keeps spelling out "Unknown" (`detail-content.ts`,
    // `agent-session-detail-view.tsx`). That is not the FEA-4274 divergence
    // coming back: FEA-4274 was a TRUTH divergence — detail invented a
    // filesystem path for a session the list called Unknown. Both surfaces here
    // make the identical claim ("no remote resolved") and differ only in how
    // densely they say it, the same way this grid's other optional columns use a
    // dash while their detail rows use words. A grid cell has room for a glyph;
    // a labelled property row has room for the word.
    // #4324 review: keeping the word is only defensible if a reader can decode
    // it. Two glyphs in one column, one of them a bare word, is otherwise a
    // puzzle for anyone outside the team — so the malformed cell carries a
    // tooltip AND an accessible name saying what it means. (The reviewer's
    // alternative, routing this to a log instead, is not available on this side
    // of the wire: `no-client-debug-logging` bans logging from client modules,
    // and this is a `"use client"` grid cell. Monitoring the condition belongs
    // to the producer that stored the value, not to the render.)
    if (display?.kind === SessionRepositoryDisplayKind.Malformed) {
      // Uses the SAME tooltip-chip the RESOLVED cell in this column uses, rather
      // than a hand-rolled span. A bare `aria-label` on a plain `<span>` is not
      // supported by its implicit role (and a `tabIndex` on one is a
      // non-interactive focus stop), so this is both the accessible answer and
      // the consistent one: every cell in this column that HAS something to say
      // says it the same way. No icon — there is no repository to point at.
      return renderTooltipChip({
        label: SESSION_REPOSITORY_UNKNOWN_LABEL,
        tooltip: SESSION_REPOSITORY_MALFORMED_TOOLTIP,
      });
    }
    // ISS-5366: everything that is not MALFORMED renders the shared empty
    // glyph, including a row that carries no `display` at all. `resolveSession
    // RepositoryDisplay` always returns a kind, so with the gate retired every
    // shipping row resolves one and an absent `display` is unreachable in
    // production — it survives only in row literals written by hand (stories,
    // tests). Those used to fall through to a plain muted "Unknown" span, which
    // made the story the one place rendering a state the product can no longer
    // produce. Folding the fallback into the ABSENT glyph means a hand-written
    // row now shows exactly what a real one shows.
    return <GridEmptyValue />;
  }
  return renderTooltipChip({
    icon: <FolderGit2Icon className="size-3 shrink-0" />,
    label,
    tooltip: label,
  });
}

/**
 * ISS-5315: the "Linked branches" cell. Renders the session's branch exactly as
 * the old "Branch" column did, and folds the row's PR summary and merge state
 * into the SAME tooltip.
 *
 * That fold is what makes hiding the separate PR and Merge columns by default
 * honest: the grid states one fact fewer per row at rest, but no fact is lost —
 * every one of them is still one hover/focus away in the cell they belong to,
 * and both columns remain one click away in the Options menu. A row with no branch
 * still renders the shared empty glyph rather than a chip labelled with a PR.
 *
 * #4480: the three facts are three LINES, and only the branch is monospaced. A
 * branch name in mono is right — it is a literal ref you might retype. A PR
 * summary and a merge state are not code, and setting all three in mono joined
 * by a dot turned "main · #412 open · Merged" into what read as one code string.
 */
function renderLinkedBranchesCell(row: SessionTableRow): ReactNode {
  const label = row.branch ?? null;
  if (!label) {
    return <GridEmptyValue />;
  }
  const notes = [row.pullRequestSummaryLabel, row.mergeStatusLabel].filter(
    (part): part is string => Boolean(part)
  );
  return renderTooltipChip({
    icon: <GitBranchIcon className="size-3 shrink-0" />,
    label,
    mono: true,
    tooltip: (
      <span className="flex flex-col gap-0.5">
        <span className="break-words font-mono">{label}</span>
        {notes.map((note) => (
          <span key={note}>{note}</span>
        ))}
      </span>
    ),
  });
}

function renderPullRequestChip(row: SessionTableRow): ReactNode {
  if (!row.pullRequestSummaryLabel) {
    return <GridEmptyValue />;
  }
  const tooltipLabel = row.pullRequests
    .map((pr) => `${pr.numberLabel} ${pr.statusLabel} · ${pr.title}`)
    .join("\n");
  return renderTooltipChip({
    icon: <GitPullRequestIcon className="size-3 shrink-0" />,
    label: row.pullRequestSummaryLabel,
    mono: true,
    tooltip: tooltipLabel,
    tooltipClassName: "max-w-xs whitespace-pre-line break-words",
  });
}

function renderMergeStatus(label: string | null): ReactNode {
  if (!label) {
    return <GridEmptyValue />;
  }
  return (
    <Chip className="min-w-0 gap-1" variant="outline">
      <GitMergeIcon className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </Chip>
  );
}

/**
 * A relative-time cell renderer.
 */
function renderTimestampCell(label: string | null): ReactNode {
  if (!label) {
    return <GridEmptyValue />;
  }
  return <span className="text-muted-foreground text-sm">{label}</span>;
}
