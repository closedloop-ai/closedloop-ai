"use client";

import { $createHeadingNode } from "@lexical/rich-text";
import {
  applyFormat$,
  applyListType$,
  convertSelectionToNode$,
  currentBlockType$,
  currentFormat$,
  currentListType$,
  insertTable$,
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
  TableIcon,
  UnderlineIcon,
  UndoIcon,
} from "lucide-react";

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
import type { LucideIcon } from "lucide-react";

const HEADING_OPTIONS = [
  { level: null, label: "Body" },
  { level: 1, label: "Heading 1" },
  { level: 2, label: "Heading 2" },
  { level: 3, label: "Heading 3" },
] as const;

type ToolbarToggleProps = {
  icon: LucideIcon;
  label: string;
  pressed: boolean;
  disabled: boolean;
  onPressedChange: () => void;
};

function ToolbarToggle({ icon: Icon, label, pressed, disabled, onPressedChange }: ToolbarToggleProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle
          aria-label={label}
          disabled={disabled}
          pressed={pressed}
          size="sm"
          onPressedChange={onPressedChange}
        >
          <Icon className="h-4 w-4" />
        </Toggle>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

type ToolbarButtonProps = {
  icon: LucideIcon;
  label: string;
  disabled: boolean;
  onClick: () => void;
};

function ToolbarButton({ icon: Icon, label, disabled, onClick }: ToolbarButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          disabled={disabled}
          size="icon-sm"
          variant="ghost"
          onClick={onClick}
        >
          <Icon className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

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
  const insertTable = usePublisher(insertTable$);

  const headingLevel = getHeadingLevel(blockType);
  const currentHeadingLabel = headingLevel === null ? "Body" : `Heading ${headingLevel}`;

  function handleHeadingSelect(level: HeadingLevel | null) {
    if (level === null || headingLevel === level) {
      convertSelectionToNode(() => $createParagraphNode());
      return;
    }
    const headingTag = `h${level}` as HeadingTagType;
    convertSelectionToNode(() => $createHeadingNode(headingTag));
  }

  function toggleList(type: ListType) {
    publishListType(listType === type ? "" : type);
  }

  function handleInsertTable() {
    insertTable({ rows: 3, columns: 3 });
  }

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
              className={cn(headingLevel === option.level && "bg-accent")}
              onClick={() => handleHeadingSelect(option.level)}
            >
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="mx-1 h-6 w-px bg-border" />

      {/* Format Toggles */}
      <ToolbarToggle
        icon={BoldIcon}
        label="Bold"
        pressed={(format & IS_BOLD) === IS_BOLD}
        disabled={!editor}
        onPressedChange={() => publishFormat("bold")}
      />
      <ToolbarToggle
        icon={ItalicIcon}
        label="Italic"
        pressed={(format & IS_ITALIC) === IS_ITALIC}
        disabled={!editor}
        onPressedChange={() => publishFormat("italic")}
      />
      <ToolbarToggle
        icon={UnderlineIcon}
        label="Underline"
        pressed={(format & IS_UNDERLINE) === IS_UNDERLINE}
        disabled={!editor}
        onPressedChange={() => publishFormat("underline")}
      />

      <div className="mx-1 h-6 w-px bg-border" />

      {/* List Toggles */}
      <ToolbarToggle
        icon={ListIcon}
        label="Bullet List"
        pressed={listType === "bullet"}
        disabled={!editor}
        onPressedChange={() => toggleList("bullet")}
      />
      <ToolbarToggle
        icon={ListOrderedIcon}
        label="Numbered List"
        pressed={listType === "number"}
        disabled={!editor}
        onPressedChange={() => toggleList("number")}
      />

      <div className="mx-1 h-6 w-px bg-border" />

      {/* Table */}
      <ToolbarButton
        icon={TableIcon}
        label="Insert Table"
        disabled={!editor}
        onClick={handleInsertTable}
      />

      <div className="mx-1 h-6 w-px bg-border" />

      {/* Undo/Redo */}
      <ToolbarButton
        icon={UndoIcon}
        label="Undo"
        disabled={!editor}
        onClick={() => editor?.dispatchCommand(UNDO_COMMAND, undefined)}
      />
      <ToolbarButton
        icon={RedoIcon}
        label="Redo"
        disabled={!editor}
        onClick={() => editor?.dispatchCommand(REDO_COMMAND, undefined)}
      />
    </div>
  );
}

function getHeadingLevel(blockType: string | null | undefined): HeadingLevel | null {
  if (!blockType?.startsWith("h")) return null;
  const level = Number(blockType.slice(1));
  return level === 1 || level === 2 || level === 3 ? (level as HeadingLevel) : null;
}
