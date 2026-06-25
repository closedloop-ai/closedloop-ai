"use client";

import type { ContentBlock } from "@repo/app/chat/lib/types";
import { cn } from "@repo/design-system/lib/utils";
import { ChevronRight, Terminal, Workflow, Wrench } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { CollapsibleBlock } from "./collapsible-block";
import { extractToolResultText } from "./subagent-block";

type ToolPair = {
  id: string;
  toolUse?: ContentBlock;
  toolResult?: ContentBlock;
};

type CollapsibleBlockGroupProps = {
  blocks: ContentBlock[];
  expandedBlocks: Set<string>;
  onToggleBlock: (id: string) => void;
};

/**
 * Pairs tool_use blocks with their corresponding tool_result blocks by matching id.
 * Returns pairs in original order (when tool_use first appeared).
 */
function pairToolBlocks(blocks: ContentBlock[]): ToolPair[] {
  const pairMap = new Map<string, ToolPair>();
  const order: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const id = block.id || `anon-${i}`;

    if (!pairMap.has(id)) {
      pairMap.set(id, { id });
      order.push(id);
    }

    const pair = pairMap.get(id)!;
    if (block.type === "tool_use") {
      pair.toolUse = block;
    } else if (block.type === "tool_result") {
      pair.toolResult = block;
    }
  }

  return order.map((id) => pairMap.get(id)!);
}

/**
 * Renders a paired tool_use + tool_result as a single CollapsibleBlock
 */
const ToolPairBlock = memo(function ToolPairBlock({
  pair,
  isExpanded,
  onToggle,
}: Readonly<{
  pair: ToolPair;
  isExpanded: boolean;
  onToggle: (id: string) => void;
}>) {
  const { toolUse, toolResult } = pair;
  const hasError = toolResult?.is_error;
  const isDone = !!toolResult;

  // Get name from toolUse (history) or toolResult (streaming - block has all props)
  const title = toolUse?.name || toolResult?.name || "Tool";
  const status = getToolStatus(hasError, isDone);

  // Get input from toolUse (history) or toolResult (streaming - block keeps original props)
  const inputData = toolUse?.input ?? toolResult?.input;

  // Variant: tool (pending), result (success), error
  const variant = getToolVariant(hasError, isDone);

  const resultText = extractToolResultText(toolResult?.content);

  // CollapsibleBlock only renders children when expanded, so defer the
  // JSON.stringify of the tool input until the block is actually open.
  const inputJson = useMemo(
    () =>
      isExpanded && inputData !== undefined
        ? JSON.stringify(inputData, null, 2)
        : null,
    [isExpanded, inputData]
  );

  return (
    <CollapsibleBlock
      icon={isDone ? Terminal : Wrench}
      id={pair.id}
      isExpanded={isExpanded}
      onToggle={onToggle}
      title={`${title}${status}`}
      variant={variant}
    >
      {inputJson !== null && (
        <div className="mb-2">
          <div className="mb-1 font-medium text-[10px] text-muted-foreground">
            Input
          </div>
          <div className="whitespace-pre-wrap">{inputJson}</div>
        </div>
      )}
      {resultText && (
        <div>
          <div className="mb-1 font-medium text-[10px] text-muted-foreground">
            Output
          </div>
          <div className="whitespace-pre-wrap">{resultText}</div>
        </div>
      )}
    </CollapsibleBlock>
  );
});

/**
 * Renders a Task (subagent) tool pair with orange SubagentBlock-like styling.
 */
