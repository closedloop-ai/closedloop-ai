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
  /** Edit/write/patch a SOURCE artifact — code, config, schema, CI. The implement
   * signal. Since AA-09 C1 this is the narrowed sense: a mutation whose target is
   * neither documentation nor agent bookkeeping (see the two below). It stays the
   * fail-safe DEFAULT, so a target the core cannot read still lands here. */
  MutateCode: "mutate_code",
  /** Edit/write a DOCUMENTATION artifact (`.md`, `.rst`, …). A real workspace
   * deliverable, so it corroborates and scores implement — but weakly, and unlike
   * `MutateCode` it does NOT veto `plan`: writing the plan document during a
   * declared planning window is planning, not implementation. */
  MutateDocument: "mutate_document",
  /** Edit/write a NON-workspace artifact: the harness's own bookkeeping (memory
   * files, session scratchpads, transcript state) or a bare transient dropped in
   * the system temp directory. Real observed activity, so it ANCHORS time on the
   * timeline exactly like `DeclaredUtility` — but it is not work ON the codebase,
   * so it scores no phase, corroborates nothing, and adds no evidence mass.
   *
   * Before AA-09 C1 these counted as `MutateCode`: a `/tmp/.commit-msg-…` write
   * anchored `implement` over 10.7 minutes of PR-admin and CI-triage, and one
   * corpus session's memory-file bookkeeping (19 writes under its `.claude`
   * per-project memory store) outnumbered its 17 real source edits — implement
   * claimed off files the project never contained. */
  MutateScratch: "mutate_scratch",
  /** Run an arbitrary shell command (non-test, non-git-lifecycle). */
  RunCommand: "run_command",
  /** Run a test suite / test command (a refinement of RunCommand). */
  TestRun: "test_run",
  /** Git/PR lifecycle action: commit, branch, push, PR create (a refinement of RunCommand). */
  GitLifecycle: "git_lifecycle",
  /** A human-authored turn (steering density); generalizes the legacy is_human rule. */
  HumanTurn: "human_turn",
  /** An explicit, declared signal of intent that is NOT plan-specific — e.g. a
   * trace phase labelled `implement`. The generic declared layer: it boosts
   * confidence but does NOT gate `plan` (FEA-4184). Since AA-03 this is reachable
   * ONLY from a trace phase ({@link declaredCategoryForTracePhase}), which declares
   * the work PHASE itself; a name-derived skill / MCP / slash-command signal the
   * core cannot positively recognize as work intent falls to the inert
   * `DeclaredUtility` instead. */
  DeclaredIntent: "declared_intent",
  /** A PLAN-SPECIFIC declared signal — a plan slash command/skill (`/create-plan`),
   * an `ExitPlanMode`-style MCP call, or a trace phase declaring `plan`. This is the
   * ONLY declared signal that gates the `plan` phase (FEA-4184): a generic
   * declaration (`DeclaredIntent`) must never fabricate `plan`. A refinement of
   * `DeclaredIntent` (every plan declaration is also a declaration for the boost). */
  DeclaredPlan: "declared_plan",
  /** An INERT declaration (FEA-4010 / AA-03): an invocation the core could not
   * positively recognize as declaring WORK intent — harness/workflow utilities
   * (auth, model or config switching, plugin management, billing/usage, session UX)
   * and, by the fail-safe default, every unrecognized command / skill / MCP call.
   *
   * It is still observed ACTIVITY, so it is emitted onto the evidence timeline and
   * ANCHORS time — idle detection depends on it (a session whose only records are
   * two failed `/plugin` installs must still resolve the dead gap between them, the
   * AA-01 contract). But it carries no work semantics, so it deliberately:
   *   - does NOT satisfy `hasDeclaredSignal` in `../parsing/activity-scoring.js`
   *     ⇒ no `declared` provenance layer and no declared confidence boost;
   *   - is scored by NO phase; and
   *   - is excluded from AA-11 evidence-mass tempering.
   * Before AA-03 these landed in `DeclaredIntent`, which stamped the FR-7
   * declared-provenance marker off an authentication or model-switch command —
   * "declared without a declaration" — and inflated `declaredDurationMs` in the
   * session rollups. */
  DeclaredUtility: "declared_utility",
} as const;
export type ToolCategory = (typeof ToolCategory)[keyof typeof ToolCategory];

