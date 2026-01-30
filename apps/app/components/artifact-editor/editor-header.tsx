"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { ArtifactStatusBadge } from "@/components/status-badge";
import { formatRelativeTime } from "@/lib/date-utils";

type EditorHeaderProps = {
  /**
   * URL to navigate back to
   */
  backHref: string;
  /**
   * Label for the back button (e.g., "Back to Project", "Back to Library")
   */
  backLabel: string;
  /**
   * Title/name of the artifact being edited
   */
  title: string;
  /**
   * Optional version display component (e.g., VersionSelector)
   */
  versionDisplay?: React.ReactNode;
  /**
   * Status of the artifact (DRAFT, REVIEW, APPROVED, etc.)
   */
  status: string;
  /**
   * Whether the content is currently being saved
   */
  isSaving: boolean;
  /**
   * Last saved timestamp
   */
  lastSaved: Date;
  /**
   * Optional additional content to display in the left section
   */
  leftContent?: React.ReactNode;
  /**
   * Optional actions to display in the right section
   */
  rightActions?: React.ReactNode;
  /**
   * Optional className for custom styling
   */
  className?: string;
};

export function EditorHeader({
  backHref,
  backLabel,
  title,
  versionDisplay,
  status,
  isSaving,
  lastSaved,
  leftContent,
  rightActions,
  className,
}: Readonly<EditorHeaderProps>) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between border-b bg-background px-4 py-3",
        className
      )}
    >
      {/* Left Section: Back button, title/version, status, save indicator */}
      <div className="flex items-center gap-4">
        <Link href={backHref}>
          <Button size="sm" variant="ghost">
            <ArrowLeftIcon className="mr-2 h-4 w-4" />
            {backLabel}
          </Button>
        </Link>

        <div className="flex items-center gap-2">
          <span className="font-medium">{title}</span>
          {versionDisplay}
          <ArtifactStatusBadge status={status} />
        </div>

        <span className="text-muted-foreground text-sm">
          {isSaving
            ? "Saving..."
            : `Last saved: ${formatRelativeTime(lastSaved)}`}
        </span>

        {leftContent}
      </div>

      {/* Right Section: Actions */}
      {rightActions && (
        <div className="flex items-center gap-2">{rightActions}</div>
      )}
    </div>
  );
}
