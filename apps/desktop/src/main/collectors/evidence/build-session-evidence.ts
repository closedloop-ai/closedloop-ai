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
import { CommandEffect, classifyCommandEffect } from "./command-semantics.js";
import { blankQuotedSpans, stripHeredocBodies } from "./command-tokens.js";
import {
  type DeclaredEvidence,
  DeclaredKind,
  declaredCategoryFor,
  declaredCategoryForTracePhase,
  EvidenceLayer,
  type EvidenceUnit,
  emptyCategoryMix,
  type HarnessAdapter,
  MUTATION_CATEGORIES,
  type SessionEvidence,
  type StructuralCategory,
  type StructuralEvidence,
  TOOL_CATEGORY_VALUES,
  ToolCategory,
} from "./evidence-model.js";
import { mutationCategoryForTargets } from "./mutation-kind.js";
import { isTestInvocation } from "./test-invocation.js";

/** One thin adapter per known harness. The core imports all of them + fallback. */
const EVIDENCE_ADAPTERS: Record<Harness, HarnessAdapter> = {
  [Harness.Claude]: claudeAdapter,
  [Harness.Codex]: codexAdapter,
  [Harness.Cursor]: cursorAdapter,
  [Harness.Copilot]: copilotAdapter,
  [Harness.OpenCode]: opencodeAdapter,
};

// Command-content classification regexes. These match UNIVERSAL shell-command
// text (git/gh lifecycle), NOT harness tool names, so they are harness-blind and
// live in the core. Test detection moved to `test-invocation.ts` (AA-09): it
// needs the line PARSED, not scanned, because a runner's name in an argument
// (`which pytest`, `cat vitest.config.mts`) is not a test run.
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
  /**
   * The paths a MUTATING tool use touched. Extracted here because the AA-09 C1
   * refinement below needs them to pick the mutation kind, and carried on the
   * result so `aggregateStructural` reuses them rather than re-parsing every
   * Codex patch (the corpus's largest is 32 KB) a second time. Empty for every
   * non-mutating tool.
   */
  mutationTargets: readonly string[];
};

/** Shared empty tail for the non-mutating paths, so they don't each allocate. */
const NO_MUTATION_TARGETS: readonly string[] = [];

/**
 * The single vendor-aware step (`adapter.categorize`) followed by the
 * harness-blind refinements: a `MutateCode` becomes `MutateDocument`/
 * `MutateScratch` from what it TOUCHED (AA-09 C1), and a `RunCommand` becomes
 * `TestRun`, `GitLifecycle`, or (AA-04) `ReadSearch` from its (universal) command
 * text, off which the git-lifecycle counters are also read.
 *
 * Refinement PRECEDENCE is load-bearing and unchanged at the top: git/PR
 * lifecycle wins over test runners (a `git commit -m "fix jest flake"` is a
 * lifecycle action, not a test run), and both win over the AA-04 read-only check
 * so no existing categorization moves. Only a command that would otherwise have
 * stayed an un-refined `RunCommand` can become `ReadSearch`.
 */
function categorizeToolUse(
  adapter: HarnessAdapter,
  tool: NormalizedToolUse
): CategorizedTool {
  const category = adapter.categorize(tool);
  if (category === ToolCategory.MutateCode) {
    const targets = mutationTargetsFor(adapter, tool);
    return {
      category: mutationCategoryForTargets(
        targets,
        // The HARNESS's opinion only. Plugin/tooling state is harness-independent
        // and is applied by the taxonomy itself, so no caller can omit it.
        (path) => adapter.isAgentStatePath?.(path) ?? false
      ),
      commit: false,
      prCreate: false,
      mutationTargets: targets,
    };
  }
  if (category !== ToolCategory.RunCommand) {
    return {
      category,
      commit: false,
      prCreate: false,
      mutationTargets: NO_MUTATION_TARGETS,
    };
  }
  // Strip heredoc BODIES once, before anything reads the line, so all three
  // readers below see the same command. A heredoc body is authored CONTENT, not
  // commands the shell will run, and each reader that missed this read the prose
  // as instructions: a document whose body mentions `git commit` landed on
  // GitLifecycle, and one whose body quoted a test plan landed on TestRun.
  // Stripping first is also what makes the openers safe to blank — doing it in
  // the other order rewrites a quoted delimiter (`<<'EOF'`) into one the closing
  // line can never match, so the body runs to end-of-string and swallows the real
  // commands after it.
  const command = stripHeredocBodies(shellCommand(tool));
  // Match the lifecycle vocabulary against QUOTED-BLANKED text: a tool name
  // inside a search pattern or a commit message is text being looked for, not a
  // tool being run, so `rg 'pnpm test'` is a search and not a test run.
  const spoken = blankQuotedSpans(command);
  let refined: StructuralCategory = ToolCategory.RunCommand;
  // Check git/PR lifecycle BEFORE test runners: a lifecycle command whose
  // message embeds a test-runner keyword (e.g. `git commit -m "fix jest flake"`)
  // is a lifecycle action, not a test run.
  if (GIT_LIFECYCLE_RE.test(spoken)) {
    refined = ToolCategory.GitLifecycle;
  } else if (isTestInvocation(command)) {
    refined = ToolCategory.TestRun;
  } else if (classifyCommandEffect(command) === CommandEffect.ReadOnly) {
    // AA-04: read-only shell work IS exploration. Before this, investigating
    // through the shell (`grep`, `sed -n`, `git log`, `cat`) produced no explore
    // signal at all, so `explore` was structurally near-unreachable and a
    // shell-only harness could never explore. Only a CONFIDENTLY read-only line
    // qualifies — `Mutating` and `Unknown` both stay `RunCommand`.
    refined = ToolCategory.ReadSearch;
  }
  return {
    category: refined,
    commit: GIT_COMMIT_RE.test(spoken),
    prCreate: GH_PR_CREATE_RE.test(spoken),
    mutationTargets: NO_MUTATION_TARGETS,
  };
}

