"use client";

import type { Priority } from "@repo/api/src/types/common";
import type { ArtifactStatus } from "@repo/api/src/types/document";
import {
  ArtifactStatusMenu,
  ArtifactStatusTooltip,
} from "@repo/app/documents/components/artifact-field-menus";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import { ArtifactPriority } from "@repo/app/shared/components/artifact-priority/artifact-priority";
import {
  ARTIFACT_PRIORITY_SUPPORT,
  ArtifactPrioritySurface,
  ArtifactPriorityVariant,
} from "@repo/app/shared/lib/artifact-priority-ownership";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import type { User as PopoverUser } from "@repo/design-system/components/ui/user-select-popover";
import { UserSelectPopover } from "@repo/design-system/components/ui/user-select-popover";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import {
  CornerDownRightIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  Link2OffIcon,
} from "lucide-react";
import type { ReactNode } from "react";

type ArtifactRowViewProps = {
  title: string;
  slug: string;
  typeIcon: ReactNode;
  typeLabel: string;
  /** Rendered status icon (e.g. DocumentStatusIcon / IssueStatusIcon). */
  statusIcon: ReactNode;
  /** Domain-owned champion display/editor; replaces the legacy icon/menu. */
  statusControl?: ReactNode;
  statusLabel: string;
  /**
   * The stored value, unnarrowed: this row renders a wire artifact, so a member
   * only a newer peer knows reaches here and must read as unknown, not as none.
   */
  priority?: string | null;
  /** A write for this row's priority is in flight (ISS-9307). */
  priorityPending?: boolean;
  assignee?: ReactNode;
  href?: string | null;
  depth?: number;
  onDetach?: () => void;
  className?: string;
  /**
   * The three edit handlers below turn the glyph, avatar and priority mark this
   * row ALREADY renders into the controls that set them (ISS-8543). Each is
   * independent and each is optional: a handler that is absent leaves its
   * control exactly as inert as it was, so a surface that only wants a readable
   * row passes none and renders byte-identically to before.
   *
   * Which status vocabulary the menu offers depends on the artifact's kind
   * (PRD-495), so `isFeature` travels with `onStatusChange`.
   */
  onStatusChange?: (status: ArtifactStatus) => void;
  isFeature?: boolean;
  onPriorityChange?: (priority: Priority | null) => void;
  /** Needs `assigneeOptions` too — a picker with nothing to pick is not a control. */
  onAssigneeChange?: (assigneeId: string | null) => void;
  assigneeOptions?: PopoverUser[];
  assigneeValue?: PopoverUser | null;
  /** Names the avatar button; the avatar itself is decorative inside it. */
  assigneeLabel?: string;
};

