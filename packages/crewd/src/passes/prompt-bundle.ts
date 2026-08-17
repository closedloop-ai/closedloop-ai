/**
 * Assemble the harness-neutral prompt bundle a review pass feeds to the cascade:
 * shared infra prompts (cross-reference, etc.) + the character prompt + runtime
 * context, with `SCRATCH_PROMPT_PATH` / `SCRATCH_REPO_DIR`-style placeholders
 * substituted. Pure string work so it is fully testable; ANY harness can run the
 * result (this is why work bodies are prompts, not Claude-only skills).
 */

export type PromptBundleInput = {
  /** The per-character analysis prompt. */
  characterPrompt: string;
  /** Shared infra prompts prepended as the common framework (order preserved). */
  sharedPrompts?: string[];
  /** Placeholder → replacement (e.g. SCRATCH_PROMPT_PATH, SCRATCH_REPO_DIR). */
  substitutions?: Record<string, string>;
  /** Runtime context appended last (recent files, findings paths, clock). */
  runtimeContext?: string;
};

function applySubstitutions(
  text: string,
  subs: Record<string, string>
): string {
  let out = text;
  for (const [key, value] of Object.entries(subs)) {
    out = out.split(key).join(value);
  }
  return out;
}

export function assemblePromptBundle(input: PromptBundleInput): string {
  const parts: string[] = [];
  for (const shared of input.sharedPrompts ?? []) {
    parts.push(shared);
  }
  parts.push(input.characterPrompt);
  if (input.runtimeContext) {
    parts.push(input.runtimeContext);
  }
  const joined = parts.join("\n\n---\n\n");
  return input.substitutions
    ? applySubstitutions(joined, input.substitutions)
    : joined;
}

export type RuntimeContextInput = {
  repoDir: string;
  findingsJsonlPath: string;
  findingsTxtPath: string;
  /**
   * Hot-spot HINT: recently-changed files the reviewer should pay attention to.
   * Advisory only, so it is capped at 40 to bound prompt size — dropping the
   * tail loses nothing but a hint. Do NOT use this for a scope that PROMISES to
   * review a specific file set (e.g. changed-since-main); use {@link scopedFiles}
   * for that, which is uncapped.
   */
  recentlyChangedFiles?: string[];
  /**
   * Scoped file list the reviewer is told to review EXHAUSTIVELY (e.g. every
   * file changed vs. main). Unlike {@link recentlyChangedFiles} this is NOT
   * capped — silently dropping the tail would leave promised files unreviewed.
   */
  scopedFiles?: string[];
  priorCovered?: string | null;
  focus?: string | null;
  /** Epoch deadlines for the "land the plane" clock, if bounded. */
  clock?: { nowSec: number; softSec: number; hardSec: number };
};

/** Hot-spot HINT cap — advisory, so bounded to keep the prompt small. */
const HOT_SPOT_HINT_CAP = 40;

/** Build the runtime-context block injected after the character prompt. */
export function buildRuntimeContext(input: RuntimeContextInput): string {
  const lines: string[] = ["## Runtime context", `REPO_DIR: ${input.repoDir}`];
  lines.push(
    `FINDINGS OUTPUT: write one JSON finding per line to ${input.findingsJsonlPath}`,
    `(and a human-readable copy to ${input.findingsTxtPath}).`
  );
  if (input.recentlyChangedFiles?.length) {
    lines.push(
      "",
      "Recently changed files (hot spots):",
      ...input.recentlyChangedFiles
        .slice(0, HOT_SPOT_HINT_CAP)
        .map((f) => `- ${f}`)
    );
  }
  if (input.scopedFiles?.length) {
    // Uncapped on purpose: the reviewer is told to review exactly these files,
    // so dropping any would leave a promised file unreviewed.
    lines.push(
      "",
      "Files in scope (review ALL of these):",
      ...input.scopedFiles.map((f) => `- ${f}`)
    );
  }
  if (input.priorCovered) {
    lines.push(
      "",
      `Prior run covered: ${input.priorCovered} — resume beyond it.`
    );
  }
  if (input.focus) {
    lines.push("", `OPERATOR FOCUS: ${input.focus}`);
  }
  if (input.clock) {
    lines.push(
      "",
      `RUNTIME CLOCK: now=${input.clock.nowSec}, SOFT deadline=${input.clock.softSec}, HARD kill=${input.clock.hardSec}.`,
      "LAND THE PLANE — write findings incrementally; wrap at SOFT, extend only toward a verifiable result."
    );
  }
  return lines.join("\n");
}