/**
 * The structural subset of `ToolCategory` an adapter may assign to a tool by
 * name. `HumanTurn` and the declared categories are derived by the core (turn
 * counts / the declared layer), never returned by `categorize`, so excluding them
 * here makes that contract machine-checked rather than merely conventional.
 */
export type StructuralCategory = Exclude<
  ToolCategory,
  | typeof ToolCategory.HumanTurn
  | typeof ToolCategory.DeclaredIntent
  | typeof ToolCategory.DeclaredPlan
  | typeof ToolCategory.DeclaredUtility
>;

/** The canonical ordered member list — the SSOT for the enum-stability guard. */
export const TOOL_CATEGORY_VALUES = [
  ToolCategory.ReadSearch,
  ToolCategory.MutateCode,
  ToolCategory.MutateDocument,
  ToolCategory.MutateScratch,
  ToolCategory.RunCommand,
  ToolCategory.TestRun,
  ToolCategory.GitLifecycle,
  ToolCategory.HumanTurn,
  ToolCategory.DeclaredIntent,
  ToolCategory.DeclaredPlan,
  ToolCategory.DeclaredUtility,
] as const satisfies readonly ToolCategory[];

/**
 * Every MUTATION category — the three kinds a mutating tool use resolves to
 * (AA-09 C1). Membership, not the individual members, is what consumers that care
 * about "did this touch a file at all" should test, so a fourth kind cannot be
 * added without them seeing it.
 */
export const MUTATION_CATEGORIES: ReadonlySet<ToolCategory> = new Set([
  ToolCategory.MutateCode,
  ToolCategory.MutateDocument,
  ToolCategory.MutateScratch,
]);

/**
 * The mutation categories that touched a WORKSPACE artifact — everything except
 * the harness's own bookkeeping. This is the set that answers "was a real edit
 * made here": it gates rework confirmation (a review→fix span is only rework if
 * something in the project actually changed) and marks corroborating structural
 * signal. `MutateScratch` is excluded for the same reason it scores no phase.
 */
export const WORKSPACE_MUTATION_CATEGORIES: ReadonlySet<ToolCategory> = new Set(
  [ToolCategory.MutateCode, ToolCategory.MutateDocument]
);

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
 * A single declared signal. The highest-rank evidence layer. `category` is the
 * abstract category this declaration maps to:
 *   - `DeclaredPlan` for a plan-specific declaration (a `/create-plan`-style
 *     command/skill, an `ExitPlanMode`-style MCP call, or a trace phase declaring
 *     `plan`) — the only one that gates the `plan` phase (FEA-4184);
 *   - `DeclaredIntent` for a trace phase that declares some OTHER work phase —
 *     a first-class declaration, so it keeps genuine declared provenance;
 *   - `DeclaredUtility` (AA-03) for everything else, including every unrecognized
 *     name-derived signal — inert: no provenance, no boost, no phase, no mass.
 * The core (`collectDeclared`) is the ONE owner of that mapping
 * ({@link declaredCategoryFor} for name-derived signals,
 * {@link declaredCategoryForTracePhase} for trace phases); adapters emit only the
 * raw kind+name with the inert `DeclaredUtility` placeholder, so no adapter can
 * inject a category and the gate cannot drift.
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
      // Inert placeholder: `collectDeclared` is the single owner that classifies
      // from the name (see {@link DeclaredEvidence}). Defaulting to the inert
      // category keeps an un-normalized direct read fail-safe rather than a
      // fabricated declaration.
      category: ToolCategory.DeclaredUtility,
    };
  }
  return null;
}

