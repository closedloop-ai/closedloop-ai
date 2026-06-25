import { CodeBlock } from "@repo/design-system/components/ui/primitives/code-block";
import { FileList } from "@repo/design-system/components/ui/primitives/file-list";
import { KeyValueGrid } from "@repo/design-system/components/ui/primitives/key-value-grid";
import {
  type GrepMatch,
  MatchList,
} from "@repo/design-system/components/ui/primitives/match-list";
import { TerminalBlock } from "@repo/design-system/components/ui/primitives/terminal-block";
import {
  type DiffHunk,
  UnifiedDiff,
} from "@repo/design-system/components/ui/primitives/unified-diff";
import type { JsonValue } from "@repo/design-system/components/ui/types";
import type { ReactNode } from "react";

const LINE_SPLIT_REGEX = /\r?\n/;
const GREP_MATCH_REGEX = /^(.+?):(\d+):(.*)$/;

function str(value: unknown) {
  return typeof value === "string" ? value : "";
}

function obj(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function isMcp(toolName: string) {
  return toolName.startsWith("mcp__");
}

function diffFromStrings(oldValue: string, newValue: string): DiffHunk[] {
  if (!(oldValue || newValue)) {
    return [];
  }
  const oldLines = oldValue ? oldValue.split(LINE_SPLIT_REGEX) : [];
  const newLines = newValue ? newValue.split(LINE_SPLIT_REGEX) : [];
  const lines = [
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];

  return [
    {
      oldStart: 1,
      newStart: 1,
      oldLines: oldLines.length,
      newLines: newLines.length,
      lines,
    },
  ];
}

function parseStructuredPatch(value: unknown): DiffHunk[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const patch = obj(entry);
      if (!patch) {
        return null;
      }
      const lines = Array.isArray(patch.lines)
        ? patch.lines.filter((line): line is string => typeof line === "string")
        : [];
      return {
        oldStart: typeof patch.oldStart === "number" ? patch.oldStart : 1,
        newStart: typeof patch.newStart === "number" ? patch.newStart : 1,
        oldLines:
          typeof patch.oldLines === "number" ? patch.oldLines : lines.length,
        newLines:
          typeof patch.newLines === "number" ? patch.newLines : lines.length,
        lines,
      };
    })
    .filter((entry): entry is DiffHunk => entry !== null);
}

function toMatch(raw: unknown): GrepMatch | null {
  if (typeof raw === "string") {
    const match = raw.match(GREP_MATCH_REGEX);
    if (match) {
      return {
        file: match[1],
        line: Number(match[2]),
        text: match[3],
      };
    }
    return { text: raw };
  }

  const record = obj(raw);
  if (!record) {
    return null;
  }

  const next: GrepMatch = {};
  if (typeof record.file === "string") {
    next.file = record.file;
  } else if (typeof record.path === "string") {
    next.file = record.path;
  }
  if (typeof record.line === "number") {
    next.line = record.line;
  } else if (typeof record.line_number === "number") {
    next.line = record.line_number;
  }
  if (typeof record.text === "string") {
    next.text = record.text;
  } else if (typeof record.match === "string") {
    next.text = record.match;
  } else if (typeof record.content === "string") {
    next.text = record.content;
  }
  return next;
}

function parseGrepMatches(value: unknown): GrepMatch[] {
  if (Array.isArray(value)) {
    return value
      .map(toMatch)
      .filter((entry): entry is GrepMatch => entry !== null);
  }
  const record = obj(value);
  if (!record) {
    return [];
  }
  if (Array.isArray(record.matches)) {
    return record.matches
      .map(toMatch)
      .filter((entry): entry is GrepMatch => entry !== null);
  }
  if (Array.isArray(record.files)) {
    return record.files
      .filter((file): file is string => typeof file === "string")
      .map((file) => ({ file }));
  }
  return [];
}

