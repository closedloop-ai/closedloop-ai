import {
  DocumentStatus,
  DocumentType,
  isTerminalStatusForSubtype,
} from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  DISPLAYED_SESSION_STATUS,
  type DisplayedSessionStatus,
  normalizeDisplayedSessionStatus,
  normalizeSessionStatus,
  SESSION_STATUS,
  TERMINAL_SESSION_STATUSES,
} from "@repo/api/src/types/session-status";
// Documents table rows can render SESSION artifacts; reuse the sessions slice's
// status labels so table tooltips stay aligned with session filters.
import { SESSION_STATUS_LABELS } from "@repo/app/agents/lib/session-status-filters";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  getDocumentRoute,
  isNavigableDocument,
} from "@repo/app/documents/lib/document-navigation";
import {
  BRANCH_STATUS_LABELS,
  BRANCH_STATUS_TO_ICON,
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_COLORS,
  DOCUMENT_TYPE_ICONS,
} from "@repo/app/projects/lib/project-constants";
import type { StatusIconStatus } from "@repo/design-system/components/ui/status-icon";
import { GitBranchIcon, TerminalIcon } from "lucide-react";
import type { ElementType } from "react";

/**
 * Per-artifact-type presentation and capability config for a table row
 * (FEA-1763 / PLN-874 Phase 2). One exhaustive source of truth so adding a
 * renderable artifact type means adding a registry entry — not hunting down
 * scattered `item.kind === "branch"` checks.
 *
 * Project rows are deliberately outside the registry: they are not artifacts
 * (no badge/status/type cells) and keep their bespoke name-cell rendering.
 */
export type RowTypeConfig = {
  /** Text for the Type column label. */
  badgeLabel: string;
  /**
   * Tailwind text-color classes for the Type column plain label (FEA-3947).
   * The Type cell renders a plain colored string, not a filled badge; the
   * color comes from the canonical type-color source (`DOCUMENT_TYPE_COLORS`)
   * — just the `.text` half, dropping the `.bg` fill.
   */
  labelClassName: string;
  /** Leading type icon in the name cell. */
  icon: ElementType;
  /** Org-relative route for the row, or null when not navigable. */
  route: string | null;
  /**
   * Whether the document inline-edit cells apply (status dropdown, assignee,
   * due date, priority, tags). Non-document artifacts render read-only dashes.
   */
  editable: boolean;
  /**
   * Whether the shared more-menu delete action applies. Sessions are not
   * deletable from the table: `DELETE /branches/:id` is type-scoped to BRANCH,
   * and no session-delete endpoint exists yet (PRD-453).
   */
  deletable: boolean;
  /** Noun for the delete dialog heading ("Delete {deleteDialogTitle}"). */
  deleteDialogTitle: string;
  /**
   * Optional delete-dialog body copy, built from the row's display name.
   * Null means the dialog's default body applies.
   */
  deleteDialogDescription: ((itemName: string) => string) | null;
  /**
   * Status icon (visual vocabulary) for the row's current `status` value. Set
   * only for branch/session rows, whose statuses map onto the generic
   * `StatusIcon`. Document/Feature rows render their own domain status icons
   * (DocumentStatusIcon / IssueStatusIcon) keyed off `data.status`, so they
   * leave this unset.
   */
  statusIcon?: StatusIconStatus;
  /** User-facing status label for branch/session row status icon tooltips. */
  statusLabel?: string;
};

export function getRowTypeConfig(item: DocumentRowItem): RowTypeConfig | null {
  switch (item.kind) {
    case "project":
      return null;
    case "document": {
      const { type, slug } = item.data;
      const colors = DOCUMENT_TYPE_COLORS[type];
      return {
        badgeLabel: DOCUMENT_TYPE_BADGE_LABELS[type],
        labelClassName: colors.text,
        icon: DOCUMENT_TYPE_ICONS[type],
        route: isNavigableDocument({ type })
          ? getDocumentRoute({ type, slug })
          : null,
        editable: true,
        deletable: true,
        deleteDialogTitle: type === DocumentType.Feature ? "Issue" : "Document",
        deleteDialogDescription: null,
      };
    }
    case "branch":
      return {
        badgeLabel: "Pull Request",
        labelClassName: "text-violet-700 dark:text-violet-300",
        icon: GitBranchIcon,
        route: `/build/${item.data.id}`,
        editable: false,
        deletable: true,
        // Branch deletes only remove the Closedloop artifact record — the
        // dialog heading and body must not imply the upstream GitHub PR or
        // git branch is touched.
        deleteDialogTitle: "Pull Request from Closedloop",
        deleteDialogDescription: (itemName) =>
          `This removes "${itemName}" from Closedloop only. The pull request and branch on GitHub are not closed or deleted.`,
        statusIcon: branchStatusToIcon(item.data.status),
        statusLabel: branchStatusToLabel(item.data.status),
      };
    case "session":
      return {
        badgeLabel: "Session",
        labelClassName: "text-muted-foreground",
        icon: TerminalIcon,
        // The SESSION artifact id IS the agent-session id (`SessionDetail`
        // is keyed by artifactId), so the row routes straight to the session
        // detail page.
        route: `/sessions/${item.data.id}`,
        editable: false,
        deletable: false,
        deleteDialogTitle: "Session",
        deleteDialogDescription: null,
        statusIcon: sessionStatusToIcon(item.data.status),
        statusLabel: sessionStatusToLabel(item.data.status),
      };
    default: {
      // Exhaustiveness check: a new row kind must be handled explicitly.
      const unhandled: never = item;
      return unhandled;
    }
  }
}

