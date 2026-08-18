/**
 * On-demand audit pass (PRD-556 M1). The interactive front door to the same
 * engine the nightly {@link runReviewPass} drives: assemble the character's
 * prompt bundle → run the harness cascade against the open repo → parse
 * `findings.jsonl` — but RETURN the parsed findings to the caller instead of
 * filing them to ClosedLoop. Filing stays the review pass's concern (and the
 * PRD's M3); M1 keeps everything local until the user explicitly captures.
 *
 * This is deliberately a thin composition over the review pass's pure parts
 * (`assemblePromptBundle` / `buildRuntimeContext` / `parseFindingsJsonl`) plus
 * `runCascade`, so there is zero engine duplication — the audit run IS a crewd
 * review pass, minus the file step. It reaches `node:fs`/`node:child_process`
 * (via the cascade), so it is a Node-only subpath (`@repo/crewd/passes/audit`)
 * and must never be pulled into a renderer graph.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CascadeEntry, runCascade } from "../harness/cascade.js";
import type { HarnessRegistry } from "../harness/index.js";
import {
  AuditScope,
  type CascadeAttempt,
  cascadeStepSchema,
  type HarnessName,
} from "../model.js";
import { type Finding, parseFindingsJsonl } from "./findings.js";
import { assemblePromptBundle, buildRuntimeContext } from "./prompt-bundle.js";
import { changedSinceMain, recentlyChangedFiles } from "./repo.js";

/** A streamed audit-progress event — the live cascade trail for the renderer. */
export type AuditProgressEvent =
  /** The run started against `repoDir` with this cascade order. */
  | {
      phase: "start";
      character: string;
      repoDir: string;
      cascade: HarnessName[];
    }
  /** A raw stdout/stderr chunk from the running harness. */
  | { phase: "output"; chunk: string }
  /** One cascade attempt (a harness) finished — success/timeout/failed/skipped. */
  | { phase: "attempt"; attempt: CascadeAttempt }
  /** The run finished; `findingsCount` is the parsed-finding total. */
  | {
      phase: "done";
      ok: boolean;
      harnessUsed: HarnessName | null;
      findingsCount: number;
    };

export type AuditRunInput = {
  /** Review character id, e.g. `"docs-darwin"`. Selects `<character>.md`. */
  character: string;
  /** Absolute path to the repo the audit reviews (the currently-open repo). */
  repoDir: string;
  /** Directory holding `<character>.md` character prompts. */
  promptsDir: string;
  /**
   * Ordered cascade to try (the "Switzerland" cascade — order is data). Each
   * entry is a full `(harness, model?)` {@link CascadeStep}, a bare harness-name
   * string, or the `"harness:model"` shorthand — all normalized by `runCascade`,
   * so a caller-selected model (e.g. `claude:opus`) is honored, not dropped.
   */
  cascade: readonly CascadeEntry[];
  /** Shared infra prompt file paths, prepended in order (optional). */
  sharedPromptPaths?: string[];
  /**
   * The scope preset the run reviews (FEA-3850 M4). Absent ⇒ `whole-repo`. The
   * preset shapes the runtime context: `docs` narrows the reviewer to
   * documentation surfaces, `changed-since-main` seeds the hot-spot file list
   * from the git diff vs. the repo's main branch, and `whole-repo` uses the
   * recent-commit hot spots (the M1 behavior).
   */
  scopePreset?: AuditScope;
  /** Optional operator focus / scope hint injected into the runtime context. */
  scope?: string | null;
  /** Per-attempt harness timeout (ms); 0/undefined = unbounded. */
  perAttemptTimeoutMs?: number;
  /** Registry override (tests inject mock harnesses). */
  registry?: HarnessRegistry;
  /** Extra env for each harness child (e.g. the resolved login-shell PATH). */
  env?: Record<string, string>;
  /** Substitutions applied across the prompt bundle. */
  substitutions?: Record<string, string>;
  /** Progress sink; every phase event is delivered here as it happens. */
  onProgress?: (event: AuditProgressEvent) => void;
  /** Cooperative cancel forwarded to the cascade. */
  signal?: AbortSignal;
};

export type AuditRunResult = {
  ok: boolean;
  character: string;
  harnessUsed: HarnessName | null;
  attempts: CascadeAttempt[];
  findings: Finding[];
  /** Non-null on a setup failure (e.g. missing character prompt). */
  error: string | null;
};

/**
 * Run one review character against a repo on demand and return its findings.
 * Never throws for an operational failure (missing prompt, cascade exhausted) —
 * the outcome is reported in the result so an IPC caller surfaces a clean state.
 */
