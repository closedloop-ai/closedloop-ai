/**
 * @file findings-triage-list.tsx
 * @description FEA-3848 (PRD-556 M2) — the findings triage list: findings
 * grouped by derived severity into collapsible sections, each row showing the
 * `path:line`, a one-line evidence preview, the proposed-fix affordance, and the
 * signature. Selecting a row opens the finding-detail drawer (owned by the
 * parent). Presentational: it takes already-grouped views and a select handler.
 *
 * FEA-3849 (PRD-556 M3) extends it with an OPTIONAL selection mode: when
 * `selectable` is set, each row carries a checkbox so the user can pick the
 * findings to file to ClosedLoop, and — after a file action — a created/skipped
 * status badge. Selection never files anything on its own; the confirm + file
 * flow is owned by the parent view.
 */
import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Checkbox } from "@closedloop-ai/design-system/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@closedloop-ai/design-system/components/ui/collapsible";
import { ChevronDownIcon, FingerprintIcon, MapPinIcon } from "lucide-react";
import { FindingFileStatus } from "./audit-file-model";
import {
  AUDIT_SEVERITY_LABEL,
  type AuditFindingGroup,
  type AuditFindingView,
} from "./audit-finding-model";
import { severityBadgeVariant } from "./severity-badge";

/** Optional selection wiring for the M3 "Create Issues & Assign" filing flow. */
export type FindingsSelection = {
  /** The set of selected view ids. */
  selectedIds: ReadonlySet<string>;
  /** Toggle a single finding's selection. */
  onToggle: (view: AuditFindingView) => void;
  /**
   * Per-view-id filing status, shown as a row badge after a file action. Keyed
   * by view id (not dedup key) so two findings that share a dedup key each get
   * their own correct badge (created vs. skipped) instead of both matching.
   */
  fileStatus?: ReadonlyMap<string, FindingFileStatus>;
  /** Disable the checkboxes while a file action is in flight. */
  disabled?: boolean;
};

export type FindingsTriageListProps = {
  groups: readonly AuditFindingGroup[];
  onSelect: (view: AuditFindingView) => void;
  /** When present, rows render a selection checkbox + filing status badge. */
  selection?: FindingsSelection;
};

/** The severity groups with their findings, each row opening the detail drawer. */
export function FindingsTriageList({
  groups,
  onSelect,
  selection,
}: FindingsTriageListProps) {
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <SeverityGroup
          group={group}
          key={group.severity}
          onSelect={onSelect}
          selection={selection}
        />
      ))}
    </div>
  );
}

function SeverityGroup({
  group,
  onSelect,
  selection,
}: {
  group: AuditFindingGroup;
  onSelect: (view: AuditFindingView) => void;
  selection?: FindingsSelection;
}) {
  return (
    <Collapsible
      className="rounded-xl border border-[var(--border)] bg-[var(--card)]"
      defaultOpen
    >
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-4 py-3 text-left">
        <span className="flex items-center gap-2">
          <Badge variant={severityBadgeVariant(group.severity)}>
            {AUDIT_SEVERITY_LABEL[group.severity]}
          </Badge>
          <span className="text-[var(--muted-foreground)] text-sm">
            {group.findings.length}{" "}
            {group.findings.length === 1 ? "finding" : "findings"}
          </span>
        </span>
        <ChevronDownIcon
          aria-hidden
          className="size-4 text-[var(--muted-foreground)] transition-transform group-data-[state=closed]:-rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col border-[var(--border)] border-t">
          {group.findings.map((view) => (
            <li key={view.id}>
              <FindingRow
                onSelect={onSelect}
                selection={selection}
                view={view}
              />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function FindingRow({
  view,
  onSelect,
  selection,
}: {
  view: AuditFindingView;
  onSelect: (view: AuditFindingView) => void;
  selection?: FindingsSelection;
}) {
  const status = selection?.fileStatus?.get(view.id);
  return (
    <div className="flex items-start gap-2 border-[var(--border)] border-b px-4 py-3 last:border-b-0 focus-within:bg-[var(--accent)] hover:bg-[var(--accent)]">
      {selection ? (
        <Checkbox
          aria-label={`Select finding: ${view.displayTitle}`}
          checked={selection.selectedIds.has(view.id)}
          className="mt-0.5"
          disabled={selection.disabled}
          onCheckedChange={() => selection.onToggle(view)}
        />
      ) : null}
      <button
        className="flex flex-1 flex-col gap-1 text-left focus-visible:outline-none"
        onClick={() => onSelect(view)}
        type="button"
      >
        <span className="flex items-center gap-2">
          <span className="font-medium text-[var(--foreground)] text-sm">
            {view.displayTitle}
          </span>
          {status ? <FileStatusBadge status={status} /> : null}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[var(--muted-foreground)] text-xs">
          {view.location ? (
            <span className="flex items-center gap-1 font-mono">
              <MapPinIcon aria-hidden className="size-3" />
              {view.location}
            </span>
          ) : null}
          {view.finding.signature ? (
            <span className="flex items-center gap-1 font-mono">
              <FingerprintIcon aria-hidden className="size-3" />
              {view.finding.signature}
            </span>
          ) : null}
        </span>
        {view.finding.description ? (
          <span className="line-clamp-1 text-[var(--muted-foreground)] text-xs">
            {view.finding.description}
          </span>
        ) : null}
      </button>
    </div>
  );
}

/** The created / skipped / failed badge shown on a row after a file action. */
function FileStatusBadge({ status }: { status: FindingFileStatus }) {
  if (status === FindingFileStatus.Created) {
    return <Badge variant="success">Filed</Badge>;
  }
  if (status === FindingFileStatus.Failed) {
    return <Badge variant="error">Failed</Badge>;
  }
  return <Badge variant="muted">Already filed</Badge>;
}
