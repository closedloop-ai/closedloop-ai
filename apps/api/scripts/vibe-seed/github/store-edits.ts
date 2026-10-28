import { z } from "zod";

/**
 * ISS-12017: the file edits a golden session's tool calls made (Claude `Edit`,
 * `MultiEdit`, `Write`, the ClosedLoop MCP `edit`, and Codex `apply_patch`),
 * folded into the per-file change set a GitHub compare of the branch would
 * report. The hunks carry the session's real before/after text; their line
 * numbers are not recoverable from a tool call, so every hunk starts at 1.
 */

export const FileChangeStatus = {
  Added: "added",
  Modified: "modified",
  Removed: "removed",
} as const;
export type FileChangeStatus =
  (typeof FileChangeStatus)[keyof typeof FileChangeStatus];

/** One tool call's change to one file. */
export type FileEdit = {
  readonly path: string;
  readonly status: FileChangeStatus;
  readonly removed: readonly string[];
  readonly added: readonly string[];
  readonly contextBefore: readonly string[];
  readonly contextAfter: readonly string[];
};

/** A file's change across a branch, compare-shaped. */
export type FileChange = {
  readonly path: string;
  readonly status: FileChangeStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
};

export const EDIT_TOOL_NAMES = [
  "Edit",
  "MultiEdit",
  "Write",
  "mcp__lc__edit",
  "apply_patch",
] as const;

const CONTEXT_LINES = 3;
const MAX_PATCH_LINES = 400;
const LINE_BREAK = /\r?\n/;
const WORKTREE_PREFIX = /^\.claude\/worktrees\/[^/]+\//;
const APPLY_PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;

const replaceSchema = z.object({
  file_path: z.string().min(1),
  old_string: z.string(),
  new_string: z.string(),
});
const multiEditSchema = z.object({
  file_path: z.string().min(1),
  edits: z.array(z.object({ old_string: z.string(), new_string: z.string() })),
});
const writeSchema = z.object({
  file_path: z.string().min(1),
  content: z.string(),
});
const mcpEditSchema = z.object({
  edits: z.array(
    z.object({ path: z.string().min(1), old: z.string(), new: z.string() })
  ),
});

/** The edits one tool call made, with paths made relative to the repository root. */
export function parseFileEdits(
  toolName: string,
  toolInput: unknown,
  cwd: string | null
): FileEdit[] {
  const toPath = (filePath: string) => repositoryRelativePath(filePath, cwd);
  if (toolName === "apply_patch") {
    return typeof toolInput === "string"
      ? parseApplyPatch(toolInput, toPath)
      : [];
  }
  const write = writeSchema.safeParse(toolInput);
  if (toolName === "Write" && write.success) {
    return withPath(toPath(write.data.file_path), (path) => [
      writeEdit(path, write.data.content),
    ]);
  }
  const replace = replaceSchema.safeParse(toolInput);
  if (replace.success) {
    return withPath(toPath(replace.data.file_path), (path) => [
      replaceEdit(path, replace.data.old_string, replace.data.new_string),
    ]);
  }
  const multi = multiEditSchema.safeParse(toolInput);
  if (multi.success) {
    return withPath(toPath(multi.data.file_path), (path) =>
      multi.data.edits.map((edit) =>
        replaceEdit(path, edit.old_string, edit.new_string)
      )
    );
  }
  const mcp = mcpEditSchema.safeParse(toolInput);
  if (mcp.success) {
    return mcp.data.edits.flatMap((edit) =>
      withPath(toPath(edit.path), (path) => [
        replaceEdit(path, edit.old, edit.new),
      ])
    );
  }
  return [];
}

/** Fold a branch's edits, in order, into one change per file. */
export function foldFileEdits(edits: readonly FileEdit[]): FileChange[] {
  const byPath = new Map<
    string,
    {
      status: FileChangeStatus;
      additions: number;
      deletions: number;
      hunks: string[];
    }
  >();
  for (const edit of edits) {
    const existing = byPath.get(edit.path);
    const file = existing ?? {
      status: edit.status,
      additions: 0,
      deletions: 0,
      hunks: [],
    };
    if (edit.status === FileChangeStatus.Removed) {
      file.status =
        existing?.status === FileChangeStatus.Added
          ? FileChangeStatus.Added
          : FileChangeStatus.Removed;
    }
    file.additions += edit.added.length;
    file.deletions += edit.removed.length;
    file.hunks.push(renderHunk(edit));
    byPath.set(edit.path, file);
  }
  return [...byPath]
    .filter(([, file]) => file.additions + file.deletions > 0)
    .map(([path, file]) => ({
      path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.hunks
        .join("\n")
        .split("\n")
        .slice(0, MAX_PATCH_LINES)
        .join("\n"),
    }));
}