/**
 * Narrow to document rows — the only kind whose `data` is a `DocumentRowData`
 * (inline-editable, mergeable, movable). Branch/session rows carry a raw
 * `Artifact`; project rows carry a project.
 */
export function isDocumentRowItem(
  item: DocumentRowItem
): item is Extract<DocumentRowItem, { kind: "document" }> {
  return item.kind === "document";
}

const STATUS_WORD_SEPARATOR_REGEX = /[-_]+/g;
const WHITESPACE_REGEX = /\s+/g;

function branchStatusToIcon(status: string): StatusIconStatus {
  const normalized = normalizeBranchStatus(status);
  return normalized ? BRANCH_STATUS_TO_ICON[normalized] : "in-progress";
}

function branchStatusToLabel(status: string): string {
  const normalized = normalizeBranchStatus(status);
  return normalized ? BRANCH_STATUS_LABELS[normalized] : humanizeStatus(status);
}

function normalizeBranchStatus(status: string): GitHubPRState | null {
  const normalized = status.toUpperCase() as GitHubPRState;
  return normalized === GitHubPRState.Open ||
    normalized === GitHubPRState.Merged ||
    normalized === GitHubPRState.Closed
    ? normalized
    : null;
}

/**
 * Documents that the hide-completed table filter treats as completed. This is
 * intentionally NARROWER than the domain-wide `TERMINAL_DOCUMENT_STATUSES`
 * (which also includes APPROVED): an APPROVED document is still actively worked
 * (it awaits execution), so hide-completed keeps it visible. Only EXECUTED and
 * OBSOLETE documents drop out. The broad terminal set stays untouched for the
 * backend loop/blocker semantics that legitimately treat APPROVED as done.
 */
const HIDE_COMPLETED_DOCUMENT_STATUSES: ReadonlySet<string> = new Set<string>([
  DocumentStatus.Executed,
  DocumentStatus.Obsolete,
]);

/**
 * Whether a row counts as "completed" for table semantics (the hide-completed
 * filter). Each row kind has its own status vocabulary — DocumentStatus for
 * documents, GitHubPRState for branches, free-form harness strings for
 * sessions — so completion is decided per kind here, next to the rest of the
 * per-type config. Projects are never hidden.
 */
export function isRowItemCompleted(item: DocumentRowItem): boolean {
  switch (item.kind) {
    case "project":
      return false;
    case "document":
      // The "document" row kind covers both Documents and Features (PRD-495).
      // Features hide on their terminal statuses (DONE/CANCELED); Documents use
      // the narrower hide-completed set above (EXECUTED/OBSOLETE only — APPROVED
      // stays visible).
      return item.data.type === DocumentType.Feature
        ? isTerminalStatusForSubtype(item.data.type, item.data.status)
        : HIDE_COMPLETED_DOCUMENT_STATUSES.has(item.data.status);
    case "branch": {
      const normalized = item.data.status.toUpperCase();
      return (
        normalized === GitHubPRState.Merged ||
        normalized === GitHubPRState.Closed
      );
    }
    case "session":
      return isTerminalSessionStatus(item.data.status);
    default: {
      // Exhaustiveness check: a new row kind must be handled explicitly.
      const unhandled: never = item;
      return unhandled;
    }
  }
}

/**
 * Whether a session `status` is terminal — decided by the canonical fold and
 * nothing else. Single definition shared by the status-icon mapping and the
 * hide-completed filter so the two cannot disagree on what terminal means.
 *
 * The fold runs BEFORE the set check so a straggler spelling is resolved by the
 * same mechanism the rest of the codebase uses, rather than by a second one
 * here.
 *
 * ISS-5592 removed two substring arms (`includes("fail")`, `includes("error")`)
 * that used to widen this. They were an OPEN-set scan standing in for a closed
 * vocabulary, which the desktop AGENTS.md rule on harness discrimination
 * forbids, and they admitted their own opposites: `no_error`, `error_recovery`,
 * `failover` and `unfailed` all classified as terminal.
 *
 * They also contradicted the fold they sit next to. A spelling this build does
 * not recognise resolves to `active` and reads "Unknown" on every other
 * surface; these arms made the hide-completed filter alone treat it as finished,
 * so a row visible as Active in the Sessions list vanished from this table. One
 * vocabulary, one answer — if a harness spelling needs recognising, it belongs
 * in the canonical fold where every surface picks it up.
 */
