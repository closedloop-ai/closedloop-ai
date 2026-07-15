/**
 * @file build-session-evidence.ts
 * @description FEA-2268: the harness-blind core. `buildSessionEvidence` projects
 * a `NormalizedSession` into the vendor-neutral `SessionEvidence` the activity
 * classifier (FEA-2269) reads. It selects the per-harness adapter (the ONLY
 * vendor-aware step) to map tool NAMES to base abstract categories, then refines
 * and aggregates over harness-AGNOSTIC signals (command text, normalized fields)
 * only — so this file contains no harness tool-name literals (boundary-guard
 * test). Total: every session yields well-formed evidence; unknown harness/tool
 * degrades to structural-only and never throws.
 */
import type { SessionTracePhaseSource } from "@repo/api/src/types/agent-session";
import { shellCommand } from "../parsing/parser-utils.js";
import {
  Harness,
  type NormalizedSession,
  type NormalizedToolUse,
} from "../types.js";
import { claudeAdapter } from "./adapters/claude-adapter.js";
import { codexAdapter } from "./adapters/codex-adapter.js";
import { copilotAdapter } from "./adapters/copilot-adapter.js";
import { cursorAdapter } from "./adapters/cursor-adapter.js";
import { fallbackAdapter } from "./adapters/fallback-adapter.js";
import { opencodeAdapter } from "./adapters/opencode-adapter.js";
import {
  type DeclaredEvidence,
  DeclaredKind,
  EvidenceLayer,
  type EvidenceUnit,
  emptyCategoryMix,
  type HarnessAdapter,
  type SessionEvidence,
  type StructuralCategory,
  type StructuralEvidence,
  TOOL_CATEGORY_VALUES,
  ToolCategory,
} from "./evidence-model.js";

/** One thin adapter per known harness. The core imports all of them + fallback. */
const EVIDENCE_ADAPTERS: Record<Harness, HarnessAdapter> = {
  [Harness.Claude]: claudeAdapter,
  [Harness.Codex]: codexAdapter,
  [Harness.Cursor]: cursorAdapter,
  [Harness.Copilot]: copilotAdapter,
  [Harness.OpenCode]: opencodeAdapter,
};

