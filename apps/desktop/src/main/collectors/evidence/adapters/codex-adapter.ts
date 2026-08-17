/**
 * @file codex-adapter.ts
 * @description FEA-2268: Codex harness adapter. Codex normalizes shell calls to
 * the `shell` tool name and edits to `apply_patch`, and is the one harness that
 * populates `mcpServer`/`mcpMethod` (from `mcp_tool_call_begin`). Concrete Codex
 * tool-name strings live ONLY here.
 */
import type { NormalizedToolUse } from "../../types.js";
import {
  type DeclaredEvidence,
  DeclaredKind,
  type HarnessAdapter,
  MCP_TOOL_NAME_PREFIX,
  type StructuralCategory,
  ToolCategory,
} from "../evidence-model.js";

// Codex shell execution: `local_shell_call`/`exec_command` events normalize to
// the `shell` tool name (codex-parser); the raw event names are included
// defensively in case a future parser path surfaces them directly.
const RUN_COMMAND_TOOLS = new Set([
  "shell",
  "local_shell_call",
  "exec_command",
]);

// Codex edits arrive as a single `apply_patch` tool use (sets `diffDelta`).
const MUTATE_CODE_TOOLS = new Set(["apply_patch"]);

/**
 * FEA-4010 (AA-09 C1): the file directives inside an `apply_patch` envelope.
 *
 * Codex sends the WHOLE patch as the tool input string, so the generic
 * `file_path`/`path` extraction in `build-session-evidence.ts` yielded the entire
 * blob where a path belongs — 65 of the corpus's 224 mutations (29%, and 100% of
 * Codex's). Any mutation taxonomy keyed on path or extension would have been
 * blind on all of them, and blind in a HARNESS-CORRELATED way, which is worse
 * than blind at random. One patch commonly names several files (87 directives
 * across 65 corpus patches; one names 14), so this is inherently a list.
 *
 * Anchored at line start, which is what makes it safe: every patch BODY line is
 * prefixed (`+`, `-`, or a space), so file content that itself starts with `***`
 * arrives as `+*** …` and cannot be read as a directive.
 *
 * `Move to` / `Rename File` are accepted although the corpus contains neither —
 * they belong to the envelope grammar, and a rename does mutate the named path.
 * Leaving them out would silently drop those mutations the first time one occurs.
 */
const PATCH_FILE_DIRECTIVE_RE =
  /^\*\*\* (?:Update File|Add File|Delete File|Move to|Move File|Rename File):[ \t]*(\S.*?)[ \t]*$/;

/** An `apply_patch` payload, as opposed to a bare path string. */
const PATCH_ENVELOPE_RE = /^\s*\*\*\* Begin Patch\b/;

/**
 * FEA-4010 (AA-09 C1): the `.codex/` subdirectories Codex owns — rollout
 * transcripts, session state, its own logs. Same allowlist shape (and same
 * reasoning) as the Claude adapter's: `.codex/config.toml` and `.codex/prompts/`
 * are user-authored, so a blanket `.codex/` match would call editing them
 * bookkeeping. The corpus contains no Codex state-path mutation, so nothing here
 * is corroborated by it — these are listed for cross-harness symmetry, because a
 * rule that fires only for Claude would make the implement metric differ by
 * HARNESS rather than by what the session did, which is worse than firing
 * nowhere. Unlisted paths keep the `MutateCode` default either way.
 */
const STATE_DIR_RE =
  /(?:^|[\\/])\.codex[\\/](?:sessions|history|log|logs|archived_sessions)[\\/]/;

/**
 * The envelope terminator. Scanning stops here when it is present, so a directive
 * that trails a completed envelope is not read as part of it. Absence is NOT
 * treated as invalid: a transcript truncated mid-patch still names real files in
 * the directives it did capture, and discarding them would lose true mutations to
 * buy precision against a shape the corpus does not contain (65 envelopes, zero
 * missing terminators, zero trailing directives).
 */
const PATCH_END_RE = /^\s*\*\*\* End Patch\b/;

