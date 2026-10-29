/**
 * @file build-session-evidence.ts
 * @description FEA-2268: the harness-blind core. Selects the per-harness adapter
 * (the ONLY vendor-aware step) to map tool NAMES to base abstract categories,
 * then refines and aggregates over harness-AGNOSTIC signals (command text,
 * normalized fields) only — so this file contains no harness tool-name literals
 * (boundary-guard test). `buildEvidenceTimeline` projects a `NormalizedSession`
 * into the ordered evidence timeline the activity classifier (FEA-2269) windows
 * and scores; `categoryMixForToolUses` applies the same categorization to an
 * arbitrary tool-use list (a subagent's own). Total: every session yields
 * well-formed evidence; unknown harness/tool degrades to structural-only and
 * never throws.
 */
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
  EvidenceLayer,
  type EvidenceUnit,
  emptyCategoryMix,
  type HarnessAdapter,
  type StructuralCategory,
  TOOL_CATEGORY_VALUES,
  ToolCategory,
} from "./evidence-model.js";
import { mutationCategoryForTargets } from "./mutation-kind.js";
import { isTestInvocation } from "./test-invocation.js";

/**
 * FEA-2271: the same vendor-aware categorization {@link buildEvidenceTimeline}
 * applies to a whole session, scoped to an ARBITRARY tool-use list — a subagent's
 * own `toolUses`. The subagent purpose classifier scores a delegated sub-task from
 * its own evidence through the IDENTICAL FEA-2268 adapter boundary (never a forked
 * heuristic), then `scoreWindow`s the returned mix to one purpose phase. Counts
 * each recognized tool's refined abstract category and classifies a
 * declared-from-tool (MCP) signal by name into `DeclaredPlan` or the inert
 * `DeclaredUtility` (FEA-4184/AA-03); `HumanTurn` stays 0 (a subagent has no
 * human turns). Pure; an unknown harness/tool degrades to structural-only (or
 * nothing), never throws.
 */
