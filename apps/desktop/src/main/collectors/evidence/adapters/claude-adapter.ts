/**
 * @file claude-adapter.ts
 * @description FEA-2268: Claude Code harness adapter. Maps Claude's concrete
 * tool names (the verbatim `block.name` claude-parser emits) to abstract
 * categories. This is one of the ONLY places Claude tool-name strings appear.
 */
import type { NormalizedToolUse } from "../../types.js";
import {
  type DeclaredEvidence,
  DeclaredKind,
  type HarnessAdapter,
  mcpDeclaredFromTool,
  type StructuralCategory,
  ToolCategory,
} from "../evidence-model.js";
import { isUnderTempRoot } from "../mutation-kind.js";

// Claude emits tool names verbatim from the transcript `block.name`
// (claude-parser.ts). Read-only inspection tools.
const READ_SEARCH_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
]);

// File-mutation tools (Edit/Write set `diffDelta`, claude-parser).
const MUTATE_CODE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

// Shell command execution.
const RUN_COMMAND_TOOLS = new Set(["Bash"]);

/**
 * FEA-4010 (AA-09 C1): the `.claude/` subdirectories Claude Code itself owns —
 * per-project transcripts and memory, todo lists, shell snapshots, telemetry.
 *
 * An ALLOWLIST rather than a blanket `.claude/` match, and the distinction is the
 * point: `.claude/agents/`, `.claude/skills/`, `.claude/commands/` and
 * `.claude/settings.json` are USER-AUTHORED configuration committed to the repo,
 * so editing them is real work, and `.claude/worktrees/` holds checkouts of the
 * user's project — a corpus session edits a project file inside one. Matching all
 * of `.claude/` would have swept every one of those in. Listing only the state
 * directories means an unrecognized subdirectory keeps the `MutateCode` default.
 */
const STATE_DIR_RE =
  /(?:^|[\\/])\.claude[\\/](?:projects|todos|shell-snapshots|statsig)[\\/]/;

/**
 * The per-session scratchpad root Claude Code creates under the system temp
 * directory (`<temp>/claude-<uid>/<project>/<session-id>/scratchpad/…`).
 *
 * BOTH structural markers are required — the `claude-<uid>` segment AND a later
 * `scratchpad/` segment — because being under temp is not enough on its own. A
 * repository cloned to `/tmp/claude-3/` satisfies the temp test and the
 * `claude-<digits>` test, so keying on those alone read a genuine source edit at
 * `/tmp/claude-3/src/index.ts` as harness bookkeeping. Pinning the documented
 * shape end to end costs nothing on real scratchpad paths and makes that
 * false positive unreachable; anything failing it keeps the `MutateCode` default.
 */
const TEMP_SCRATCH_RE = /(?:^|[\\/])claude-\d+[\\/](?:.*[\\/])?scratchpad[\\/]/;

export const claudeAdapter: HarnessAdapter = {
  categorize(tool: NormalizedToolUse): StructuralCategory | null {
    if (READ_SEARCH_TOOLS.has(tool.name)) {
      return ToolCategory.ReadSearch;
    }
    if (MUTATE_CODE_TOOLS.has(tool.name)) {
      return ToolCategory.MutateCode;
    }
    if (RUN_COMMAND_TOOLS.has(tool.name)) {
      return ToolCategory.RunCommand;
    }
    // Skill / Task (subagent spawn) / TodoWrite / MCP calls are not structural
    // tool categories: a skill surfaces via the declared layer (when it carries
    // a skill identifier); the rest contribute no category (unknown → null).
    return null;
  },

  declaredFromTool(tool: NormalizedToolUse): DeclaredEvidence | null {
    if (tool.skillName) {
      return {
        kind: DeclaredKind.Skill,
        name: tool.skillName,
        timestamp: tool.timestamp,
        // Inert placeholder — `collectDeclared` owns the classification.
        category: ToolCategory.DeclaredUtility,
      };
    }
    // A bare `Skill` tool use with no `skillName` carries no useful identifier,
    // so it degrades to null (via the shared MCP rule) rather than emitting a
    // misleading `name: "Skill"` declared record.
    return mcpDeclaredFromTool(tool);
  },

  isAgentStatePath(path: string): boolean {
    return (
      STATE_DIR_RE.test(path) ||
      (isUnderTempRoot(path) && TEMP_SCRATCH_RE.test(path))
    );
  },
};