/**
 * Line split that tolerates CRLF.
 *
 * Splitting on `"\n"` alone left a trailing `\r` on every line of a
 * Windows-captured patch, and `\r` is a LINE TERMINATOR to a JS regex — so `.`
 * cannot consume it and `$` (no `m` flag) sits after it, meaning
 * {@link PATCH_FILE_DIRECTIVE_RE} matched nothing. The failure was silent and
 * total: `*** Begin Patch` still matched (`\s` does accept `\r`), so the adapter
 * claimed the input as a patch and then reported ZERO targets, which
 * `mutationTargetsFor` reads as an authoritative answer and does not fall back
 * from. Every mutation in such a session collapsed to the `MutateCode` default,
 * silently undoing AA-09 C1 for that harness+platform.
 */
const PATCH_LINE_SPLIT_RE = /\r?\n/;

/** Every path named by an `apply_patch` envelope, in envelope order. */
function patchTargets(patch: string): string[] {
  const targets: string[] = [];
  for (const line of patch.split(PATCH_LINE_SPLIT_RE)) {
    if (PATCH_END_RE.test(line)) {
      break;
    }
    const match = line.match(PATCH_FILE_DIRECTIVE_RE);
    if (match) {
      targets.push(match[1]);
    }
  }
  return targets;
}

/** The `path` field's value when the input carries a usable one. */
function directPath(input: Record<string, unknown>): string | null {
  const path = input.path;
  return typeof path === "string" && path.trim() && !path.includes("\n")
    ? path
    : null;
}

export const codexAdapter: HarnessAdapter = {
  categorize(tool: NormalizedToolUse): StructuralCategory | null {
    if (MUTATE_CODE_TOOLS.has(tool.name)) {
      return ToolCategory.MutateCode;
    }
    if (RUN_COMMAND_TOOLS.has(tool.name)) {
      return ToolCategory.RunCommand;
    }
    return null;
  },

  declaredFromTool(tool: NormalizedToolUse): DeclaredEvidence | null {
    // Codex preserves the MCP server/method on the tool use; the display name
    // is already `server__method`. Either signal marks an MCP call.
    if (tool.mcpServer || tool.name.startsWith(MCP_TOOL_NAME_PREFIX)) {
      const name = tool.mcpServer
        ? `${tool.mcpServer}${tool.mcpMethod ? `__${tool.mcpMethod}` : ""}`
        : tool.name;
      return {
        kind: DeclaredKind.McpCall,
        name,
        timestamp: tool.timestamp,
        // Inert placeholder — `collectDeclared` owns the classification.
        category: ToolCategory.DeclaredUtility,
      };
    }
    return null;
  },

  mutationTargets(tool: NormalizedToolUse): string[] | null {
    if (!MUTATE_CODE_TOOLS.has(tool.name)) {
      return null;
    }
    // The dominant shape: the raw envelope as the whole input string.
    if (typeof tool.input === "string" && PATCH_ENVELOPE_RE.test(tool.input)) {
      return patchTargets(tool.input);
    }
    // The structured shape (`{ path, patch }`). Returning either side alone
    // drops the other: answering with the envelope's directives suppresses the
    // generic scan that would have read `path`, so a source file named ONLY in
    // `path` beside a documentation-only patch was downgraded to documentation.
    // Both are real targets, so both are returned and the caller reconciles them.
    if (tool.input && typeof tool.input === "object") {
      const input = tool.input as Record<string, unknown>;
      const patch = input.patch;
      if (typeof patch === "string" && PATCH_ENVELOPE_RE.test(patch)) {
        const path = directPath(input);
        const targets = patchTargets(patch);
        return path === null ? targets : [path, ...targets];
      }
    }
    // An apply_patch whose payload is not a recognizable envelope: say nothing
    // rather than hand back a blob, and let the generic extraction try.
    return null;
  },

  isAgentStatePath(path: string): boolean {
    return STATE_DIR_RE.test(path);
  },
};