function parseFileList(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  const record = obj(value);
  if (!record) {
    return [];
  }
  if (Array.isArray(record.files)) {
    return record.files.filter(
      (entry): entry is string => typeof entry === "string"
    );
  }
  if (Array.isArray(record.paths)) {
    return record.paths.filter(
      (entry): entry is string => typeof entry === "string"
    );
  }
  return [];
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: per-tool input rendering switch migrated as-is from @repo/design-system in PR A2.
export function ToolInputView({
  toolName,
  input,
}: {
  toolName: string | null | undefined;
  input: JsonValue;
}): ReactNode | null {
  if (!toolName) {
    return null;
  }

  const record = obj(input);
  if (!record) {
    return null;
  }

  if (isMcp(toolName)) {
    return <KeyValueGrid data={record as Record<string, JsonValue>} />;
  }

  switch (toolName) {
    case "Bash":
    case "PowerShell": {
      const command = str(record.command);
      if (!command) {
        return null;
      }
      return (
        <TerminalBlock
          command={command}
          description={str(record.description) || undefined}
        />
      );
    }
    case "Read": {
      const path = str(record.file_path);
      const flags = [
        record.offset == null ? null : `--offset=${record.offset}`,
        record.limit == null ? null : `--limit=${record.limit}`,
      ].filter(Boolean);
      if (!path) {
        return null;
      }
      return (
        <TerminalBlock
          command={`read ${path}${flags.length ? ` ${flags.join(" ")}` : ""}`}
        />
      );
    }
    case "Write": {
      return (
        <div className="space-y-2">
          {str(record.file_path) ? (
            <TerminalBlock command={`write ${str(record.file_path)}`} />
          ) : null}
          {str(record.content) ? (
            <CodeBlock
              code={str(record.content)}
              label="content"
              showLineNumbers
            />
          ) : null}
        </div>
      );
    }
    case "Edit":
    case "NotebookEdit": {
      const hunks = diffFromStrings(
        str(record.old_string),
        str(record.new_string)
      );
      return (
        <div className="space-y-2">
          {str(record.file_path) ? (
            <TerminalBlock
              command={`edit ${str(record.file_path)}${record.replace_all === true ? " --replace-all" : ""}`}
            />
          ) : null}
          {hunks.length > 0 ? <UnifiedDiff hunks={hunks} /> : null}
        </div>
      );
    }
    case "Grep": {
      const pattern = str(record.pattern);
      const path = str(record.path);
      const flags = [
        record.glob ? `--glob=${str(record.glob)}` : null,
        record.type ? `--type=${str(record.type)}` : null,
        record.output_mode ? `--mode=${str(record.output_mode)}` : null,
        record["-i"] ? "-i" : null,
        record["-n"] ? "-n" : null,
      ].filter(Boolean);
      return (
        <TerminalBlock
          command={`grep "${pattern}"${path ? ` ${path}` : ""}${flags.length ? ` ${flags.join(" ")}` : ""}`}
        />
      );
    }
    case "Glob":
      return (
        <TerminalBlock
          command={`glob "${str(record.pattern)}"${str(record.path) ? ` ${str(record.path)}` : ""}`}
        />
      );
    case "WebFetch":
      return (
        <TerminalBlock
          command={`fetch ${str(record.url)}`}
          description={str(record.prompt) || undefined}
        />
      );
    case "Task":
    case "Agent":
      return (
        <div className="space-y-2">
          <KeyValueGrid
            data={
              {
                ...(str(record.description)
                  ? { description: str(record.description) }
                  : {}),
                ...(str(record.subagent_type)
                  ? { subagent_type: str(record.subagent_type) }
                  : {}),
              } as Record<string, JsonValue>
            }
          />
          {str(record.prompt) ? (
            <CodeBlock
              code={str(record.prompt)}
              label="prompt"
              maxHeight="16rem"
              showLineNumbers
            />
          ) : null}
        </div>
      );
    case "AskUserQuestion": {
      if (!Array.isArray(record.questions)) {
        return null;
      }
      return (
        <div className="space-y-2">
          {record.questions.map((question) => {
            const value = obj(question);
            if (!value) {
              return null;
            }
            return (
              <KeyValueGrid
                data={value as Record<string, JsonValue>}
                key={JSON.stringify(value)}
              />
            );
          })}
        </div>
      );
    }
    default:
      return null;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: per-tool response rendering switch migrated as-is from @repo/design-system in PR A2.
export function ToolResponseView({
  toolName,
  response,
}: {
  toolName: string | null | undefined;
  response: JsonValue;
}): ReactNode | null {
  if (!toolName) {
    return null;
  }

  if (isMcp(toolName)) {
    const record = obj(response);
    return record ? (
      <KeyValueGrid data={record as Record<string, JsonValue>} />
    ) : null;
  }

  switch (toolName) {
    case "Bash":
    case "PowerShell": {
      const record = obj(response);
      if (!record) {
        return null;
      }
      const stdout = str(record.stdout);
      const stderr = str(record.stderr);
      const exitCode =
        typeof record.exitCode === "number" ? `exit ${record.exitCode}` : null;

      return (
        <div className="space-y-2">
          {stdout ? <TerminalBlock stream="stdout" text={stdout} /> : null}
          {stderr ? <TerminalBlock stream="stderr" text={stderr} /> : null}
          {record.interrupted === true ? (
            <CodeBlock code="interrupted" compact tone="danger" />
          ) : null}
          {!record.interrupted && exitCode ? (
            <CodeBlock code={exitCode} compact tone="danger" />
          ) : null}
        </div>
      );
    }
    case "Edit":
    case "NotebookEdit": {
      const record = obj(response);
      if (!record) {
        return null;
      }
      const hunks = parseStructuredPatch(record.structuredPatch);
      return (
        <div className="space-y-2">
          {hunks.length > 0 ? <UnifiedDiff hunks={hunks} /> : null}
          {str(record.originalFile) ? (
            <CodeBlock
              code={str(record.originalFile)}
              label="original file"
              maxHeight="24rem"
              showLineNumbers
            />
          ) : null}
        </div>
      );
    }
    case "Read": {
      if (typeof response === "string") {
        return <CodeBlock code={response} showLineNumbers />;
      }
      const record = obj(response);
      return record && typeof record.content === "string" ? (
        <CodeBlock code={record.content} showLineNumbers />
      ) : null;
    }
    case "Write": {
      const record = obj(response);
      return record ? (
        <KeyValueGrid data={record as Record<string, JsonValue>} />
      ) : null;
    }
    case "Grep": {
      const matches = parseGrepMatches(response);
      return matches.length > 0 ? <MatchList matches={matches} /> : null;
    }
    case "Glob": {
      const files = parseFileList(response);
      return files.length > 0 ? <FileList paths={files} /> : null;
    }
    case "WebFetch": {
      if (typeof response === "string") {
        return <CodeBlock code={response} showLineNumbers />;
      }
      const record = obj(response);
      if (!record) {
        return null;
      }
      if (typeof record.content === "string") {
        return <CodeBlock code={record.content} showLineNumbers />;
      }
      return <KeyValueGrid data={record as Record<string, JsonValue>} />;
    }
    case "Task":
    case "Agent": {
      if (typeof response === "string") {
        return <CodeBlock code={response} label="output" showLineNumbers />;
      }
      const record = obj(response);
      return record ? (
        <KeyValueGrid data={record as Record<string, JsonValue>} />
      ) : null;
    }
    case "AskUserQuestion": {
      const record = obj(response);
      return record ? (
        <KeyValueGrid data={record as Record<string, JsonValue>} />
      ) : null;
    }
    default:
      return null;
  }
}
