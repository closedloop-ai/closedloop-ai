"use client";

import type { Tag, TagColor } from "@repo/api/src/types/tag";
import { TAG_NAME_MAX_LENGTH } from "@repo/api/src/types/tag";
import { TagChip } from "@repo/app/shared/components/tag-chip";
import {
  TAG_COLOR_CLASSES,
  TagColorPicker,
} from "@repo/app/shared/components/tag-color-picker";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { Button } from "@repo/design-system/components/ui/button";
import type { Column } from "@repo/design-system/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
import { MoreHorizontalIcon } from "lucide-react";
import { useState } from "react";

/**
 * @file tag-columns.tsx
 * @description How a tag row RENDERS and is edited in place, extracted from
 * `tags-settings-tab.tsx` so the legacy Settings tab and the Settings v2 Tags
 * panel (ISS-8367) present one identical table.
 *
 * Presentation only. The v2 panel differs in what it does around the table —
 * it classifies its read instead of defaulting to `[]`, and it reports a failed
 * rename instead of letting the row silently revert — and none of that lives
 * here.
 *
 * `handlers` is OPTIONAL, and that is the read-only mode: omit it and the name
 * and colour cells render as plain text and a static swatch instead of an
 * editor and a picker. A caller that cannot establish the actor's `edit` grant
 * must not hand the user two live write controls (ISS-8367 review, bha_p0_f1).
 */

function InlineNameEditor({
  value,
  onSave,
}: Readonly<{
  value: string;
  onSave: (name: string) => void;
}>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <button
        className="rounded px-1 py-0.5 text-left text-sm hover:bg-muted"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        type="button"
      >
        {value}
      </button>
    );
  }

  return (
    <Input
      aria-label="Rename tag"
      autoFocus
      className="h-7 max-w-[200px] text-sm"
      maxLength={TAG_NAME_MAX_LENGTH}
      onBlur={() => {
        onSave(draft);
        setEditing(false);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          onSave(draft);
          setEditing(false);
        }
        if (e.key === "Escape") {
          setEditing(false);
        }
      }}
      value={draft}
    />
  );
}

/**
 * The colour cell when the actor may not recolour. Reads
 * {@link TAG_COLOR_CLASSES}, the same map the picker's trigger uses, so the
 * read-only cell cannot drift from the editable one. Carries its own accessible
 * name because hue alone is not a statement (WCAG 1.4.1).
 */
function TagColorSwatch({ color }: Readonly<{ color: TagColor }>) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={`size-3.5 rounded-full ${TAG_COLOR_CLASSES[color] ?? "bg-blue-500"}`}
      />
      <span className="sr-only">{`Color: ${color}`}</span>
    </span>
  );
}

export type TagRowActionsProps = {
  tag: Tag;
  onDelete: (tag: Tag) => void;
};

export function TagRowActions({ tag, onDelete }: Readonly<TagRowActionsProps>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost">
          <MoreHorizontalIcon className="h-4 w-4" />
          <span className="sr-only">Open actions menu</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          className="text-destructive"
          onClick={() => onDelete(tag)}
        >
          Delete tag
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type BuildTagColumnsHandlers = {
  onRename: (tag: Tag, name: string) => void;
  onRecolor: (tag: Tag, color: TagColor) => void;
};

export function buildTagColumns(
  handlers?: Readonly<BuildTagColumnsHandlers>
): Column<Tag>[] {
  return [
    {
      key: "color",
      header: "",
      render: (tag) =>
        handlers === undefined ? (
          <TagColorSwatch color={tag.color as TagColor} />
        ) : (
          <TagColorPicker
            onChange={(c) => handlers.onRecolor(tag, c)}
            value={tag.color as TagColor}
          />
        ),
    },
    {
      key: "name",
      header: "Name",
      render: (tag) =>
        handlers === undefined ? (
          <span className="px-1 py-0.5 text-sm">{tag.name}</span>
        ) : (
          <InlineNameEditor
            onSave={(n) => handlers.onRename(tag, n)}
            value={tag.name}
          />
        ),
    },
    {
      key: "preview",
      header: "Preview",
      render: (tag) => (
        <TagChip
          size="md"
          tag={{ id: tag.id, name: tag.name, color: tag.color as TagColor }}
        />
      ),
    },
    {
      key: "createdAt",
      header: "Created",
      render: (tag) => (
        <span className="text-muted-foreground text-sm">
          {formatRelativeTime(tag.createdAt)}
        </span>
      ),
    },
  ];
}