const TaskPairBlock = memo(function TaskPairBlock({
  pair,
  isExpanded,
  onToggle,
}: Readonly<{
  pair: ToolPair;
  isExpanded: boolean;
  onToggle: (id: string) => void;
}>) {
  const { toolUse, toolResult } = pair;
  const input = (toolUse?.input ?? toolResult?.input) as
    | { description?: string; subagent_type?: string; prompt?: string }
    | undefined;
  const description = input?.description || "Subagent task";
  const agentType = input?.subagent_type || "";
  const agentLabel = agentType.includes(":")
    ? agentType.split(":").pop()
    : agentType;

  const hasError = toolResult?.is_error;
  const isDone = !!toolResult;
  const statusLabel = getTaskStatusLabel(hasError, isDone);
  const badgeStyle = getTaskBadgeStyle(hasError, isDone);
  const resultText = extractToolResultText(toolResult?.content);

  return (
    <div className="overflow-hidden rounded-lg border border-orange-400/30 dark:border-orange-400/35">
      <button
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors",
          "bg-orange-400/5 hover:bg-orange-400/10 dark:bg-orange-400/10 dark:hover:bg-orange-400/15",
          "text-orange-700 dark:text-orange-300"
        )}
        onClick={() => onToggle(pair.id)}
        type="button"
      >
        <span
          className="shrink-0 transition-transform duration-200"
          style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          <ChevronRight className="size-3.5" />
        </span>
        <Workflow className="size-3.5 shrink-0 opacity-70" />
        <div className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">
              {agentLabel || "Subagent"}
            </span>
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 font-semibold text-[10px]",
                badgeStyle
              )}
            >
              {statusLabel}
            </span>
          </div>
          <div className="truncate text-orange-600/60 text-xs dark:text-orange-300/50">
            {description}
          </div>
        </div>
      </button>
      <div
        className={cn(
          "grid transition-all duration-200 ease-out",
          isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className="space-y-2 bg-orange-400/[0.02] px-3 py-2 dark:bg-orange-400/[0.03]">
            {input?.prompt && (
              <div>
                <div className="mb-1 font-medium text-[10px] text-muted-foreground">
                  Prompt
                </div>
                <div className="log-scrollbar max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs">
                  {input.prompt}
                </div>
              </div>
            )}
            {resultText && (
              <div>
                <div className="mb-1 font-medium text-[10px] text-muted-foreground">
                  Result
                </div>
                <div className="log-scrollbar max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs">
                  {resultText}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

/**
 * Groups all tool calls into a single collapsible "Tools" section.
 * Task/subagent blocks get orange SubagentBlock-like styling;
 * other tool calls render as standard ToolPairBlocks.
 */
export const CollapsibleBlockGroup = memo(function CollapsibleBlockGroup({
  blocks,
  expandedBlocks,
  onToggleBlock,
}: Readonly<CollapsibleBlockGroupProps>) {
  const [isGroupExpanded, setIsGroupExpanded] = useState(false);

  const toggleGroup = useCallback(() => {
    setIsGroupExpanded((prev) => !prev);
  }, []);

  const pairs = useMemo(() => pairToolBlocks(blocks), [blocks]);

  if (pairs.length === 0) {
    return null;
  }

  const count = pairs.length;

  return (
    <div className="mt-1">
      <button
        className={cn(
          "flex items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground",
          "-ml-2 rounded-md px-2 py-1 hover:bg-muted/50"
        )}
        onClick={toggleGroup}
        type="button"
      >
        <ChevronRight
          className={cn(
            "size-3 transition-transform duration-200",
            isGroupExpanded && "rotate-90"
          )}
        />
        <Wrench className="size-3 opacity-70" />
        <span>
          {count} tool call{count === 1 ? "" : "s"}
        </span>
      </button>

      <div
        className={cn(
          "grid transition-all duration-200 ease-out",
          isGroupExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className="space-y-2 border-muted-foreground/20 border-l-2 pt-2 pl-2">
            {pairs.map((pair) => {
              const isTask =
                pair.toolUse?.name === "Task" ||
                pair.toolResult?.name === "Task";
              if (isTask) {
                return (
                  <TaskPairBlock
                    isExpanded={expandedBlocks.has(pair.id)}
                    key={pair.id}
                    onToggle={onToggleBlock}
                    pair={pair}
                  />
                );
              }
              return (
                <ToolPairBlock
                  isExpanded={expandedBlocks.has(pair.id)}
                  key={pair.id}
                  onToggle={onToggleBlock}
                  pair={pair}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
});

function getToolStatus(hasError: boolean | undefined, isDone: boolean): string {
  if (hasError) {
    return " - Error";
  }
  if (isDone) {
    return " - Done";
  }
  return "";
}

function getToolVariant(
  hasError: boolean | undefined,
  isDone: boolean
): "error" | "result" | "tool" {
  if (hasError) {
    return "error";
  }
  if (isDone) {
    return "result";
  }
  return "tool";
}

function getTaskStatusLabel(
  hasError: boolean | undefined,
  isDone: boolean
): string {
  if (hasError) {
    return "Error";
  }
  if (isDone) {
    return "Done";
  }
  return "Running...";
}

function getTaskBadgeStyle(
  hasError: boolean | undefined,
  isDone: boolean
): string {
  if (hasError) {
    return "bg-destructive/15 text-destructive";
  }
  if (isDone) {
    return "bg-green-500/15 text-green-700 dark:text-green-300";
  }
  return "bg-orange-400/15 dark:bg-orange-400/20 text-orange-700 dark:text-orange-300";
}
