"use client";

import { $createHeadingNode } from "@lexical/rich-text";
import {
  applyFormat$,
  applyListType$,
  convertSelectionToNode$,
  currentBlockType$,
  currentFormat$,
  currentListType$,
  IS_BOLD,
  IS_ITALIC,
  IS_UNDERLINE,
  rootEditor$,
  useCellValues,
  usePublisher,
} from "@mdxeditor/editor";
import {
  $createParagraphNode,
  REDO_COMMAND,
  UNDO_COMMAND,
} from "lexical";
import {
  BoldIcon,
  ChevronDownIcon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  RedoIcon,
  UnderlineIcon,
  UndoIcon,
} from "lucide-react";
import { useCallback, useMemo } from "react";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Toggle } from "@repo/design-system/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";

import type { HeadingLevel } from "./types";
import type { ListType } from "@lexical/list";
import type { HeadingTagType } from "@lexical/rich-text";

const HEADING_OPTIONS = [
  { level: null, label: "Body" },
  { level: 1, label: "Heading 1" },
  { level: 2, label: "Heading 2" },
  { level: 3, label: "Heading 3" },
] as const;

export function RichTextToolbar() {
  const [format, blockType, listType, editor] = useCellValues(
    currentFormat$,
    currentBlockType$,
    currentListType$,
    rootEditor$
  );
  const publishFormat = usePublisher(applyFormat$);
  const publishListType = usePublisher(applyListType$);
  const convertSelectionToNode = usePublisher(convertSelectionToNode$);

  const headingLevel = getHeadingLevel(blockType);
  const boldActive = hasFormat(format, IS_BOLD);
  const italicActive = hasFormat(format, IS_ITALIC);
  const underlineActive = hasFormat(format, IS_UNDERLINE);
  const bulletActive = listType === "bullet";
  const orderedActive = listType === "number";

  const toggleList = useCallback(
    (type: ListType) => {
      const nextType = listType === type ? "" : type;
      publishListType(nextType);
    },
    [listType, publishListType]
  );

  const handleHeadingSelect = useCallback(
    (level: HeadingLevel | null) => {
      if (level === null) {
        convertSelectionToNode(() => $createParagraphNode());
        return;
      }
      if (headingLevel === level) {
        convertSelectionToNode(() => $createParagraphNode());
        return;
      }
      const headingTag = `h${level}` as HeadingTagType;
      convertSelectionToNode(() => $createHeadingNode(headingTag));
    },
    [convertSelectionToNode, headingLevel]
  );

  const currentHeadingLabel = useMemo(() => {
    if (headingLevel === null) return "Body";
    return `Heading ${headingLevel}`;
  }, [headingLevel]);

  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-background p-1 shadow-sm text-foreground">
      {/* Heading Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="h-8 gap-1 px-2 text-sm"
            disabled={!editor}
            variant="ghost"
          >
            {currentHeadingLabel}
            <ChevronDownIcon className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {HEADING_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.label}
              className={cn(
                headingLevel === option.level && "bg-accent"
              )}
              onClick={() => handleHeadingSelect(option.level)}
            >
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="mx-1 h-6 w-px bg-border" />

      {/* Format Toggles */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            aria-label="Bold"
            disabled={!editor}
            pressed={boldActive}
            size="sm"
            onPressedChange={() => publishFormat("bold")}
          >
            <BoldIcon className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>Bold</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            aria-label="Italic"
            disabled={!editor}
            pressed={italicActive}
            size="sm"
            onPressedChange={() => publishFormat("italic")}
          >
            <ItalicIcon className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>Italic</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            aria-label="Underline"
            disabled={!editor}
            pressed={underlineActive}
            size="sm"
            onPressedChange={() => publishFormat("underline")}
          >
            <UnderlineIcon className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>Underline</TooltipContent>
      </Tooltip>

      <div className="mx-1 h-6 w-px bg-border" />

      {/* List Toggles */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            aria-label="Bullet List"
            disabled={!editor}
            pressed={bulletActive}
            size="sm"
            onPressedChange={() => toggleList("bullet")}
          >
            <ListIcon className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>Bullet List</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            aria-label="Numbered List"
            disabled={!editor}
            pressed={orderedActive}
            size="sm"
            onPressedChange={() => toggleList("number")}
          >
            <ListOrderedIcon className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>Numbered List</TooltipContent>
      </Tooltip>

      <div className="mx-1 h-6 w-px bg-border" />

      {/* Undo/Redo */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="Undo"
            disabled={!editor}
            size="icon-sm"
            variant="ghost"
            onClick={() => editor?.dispatchCommand(UNDO_COMMAND, undefined)}
          >
            <UndoIcon className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Undo</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="Redo"
            disabled={!editor}
            size="icon-sm"
            variant="ghost"
            onClick={() => editor?.dispatchCommand(REDO_COMMAND, undefined)}
          >
            <RedoIcon className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Redo</TooltipContent>
      </Tooltip>
    </div>
  );
}

function getHeadingLevel(
  blockType: string | null | undefined
): HeadingLevel | null {
  if (!blockType?.startsWith("h")) return null;
  const level = Number(blockType.slice(1));
  return level === 1 || level === 2 || level === 3
    ? (level as HeadingLevel)
    : null;
}

function hasFormat(format: number, mask: number) {
  return (format & mask) === mask;
}