export async function runAuditPass(
  input: AuditRunInput
): Promise<AuditRunResult> {
  const promptFile = join(input.promptsDir, `${input.character}.md`);
  if (!existsSync(promptFile)) {
    return failed(input.character, `character prompt not found: ${promptFile}`);
  }

  // Resolve the scope BEFORE spawning anything: a clean changed-since-main tree
  // selected no files, so review nothing and return an empty result rather than
  // widening to a whole-repo audit.
  const scope = await resolveScope(input);
  if (scope.empty) {
    input.onProgress?.({
      phase: "done",
      ok: true,
      harnessUsed: null,
      findingsCount: 0,
    });
    return emptyScopeResult(input.character);
  }

  const cascade = [...input.cascade];
  input.onProgress?.({
    phase: "start",
    character: input.character,
    repoDir: input.repoDir,
    // The `start` event surfaces the harness order for the live trail; normalize
    // each entry (bare name / `harness:model` / step) to its harness name.
    cascade: cascade.map((entry) => cascadeStepSchema.parse(entry).harness),
  });

  // Work dir for the findings output the harness writes. `fsSlug` flattens a
  // nested character id (e.g. `kaitic/desktop-denny`) to a single path segment:
  // the raw id is a `promptsDir`-relative PATH for prompt resolution, but a `/`
  // in a `mkdtemp` prefix or a findings filename would demand a non-existent
  // parent dir and throw. Keep the raw id for prompt/progress; slug only fs names.
  const characterSlug = fsSlug(input.character);
  const workDir = mkdtempSync(join(tmpdir(), `crewd-audit-${characterSlug}-`));
  const nrDir = join(workDir, ".nightly-review");
  mkdirSync(nrDir, { recursive: true });
  const findingsJsonl = join(nrDir, "findings.jsonl");
  const findingsTxt = join(nrDir, `${characterSlug}-findings.txt`);

  const prompt = assembleAuditPrompt(input, scope, {
    promptFile,
    findingsJsonl,
    findingsTxt,
  });

  // Stream every attempt as it lands rather than only at the end.
  const attempts: CascadeAttempt[] = [];
  const result = await runCascade({
    prompt,
    cwd: input.repoDir,
    addDirs: [input.repoDir, workDir],
    cascade,
    registry: input.registry,
    env: input.env,
    perAttemptTimeoutMs: input.perAttemptTimeoutMs,
    // FEA-4012: the audit runs non-interactively, so a harness that ends by
    // asking a question can never be answered — reclassify it as failed and
    // cascade rather than reporting a false success and hanging the session.
    rejectElicitation: true,
    signal: input.signal,
    onOutput: (chunk) => input.onProgress?.({ phase: "output", chunk }),
  });
  for (const attempt of result.attempts) {
    attempts.push(attempt);
    input.onProgress?.({ phase: "attempt", attempt });
  }

  // Findings are present even if the run timed out mid-write.
  const findings = existsSync(findingsJsonl)
    ? parseFindingsJsonl(readFileSync(findingsJsonl, "utf8"))
    : [];

  input.onProgress?.({
    phase: "done",
    ok: result.ok,
    harnessUsed: result.harnessUsed,
    findingsCount: findings.length,
  });

  return {
    ok: result.ok,
    character: input.character,
    harnessUsed: result.harnessUsed,
    attempts,
    findings,
    error: result.ok || findings.length > 0 ? null : "cascade exhausted",
  };
}

/**
 * Non-interactive directive prepended to every audit prompt (FEA-4012). The
 * audit runs each harness with stdin closed after the prompt — there is no
 * channel to answer a follow-up question — so a harness that stops to interview
 * the operator or ask a clarifying question makes NO audit progress and, left to
 * the runner's elicitation guard, fails and cascades. This directive reduces
 * that elicitation at the source: it tells the harness to run the audit
 * directly against the repo/scope in context and never to interview or ask.
 */
const NON_INTERACTIVE_DIRECTIVE = [
  "## Non-interactive audit (IMPORTANT)",
  "",
  "You are running NON-INTERACTIVELY: there is no operator to answer questions,",
  "and stdin is closed after this prompt. Run the audit DIRECTLY against the",
  "repository and scope described in the runtime context below. Do NOT interview",
  "the operator, do NOT ask clarifying questions, and do NOT wait for input or",
  "confirmation before proceeding. If something is ambiguous, make the most",
  "reasonable assumption, state it briefly in your findings, and continue. Your",
  "only output is the findings file described below — produce it (or, if you",
  "genuinely find nothing, write nothing and finish). Never end by asking a",
  "question.",
].join("\n");

function assembleAuditPrompt(
  input: AuditRunInput,
  scope: ResolvedScope,
  paths: { promptFile: string; findingsJsonl: string; findingsTxt: string }
): string {
  const characterPrompt = readFileSync(paths.promptFile, "utf8");
  const sharedPrompts = [
    // FEA-4012: prepend the non-interactive directive ahead of any caller-
    // supplied shared prompts so every audit character inherits it.
    NON_INTERACTIVE_DIRECTIVE,
    ...(input.sharedPromptPaths ?? [])
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, "utf8")),
  ];
  const runtimeContext = buildRuntimeContext({
    repoDir: input.repoDir,
    findingsJsonlPath: paths.findingsJsonl,
    findingsTxtPath: paths.findingsTxt,
    recentlyChangedFiles: scope.hotSpots,
    scopedFiles: scope.scopedFiles ?? undefined,
    priorCovered: null,
    focus: composeFocus(scope.focus, input.scope),
  });
  return assemblePromptBundle({
    characterPrompt,
    sharedPrompts,
    runtimeContext,
    substitutions: input.substitutions,
  });
}

