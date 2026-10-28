"use client";

import type { TagColor, TagSummary } from "@repo/api/src/types/tag";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { XIcon } from "lucide-react";

// Re-exported so callers can consume the visual seam and its canonical colour
// type from one shared module.
export type { TagColor } from "@repo/api/src/types/tag";

const TAG_COLOR_STYLES: Record<TagColor, { bg: string; text: string }> = {
  red: { bg: "bg-red-500/15", text: "text-red-700 dark:text-red-400" },
  rose: { bg: "bg-rose-500/15", text: "text-rose-700 dark:text-rose-400" },
  orange: {
    bg: "bg-orange-500/15",
    text: "text-orange-700 dark:text-orange-400",
  },
  amber: { bg: "bg-amber-500/15", text: "text-amber-700 dark:text-amber-400" },
  yellow: {
    bg: "bg-yellow-500/15",
    text: "text-yellow-700 dark:text-yellow-400",
  },
  lime: { bg: "bg-lime-500/15", text: "text-lime-700 dark:text-lime-400" },
  green: { bg: "bg-green-500/15", text: "text-green-700 dark:text-green-400" },
  emerald: {
    bg: "bg-emerald-500/15",
    text: "text-emerald-700 dark:text-emerald-400",
  },
  teal: { bg: "bg-teal-500/15", text: "text-teal-700 dark:text-teal-400" },
  cyan: { bg: "bg-cyan-500/15", text: "text-cyan-700 dark:text-cyan-400" },
  sky: { bg: "bg-sky-500/15", text: "text-sky-700 dark:text-sky-400" },
  blue: { bg: "bg-blue-500/15", text: "text-blue-700 dark:text-blue-400" },
  indigo: {
    bg: "bg-indigo-500/15",
    text: "text-indigo-700 dark:text-indigo-400",
  },
  violet: {
    bg: "bg-violet-500/15",
    text: "text-violet-700 dark:text-violet-400",
  },
  purple: {
    bg: "bg-purple-500/15",
    text: "text-purple-700 dark:text-purple-400",
  },
  pink: { bg: "bg-pink-500/15", text: "text-pink-700 dark:text-pink-400" },
};

/**
 * The ONE expression that turns a {@link TagColor} into chip colour classes
 * (ISS-6385). `TagChip` renders it, and a surface that must colour its own
 * element — a measured-fit chip list, a swatch beside a label — imports it
 * rather than growing a second palette beside {@link TAG_COLOR_STYLES}. Three
 * incompatible tag-colour vocabularies is what this repo actually had.
 *
 * `border-current` is the class form of the `borderColor: currentColor` this
 * component used to set inline: the border tracks the text colour, so a caller
 * pairing this with a bordered chip gets the same edge `TagChip` draws.
 */
export function tagChipClassName(color: TagColor): string {
  const style = TAG_COLOR_STYLES[color] ?? TAG_COLOR_STYLES.blue;
  return cn(style.bg, style.text, "border-current");
}

type TagChipProps = {
  tag: TagSummary;
  onClick?: () => void;
  onRemove?: () => void;
  size?: "sm" | "md";
};

export function TagChip({
  tag,
  onClick,
  onRemove,
  size = "sm",
}: Readonly<TagChipProps>) {
  const classes = cn(
    "inline-flex max-w-[120px] items-center gap-0.5 rounded-full border font-medium",
    tagChipClassName(tag.color),
    size === "sm" ? "h-5 px-1.5 text-[11px]" : "h-6 px-2 text-xs",
    onClick && "cursor-pointer"
  );

  const removeButton =
    onRemove && !onClick ? (
      <button
        aria-label={`Remove ${tag.name}`}
        className="ml-0.5 flex shrink-0 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onRemove();
        }}
        type="button"
      >
        <XIcon className="h-3 w-3" />
      </button>
    ) : null;

  const Root = onClick ? "button" : "span";
  const rootProps = onClick
    ? {
        className: classes,
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation();
          onClick();
        },
        type: "button" as const,
      }
    : { className: classes };

  return (
    <Root {...rootProps}>
      <span className="truncate">{tag.name}</span>
      {removeButton}
    </Root>
  );
}

type TagChipsProps = {
  tags: TagSummary[];
  maxVisible?: number;
  /**
   * Routes a chip press somewhere (Documents' tag search). Present so a surface
   * with navigable chips still reads its run through THIS component and gets the
   * cap and the overflow indicator with it, rather than rendering its own
   * uncapped row of `TagChip`s beside the picker.
   */
  onChipClick?: (tag: TagSummary) => void;
  onRemove?: (tagId: string) => void;
  size?: "sm" | "md";
};

export function TagChips({
  tags,
  maxVisible = 2,
  onChipClick,
  onRemove,
  size = "sm",
}: Readonly<TagChipsProps>) {
  if (tags.length === 0) {
    return null;
  }

  const visible = tags.slice(0, maxVisible);
  const overflowCount = tags.length - maxVisible;

  return (
    <div className="flex items-center gap-1">
      {visible.map((tag) => (
        <TagChip
          key={tag.id}
          onClick={onChipClick ? () => onChipClick(tag) : undefined}
          onRemove={onRemove ? () => onRemove(tag.id) : undefined}
          size={size}
          tag={tag}
        />
      ))}
      {overflowCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex h-5 items-center rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
              +{overflowCount}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <div className="flex flex-col gap-1">
              {tags.slice(maxVisible).map((tag) => (
                <span key={tag.id}>{tag.name}</span>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