/**
 * A declared signal's NAME denotes a PLAN declaration (FEA-4184). High-precision
 * and harness-blind — it matches the plan vocabulary that surfaces identically
 * across harnesses, at word boundaries so unrelated names never leak in:
 *   - `create-plan`, `/plan`, `plan-with-codex`, `create_plan` (plan slash
 *     command / skill names)
 *   - `ExitPlanMode`, `exit_plan_mode`, `update_plan` (Claude's plan-mode exit +
 *     Codex's `update_plan` MCP/tool call)
 *   - a trace phase whose key/label is `plan`/`planning`
 * The leading `\b` keeps `deploy`/`explain`/`replan` from matching `plan` mid-word
 * only when they lack a boundary; `replan`/`re-plan` DO carry a boundary and are
 * intentionally treated as planning. Deliberately narrow (grows with corpus
 * evidence), mirroring `isReviewRequestCommandName`.
 */
export const PLAN_DECLARATION_NAME_CUE =
  /\b(?:create[-_\s]?plan|exit[-_\s]?plan(?:[-_\s]?mode)?|update[-_\s]?plan|plan(?:ning|[-_\s]?mode|[-_\s]?with[-_\s]?\w+)?)\b/i;

/**
 * The abstract category a NAME-DERIVED declared signal maps to — a slash command,
 * a skill, or an MCP call. The SINGLE owner of that decision (FEA-4184), so every
 * declared producer classifies identically and the `plan` gate cannot drift. Pure:
 * a name test, no session/DB access.
 *
 * AA-03 inverted the DEFAULT: a name-derived declaration claims the `declared`
 * layer only when the core positively RECOGNIZES it as declaring work intent;
 * anything unrecognized is inert {@link ToolCategory.DeclaredUtility}. Previously
 * the default was `DeclaredIntent`, so every `/login`, `/model`, `/plugin`,
 * `/clear` and every work-tracking MCP call minted a declaration — stamping FR-7
 * `declared` provenance (and a confidence boost) off commands that declare nothing
 * about the work. Fail-safe direction: an unrecognized *genuine* work declaration
 * merely under-claims provenance, whereas the old default FABRICATED it. This is a
 * recognition rule, never a denylist of any one organization's command names.
 */
export function declaredCategoryFor(name: string): ToolCategory {
  return PLAN_DECLARATION_NAME_CUE.test(name)
    ? ToolCategory.DeclaredPlan
    : ToolCategory.DeclaredUtility;
}

/**
 * The category a TRACE-PHASE declaration maps to. Unlike a command/skill/MCP name,
 * a trace phase is a first-class declaration of the work phase itself (supplied by
 * the caller from DB-derived `tracePhaseSources`, not guessed from a vendor
 * string), so a non-plan trace phase keeps genuine `DeclaredIntent` provenance
 * rather than falling to the inert default that {@link declaredCategoryFor}
 * applies to name-derived signals. The plan cue is shared, so a trace phase
 * declaring `plan` still gates `plan` exactly as before.
 */
export function declaredCategoryForTracePhase(
  phaseKey: string,
  label: string
): ToolCategory {
  return PLAN_DECLARATION_NAME_CUE.test(`${phaseKey} ${label}`)
    ? ToolCategory.DeclaredPlan
    : ToolCategory.DeclaredIntent;
}

/**
 * The harness-blind structural aggregate over abstract categories. `categoryMix`
 * is a complete count keyed by EVERY `ToolCategory` (zero-filled), so the
 * classifier can read any category without a presence check.
 */
export type StructuralEvidence = {
  categoryMix: Record<ToolCategory, number>;
  /** File paths touched by mutating tool uses of EVERY kind — code, documentation
   * and scratch alike (deduped, capped). Scoped to the code kind this would stop
   * reporting the paths that motivated the split. */
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
  /**
   * FEA-4010 (AA-09 C1): the workspace paths a mutating tool use actually
   * touched, for a harness that encodes them in a shape the generic
   * field-name extraction cannot read — Codex's `apply_patch`, whose entire
   * multi-file patch arrives as one opaque string. OPTIONAL: a harness that
   * puts its path in a plain `file_path`/`path` field needs no override and
   * should not define this.
   *
   * `null` means "no opinion — use the generic extraction". `[]` means "this
   * tool named nothing", which is a real answer and suppresses the fallback.
   * Paths are returned verbatim; de-duplication and the collection bound belong
   * to the caller.
   */
  mutationTargets?(tool: NormalizedToolUse): string[] | null;
  /**
   * FEA-4010 (AA-09 C1): true when `path` lives under a root THIS HARNESS owns
   * for its own bookkeeping — a memory store, a session scratchpad, a transcript
   * or todo directory — rather than in the user's project.
   *
   * This is level-3 (adapter-declared) knowledge by necessity, and the corpus is
   * why: the two obvious harness-blind rules both fail. A `/tmp`-prefix rule
   * mislabels a real source edit in a worktree that happens to live under `/tmp`
   * (`/tmp/nrev/…/cursor-parser.ts`), and an out-of-workspace rule is worse still
   * — it mislabels genuine infrastructure work in a sibling repo, and one corpus
   * session's own `cwd` IS `/private/tmp`. What actually separates agent
   * bookkeeping from project work is knowing which roots the harness created,
   * which only the harness's own adapter can say.
   *
   * OPTIONAL, and fail-safe by omission: an adapter that declares nothing leaves
   * its mutations on the `MutateCode` default — the pre-C1 behaviour — so a
   * harness is never mislabelled for want of an entry here.
   */
  isAgentStatePath?(path: string): boolean;
};

