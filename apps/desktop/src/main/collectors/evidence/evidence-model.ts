/**
 * @file evidence-model.ts
 * @description FEA-2268 (PRD-488): the vendor-neutral, harness-blind evidence
 * MODEL — the abstract tool-category vocabulary, the three ranked evidence
 * layers (`declared` > `structural` > `linguistic`), and the output shape the
 * activity classifier (FEA-2269) consumes. This module is the leaf contract: it
 * holds the vocabulary types, const-object enums, and small pure per-tool
 * helpers (no adapter imports, no session iteration) so the per-harness adapters
 * can import it without an import cycle.
 *
 * THE ANTI-OVER-FITTING BOUNDARY: this file (and FEA-2269's consumer) reference
 * only the abstract `ToolCategory` members below; concrete harness tool-name
 * strings (`Bash`, `shell`, `file_edit`, `copilot_tool`, …) live ONLY in the
 * per-harness adapters under `./adapters`. A boundary-guard test enforces it.
 *
 * Pure/in-memory: nothing here persists or touches the DB (FEA-2269 owns that).
 */
import type { NormalizedToolUse } from "../types.js";

/**
 * The abstract, harness-blind tool categories — the ONLY activity vocabulary the
 * classifier core reasons about. Per-harness adapters map concrete tool names
 * into these; the classifier never sees a vendor string. Stored as snake_case
 * SSOT/display tokens (PLN-1196 §5 R4); the const-object member identifiers are
 * PascalCase, mapped 1:1.
 */
export const ToolCategory = {
  /** Read/inspect/search the codebase, no mutation (Read/Grep/Glob, read-only shell). */
  ReadSearch: "read_search",
  /** Edit/write/patch a file. */
  MutateCode: "mutate_code",
  /** Run an arbitrary shell command (non-test, non-git-lifecycle). */
  RunCommand: "run_command",
  /** Run a test suite / test command (a refinement of RunCommand). */
  TestRun: "test_run",
  /** Git/PR lifecycle action: commit, branch, push, PR create (a refinement of RunCommand). */
  GitLifecycle: "git_lifecycle",
  /** A human-authored turn (steering density); generalizes the legacy is_human rule. */
  HumanTurn: "human_turn",
  /** An explicit, declared signal of intent (slash command, skill, MCP call, trace phase). */
  DeclaredIntent: "declared_intent",
} as const;
export type ToolCategory = (typeof ToolCategory)[keyof typeof ToolCategory];

/**
 * The structural subset of `ToolCategory` an adapter may assign to a tool by
 * name. `HumanTurn` and `DeclaredIntent` are derived by the core (turn counts /
 * the declared layer), never returned by `categorize`, so excluding them here
 * makes that contract machine-checked rather than merely conventional.
 */
export type StructuralCategory = Exclude<
  ToolCategory,
  typeof ToolCategory.HumanTurn | typeof ToolCategory.DeclaredIntent
>;

/** The canonical ordered member list — the SSOT for the enum-stability guard. */
export const TOOL_CATEGORY_VALUES = [
  ToolCategory.ReadSearch,
  ToolCategory.MutateCode,
  ToolCategory.RunCommand,
  ToolCategory.TestRun,
  ToolCategory.GitLifecycle,
  ToolCategory.HumanTurn,
  ToolCategory.DeclaredIntent,
] as const satisfies readonly ToolCategory[];

/** The three ranked evidence layers; `declared` > `structural` > `linguistic`. */
export const EvidenceLayer = {
  Declared: "declared",
  Structural: "structural",
  Linguistic: "linguistic",
} as const;
export type EvidenceLayer = (typeof EvidenceLayer)[keyof typeof EvidenceLayer];

/** What kind of explicit signal a declared-evidence item came from. */
export const DeclaredKind = {
  SlashCommand: "slash_command",
  Skill: "skill",
  McpCall: "mcp_call",
  TracePhase: "trace_phase",
} as const;
export type DeclaredKind = (typeof DeclaredKind)[keyof typeof DeclaredKind];

/**
 * The harness-AGNOSTIC MCP tool-name convention (`mcp__server__method`). This is
 * a cross-harness protocol token, not a vendor tool name, so it lives in the
 * shared contract (the boundary guard intentionally excludes it) and every
 * adapter reuses it rather than re-declaring its own copy.
 */
export const MCP_TOOL_NAME_PREFIX = "mcp__";

/**
 * A single declared-intent signal. The highest-rank evidence layer. `category`
 * is the abstract category this declaration maps to (always `DeclaredIntent`
 * today; the field is explicit so the classifier reads one shape across layers).
 */
export type DeclaredEvidence = {
  kind: DeclaredKind;
  name: string;
  timestamp: string | null;
  category: ToolCategory;
};

/**
 * The shared declared-from-tool rule every adapter reuses: a tool whose name
 * follows the agnostic `mcp__` convention is a declared MCP call. Adapters with
 * no other declared signal (Cursor/Copilot/OpenCode) delegate to this directly;
 * Claude and the fallback call it after their skill check. Returns null
 * otherwise. Codex has its own variant (it carries structured `mcpServer`).
 */
