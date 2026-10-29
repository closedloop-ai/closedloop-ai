"use client";

import type { TagColor } from "@repo/api/src/types/tag";
import {
  type ActivityPart,
  ActivityPartKind,
} from "@repo/app/documents/components/feed-sidebar/sources/activity-formatting";
import { ArtifactPriority } from "@repo/app/shared/components/artifact-priority/artifact-priority";
import { TagChip } from "@repo/app/shared/components/tag-chip";
import { ArtifactPriorityVariant } from "@repo/app/shared/lib/artifact-priority-ownership";
import type { ArtifactStatusTone } from "@repo/app/shared/lib/artifact-status-appearance";
import { Badge } from "@repo/design-system/components/ui/badge";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { Fragment } from "react";

/**
 * Draws an activity row's action phrase from the adapter's parts
 * (`describeActivityParts`): plain words, bold names, status pills in the
 * status colours, priority pills, tags in their own colour, a struck-through
 * old value before a bold new one, and linked artifact keys (ISS-12117).
 *
 * Presentational and stateless: the adapter already decided every word, so
 * the tab's timeline line and the comments rail's compact card render the
 * same phrase from the same parts.
 */
export function ActivityParts({
  parts,
  className,
}: Readonly<{ parts: readonly ActivityPart[]; className?: string }>) {
  return (
    <span className={cn("inline", className)}>
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder within a row
        <Fragment key={index}>
          {index > 0 ? " " : null}
          <ActivityPartView part={part} />
        </Fragment>
      ))}
    </span>
  );
}

/**
 * A value longer than this many characters is truncated with an ellipsis and
 * its full text moves to a tooltip; shorter values never need one.
 */
const LONG_VALUE_CHARS = 40;

function ActivityPartView({ part }: Readonly<{ part: ActivityPart }>) {
  switch (part.kind) {
    case ActivityPartKind.Text:
      return <>{part.text}</>;
    case ActivityPartKind.Person:
      return (
        <strong className="font-medium text-foreground">{part.name}</strong>
      );
    case ActivityPartKind.Pending:
      // Reserve the name's space; a lookup in flight names nobody.
      return <ActivityInlineSkeleton className="h-4 w-20" />;
    case ActivityPartKind.Status:
      return (
        <Badge
          className={PILL_ALIGN_CLASS}
          variant={statusPillVariant(part.tone)}
        >
          {part.label}
        </Badge>
      );
    case ActivityPartKind.Priority:
      return (
        <span className={cn("inline-flex", PILL_ALIGN_CLASS)}>
          <ArtifactPriority
            priority={part.value}
            variant={ArtifactPriorityVariant.Badge}
          />
        </span>
      );
    case ActivityPartKind.Tag:
      return (
        <span className={cn("inline-flex", PILL_ALIGN_CLASS)}>
          <TagPill color={part.color} id={part.id} name={part.name} />
        </span>
      );
    case ActivityPartKind.Value:
      return <LongValue bold href={part.href} text={part.text} />;
    case ActivityPartKind.Rename:
      return (
        <>
          {/* Strikethrough alone is invisible to a screen reader. */}
          <span className="sr-only">from </span>
          <LongValue struck text={part.before} />{" "}
          <span className="sr-only">to </span>
          <LongValue bold text={part.after} />
        </>
      );
    case ActivityPartKind.Code:
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">
          {part.text}
        </code>
      );
    default: {
      const unhandled: never = part;
      return unhandled;
    }
  }
}

/**
 * How a pill sits in the sentence: centred on the text's x-height so its
 * label shares the line's baseline.
 */
const PILL_ALIGN_CLASS = "-translate-y-px align-middle";

/**
 * TagChip caps a tag at 120px; a name long enough to be cut keeps its full
 * text one hover or focus away, like every other long value in the row.
 */
const LONG_TAG_CHARS = 16;

function TagPill({
  id,
  name,
  color,
}: Readonly<{ id: string; name: string; color: TagColor }>) {
  const chip = <TagChip tag={{ id, name, color }} />;
  if (name.length <= LONG_TAG_CHARS) {
    return chip;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("inline-flex rounded-full", CHIP_FOCUS_RING_CLASS)}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the full tag name lives in a tooltip, which keyboard users reach by focusing the pill
          tabIndex={0}
        >
          {chip}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-words">{name}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A placeholder that can sit inside a sentence: the design-system Skeleton's
 * look as an inline `<span>`, because a `<div>` may not live in a `<p>`.
 */
export function ActivityInlineSkeleton({
  className,
}: Readonly<{ className?: string }>) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block animate-pulse rounded-md bg-accent align-middle",
        className
      )}
      data-slot="skeleton"
    />
  );
}

/**
 * The status registry's tones, drawn as the soft tints every other pill in
 * the row uses. The registry's `destructive` tone is the one solid fill in
 * the Badge palette; inside a sentence it shouted over the rest of the row,
 * and the app's own Session badge draws Failed as a soft red. So here it maps
 * to the soft `error` tint. Every other tone passes through unchanged.
 */
function statusPillVariant(tone: ArtifactStatusTone): ArtifactStatusTone {
  return tone === "destructive" ? "error" : tone;
}

/**
 * A named value (a project, a title, a linked artifact). Long values truncate
 * with an ellipsis and keep the full text one hover or focus away in an
 * accessible tooltip; the full string also stays in the DOM, so assistive tech
 * and copy get all of it.
 */
function LongValue({
  text,
  bold = false,
  struck = false,
  href,
}: Readonly<{
  text: string;
  bold?: boolean;
  struck?: boolean;
  href?: string;
}>) {
  const long = text.length > LONG_VALUE_CHARS;
  const className = cn(
    "max-w-[18rem] align-bottom",
    long && "inline-block truncate",
    bold && "font-medium text-foreground",
    struck && "text-muted-foreground line-through"
  );
  const content = href ? (
    <Link
      className={cn(
        className,
        "rounded-sm underline-offset-2 hover:underline",
        CHIP_FOCUS_RING_CLASS
      )}
      href={href}
    >
      {text}
    </Link>
  ) : (
    <span className={className} tabIndex={long ? 0 : undefined}>
      {text}
    </span>
  );
  if (!long) {
    return content;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent className="max-w-sm break-words">{text}</TooltipContent>
    </Tooltip>
  );
}