export function categoryMixForToolUses(
  toolUses: readonly NormalizedToolUse[],
  harness: Harness
): Record<ToolCategory, number> {
  const adapter = resolveAdapter(harness);
  const mix = emptyCategoryMix();
  for (const tool of toolUses) {
    const category = categorizeToolUse(adapter, tool);
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

/**
 * Project a parsed session into the ORDERED, time-anchored evidence timeline the
 * activity classifier (FEA-2269) windows and scores. The per-harness adapter maps
 * tool NAMES to abstract categories (the ONLY vendor-aware step); each signal
 * keeps its own timestamp. Pure + deterministic: reads only the parsed session,
 * never the wall clock, and the total `compareEvidenceUnits` order makes the
 * output byte-identical across runs regardless of engine sort stability.
 */
export function buildEvidenceTimeline(
  session: NormalizedSession,
  harness: Harness
): EvidenceUnit[] {
  const adapter = resolveAdapter(harness);
  // Self-named intent — a slash command the OPERATOR typed, or a Skill/MCP call
  // the AGENT chose by name — vs. intent the classifier must infer from what a
  // generic tool (Bash, Edit, ...) structurally did.
  const declaredSignals = collectDeclared(session, adapter);
  const units = [
    ...structuralToolUnits(session, adapter),
    ...humanTurnUnits(session),
    ...declaredUnits(declaredSignals),
  ];
  units.sort(compareEvidenceUnits);
  return units;
}

// Command-content classification regexes. These match UNIVERSAL shell-command
// text (git/gh lifecycle), NOT harness tool names, so they are harness-blind and
// live in the core. Test detection moved to `test-invocation.ts` (AA-09): it
// needs the line PARSED, not scanned, because a runner's name in an argument
// (`which pytest`, `cat vitest.config.mts`) is not a test run.
const GIT_LIFECYCLE_RE =
  /\bgit\s+(?:commit|push|checkout|switch|worktree|branch|merge|rebase|tag|cherry-pick)\b|\bgh\s+pr\s+create\b/;

// Common normalized input keys that carry a mutated file path across harnesses.
const MUTATION_PATH_KEYS = ["file_path", "path", "filePath", "file"] as const;

/**
 * Best-effort, harness-agnostic mutated-path extraction from a tool's input.
 *
 * The harness ADAPTER gets first refusal (FEA-4010 / AA-09 C1): only it knows
 * shapes this field-name scan cannot read — Codex's `apply_patch`, where the
 * whole multi-file patch IS the input string. An adapter returning `[]` has
 * answered; the fallback below serves adapters with no opinion (`null`).
 *
 * Exported as the narrowest entry point onto this scan: it is the operand
 * {@link categorizeToolUse} hands `mutationCategoryForTargets` to pick the
 * mutation kind, and the only place "which paths did this tool name" is
 * observable — the category alone cannot distinguish a declined path from a
 * fabricated one.
 */
export function mutationTargetsFor(
  adapter: HarnessAdapter,
  tool: NormalizedToolUse
): string[] {
  const adapterTargets = adapter.mutationTargets?.(tool);
  if (adapterTargets) {
    return adapterTargets;
  }
  const input = tool.input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    // A path never spans lines. This previously returned the string
    // unconditionally, which is how an entire patch blob (median 1.5 KB, max
    // 32 KB) was stored as a "mutated path" for every Codex edit. Declining to
    // answer is the right failure: a consumer can tell "unknown" from a
    // fabricated path.
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
 * The single vendor-aware step (`adapter.categorize`) followed by the
 * harness-blind refinements: a `MutateCode` becomes `MutateDocument`/
 * `MutateScratch` from what it TOUCHED (AA-09 C1), and a `RunCommand` becomes
 * `TestRun`, `GitLifecycle`, or (AA-04) `ReadSearch` from its (universal) command
 * text.
 *
 * Refinement PRECEDENCE is load-bearing and unchanged at the top: git/PR
 * lifecycle wins over test runners (a `git commit -m "fix jest flake"` is a
 * lifecycle action, not a test run), and both win over the AA-04 read-only check
 * so no existing categorization moves. Only a command that would otherwise have
 * stayed an un-refined `RunCommand` can become `ReadSearch`.
 */
export function categorizeToolUse(
  adapter: HarnessAdapter,
  tool: NormalizedToolUse
): StructuralCategory | null {
  const category = adapter.categorize(tool);
  if (category === ToolCategory.MutateCode) {
    return mutationCategoryForTargets(
      mutationTargetsFor(adapter, tool),
      // The HARNESS's opinion only. Plugin/tooling state is harness-independent
      // and is applied by the taxonomy itself, so no caller can omit it.
      (path) => adapter.isAgentStatePath?.(path) ?? false
    );
  }
  if (category !== ToolCategory.RunCommand) {
    return category;
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
  // Check git/PR lifecycle BEFORE test runners: a lifecycle command whose
  // message embeds a test-runner keyword (e.g. `git commit -m "fix jest flake"`)
  // is a lifecycle action, not a test run.
  if (GIT_LIFECYCLE_RE.test(spoken)) {
    return ToolCategory.GitLifecycle;
  }
  if (isTestInvocation(command)) {
    return ToolCategory.TestRun;
  }
  if (classifyCommandEffect(command) === CommandEffect.ReadOnly) {
    // AA-04: read-only shell work IS exploration. Before this, investigating
    // through the shell (`grep`, `sed -n`, `git log`, `cat`) produced no explore
    // signal at all, so `explore` was structurally near-unreachable and a
    // shell-only harness could never explore. Only a CONFIDENTLY read-only line
    // qualifies — `Mutating` and `Unknown` both stay `RunCommand`.
    return ToolCategory.ReadSearch;
  }
  return ToolCategory.RunCommand;
}

/** One thin adapter per known harness. The core imports all of them + fallback. */
const EVIDENCE_ADAPTERS: Record<Harness, HarnessAdapter> = {
  [Harness.Claude]: claudeAdapter,
  [Harness.Codex]: codexAdapter,
  [Harness.Cursor]: cursorAdapter,
  [Harness.Copilot]: copilotAdapter,
  [Harness.OpenCode]: opencodeAdapter,
};

/**
 * The declared layer (highest rank): session slash commands + per-tool declared
 * signals (skill / MCP). Neither source is required. Each signal's abstract
 * category is classified by name through {@link declaredCategoryFor}: a
 * plan-specific declaration (`/create-plan`, `ExitPlanMode`) becomes
 * `DeclaredPlan` — the ONLY declaration that gates `plan` (FEA-4184) — and
 * everything the core does not positively recognize as work intent falls to the
 * INERT `DeclaredUtility` (AA-03), so an auth/model/plugin command or a
 * work-tracking MCP call no longer fabricates `declared` provenance or a
 * confidence boost. Classification is centralized here (adapters emit the raw
 * kind+name) so the gate and the inert default each have exactly one owner.
 */
export function collectDeclared(
  session: NormalizedSession,
  adapter: HarnessAdapter
): DeclaredEvidence[] {
  const declaredSignals: DeclaredEvidence[] = [];
  for (const slashCommand of session.slashCommands) {
    declaredSignals.push({
      kind: DeclaredKind.SlashCommand,
      name: slashCommand.name,
      timestamp: slashCommand.timestamp,
      category: declaredCategoryFor(slashCommand.name),
    });
  }
  for (const tool of session.toolUses) {
    const toolDeclared = adapter.declaredFromTool(tool);
    if (toolDeclared) {
      declaredSignals.push({
        ...toolDeclared,
        category: declaredCategoryFor(toolDeclared.name),
      });
    }
  }
  return declaredSignals;
}

/** Select the per-harness adapter, falling back for an unknown harness. */
export function resolveAdapter(harness: Harness): HarnessAdapter {
  return EVIDENCE_ADAPTERS[harness] ?? fallbackAdapter;
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

/** A `null` timestamp (no source date) parses to NaN, same as an unparseable one. */
function parseTimestampMs(timestamp: string | null): number {
  return timestamp ? Date.parse(timestamp) : Number.NaN;
}

// Structural tool-use units: each recognized tool contributes its refined
// abstract category at its own timestamp. Unrecognized (null) tools and
// undateable tools contribute nothing — never an error.
function structuralToolUnits(
  session: NormalizedSession,
  adapter: HarnessAdapter
): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];
  for (const tool of session.toolUses) {
    const category = categorizeToolUse(adapter, tool);
    const ms = parseTimestampMs(tool.timestamp);
    if (category && Number.isFinite(ms)) {
      units.push({ ms, category, layer: EvidenceLayer.Structural });
    }
  }
  return units;
}

// Human-steering units from the ordered message list (`role === "human"`). The
// timeline needs the WHEN, so it dates each human turn from `messages` rather
// than a bare count. Sessions whose parser populates only the count (empty
// `messages`) simply contribute no human-turn units.
function humanTurnUnits(session: NormalizedSession): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];
  for (const message of session.messages) {
    if (message.role !== "human") {
      continue;
    }
    // ISS-8659: `session.userMessages` (the turn COUNT) already excludes a
    // fork's replayed turns. Walking `messages` unfiltered here would disagree
    // with that count — the count says the fork asked once, the timeline would
    // draw the parent's prompts beside it.
    if (message.isForkReplayed === true) {
      continue;
    }
    const ms = parseTimestampMs(message.timestamp);
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

// Declared units: the declaredSignals collectDeclared already produced,
// dropping any with no parseable timestamp (it can't be placed on the timeline).
// Emits each signal's OWN category (`DeclaredPlan` vs `DeclaredIntent`, FEA-4184)
// so the plan-specific signal reaches the per-window scorer's `plan` gate rather
// than being flattened into the generic declared bucket.
function declaredUnits(
  declaredSignals: readonly DeclaredEvidence[]
): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];
  for (const signal of declaredSignals) {
    const ms = parseTimestampMs(signal.timestamp);
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