// Command-content classification regexes. These match UNIVERSAL shell-command
// text (git/gh/test runners), NOT harness tool names, so they are harness-blind
// and live in the core. `TestRun` is a conservative refinement of `RunCommand`
// (a miss safely degrades to RunCommand); start narrow (PLN-1202 §8).
const TEST_COMMAND_RE =
  /\b(?:vitest|jest|mocha|pytest|rspec|phpunit|ctest|tox|(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test|go\s+test|cargo\s+test|gradle\s+(?:test|check)|mvn\s+test|dotnet\s+test)\b/i;
const GIT_LIFECYCLE_RE =
  /\bgit\s+(?:commit|push|checkout|switch|worktree|branch|merge|rebase|tag|cherry-pick)\b|\bgh\s+pr\s+create\b/;
const GIT_COMMIT_RE = /\bgit\s+commit\b/;
const GH_PR_CREATE_RE = /\bgh\s+pr\s+create\b/;

// Common normalized input keys that carry a mutated file path across harnesses.
const MUTATION_PATH_KEYS = ["file_path", "path", "filePath", "file"] as const;
// Bounds on unbounded-by-input collections fed by untrusted agent data, so one
// pathological session can't balloon the evidence record.
const MAX_MUTATION_TARGETS = 50;
const MAX_BRANCHES_TOUCHED = 50;

type CategorizedTool = {
  category: StructuralCategory | null;
  commit: boolean;
  prCreate: boolean;
};

/**
 * The single vendor-aware step (`adapter.categorize`) followed by the
 * harness-blind shell-command refinement: a `RunCommand` becomes `TestRun` or
 * `GitLifecycle` from its (universal) command text, and git-lifecycle counters
 * are read off the same text.
 */
function categorizeToolUse(
  adapter: HarnessAdapter,
  tool: NormalizedToolUse
): CategorizedTool {
  const category = adapter.categorize(tool);
  if (category !== ToolCategory.RunCommand) {
    return { category, commit: false, prCreate: false };
  }
  const command = shellCommand(tool);
  let refined: StructuralCategory = ToolCategory.RunCommand;
  // Check git/PR lifecycle BEFORE test runners: a lifecycle command whose
  // message embeds a test-runner keyword (e.g. `git commit -m "fix jest flake"`)
  // is a lifecycle action, not a test run.
  if (GIT_LIFECYCLE_RE.test(command)) {
    refined = ToolCategory.GitLifecycle;
  } else if (TEST_COMMAND_RE.test(command)) {
    refined = ToolCategory.TestRun;
  }
  return {
    category: refined,
    commit: GIT_COMMIT_RE.test(command),
    prCreate: GH_PR_CREATE_RE.test(command),
  };
}

/** Best-effort, harness-agnostic mutated-path extraction from a tool's input. */
function mutationTarget(tool: NormalizedToolUse): string | null {
  const input = tool.input;
  if (typeof input === "string") {
    return input.trim() || null;
  }
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of MUTATION_PATH_KEYS) {
      const value = obj[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  return null;
}

/**
 * The declared layer (highest rank): session slash commands + per-tool declared
 * signals (skill / MCP) + DB-derived trace-phase boundaries supplied by the
 * caller. No single source is required.
 */
function collectDeclared(
  session: NormalizedSession,
  adapter: HarnessAdapter,
  tracePhaseSources: readonly SessionTracePhaseSource[]
): DeclaredEvidence[] {
  const declared: DeclaredEvidence[] = [];
  for (const slashCommand of session.slashCommands) {
    declared.push({
      kind: DeclaredKind.SlashCommand,
      name: slashCommand.name,
      timestamp: slashCommand.timestamp,
      category: ToolCategory.DeclaredIntent,
    });
  }
  for (const tool of session.toolUses) {
    const toolDeclared = adapter.declaredFromTool(tool);
    if (toolDeclared) {
      declared.push(toolDeclared);
    }
  }
  for (const phase of tracePhaseSources) {
    declared.push({
      kind: DeclaredKind.TracePhase,
      name: phase.label ?? phase.phaseKey,
      timestamp: phase.startedAt,
      category: ToolCategory.DeclaredIntent,
    });
  }
  return declared;
}

/**
 * The harness-blind structural aggregate over the session's tool uses:
 * abstract-category mix, mutated file paths, git-lifecycle counts, and human
 * steering density. `declaredCount` folds the declared-signal count into the
 * complete `categoryMix` so the classifier reads one shape.
 */
function aggregateStructural(
  session: NormalizedSession,
  adapter: HarnessAdapter,
  declaredCount: number
): StructuralEvidence {
  const categoryMix = emptyCategoryMix();
  const mutationTargets: string[] = [];
  const mutationSeen = new Set<string>();
  const branchesTouched = new Set<string>();
  let commits = 0;
  let prsCreated = 0;

  for (const tool of session.toolUses) {
    const { category, commit, prCreate } = categorizeToolUse(adapter, tool);
    if (commit) {
      commits += 1;
    }
    if (prCreate) {
      prsCreated += 1;
    }
    if (category) {
      categoryMix[category] += 1;
    }
    if (
      category === ToolCategory.MutateCode &&
      mutationTargets.length < MAX_MUTATION_TARGETS
    ) {
      const target = mutationTarget(tool);
      if (target && !mutationSeen.has(target)) {
        mutationSeen.add(target);
        mutationTargets.push(target);
      }
    }
    if (tool.gitBranch && branchesTouched.size < MAX_BRANCHES_TOUCHED) {
      branchesTouched.add(tool.gitBranch);
    }
  }

  const humanTurns = session.userMessages;
  categoryMix[ToolCategory.HumanTurn] = humanTurns;
  categoryMix[ToolCategory.DeclaredIntent] = declaredCount;

  return {
    categoryMix,
    mutationTargets,
    gitLifecycle: {
      commits,
      branchesTouched: [...branchesTouched],
      prsCreated,
    },
    humanTurnDensity: {
      humanTurns,
      totalTurns: session.userMessages + session.assistantMessages,
    },
  };
}

/**
 * The single vendor-aware resolution shared by both evidence projections: select
 * the per-harness adapter (fallback for an unknown harness) and collect the
 * declared layer. Extracted so the aggregate ({@link buildSessionEvidence}) and
 * the timeline ({@link buildEvidenceTimeline}) cannot drift their adapter/declared
 * handling apart on a one-sided edit.
 */
function resolveAdapterAndDeclared(
  session: NormalizedSession,
  harness: Harness,
  options?: { tracePhaseSources?: readonly SessionTracePhaseSource[] }
): { adapter: HarnessAdapter; declared: DeclaredEvidence[] } {
  const adapter = EVIDENCE_ADAPTERS[harness] ?? fallbackAdapter;
  const declared = collectDeclared(
    session,
    adapter,
    options?.tracePhaseSources ?? []
  );
  return { adapter, declared };
}

/**
 * Project a parsed session into the session-level vendor-neutral evidence
 * AGGREGATE (`categoryMix` + mutation/git/human rollups). NOTE: FEA-2269's
 * classifier consumes the time-ordered {@link buildEvidenceTimeline}, NOT this
 * aggregate — the aggregate is retained for the session-level consumers of later
 * PRD-488 waves (e.g. work-item linkage over `mutationTargets`/`gitLifecycle`,
 * cohort metrics). `harness` is threaded explicitly (known at the collector level)
 * rather than re-derived from tool names, which would re-couple the core to vendor
 * strings; `tracePhaseSources` are the optional DB-derived declared-phase
 * boundaries. Pure and DB-free.
 */
export function buildSessionEvidence(
  session: NormalizedSession,
  harness: Harness,
  options?: { tracePhaseSources?: readonly SessionTracePhaseSource[] }
): SessionEvidence {
  const { adapter, declared } = resolveAdapterAndDeclared(
    session,
    harness,
    options
  );
  return {
    harness,
    harnessKnown: Object.hasOwn(EVIDENCE_ADAPTERS, harness),
    declared,
    structural: aggregateStructural(session, adapter, declared.length),
    linguistic: [],
  };
}

// Ranks for the deterministic timeline tie-break: `declared` before `structural`
// (declared outranks structural). `linguistic` is never emitted onto the
// timeline but is ranked for totality. Same ms + same category → this fixed rank
// keeps the ordering total, so the sort is byte-identical regardless of engine
// sort stability.
const EVIDENCE_LAYER_RANK: Record<EvidenceLayer, number> = {
  [EvidenceLayer.Declared]: 0,
  [EvidenceLayer.Structural]: 1,
  [EvidenceLayer.Linguistic]: 2,
};

/** Total, engine-independent ordering of evidence units: (ms, category, layer). */
function compareEvidenceUnits(a: EvidenceUnit, b: EvidenceUnit): number {
  if (a.ms !== b.ms) {
    return a.ms - b.ms;
  }
  const categoryDelta =
    TOOL_CATEGORY_VALUES.indexOf(a.category) -
    TOOL_CATEGORY_VALUES.indexOf(b.category);
  if (categoryDelta !== 0) {
    return categoryDelta;
  }
  return EVIDENCE_LAYER_RANK[a.layer] - EVIDENCE_LAYER_RANK[b.layer];
}

// Structural tool-use units: each recognized tool contributes its refined
// abstract category at its own timestamp. Unrecognized (null) tools and
// undateable tools contribute nothing (never an error) — the same degrade-to-
// nothing rule the aggregate applies.
function structuralToolUnits(
  session: NormalizedSession,
  adapter: HarnessAdapter
): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];
  for (const tool of session.toolUses) {
    const { category } = categorizeToolUse(adapter, tool);
    const ms = tool.timestamp ? Date.parse(tool.timestamp) : Number.NaN;
    if (category && Number.isFinite(ms)) {
      units.push({ ms, category, layer: EvidenceLayer.Structural });
    }
  }
  return units;
}