/**
 * A path the tool named, relative to the repository root, or null for a file
 * outside the session's checkout or under a dot-directory other than
 * `.github` (scratch output such as `.closedloop-ai/` or `.claude/`).
 */
export function repositoryRelativePath(
  filePath: string,
  cwd: string | null
): string | null {
  let relative = filePath;
  if (filePath.startsWith("/")) {
    if (cwd === null || !filePath.startsWith(`${cwd}/`)) {
      return null;
    }
    relative = filePath.slice(cwd.length + 1);
  }
  relative = relative.replace(WORKTREE_PREFIX, "");
  const [first] = relative.split("/");
  if (!first || (first.startsWith(".") && first !== ".github")) {
    return null;
  }
  return relative;
}

function withPath(
  path: string | null,
  build: (path: string) => FileEdit[]
): FileEdit[] {
  return path === null ? [] : build(path);
}

function writeEdit(path: string, content: string): FileEdit {
  return {
    path,
    status: FileChangeStatus.Added,
    removed: [],
    added: splitLines(content),
    contextBefore: [],
    contextAfter: [],
  };
}

/** Trim the lines both sides share so the hunk carries only what changed. */
function replaceEdit(path: string, before: string, after: string): FileEdit {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines.at(-1 - suffix) === newLines.at(-1 - suffix)
  ) {
    suffix += 1;
  }
  return {
    path,
    status: FileChangeStatus.Modified,
    removed: oldLines.slice(prefix, oldLines.length - suffix),
    added: newLines.slice(prefix, newLines.length - suffix),
    contextBefore: oldLines.slice(Math.max(0, prefix - CONTEXT_LINES), prefix),
    contextAfter: oldLines.slice(
      oldLines.length - suffix,
      oldLines.length - suffix + CONTEXT_LINES
    ),
  };
}

function parseApplyPatch(
  patch: string,
  toPath: (filePath: string) => string | null
): FileEdit[] {
  const edits: FileEdit[] = [];
  let current: {
    path: string | null;
    status: FileChangeStatus;
    removed: string[];
    added: string[];
  } | null = null;
  const flush = () => {
    if (current?.path) {
      edits.push({
        path: current.path,
        status: current.status,
        removed: current.removed,
        added: current.added,
        contextBefore: [],
        contextAfter: [],
      });
    }
  };
  for (const line of patch.split(LINE_BREAK)) {
    const header = APPLY_PATCH_FILE.exec(line);
    if (header) {
      flush();
      current = {
        path: toPath(header[2].trim()),
        status: applyPatchStatus(header[1]),
        removed: [],
        added: [],
      };
    } else if (current && line.startsWith("+")) {
      current.added.push(line.slice(1));
    } else if (current && line.startsWith("-")) {
      current.removed.push(line.slice(1));
    }
  }
  flush();
  return edits;
}

function applyPatchStatus(verb: string | undefined): FileChangeStatus {
  if (verb === "Add") {
    return FileChangeStatus.Added;
  }
  return verb === "Delete"
    ? FileChangeStatus.Removed
    : FileChangeStatus.Modified;
}

function renderHunk(edit: FileEdit): string {
  const oldCount =
    edit.contextBefore.length + edit.removed.length + edit.contextAfter.length;
  const newCount =
    edit.contextBefore.length + edit.added.length + edit.contextAfter.length;
  return [
    `@@ -${oldCount === 0 ? 0 : 1},${oldCount} +1,${newCount} @@`,
    ...edit.contextBefore.map((line) => ` ${line}`),
    ...edit.removed.map((line) => `-${line}`),
    ...edit.added.map((line) => `+${line}`),
    ...edit.contextAfter.map((line) => ` ${line}`),
  ].join("\n");
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(LINE_BREAK);
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}