export function mcpDeclaredFromTool(
  tool: NormalizedToolUse
): DeclaredEvidence | null {
  if (tool.name.startsWith(MCP_TOOL_NAME_PREFIX)) {
    return {
      kind: DeclaredKind.McpCall,
      name: tool.name,
      timestamp: tool.timestamp,
      category: ToolCategory.DeclaredIntent,
    };
  }
  return null;
}

/**
 * The harness-blind structural aggregate over abstract categories. `categoryMix`
 * is a complete count keyed by EVERY `ToolCategory` (zero-filled), so the
 * classifier can read any category without a presence check.
 */
export type StructuralEvidence = {
  categoryMix: Record<ToolCategory, number>;
  /** File paths touched by `MutateCode` tool uses (deduped, capped). */
  mutationTargets: string[];
  gitLifecycle: {
    commits: number;
    /** Distinct git branches touched (deduped, capped — like `mutationTargets`). */
    branchesTouched: string[];
    prsCreated: number;
  };
  humanTurnDensity: { humanTurns: number; totalTurns: number };
};

/**
 * The natural-language evidence layer. Intentionally a typed-but-empty slot in
 * FEA-2268 — FEA-2274 (the opt-in, isolated linguistic layer) populates it. The
 * shape is deliberately minimal/opaque here so FEA-2269's consumer type is
 * stable across the decomposition without pinning FEA-2274's design.
 */
export type LinguisticEvidence = {
  kind: string;
  detail: string;
};

/**
 * The complete session-level evidence AGGREGATE for one session. NOTE: FEA-2269's
 * classifier consumes the time-ordered `EvidenceUnit` timeline
 * (`buildEvidenceTimeline`), NOT this aggregate; the aggregate is retained for the
 * session-level consumers of later PRD-488 waves. `harnessKnown` is false when no
 * adapter matched the harness (a future/unknown harness fell back to
 * structural-only signal).
 */
export type SessionEvidence = {
  harness: string;
  harnessKnown: boolean;
  declared: DeclaredEvidence[];
  structural: StructuralEvidence;
  linguistic: LinguisticEvidence[];
};

/**
 * The thin per-harness adapter — the ONLY place concrete tool-name strings live.
 * `categorize` returns the BASE STRUCTURAL category for a tool by NAME (the core
 * refines `RunCommand` → `TestRun`/`GitLifecycle` from harness-agnostic command
 * text); it can never return `HumanTurn`/`DeclaredIntent`, which the core derives
 * itself. Both methods return `null` for tools they don't recognize — an unknown
 * tool contributes to no category and is never an error.
 */
export type HarnessAdapter = {
  categorize(tool: NormalizedToolUse): StructuralCategory | null;
  declaredFromTool(tool: NormalizedToolUse): DeclaredEvidence | null;
};

/**
 * Bumped when the evidence model's deterministic output semantics change, so
 * FEA-2269 can version-gate re-derivation. Mirrors `EXTRACTOR_VERSION`.
 */
export const EVIDENCE_MODEL_VERSION = 1;

/**
 * A zero-filled `categoryMix` covering every `ToolCategory`. Iterates the LIVE
 * member set via `Object.values(ToolCategory)` rather than the hand-maintained
 * `TOOL_CATEGORY_VALUES` — whose `satisfies readonly ToolCategory[]` only checks
 * that each element IS a category, not that ALL are present. So a newly added
 * category is always zero-filled here, guarding `categoryMix[category] += 1`
 * against `NaN` if the pinned array is ever left out of sync.
 */
export function emptyCategoryMix(): Record<ToolCategory, number> {
  const mix = {} as Record<ToolCategory, number>;
  for (const category of Object.values(ToolCategory)) {
    mix[category] = 0;
  }
  return mix;
}

/**
 * A single time-anchored evidence unit — the per-signal element of the ordered
 * evidence TIMELINE that FEA-2269 windows and scores. Unlike the session-level
 * `StructuralEvidence` aggregate (a whole-session `categoryMix`), this preserves
 * WHEN each abstract signal occurred, so the classifier can partition the
 * timeline into contiguous typed windows rather than label the session as a
 * whole. Still harness-blind: `category` is an abstract `ToolCategory`, never a
 * vendor tool name (the adapter boundary maps names → categories upstream).
 *
 * `linguistic` units are intentionally never emitted here — that layer is
 * FEA-2274's (opt-in, isolated). A unit is either a `structural` tool/human
 * signal or a `declared` intent signal.
 */
export type EvidenceUnit = {
  /** epoch-ms of the signal, parsed from its source timestamp (finite). */
  ms: number;
  /** The abstract category this unit contributes to its window's mix. */
  category: ToolCategory;
  /** Which ranked layer produced the unit (`declared` outranks `structural`). */
  layer: EvidenceLayer;
};