/**
 * Bumped when the evidence model's deterministic output semantics change, so
 * FEA-2269 can version-gate re-derivation. Mirrors `EXTRACTOR_VERSION`.
 *
 * 2 — FEA-4010 / AA-03: added the inert `DeclaredUtility` category and inverted
 *     the name-derived declaration default into it, so the emitted `categoryMix`
 *     and per-unit categories differ from v1 for the same input. A distillation
 *     report can now tell this model apart from the v1 catch-all.
 * 3 — FEA-4010 / AA-04: a confidently read-only shell command now refines to
 *     `ReadSearch` instead of staying `RunCommand` (see `command-semantics.ts`),
 *     so the emitted `categoryMix` shifts for the same input on every session that
 *     investigates through the shell.
 * 4 — FEA-4010 / AA-09 C1: `MutateCode` splits by TARGET into `MutateCode` /
 *     `MutateDocument` / `MutateScratch`, so the emitted `categoryMix` now
 *     distinguishes source edits from documentation and from the harness's own
 *     bookkeeping for the same input.
 * 5 — FEA-4010 / AA-09 test detection: `TestRun` is resolved by parsing the
 *     command head (`test-invocation.ts`) instead of scanning the line for runner
 *     names, so the emitted `categoryMix` both gains real test runs spelled as a
 *     task name or a `--test` flag and loses the reads/lints that merely mentioned
 *     a runner.
 * 6 — FEA-4010 / AA-09 test detection, review follow-ups: three lexing defects
 *     that each SUPPRESSED real `TestRun` evidence. The reader was handed
 *     quote-blanked text, so a quoted heredoc opener never closed and swallowed
 *     the commands after it; a here-string (`<<<`) was read as a heredoc opener
 *     for the same reason; and a namespaced task name (`pnpm test:node`) was
 *     discarded as a flag's value, making every `test:*` script invisible.
 * 7 — FEA-4010 / AA-09 review round 2: heredoc bodies are stripped ONCE before
 *     any reader sees the line (a document body mentioning `git commit` was
 *     landing on `GitLifecycle`), package-installed executables resolve through
 *     the full head decision rather than the runner set alone
 *     (`.venv/bin/python -m pytest`), and a task runner's declared option arity
 *     is honoured so a plain-word flag value is not read as the operation
 *     (`pnpm --filter desktop run test`).
 * 8 — FEA-4010 / AA-09 review round 3: the segment splitter honours shell escape
 *     and comment state (`find … -exec rm {} \;`, `echo ok # && pnpm test` no
 *     longer fabricate a second command); runtime options stop at the entry
 *     point, so a script's own `--test` is not Node's — including the two entry
 *     spellings that themselves begin with a dash: stdin (`node - --test`) and
 *     `-e`/`-p`, whose value IS the program; a delegated operand
 *     resolves as a PROGRAM rather than a task name (`pnpm exec test`,
 *     `python test`); a project-qualified task resolves to its terminal name
 *     (`gradle :app:test`); and a runner asked to ENUMERATE its tests
 *     (`vitest list`, `pytest --collect-only`) is no longer a test run.
 */
export const EVIDENCE_MODEL_VERSION = 8;

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
