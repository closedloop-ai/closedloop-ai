import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { SESSION_STATUS } from "@repo/app/agents/lib/session-types";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  getDocumentRoute,
  isNavigableDocument,
} from "@repo/app/documents/lib/document-navigation";
import {
  BRANCH_STATUS_TO_ICON,
  DOCUMENT_STATUS_TO_ICON,
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
  /** Text for the Type column badge. */
  badgeLabel: string;
  /** Tailwind classes for the Type column badge. */
  badgeClassName: string;
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
  /** Status icon for the row's current `status` value. */
  statusIcon: StatusIconStatus;
};

export function getRowTypeConfig(item: DocumentRowItem): RowTypeConfig | null {
  switch (item.kind) {
    case "project":
      return null;
    case "document": {
      const { type, status, slug } = item.data;
      const colors = DOCUMENT_TYPE_COLORS[type];
      return {
        badgeLabel: DOCUMENT_TYPE_BADGE_LABELS[type],
        badgeClassName: `${colors.bg} ${colors.text}`,
        icon: DOCUMENT_TYPE_ICONS[type],
        route: isNavigableDocument({ type })
          ? getDocumentRoute({ type, slug })
          : null,
        editable: true,
        deletable: true,
        deleteDialogTitle:
          type === DocumentType.Feature ? "Feature" : "Document",
        deleteDialogDescription: null,
        statusIcon: DOCUMENT_STATUS_TO_ICON[status],
      };
    }
    case "branch":
      return {
        badgeLabel: "Pull Request",
        badgeClassName:
          "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300",
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
      };
    case "session":
      return {
        badgeLabel: "Session",
        badgeClassName: "bg-muted text-muted-foreground",
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

function branchStatusToIcon(status: string): StatusIconStatus {
  const normalized = status.toUpperCase() as GitHubPRState;
  return BRANCH_STATUS_TO_ICON[normalized] ?? "in-progress";
}

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
      return (
        item.data.status === DocumentStatus.Done ||
        item.data.status === DocumentStatus.Obsolete
      );
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
 * Whether a session `status` is terminal. Session status is a free-form
 * harness string, so this matches by pattern rather than by enum: exact
 * `SESSION_STATUS.COMPLETED`, plus any "fail"/"error" variant (e.g. "failed",
 * "execution_failed", "timeout_error") — the same strategy the agent-session
 * sync service uses. Single definition shared by the status-icon mapping and
 * the hide-completed filter so the two can't disagree on what terminal means.
 */
export function isTerminalSessionStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    normalized === SESSION_STATUS.COMPLETED ||
    normalized.includes("fail") ||
    normalized.includes("error")
  );
}

/**
 * Session `status` is a free-form harness string — not a DocumentStatus.
 * Terminal detection delegates to `isTerminalSessionStatus`; everything
 * non-terminal is treated as running.
 */
function sessionStatusToIcon(status: string): StatusIconStatus {
  const normalized = status.toLowerCase();
  if (normalized === SESSION_STATUS.COMPLETED) {
    return "complete";
  }
  if (isTerminalSessionStatus(normalized)) {
    return "wont-do";
  }
  if (normalized === SESSION_STATUS.WAITING) {
    return "in-review";
  }
  return "in-progress";
}
