"use client";

import { stringifyJsonValue } from "@repo/app/agents/lib/conversation-transforms";
import { CodeBlock } from "@repo/design-system/components/ui/primitives/code-block";
import { KeyValueGrid } from "@repo/design-system/components/ui/primitives/key-value-grid";
import { TerminalBlock } from "@repo/design-system/components/ui/primitives/terminal-block";
import {
  type DiffHunk,
  UnifiedDiff,
} from "@repo/design-system/components/ui/primitives/unified-diff";
import type {
  ConversationContentBlock,
  JsonValue,
} from "@repo/design-system/components/ui/types";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  FilePen,
  FilePlus2,
  FileText,
  FolderTree,
  Globe,
  ListTodo,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

type ToolCallBlockProps = {
  toolUse: Extract<ConversationContentBlock, { type: "tool_use" }>;
  toolResult?: Extract<
    ConversationContentBlock,
    { type: "tool_result" }
  > | null;
};

type ToolStyle = {
  Icon: typeof Wrench;
  text: string;
  chip: string;
  border: string;
};

const DEFAULT_STYLE: ToolStyle = {
  Icon: Wrench,
  text: "text-violet-300",
  chip: "bg-violet-500/15 text-violet-300",
  border: "border-violet-500/20",
};

const TOOL_STYLES: Record<string, ToolStyle> = {
  bash: {
    Icon: Terminal,
    text: "text-emerald-300",
    chip: "bg-emerald-500/15 text-emerald-300",
    border: "border-emerald-500/20",
  },
  read: {
    Icon: FileText,
    text: "text-sky-300",
    chip: "bg-sky-500/15 text-sky-300",
    border: "border-sky-500/20",
  },
  write: {
    Icon: FilePlus2,
    text: "text-violet-300",
    chip: "bg-violet-500/15 text-violet-300",
    border: "border-violet-500/20",
  },
  edit: {
    Icon: FilePen,
    text: "text-amber-300",
    chip: "bg-amber-500/15 text-amber-300",
    border: "border-amber-500/20",
  },
  multiedit: {
    Icon: FilePen,
    text: "text-amber-300",
    chip: "bg-amber-500/15 text-amber-300",
    border: "border-amber-500/20",
  },
  grep: {
    Icon: Search,
    text: "text-cyan-300",
    chip: "bg-cyan-500/15 text-cyan-300",
    border: "border-cyan-500/20",
  },
  glob: {
    Icon: FolderTree,
    text: "text-cyan-300",
    chip: "bg-cyan-500/15 text-cyan-300",
    border: "border-cyan-500/20",
  },
  webfetch: {
    Icon: Globe,
    text: "text-blue-300",
    chip: "bg-blue-500/15 text-blue-300",
    border: "border-blue-500/20",
  },
  task: {
    Icon: Bot,
    text: "text-pink-300",
    chip: "bg-pink-500/15 text-pink-300",
    border: "border-pink-500/20",
  },
  agent: {
    Icon: Bot,
    text: "text-pink-300",
    chip: "bg-pink-500/15 text-pink-300",
    border: "border-pink-500/20",
  },
  todowrite: {
    Icon: ListTodo,
    text: "text-rose-300",
    chip: "bg-rose-500/15 text-rose-300",
    border: "border-rose-500/20",
  },
  skill: {
    Icon: Sparkles,
    text: "text-fuchsia-300",
    chip: "bg-fuchsia-500/15 text-fuchsia-300",
    border: "border-fuchsia-500/20",
  },
};
const LINE_SPLIT_RE = /\r?\n/;

function styleForTool(name: string) {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return TOOL_STYLES[key] ?? DEFAULT_STYLE;
}

function asRecord(value: JsonValue): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function diffFromStrings(oldString: string, newString: string): DiffHunk[] {
  if (!(oldString || newString)) {
    return [];
  }
  const oldLines = oldString ? oldString.split(LINE_SPLIT_RE) : [];
  const newLines = newString ? newString.split(LINE_SPLIT_RE) : [];
  return [
    {
      oldStart: 1,
      newStart: 1,
      oldLines: oldLines.length,
      newLines: newLines.length,
      lines: [
        ...oldLines.map((line) => `-${line}`),
        ...newLines.map((line) => `+${line}`),
      ],
    },
  ];
}

function buildSummary(
  toolUse: Extract<ConversationContentBlock, { type: "tool_use" }>
) {
  const input = asRecord(toolUse.input);
  if (!input) {
    return null;
  }
  if (typeof input.file_path === "string") {
    return input.file_path;
  }
  if (typeof input.path === "string") {
    return input.path;
  }
  if (typeof input.command === "string") {
    return input.command.slice(0, 200);
  }
  if (typeof input.pattern === "string") {
    return input.pattern;
  }
  if (typeof input.query === "string") {
    return input.query;
  }
  if (typeof input.url === "string") {
    return input.url;
  }
  return null;
}

function renderBashInput(input: Record<string, JsonValue>) {
  if (typeof input.command !== "string") {
    return null;
  }
  return (
    <TerminalBlock
      command={input.command}
      description={
        typeof input.description === "string" ? input.description : undefined
      }
    />
  );
}

