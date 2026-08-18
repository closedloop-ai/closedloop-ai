/**
 * @file mutation-kind.ts
 * @description FEA-4010 (AA-09 C1): WHAT a mutating tool use actually changed —
 * source, documentation, or something that is not a workspace artifact at all.
 * Before this, every edit was `MutateCode`, so `implement` was claimed off
 * `/tmp/.commit-msg-*` writes and off a session's own memory-file bookkeeping;
 * on one corpus session the bookkeeping writes (19) outnumbered the real source
 * edits (17).
 *
 * THREE RULES, and the corpus rejected every simpler single one:
 *   1. Harness-owned state (adapter-declared, level 3). Only the harness knows
 *      which roots IT created; see `HarnessAdapter.isAgentStatePath`.
 *   2. Agent TOOLING state — a published plugin's per-run bookkeeping, which is
 *      harness-independent because the same plugin runs inside several harnesses
 *      (`./agent-tooling-state.js`). Applied here rather than passed in
 *      by the caller precisely because it does NOT vary by caller: making it a
 *      parameter invites exactly one call site to forget it.
 *   3. A BARE file in the system temp directory (structural, level 1, here).
 * A `/tmp`-prefix rule alone mislabels a real source edit in a worktree that
 * lives under `/tmp`, and an out-of-workspace rule mislabels genuine work in a
 * sibling repo — measured, not assumed (see the module docs on each rule).
 *
 * Every rule fails SAFE toward `MutateCode`: an unreadable path, an unknown
 * extension, and an adapter with no opinion all keep the pre-C1 classification,
 * so this can only ever remove an over-claim, never invent one.
 *
 * Pure: string inspection only — no filesystem access, no `os.tmpdir()`. The
 * session was very often produced on a DIFFERENT machine than the one importing
 * it, so the ingesting host's real temp directory says nothing about the paths in
 * the transcript; the roots below are matched as PATTERNS for that reason.
 */
import { isAgentToolingStatePath } from "./agent-tooling-state.js";
import { ToolCategory } from "./evidence-model.js";

/** The three categories a mutating tool use resolves to. */
export type MutationCategory =
  | typeof ToolCategory.MutateCode
  | typeof ToolCategory.MutateDocument
  | typeof ToolCategory.MutateScratch;

/**
 * Documentation file extensions. Deliberately prose-only: `.json`/`.yml`/`.toml`
 * are CONFIG (source, and often the substance of a change — one corpus session's
 * heaviest edit target is a `.github/workflows/*.yml`), so they stay `MutateCode`.
 *
 * `.txt` is EXCLUDED, and the reason is generality: the extension is genuinely
 * ambiguous, and its source-like uses belong to ecosystems this repo is not
 * written in — `requirements.txt` and `constraints.txt` (Python dependency
 * manifests), `CMakeLists.txt` (a build system). Demoting those to a third of
 * implement weight, and stripping their `plan` veto, would misread real work on
 * exactly the stacks the classifier has to generalize to. Prose `.txt` loses its
 * document label as a result, which is the safe direction: it falls back to
 * `MutateCode`, the pre-C1 answer, rather than to a wrong new one.
 */
const DOCUMENT_EXTENSION_RE = /\.(?:md|mdx|markdown|rst|adoc|asciidoc|org)$/i;

/**
 * The system temp roots, as PATTERNS (see the file header on why not
 * `os.tmpdir()`): POSIX `/tmp` and `/var/tmp`, macOS's per-user
 * `/var/folders/<xx>/<yyy>/T`, and the Windows user temp. Matched to the trailing
 * separator so the remainder is the path INSIDE the root.
 *
 * The optional `/private` prefix spans BOTH POSIX forms, because on macOS `/var`
 * and `/tmp` are symlinks into `/private` and a resolved path is just as common as
 * an unresolved one — a tool that calls `realpath` reports
 * `/private/var/folders/…/T`. Scoping the prefix to the `/tmp` alternative alone
 * left every resolved `/var/folders` path unrecognized.
 */
const TEMP_ROOT_RE =
  /^(?:(?:\/private)?(?:\/(?:tmp|var\/tmp)|\/var\/folders\/[^/]+\/[^/]+\/T)|[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/]AppData[\\/]Local[\\/]Temp|[A-Za-z]:[\\/]Windows[\\/]Temp)[\\/]/i;

/** True when `path` sits anywhere beneath a system temp root. */
export function isUnderTempRoot(path: string): boolean {
  return TEMP_ROOT_RE.test(path);
}

/**
 * True for a file dropped DIRECTLY in a temp root — no intervening directory.
 *
 * The depth bound is the whole rule, and the corpus is what fixes it there. A
 * bare `/tmp/.commit-msg-fea1459` is a transient the tool will delete; a
 * DIRECTORY under temp is a workspace, and the corpus holds three of them doing
 * real work — `/tmp/nrev/…/cursor-parser.ts` (a checked-out worktree),
 * `/tmp/cc-expert-training/docs/…` (a training repo), and one session whose own
 * `cwd` is `/private/tmp`. Treating all of `/tmp` as scratch would have
 * mislabelled every one of them, which is why the naive prefix rule was dropped.
 */
function isBareTempFile(path: string): boolean {
  const match = TEMP_ROOT_RE.exec(path);
  if (!match) {
    return false;
  }
  const inside = path.slice(match[0].length);
  return inside.length > 0 && !(inside.includes("/") || inside.includes("\\"));
}

/**
 * The category ONE mutated path resolves to. Order is precedence: agent
 * bookkeeping of either kind outranks the extension test, so a `MEMORY.md` in
 * the agent's own memory store — or a plugin's generated `code-review-summary.md`
 * — is bookkeeping rather than documentation. That matters, because
 * documentation counts toward a phase and bookkeeping deliberately does not.
 *
 * `isAgentStatePath` carries only the HARNESS's opinion; tooling state is
 * consulted unconditionally (see the file header on why it is not a parameter).
 */
export function mutationCategoryForPath(
  path: string,
  isAgentStatePath: (candidate: string) => boolean
): MutationCategory {
  if (
    isAgentStatePath(path) ||
    isAgentToolingStatePath(path) ||
    isBareTempFile(path)
  ) {
    return ToolCategory.MutateScratch;
  }
  if (DOCUMENT_EXTENSION_RE.test(path)) {
    return ToolCategory.MutateDocument;
  }
  return ToolCategory.MutateCode;
}

/**
 * The category ONE TOOL USE resolves to, given every path it touched. A single
 * Codex `apply_patch` commonly names several files (one corpus patch names 14),
 * so the kinds must be reconciled rather than read off the first path.
 *
 * Precedence is `MutateCode` > `MutateDocument` > `MutateScratch`: a patch that
 * touches even one source file IS a source edit, whatever else it carried along.
 * That direction is deliberate — it can only ever refuse to demote, so a
 * mixed patch is never quietly stripped of its implement signal.
 *
 * NO paths (an unreadable input shape) yields `MutateCode`, the pre-C1 default:
 * "we could not tell" must not read as "not real work".
 */
export function mutationCategoryForTargets(
  paths: readonly string[],
  isAgentStatePath: (candidate: string) => boolean
): MutationCategory {
  if (paths.length === 0) {
    return ToolCategory.MutateCode;
  }
  let sawDocument = false;
  for (const path of paths) {
    const category = mutationCategoryForPath(path, isAgentStatePath);
    if (category === ToolCategory.MutateCode) {
      return ToolCategory.MutateCode;
    }
    sawDocument ||= category === ToolCategory.MutateDocument;
  }
  return sawDocument ? ToolCategory.MutateDocument : ToolCategory.MutateScratch;
}