// Human-steering units from the ordered message list (`role === "human"`). The
// aggregate reads a bare count (`userMessages`); the timeline needs the WHEN, so
// it dates each human turn from `messages`. Sessions whose parser populates only
// the count (empty `messages`) simply contribute no human-turn units.
function humanTurnUnits(session: NormalizedSession): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];
  for (const message of session.messages) {
    if (message.role !== "human") {
      continue;
    }
    const ms = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
    if (Number.isFinite(ms)) {
      units.push({
        ms,
        category: ToolCategory.HumanTurn,
        layer: EvidenceLayer.Structural,
      });
    }
  }
  return units;
}

// Declared-intent units: reuse the same declared signals the aggregate collects,
// dropping any with no parseable timestamp (it can't be placed on the timeline).
function declaredUnits(declared: readonly DeclaredEvidence[]): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];
  for (const signal of declared) {
    const ms = signal.timestamp ? Date.parse(signal.timestamp) : Number.NaN;
    if (Number.isFinite(ms)) {
      units.push({
        ms,
        category: ToolCategory.DeclaredIntent,
        layer: EvidenceLayer.Declared,
      });
    }
  }
  return units;
}

/**
 * Project a parsed session into the ORDERED, time-anchored evidence timeline the
 * activity classifier (FEA-2269) windows and scores. Same single vendor-aware
 * step as `buildSessionEvidence` (the per-harness adapter maps tool NAMES →
 * abstract categories), but it preserves each signal's timestamp instead of
 * folding everything into a session-level `categoryMix`. Pure + deterministic:
 * reads only the parsed session (+ the caller's optional trace phases), never the
 * wall clock, and the total `compareEvidenceUnits` order makes the output
 * byte-identical across runs regardless of engine sort stability.
 */
export function buildEvidenceTimeline(
  session: NormalizedSession,
  harness: Harness,
  options?: { tracePhaseSources?: readonly SessionTracePhaseSource[] }
): EvidenceUnit[] {
  const { adapter, declared } = resolveAdapterAndDeclared(
    session,
    harness,
    options
  );
  const units = [
    ...structuralToolUnits(session, adapter),
    ...humanTurnUnits(session),
    ...declaredUnits(declared),
  ];
  units.sort(compareEvidenceUnits);
  return units;
}