export function ArtifactRowView({
  title,
  slug,
  typeIcon,
  typeLabel,
  statusIcon,
  statusControl,
  statusLabel,
  priority,
  priorityPending,
  assignee,
  href,
  depth = 1,
  onDetach,
  className,
  onStatusChange,
  isFeature = false,
  onPriorityChange,
  onAssigneeChange,
  assigneeOptions,
  assigneeValue,
  assigneeLabel,
}: Readonly<ArtifactRowViewProps>) {
  const isChild = depth > 1;
  let renderedStatus: ReactNode;
  if (statusControl) {
    renderedStatus = (
      <span className="relative z-10 inline-flex shrink-0 items-center">
        {statusControl}
      </span>
    );
  } else if (onStatusChange) {
    renderedStatus = (
      <ArtifactStatusMenu
        isFeature={isFeature}
        onSelect={onStatusChange}
        tooltipLabel={statusLabel}
        trigger={
          <button
            aria-label={statusLabel}
            className={ROW_CONTROL_CLASS}
            onClick={(event) => event.stopPropagation()}
            type="button"
          >
            {statusIcon}
          </button>
        }
      />
    );
  } else {
    renderedStatus = (
      <ArtifactStatusTooltip label={statusLabel}>
        <button
          aria-label={statusLabel}
          className="relative z-10 inline-flex shrink-0 items-center"
          type="button"
        >
          {statusIcon}
        </button>
      </ArtifactStatusTooltip>
    );
  }

  return (
    <div
      className={cn(
        "group/row relative flex items-center gap-2 border-b py-2.5 pr-2 pl-2 hover:bg-accent/50",
        href ? "cursor-pointer" : "cursor-default",
        className
      )}
    >
      {isChild ? (
        <CornerDownRightIcon
          aria-hidden
          className="h-4 w-4 shrink-0 text-muted-foreground opacity-50"
        />
      ) : null}
      <span className="flex shrink-0 items-center text-muted-foreground">
        {typeIcon}
      </span>
      <span className="mr-1.5 ml-1 inline-block min-w-[7ch] shrink-0 font-mono text-muted-foreground text-xs">
        {slug}
      </span>
      {renderedStatus}
      {href ? (
        <Link
          className="min-w-0 flex-1 truncate font-medium text-sm after:absolute after:inset-0"
          href={href}
        >
          {title}
        </Link>
      ) : (
        <span className="min-w-0 flex-1 truncate font-medium text-sm">
          {title}
        </span>
      )}
      <div className="relative z-10 flex shrink-0 items-center gap-4">
        {onAssigneeChange && assigneeOptions ? (
          <UserSelectPopover
            onSelect={(user) => onAssigneeChange(user?.id ?? null)}
            trigger={
              <button
                aria-label={assigneeLabel}
                className={ROW_CONTROL_CLASS}
                onClick={(event) => event.stopPropagation()}
                type="button"
              >
                {assignee}
              </button>
            }
            users={assigneeOptions}
            value={assigneeValue ?? null}
          />
        ) : (
          assignee
        )}
        {renderPriority({
          mutationActivity: priorityPending,
          onPriorityChange,
          priority,
        })}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="More actions"
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
              type="button"
            >
              <EllipsisIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {href ? (
              <DropdownMenuItem asChild>
                <Link href={href}>
                  <ExternalLinkIcon className="h-4 w-4" />
                  View {typeLabel}
                </Link>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled>
                <ExternalLinkIcon className="h-4 w-4" />
                View {typeLabel}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={!onDetach} onClick={onDetach}>
              <Link2OffIcon className="h-4 w-4" />
              Detach Association
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/**
 * The box every editable control on this row occupies. It is the "More actions"
 * button's own box, so the three controls line up with the affordance the row
 * already had, and it clears the 24px minimum target the inert 20px priority
 * mark does not (WCAG 2.5.8) — the reason the design system's inline cells size
 * their empty state the same way. Focus comes from the design system's ring
 * rather than a ring invented here.
 *
 * `relative z-10` is load-bearing, not decoration: the title link paints
 * `after:absolute after:inset-0` across the whole row to make the row itself
 * clickable, so anything interactive has to climb above that overlay or the
 * click navigates instead. The read-only status button and the right-hand
 * cluster each already carry it; a control that omits it is unreachable by
 * mouse while looking perfectly fine in jsdom, which has no layout.
 */
const ROW_CONTROL_CLASS = `relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-muted ${CHIP_FOCUS_RING_CLASS}`;

/**
 * The priority mark: the champion's editor when the row can set it, the champion
 * read-only otherwise (ISS-9307).
 *
 * Editable, it renders even with no priority set, because "unset" is a value the
 * user needs a way to leave — read-only, an absent priority stays absent rather
 * than growing a control the row never had, which is why the null check below
 * stays outside the champion.
 */
function renderPriority({
  mutationActivity,
  onPriorityChange,
  priority,
}: {
  mutationActivity?: boolean;
  onPriorityChange?: (priority: Priority | null) => void;
  priority?: string | null;
}) {
  if (!onPriorityChange) {
    return priority ? (
      <div className="flex h-5 w-5 items-center justify-center">
        <ArtifactPriority
          priority={priority}
          variant={ArtifactPriorityVariant.IconOnly}
        />
      </div>
    ) : null;
  }
  return (
    <ArtifactPriorityEditor
      className={ROW_CONTROL_CLASS}
      mutationActivity={mutationActivity}
      onSelect={onPriorityChange}
      priority={priority ?? null}
      // Every row here is an artifact, whose priority column is nullable.
      support={ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Artifact]}
      variant={ArtifactPriorityVariant.IconOnly}
    />
  );
}