/**
 * Best-effort, harness-agnostic mutated-path extraction from a tool's input.
 *
 * The harness ADAPTER gets first refusal (FEA-4010 / AA-09 C1): only it knows
 * shapes this field-name scan cannot read — Codex's `apply_patch`, where the
 * whole multi-file patch IS the input string. An adapter returning `[]` has
 * answered; the fallback below serves adapters with no opinion (`null`).
 */
function mutationTargetsFor(
  adapter: HarnessAdapter,
  tool: NormalizedToolUse
): string[] {
  const declared = adapter.mutationTargets?.(tool);
  if (declared) {
    return declared;
  }
  const input = tool.input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    // A path never spans lines. This previously returned the string
    // unconditionally, which is how an entire patch blob (median 1.5 KB, max
    // 32 KB) was stored as a "mutated path" for every Codex edit. Declining to
    // answer is the right failure: a consumer can tell "unknown" from a
    // fabricated path, and MAX_MUTATION_TARGETS stays a bound on paths rather
    // than on blobs.
    return trimmed && !trimmed.includes("\n") ? [trimmed] : [];
  }
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of MUTATION_PATH_KEYS) {
      const value = obj[key];
      if (typeof value === "string" && value.length > 0) {
        return [value];
      }
    }
  }
  return [];
}

/**
 * The declared layer (highest rank): session slash commands + per-tool declared
 * signals (skill / MCP) + DB-derived trace-phase boundaries supplied by the
 * caller. No single source is required. Each signal's abstract category is
 * classified by name through {@link declaredCategoryFor}: a plan-specific
 * declaration (`/create-plan`, `ExitPlanMode`) becomes `DeclaredPlan` — the ONLY
 * declaration that gates `plan` (FEA-4184) — and everything the core does not
 * positively recognize as work intent falls to the INERT
 * `DeclaredUtility` (AA-03), so an auth/model/plugin command or a work-tracking
 * MCP call no longer fabricates `declared` provenance or a confidence boost.
 * Trace phases are the exception: they declare the work phase itself, so
 * {@link declaredCategoryForTracePhase} keeps them on genuine `DeclaredIntent`.
 * Classification is centralized here (adapters emit the raw kind+name) so the
 * gate and the inert default each have exactly one owner.
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
      category: declaredCategoryFor(slashCommand.name),
    });
  }
  for (const tool of session.toolUses) {
    const toolDeclared = adapter.declaredFromTool(tool);
    if (toolDeclared) {
      declared.push({
        ...toolDeclared,
        category: declaredCategoryFor(toolDeclared.name),
      });
    }
  }
  for (const phase of tracePhaseSources) {
    const name = phase.label ?? phase.phaseKey;
    declared.push({
      kind: DeclaredKind.TracePhase,
      name,
      timestamp: phase.startedAt,
      // A trace phase carries its intent in both the machine key and the label;
      // classify from whichever names the phase (key is the stable one). Unlike a
      // command/skill/MCP name this is a first-class declaration of the work phase
      // itself, so a non-plan phase keeps genuine `DeclaredIntent` provenance
      // rather than AA-03's inert default for name-derived signals.
      category: declaredCategoryForTracePhase(phase.phaseKey, name),
    });
  }
  return declared;
}

/**
 * The harness-blind structural aggregate over the session's tool uses:
 * abstract-category mix, mutated file paths, git-lifecycle counts, and human
 * steering density. `declared` folds the declared-signal counts into the complete
 * `categoryMix` BY CATEGORY (`DeclaredIntent` vs the plan-specific `DeclaredPlan`,
 * FEA-4184) so the classifier reads one shape and the plan gate sees only genuine
 * plan declarations.
 */