/** An empty-but-successful audit result (a clean scope selected no files). */
function emptyScopeResult(character: string): AuditRunResult {
  return {
    ok: true,
    character,
    harnessUsed: null,
    attempts: [],
    findings: [],
    error: null,
  };
}

/** The runtime-context inputs a scope preset resolves to. */
type ResolvedScope = {
  /** Files to seed the reviewer's hot-spot list with (may be empty). */
  hotSpots: string[];
  /**
   * The exhaustive, uncapped file set the reviewer must cover (e.g. every file
   * changed vs. main). Null for scopes that do not pin an exact file set
   * (whole-repo, docs). Not merged into {@link hotSpots} so it is never capped.
   */
  scopedFiles: string[] | null;
  /** A preset-specific focus directive prepended to the operator's own focus. */
  focus: string | null;
  /**
   * True when the scope resolved but selected NO files (a clean
   * changed-since-main tree). The pass then reviews nothing and returns an empty
   * result rather than silently widening to a whole-repo audit.
   */
  empty: boolean;
};

/**
 * Map a scope preset to its runtime-context inputs (FEA-3850 M4). `whole-repo`
 * (the default) keeps the M1 behavior — recent-commit hot spots, no directive.
 * `changed-since-main` lists the git diff vs. main as the exhaustive scoped file
 * set (uncapped) and tells the reviewer to review only those; it degrades to a
 * whole-repo review ONLY when main is unresolvable, and returns an empty scope
 * (review nothing) when main resolves but the branch is clean. `docs` steers the
 * reviewer to documentation surfaces while keeping the recent-commit hot spots.
 * Never throws — the git helpers already degrade.
 */
async function resolveScope(input: AuditRunInput): Promise<ResolvedScope> {
  const preset = input.scopePreset ?? AuditScope.WholeRepo;
  if (preset === AuditScope.ChangedSinceMain) {
    const changed = await changedSinceMain(input.repoDir).catch(() => null);
    if (changed === null) {
      // Main is unresolvable (no main branch, non-git dir): degrade to the
      // whole-repo hot spots rather than review nothing.
      return {
        hotSpots: await recentlyChangedFiles(input.repoDir).catch(() => []),
        scopedFiles: null,
        focus:
          "SCOPE: changed-since-main was requested but no diff vs. main could be resolved — review the whole repository.",
        empty: false,
      };
    }
    if (changed.length === 0) {
      // Main resolved, but the branch is clean: the picker promised only changed
      // files, so review nothing instead of silently widening to whole-repo.
      return { hotSpots: [], scopedFiles: [], focus: null, empty: true };
    }
    return {
      hotSpots: [],
      scopedFiles: changed,
      focus:
        "SCOPE: review ONLY the files changed vs. the merge-base with the repo's main branch (listed above under 'Files in scope'). Do not report issues in unchanged files.",
      empty: false,
    };
  }
  const hotSpots = await recentlyChangedFiles(input.repoDir).catch(() => []);
  if (preset === AuditScope.Docs) {
    return {
      hotSpots,
      scopedFiles: null,
      focus:
        "SCOPE: focus on documentation surfaces — README*, AGENTS.md, CLAUDE.md, docs/**, and other **/*.md — and the code they describe.",
      empty: false,
    };
  }
  return { hotSpots, scopedFiles: null, focus: null, empty: false };
}

/** Combine the preset scope directive with the operator's free-text focus. */
function composeFocus(
  scopeFocus: string | null,
  operatorFocus?: string | null
): string | null {
  const parts = [scopeFocus, operatorFocus?.trim() || null].filter(
    (p): p is string => Boolean(p)
  );
  return parts.length > 0 ? parts.join("\n") : null;
}

function failed(character: string, error: string): AuditRunResult {
  return {
    ok: false,
    character,
    harnessUsed: null,
    attempts: [],
    findings: [],
    error,
  };
}

/** Path-separator + other unsafe chars, collapsed to `-` for a single fs segment. */
const FS_UNSAFE_RE = /[^a-zA-Z0-9._-]+/g;

/**
 * Flatten a character id to a single filesystem-safe segment (e.g.
 * `kaitic/desktop-denny` → `kaitic-desktop-denny`). Used only for temp-dir
 * prefixes and findings filenames, never for prompt resolution — the raw id is
 * a `promptsDir`-relative path there. A `/` in a `mkdtemp` prefix or a filename
 * would require a non-existent parent dir and throw.
 */
function fsSlug(character: string): string {
  return character.replace(FS_UNSAFE_RE, "-");
}
