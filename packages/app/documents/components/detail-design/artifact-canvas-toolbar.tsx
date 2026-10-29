// gardener-support: test and story data, not shipped
"use client";

import { EditorToolbarRow } from "@repo/app/documents/components/editor-toolbar-row";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { type LucideIcon, MessageSquarePlusIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * ISS-12576 (DI-07): the toolbar at the top of a Document's or an Issue's
 * Artifact canvas, one design for both (Nerys, 2026-10-22). It is the
 * document editor's toolbar row, flush with the canvas card's edges and top,
 * and it stays there while the artifact scrolls under it.
 *
 * - The artifact's own controls on the left; on the right, a document's
 *   version dropdown, then the place Publish will take (not designed yet, so
 *   nothing draws there). Add comment is in the page header, beside the
 *   comments toggle.
 * - `editBar`: the editor's text controls in a second row under the first,
 *   while the artifact's text is being edited (an issue; a document's text
 *   controls are always in its first row).
 */
export function ArtifactCanvasToolbar({
  editBar,
  label,
  left,
  publish,
  right,
}: Readonly<{
  /** The text controls, shown under the toolbar while editing. */
  editBar?: ReactNode;
  /** The toolbar's region name. */
  label: string;
  left: ReactNode;
  /** Reserved for Publish, last on the right. Nothing passes it yet. */
  publish?: ReactNode;
  /** Controls on the right before Publish (a document's versions). */
  right?: ReactNode;
}>) {
  return (
    <section
      aria-label={label}
      // `ArtifactCanvasPanel` pads its card px-5 pt-4: the toolbar cancels
      // that, so the artifact scrolls under it edge to edge.
      className="sticky top-0 z-10 -mx-5 -mt-4"
    >
      <EditorToolbarRow
        // Tighter than the editor's own row, so an issue's fields keep one
        // row beside the open comments rail.
        className="gap-1.5 px-3"
        leftContent={left}
        rightContent={
          right || publish ? (
            <>
              {right}
              {publish}
            </>
          ) : null
        }
      />
      {editBar ? (
        <EditorToolbarRow className="gap-1.5 px-3" leftContent={editBar} />
      ) : null}
    </section>
  );
}

/**
 * Add comment, an icon as the editor toolbar's tools are, for the page header
 * beside the comments toggle. It comments on the text selected in the
 * artifact, or on the artifact as a whole.
 */
export function AddCommentButton({
  onAddComment,
}: Readonly<{ onAddComment: () => void }>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label="Add comment"
          onClick={onAddComment}
          // Keep the body's selection: it is what the comment quotes.
          onMouseDown={(event) => event.preventDefault()}
          size="icon-sm"
          variant="outline"
        >
          <MessageSquarePlusIcon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Add comment</TooltipContent>
    </Tooltip>
  );
}

/**
 * A read-only value in the toolbar, bordered and sized like the toolbar's
 * controls (an outline small button) so a row of fields lines up.
 */
export function ToolbarField({
  children,
  className,
}: Readonly<{ children: ReactNode; className?: string }>) {
  return (
    <span
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-input-border bg-input px-2 text-sm",
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * The artifact's slug, led by its type's icon: the icon its rows carry in
 * linked-artifact tables (an issue's sub-issues).
 */
export function ToolbarSlug({
  icon: Icon,
  slug,
}: Readonly<{ icon: LucideIcon; slug: string }>) {
  return (
    <ToolbarField>
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="font-mono text-muted-foreground text-xs">{slug}</span>
    </ToolbarField>
  );
}