function renderWriteInput(input: Record<string, JsonValue>) {
  if (
    typeof input.file_path !== "string" ||
    typeof input.content !== "string"
  ) {
    return null;
  }
  return (
    <CodeBlock
      code={input.content}
      filename={input.file_path}
      label="new file"
    />
  );
}

function renderEditInput(input: Record<string, JsonValue>) {
  if (typeof input.file_path !== "string") {
    return null;
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <FileText className="size-3.5" />
        <span className="font-mono">{input.file_path}</span>
      </div>
      {typeof input.old_string === "string" ? (
        <CodeBlock code={input.old_string} label="removed" tone="danger" />
      ) : null}
      {typeof input.new_string === "string" ? (
        <CodeBlock code={input.new_string} label="added" tone="success" />
      ) : null}
    </div>
  );
}

function renderReadInput(input: Record<string, JsonValue>) {
  if (typeof input.file_path !== "string") {
    return null;
  }
  return (
    <TerminalBlock
      command={`read ${input.file_path}`}
      description={[
        typeof input.offset === "number" ? `offset=${input.offset}` : null,
        typeof input.limit === "number" ? `limit=${input.limit}` : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    />
  );
}

function renderGrepInput(input: Record<string, JsonValue>) {
  if (typeof input.pattern !== "string") {
    return null;
  }
  return (
    <KeyValueGrid
      data={{
        pattern: input.pattern,
        ...(typeof input.path === "string" ? { path: input.path } : {}),
        ...(typeof input.glob === "string" ? { glob: input.glob } : {}),
      }}
      priority={["pattern", "path", "glob"]}
    />
  );
}

function renderInput(
  toolUse: Extract<ConversationContentBlock, { type: "tool_use" }>
) {
  const input = asRecord(toolUse.input);
  if (!input) {
    return <KeyValueGrid data={{ input: toolUse.input }} />;
  }

  const tool = toolUse.name.toLowerCase();
  if (tool === "bash") {
    return renderBashInput(input) ?? <KeyValueGrid data={input} />;
  }
  if (tool === "write") {
    return renderWriteInput(input) ?? <KeyValueGrid data={input} />;
  }
  if (tool === "edit") {
    return renderEditInput(input) ?? <KeyValueGrid data={input} />;
  }
  if (tool === "read") {
    return renderReadInput(input) ?? <KeyValueGrid data={input} />;
  }
  if (tool === "grep") {
    return renderGrepInput(input) ?? <KeyValueGrid data={input} />;
  }
  return <KeyValueGrid data={input} />;
}

function renderResult(
  toolResult: Extract<ConversationContentBlock, { type: "tool_result" }>,
  toolName: string
) {
  const text = stringifyJsonValue(toolResult.output);
  if (!text) {
    return (
      <div className="text-[11px] text-muted-foreground italic">(empty)</div>
    );
  }

  const tool = toolName.toLowerCase();
  const trimmed = text.trim();

  if (tool === "edit" && trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        typeof parsed.old_string === "string" &&
        typeof parsed.new_string === "string"
      ) {
        return (
          <UnifiedDiff
            hunks={diffFromStrings(parsed.old_string, parsed.new_string)}
          />
        );
      }
    } catch {}
  }

  let label = "output";
  let tone: "default" | "danger" | "success" = "default";
  if (toolResult.isError) {
    label = "error";
    tone = "danger";
  }

  const record = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (record) {
    try {
      const parsed = JSON.parse(trimmed) as JsonValue;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return <KeyValueGrid data={parsed} />;
      }
    } catch {}
  }

  return (
    <CodeBlock
      code={text}
      label={label}
      showLineNumbers={text.includes("\n")}
      tone={tone}
    />
  );
}

export function ToolCallBlock({ toolUse, toolResult }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const summary = buildSummary(toolUse);
  const style = styleForTool(toolUse.name);
  const Icon = style.Icon;
  let statusBadge: ReactNode = null;
  if (toolResult?.isError) {
    statusBadge = (
      <span className="inline-flex items-center gap-1 rounded border border-red-500/25 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-200 uppercase tracking-[0.12em]">
        <AlertCircle className="size-3" />
        error
      </span>
    );
  } else if (toolResult) {
    statusBadge = (
      <span className="inline-flex items-center gap-1 rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-200 uppercase tracking-[0.12em]">
        <CheckCircle2 className="size-3" />
        complete
      </span>
    );
  }

  return (
    <div
      className={`overflow-hidden rounded-xl border bg-card/70 ${toolResult?.isError ? "border-red-500/25 bg-red-950/10" : style.border}`}
    >
      <button
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-muted/35"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <ChevronRight
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span
          className={`inline-flex size-5 shrink-0 items-center justify-center rounded ${style.chip}`}
        >
          <Icon className="size-3" />
        </span>
        <span className={`font-medium font-mono text-[13px] ${style.text}`}>
          {toolUse.name}
        </span>
        {summary ? (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {summary}
          </span>
        ) : null}
        <span className="ml-auto shrink-0">{statusBadge}</span>
      </button>
      {expanded ? (
        <div className="space-y-3 border-border/60 border-t px-3 py-3">
          <div className="space-y-1.5">
            <p className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
              Input
            </p>
            {renderInput(toolUse)}
          </div>
          {toolResult ? (
            <div className="space-y-1.5">
              <p className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
                Result
              </p>
              {renderResult(toolResult, toolUse.name)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