/**
 * Append one mutating tool's distinct paths, respecting the collection bound.
 *
 * The bound is re-checked per PATH, not once per tool: a single tool use can
 * name several files (a Codex patch commonly does; one corpus patch names 14),
 * so a large patch arriving near the limit would otherwise overshoot it.
 */
function collectMutationTargets(
  targets: readonly string[],
  into: string[],
  seen: Set<string>
): void {
  for (const target of targets) {
    if (into.length >= MAX_MUTATION_TARGETS) {
      return;
    }
    if (!seen.has(target)) {
      seen.add(target);
      into.push(target);
    }
  }
}

function aggregateStructural(
  session: NormalizedSession,
  adapter: HarnessAdapter,
  declared: readonly DeclaredEvidence[]
): StructuralEvidence {
  const categoryMix = emptyCategoryMix();
  const mutationTargets: string[] = [];
  const mutationSeen = new Set<string>();
  const branchesTouched = new Set<string>();
  let commits = 0;
  let prsCreated = 0;

  for (const tool of session.toolUses) {
    const categorized = categorizeToolUse(adapter, tool);
    const { category } = categorized;
    if (categorized.commit) {
      commits += 1;
    }
    if (categorized.prCreate) {
      prsCreated += 1;
    }
    if (category) {
      categoryMix[category] += 1;
    }
    if (category && MUTATION_CATEGORIES.has(category)) {
      collectMutationTargets(
        categorized.mutationTargets,
        mutationTargets,
        mutationSeen
      );
    }
    if (tool.gitBranch && branchesTouched.size < MAX_BRANCHES_TOUCHED) {
      branchesTouched.add(tool.gitBranch);
    }
  }

  const humanTurns = session.userMessages;
  categoryMix[ToolCategory.HumanTurn] = humanTurns;
  for (const signal of declared) {
    categoryMix[signal.category] += 1;
  }

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
    structural: aggregateStructural(session, adapter, declared),
    linguistic: [],
  };
}

/**
 * FEA-2271: the same vendor-aware categorization {@link buildSessionEvidence}
 * applies to a whole session, scoped to an ARBITRARY tool-use list — a subagent's
 * own `toolUses`. The subagent purpose classifier scores a delegated sub-task from
 * its own evidence through the IDENTICAL FEA-2268 adapter boundary (never a forked
 * heuristic), then `scoreWindow`s the returned mix to one purpose phase. Counts
 * each recognized tool's refined abstract category and folds a declared-from-tool
 * (MCP) signal into `DeclaredIntent`; `HumanTurn` stays 0 (a subagent has no human
 * turns). Pure; an unknown harness/tool degrades to structural-only (or nothing),
 * never throws — the same degrade-to-nothing rule the aggregate applies.
 */
export function categoryMixForToolUses(
  toolUses: readonly NormalizedToolUse[],
  harness: Harness
): Record<ToolCategory, number> {
  const adapter = EVIDENCE_ADAPTERS[harness] ?? fallbackAdapter;
  const mix = emptyCategoryMix();
  for (const tool of toolUses) {
    const { category } = categorizeToolUse(adapter, tool);
    if (category) {
      mix[category] += 1;
    }
    const toolDeclared = adapter.declaredFromTool(tool);
    if (toolDeclared) {
      // Classify plan-specificity by name (FEA-4184) so a subagent's own plan
      // declaration gates its purpose phase the same way the session timeline does.
      mix[declaredCategoryFor(toolDeclared.name)] += 1;
    }
  }
  return mix;
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

// Declared units: reuse the same declared signals the aggregate collects,
// dropping any with no parseable timestamp (it can't be placed on the timeline).
// Emits each signal's OWN category (`DeclaredPlan` vs `DeclaredIntent`, FEA-4184)
// so the plan-specific signal reaches the per-window scorer's `plan` gate rather
// than being flattened into the generic declared bucket.
function declaredUnits(declared: readonly DeclaredEvidence[]): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];
  for (const signal of declared) {
    const ms = signal.timestamp ? Date.parse(signal.timestamp) : Number.NaN;
    if (Number.isFinite(ms)) {
      units.push({
        ms,
        category: signal.category,
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