export function isTerminalSessionStatus(status: string): boolean {
  return TERMINAL_SESSION_STATUSES.has(
    normalizeSessionStatus(status.toLowerCase())
  );
}

/**
 * The icon each DISPLAYED session status renders, declared as a table rather
 * than an if-chain so it reads as a mapping and not as a rename — and so it is
 * EXHAUSTIVE. A new `DisplayedSessionStatus` member fails `tsc` here until it
 * is intentionally mapped, which is how the two below came to be missing.
 *
 * Mirrors the sibling `BRANCH_STATUS_TO_ICON`; sessions had drifted into an
 * inline chain that silently defaulted.
 *
 * `StatusIconStatus` is the DOCUMENT phase vocabulary and has no failure
 * member, so two of these are the least-wrong option rather than the right one,
 * and `StatusIcon` publishes its own accessible name — so the icon states a
 * second fact the row's label cannot correct. Kaiti owns the call (ISS-6801);
 * do not quietly re-pick a member here.
 */
const SESSION_STATUS_TO_ICON: Record<DisplayedSessionStatus, StatusIconStatus> =
  {
    [SESSION_STATUS.ACTIVE]: "in-progress",
    // The collapsed "finished, did not fail" state — the one genuinely faithful
    // mapping in this table.
    [SESSION_STATUS.INACTIVE]: "complete",
    // RESIDUAL: announces "Won't do" and renders neutral, so a failed run reads
    // as a deliberate decision not to do the work, with no failure colour. Kept
    // because it is the only terminal-but-not-success member the set has.
    [SESSION_STATUS.ERROR]: "wont-do",
    // RESIDUAL: announces "In review". The session is blocked on a human, which
    // is not the same claim.
    [DISPLAYED_SESSION_STATUS.WAITING]: "in-review",
    // UNREACHABLE TODAY, and present only because the Record is exhaustive —
    // stated plainly because the obvious reading is that they fix something.
    // They do not: `normalizeDisplayedSessionStatus` preserves a literal
    // `waiting` and otherwise delegates to `normalizeSessionStatus`, whose
    // lifecycle fold sends BOTH of these to `active`. Verified, not assumed.
    //
    // The live defect they might look like they address is real but sits one
    // layer up: this table maps the RAW artifact status, so it never applies
    // the honest display derivation (`resolveDisplayedSessionStatus`) at all. A
    // long-silent session therefore renders "In progress" here while the
    // Sessions list badges it "Stale" — a cross-surface disagreement that
    // adding keys here cannot fix. Filed with the icon decision (ISS-6801).
    //
    // `decorative` announces the non-committal "Status" and renders muted, so
    // IF the derivation is ever routed through here these assert nothing rather
    // than claiming progress.
    [DISPLAYED_SESSION_STATUS.STALE]: "decorative",
    [DISPLAYED_SESSION_STATUS.UNKNOWN]: "decorative",
  };

/**
 * Session `status` is a free-form harness string — not a DocumentStatus — so it
 * is folded to the displayed vocabulary before the lookup. The fold is total,
 * so every input lands on a key and there is no default arm to hide a gap.
 */
function sessionStatusToIcon(status: string): StatusIconStatus {
  return SESSION_STATUS_TO_ICON[
    normalizeDisplayedSessionStatus(status.toLowerCase())
  ];
}

function sessionStatusToLabel(status: string): string {
  // One label per displayed state, matching the badge. What each spelling reads
  // is `SESSION_STATUS_LABELS` keyed by the fold — do not restate it here; the
  // sentence this replaced did, and was false on all three of its claims by the
  // time ISS-5592 finished (code review, #5156). `completed`, `failed` and
  // `unknown` are unrecognized now, so they fold to `active` and read "Active",
  // not the "Inactive"/"Failed" that note promised.
  return SESSION_STATUS_LABELS[
    normalizeDisplayedSessionStatus(status.toLowerCase())
  ];
}

function humanizeStatus(status: string): string {
  const label = status
    .trim()
    .toLowerCase()
    .replace(STATUS_WORD_SEPARATOR_REGEX, " ")
    .replace(WHITESPACE_REGEX, " ");
  if (!label) {
    return "Status";
  }
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}
