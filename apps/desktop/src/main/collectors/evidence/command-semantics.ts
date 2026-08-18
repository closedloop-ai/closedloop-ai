/**
 * @file command-semantics.ts
 * @description FEA-4010 (AA-04): the PURE, harness-blind reading of a shell
 * command line's *effect* — read-only vs mutating vs unknowable — so the evidence
 * core can refine an un-refined `RunCommand` into `ReadSearch` instead of leaving
 * every shell invocation phase-neutral.
 *
 * WHY THIS EXISTS. `explore` was structurally near-unreachable: only a harness's
 * own Read/Grep/Glob tools produced `ReadSearch`, so a session that investigated
 * entirely through the shell earned no explore signal, and a shell-only harness
 * could never explore at all. The audit's exemplar E-1 spent its runtime on
 * read-only shell investigation and scored 2% explore / 92% implement.
 *
 * THE GENERALITY CONTRACT (PLN-1490). This file may name UNIVERSAL command
 * vocabulary — POSIX/coreutils, and the cross-ecosystem tools every stack has —
 * because that is shared across organizations. It may NOT encode any one
 * organization's wrappers, aliases, scripts, or repo layout. The corpus that drove
 * this design leads 47% of its command lines with a bespoke two-token sandbox
 * wrapper; that is handled STRUCTURALLY (scan past unrecognized leading tokens),
 * never by name — which is also why `sudo`, `env`, `time`, `nice`, `xargs`, `npx`,
 * `bundle exec`, `uv run` and any future wrapper work without being listed.
 *
 * KNOWN BOUND of that scan. It cannot distinguish a wrapper that EXECUTES its
 * argument (`sudo cat x`) from a program that merely CONSUMES one (`mytool cat
 * x`) — they are the same token sequence — so the latter can reach a read-only
 * verdict off its argument. Script invocations are refused outright
 * ({@link isScriptInvocation}); for a bare unrecognized name the scan is kept,
 * because 69% of read-only lines depend on it and the alternative — dropping the
 * scan, or enumerating wrapper names — either forfeits most of the explore
 * recovery or breaks the generality contract above. Closing it properly needs
 * evidence this module does not have (the invoked program's actual behaviour),
 * not a longer list.
 *
 * SAFETY DIRECTION. Every ambiguity resolves to `Unknown`, which scores no phase.
 * Under-claiming explore is the safe failure; fabricating it is not. A line is
 * called read-only only when every meaningful segment is recognized read-only.
 *
 * Note that read-only and EXPLORING are not the same claim: a downstream
 * read-only verdict becomes exploration evidence, so a command that changes
 * nothing but investigates nothing either — `sleep 30`, `true` — is neutral
 * ({@link NEUTRAL_HEADS}), not read-only.
 *
 * THREE TRAPS THIS DELIBERATELY AVOIDS, all found by measuring the corpus rather
 * than reasoning about it:
 *   1. A write flag is NEVER universal, so every one is scoped to the heads where
 *      it means that ({@link HEAD_WRITE_FLAGS}). `-i` edits in place for
 *      `sed`/`perl` but means include-headers for `curl` and ignore-case for
 *      `grep`/`rg`; `-o` names an output file for `sort` but means logical-OR for
 *      `find` and only-matching for `grep`. A blanket veto on either mislabels
 *      ordinary searches as mutating — 17 corpus lines carry a read-only `-o`.
 *   2. Redirection detection must ignore QUOTED text, or a search for a conflict
 *      marker (`rg "^(<<<<<<<|=======|>>>>>>>)"`) reads as a file write. It must
 *      also key on the redirection TARGET rather than its source, or
 *      `cat x 2>err.log` looks like the plumbing that `2>&1` genuinely is.
 *   3. A nested command hides a whole second command that this module never
 *      reads, and only SINGLE quotes make it literal — `"$(…)"` still executes.
 *      It therefore vetoes a read-only verdict ({@link hasNestedCommand}).
 *
 * The lexical layer this builds on — quote blanking, segment splitting, token
 * normalization, the wrapper scan — lives in `./command-tokens.js`, shared with
 * test detection (AA-09). This file owns only the EFFECT vocabulary.
 */
import {
  bareTokensAfter,
  blankQuotedSpans,
  firstNonEnvIndex,
  headToken,
  isScriptInvocation,
  MAX_WRAPPER_TOKENS,
  segmentTokens,
  splitSegments,
} from "./command-tokens.js";

/** What a shell command line was determined to DO. */
export const CommandEffect = {
  /** Every recognized segment only reads/inspects; nothing observed can mutate. */
  ReadOnly: "read_only",
  /** At least one segment is a recognized mutating operation. */
  Mutating: "mutating",
  /** Not confidently determinable — the fail-safe default (scores no phase). */
  Unknown: "unknown",
} as const;
export type CommandEffect = (typeof CommandEffect)[keyof typeof CommandEffect];

/**
 * Read-only command heads: POSIX/coreutils inspection plus the cross-ecosystem
 * search tools that replaced them. These have no common mutating mode (the ones
 * that do are handled by {@link IN_PLACE_EDIT_HEADS} or excluded entirely).
 */
const READ_ONLY_HEADS = new Set([
  // Content inspection
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "nl",
  "tac",
  "rev",
  "strings",
  "xxd",
  "od",
  "hexdump",
  "wc",
  "file",
  "stat",
  "du",
  "df",
  "readlink",
  "realpath",
  "basename",
  "dirname",
  // Search
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "find",
  "fd",
  "locate",
  "which",
  "whereis",
  "type",
  "whatis",
  "apropos",
  "man",
  // Listing / environment inspection
  "ls",
  "dir",
  "tree",
  "pwd",
  "whoami",
  "id",
  "hostname",
  "uname",
  "date",
  "printenv",
  "history",
  "jobs",
  "ps",
  "uptime",
  // Text processing (read-only forms)
  "sort",
  "uniq",
  "cut",
  "tr",
  "column",
  "paste",
  "join",
  "comm",
  "fold",
  "expand",
  "unexpand",
  "seq",
  "echo",
  "printf",
  "diff",
  "cmp",
  "diff3",
  "jq",
  "yq",
  "xmllint",
]);

/** Command heads that mutate the workspace or environment. */
const MUTATING_HEADS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "ln",
  "chmod",
  "chown",
  "chgrp",
  "dd",
  "truncate",
  "tee",
  "install",
  "patch",
  "shred",
  "unlink",
]);

/**
 * Segments with no effect AND no investigative content. These resolve to neither
 * read-only nor mutating, because a read-only verdict becomes EXPLORATION
 * evidence downstream and "did not mutate" is not the same claim as "was
 * investigating" — `sleep 30` only anchors time.
 *
 * Navigation is here so `cd <dir> && <real command>` classifies on the real
 * command; 24% of the corpus's command lines take that shape.
 */
const NEUTRAL_HEADS = new Set([
  // Navigation / grouping
  "cd",
  "pushd",
  "popd",
  // No-ops and waits: they change nothing, but they also read nothing.
  "true",
  "false",
  "sleep",
  "test",
  "help",
]);

/**
 * MIXED-MODE tools: universal binaries whose effect depends on the SUBCOMMAND, so
 * neither an all-read nor an all-write listing is honest. Only the enumerated
 * read-only subcommand PATHS count as inspection; every other subcommand
 * (including unrecognized ones) falls through to `Unknown`, never to read-only.
 *
 * Entries are whole command paths, matched against the leading non-flag tokens
 * from the head — NOT against any token in the line. `gh` needs the two-token
 * `<noun> <verb>` form; the rest name their operation in one token. Matching a
 * path rather than any token is what stops a later positional argument from
 * laundering a mutating operation into exploration (`git add status`).
 *
 * `gh api` is deliberately absent — it defaults to GET but writes freely with
 * `-X POST`/`-f`, and the corpus contains both shapes. Unknown is the honest read.
 * `npm audit` is absent for the same reason: `npm audit fix` rewrites the tree,
 * and one path cannot be read-only while its own extension is not.
 *
 * A `Map`, not an object literal: the key is a head token parsed out of untrusted
 * agent-authored command text, so a plain `{}` lookup would resolve inherited
 * members (`constructor`, `__proto__`, `toString`) to truthy non-Set values and
 * throw on `.has`.
 */
const MIXED_MODE_READ_SUBCOMMANDS = new Map<string, ReadonlySet<string>>([
  [
    "git",
    new Set([
      "status",
      "log",
      "show",
      "diff",
      "blame",
      "rev-parse",
      "rev-list",
      "describe",
      "shortlog",
      "reflog",
      "whatchanged",
      "grep",
      "ls-files",
      "ls-tree",
      "ls-remote",
      "cat-file",
      "count-objects",
      "verify-commit",
    ]),
  ],
  [
    "gh",
    new Set([
      "status",
      "auth status",
      "pr view",
      "pr list",
      "pr status",
      "pr diff",
      "pr checks",
      "repo list",
      "run view",
      "run list",
      "issue view",
      "issue list",
      "repo view",
      "workflow view",
      "workflow list",
      "release view",
      "release list",
      "cache list",
      "label list",
    ]),
  ],
  ["docker", new Set(["ps", "images", "logs", "inspect", "version", "info"])],
  ["kubectl", new Set(["get", "describe", "logs", "explain", "version"])],
  ["npm", new Set(["ls", "list", "view", "outdated"])],
  ["pnpm", new Set(["ls", "list", "outdated", "why"])],
  ["yarn", new Set(["list", "info", "why"])],
  ["cargo", new Set(["tree", "metadata"])],
  ["go", new Set(["list", "env", "version"])],
  ["brew", new Set(["list", "info", "outdated"])],
]);

/**
 * Per-head flags that turn an otherwise-reading command into a WRITE — either by
 * editing its input in place or by naming an output file. Scoped per head, NEVER
 * matched globally, because each of these spellings means something harmless on
 * some other tool (trap 1 in the file header).
 *
 * A `Map` for the same reason as {@link MIXED_MODE_READ_SUBCOMMANDS}: the key is
 * a head token parsed out of untrusted agent-authored command text.
 */
const HEAD_WRITE_FLAGS = new Map<string, ReadonlySet<string>>([
  // Stream editors: `-i` / `-i.bak` rewrites the file instead of stdout.
  ["sed", new Set(["-i"])],
  ["perl", new Set(["-i"])],
  ["ruby", new Set(["-i"])],
  ["awk", new Set(["-i"])],
  ["gawk", new Set(["-i"])],
  // `sort -o out` writes to a file, and legitimately overwrites its own input.
  ["sort", new Set(["-o", "--output"])],
  // `find … -fprint out` writes the match list to a file.
  ["find", new Set(["-fprint", "-fprintf", "-fls"])],
  // yq spells in-place `-i`/`--inplace` (no hyphen), unlike sed's `--in-place`.
  ["yq", new Set(["-i", "--inplace"])],
]);

/**
 * Stream processors that only write to STDOUT unless invoked in place. `sed -n
 * '1,220p' file` is ordinary reading and is common in every stack (312 of the
 * corpus's read-only lines invoke one), so treating them as unknown left a large
 * slice of genuine investigation unscored.
 *
 * Deliberately excludes `perl`/`ruby`: they are general-purpose languages whose
 * one-liners can open files for write or unlink them, so they stay `Unknown`
 * (while still counting as `Mutating` under `-i`).
 *
 * Their SCRIPTS can still write, so a read-only verdict is conditional on
 * {@link SCRIPT_WRITE_RE} finding no write/exec command inside.
 */
const STREAM_PROCESSOR_HEADS = new Set(["sed", "awk", "gawk", "nawk"]);

/**
 * Write or execute commands appearing inside a stream-processor SCRIPT, which is
 * ordinarily quoted and therefore invisible to token scanning: sed's `w`/`W`
 * file commands and `s///w` flag, and awk's `system()` and output redirection.
 *
 * The redirection alternative requires a QUOTED target. awk overloads `>` as
 * both redirection and comparison, so a bare target cannot be told apart from an
 * expression — `awk '{print substr($0, length($0)>0 ? 1 : 2)}'` is a formatting
 * script, not a write, and reading it as one would fabricate the mutation
 * evidence AA-09 exists to remove. Missing `print > outvar` is the safer error.
 */
const SCRIPT_WRITE_RE =
  /(?:^|[;{\s\d$/,'"])[wW]\s+\S|\/[gpiIme0-9]*w\b|\bsystem\s*\(|(?:print|printf)[^;'"]*>{1,2}\s*["']/;

/** A stream-processor invocation anywhere on the line. */
const STREAM_PROCESSOR_INVOCATION_RE = /(?:^|[\s/|;&])(?:sed|awk|gawk|nawk)\s/;

/** How deep a mixed-mode subcommand PATH may run. Two covers the
 * `<tool> <noun> <verb>` shape (`gh pr view`) as well as plain `<tool> <verb>`
 * (`git status`). Kept at two so a later positional ARGUMENT can never be read
 * as part of the operation. */
const MAX_SUBCOMMAND_TOKENS = 2;

/**
 * Argument forms that mutate regardless of head: the whole `find` action family
 * that runs another command (`-exec`/`-execdir`/`-ok`/`-okdir`) or removes files,
 * and the write-flag conventions shared by formatters and linters across
 * ecosystems. The `dir` suffixes are spelled out because `\b` does not end a
 * match at `-exec|dir`, so a bare `-exec` alternative silently misses them.
 */
const MUTATING_ARGUMENT_RE =
  /(?:^|\s)(?:-delete|-exec(?:dir)?|-ok(?:dir)?|--in-place|--write|--fix|--fix-dry-run)\b/;

/** A SINGLE-quoted span — the only quoting that makes `$(…)` and backticks
 * literal text rather than a nested command. */
const SINGLE_QUOTED_SPAN_RE = /'[^']*'/g;

/** Every syntax that runs a nested command: command substitution (`$(…)`,
 * backticks) and process substitution (`<(…)`, `>(…)`). */
const NESTED_COMMAND_RE = /\$\(|[<>]\(|`/;

/**
 * A `>`/`>>` redirection whose TARGET is a real file.
 *
 * The discriminator is the target, not the source. Keying on the source — taking
 * any `N>` or `&>` for plumbing — let `cat input 2>errors.log` and
 * `cat input &>errors.log` write a file unnoticed. Only `&1`/`&2`, which
 * duplicate a descriptor, and `/dev/null`, which discards, are genuinely not
 * writes.
 */
const REDIRECT_WRITE_RE =
  /(?:[0-9]+|&)?>{1,2}\s*(?![&>])(?!\/dev\/null\b)[^\s;|&]/;

/**
 * The candidate subcommand PATHS for a mixed-mode tool: the first bare token
 * after `head`, and the first two joined.
 *
 * Deliberately NOT "any of the leading tokens" — matching any token lets a read
 * word that appears AFTER a mutating operation launder the whole line
 * (`git add status`). Equally deliberately, the scan skips a leading flag value
 * but never a leading bare word: a bare word before the operation means the
 * operation already happened, so the line must not resolve to read-only.
 */
function subcommandPaths(tokens: string[], headIndex: number): string[] {
  const found = bareTokensAfter(tokens, headIndex, MAX_SUBCOMMAND_TOKENS).map(
    ({ token }) => token
  );
  if (found.length < MAX_SUBCOMMAND_TOKENS) {
    return found;
  }
  return [found[0], found.join(" ")];
}

/**
 * True for a token that carries `flag`, in any spelling POSIX tools accept:
 * exact (`-i`), attached value (`-i.bak`, `-oout`, `--output=path`), or — for a
 * short flag — BUNDLED with other short flags (`sed -Ei`, `sort -uo out`).
 *
 * Bundling is only searched for single-letter short flags, and only ever for the
 * head that declared them, so this cannot resurrect the `-i`/`-o` overload trap:
 * `grep -in` is never consulted here because `grep` declares no write flags.
 */
function matchesFlag(token: string, flag: string): boolean {
  if (
    token === flag ||
    token.startsWith(`${flag}.`) ||
    token.startsWith(`${flag}=`)
  ) {
    return true;
  }
  const isShortFlag = flag.length === 2 && flag.startsWith("-");
  if (!isShortFlag || token.startsWith("--") || !token.startsWith("-")) {
    return false;
  }
  return token.slice(1).includes(flag.slice(1));
}

/**
 * True when this head was invoked with one of its own write flags — `sed -i`
 * rewriting a file, `sort -o` naming an output path. Without this, a head listed
 * as read-only launders a genuine file write into exploration evidence.
 */
function writesViaFlag(
  head: string,
  tokens: string[],
  headIndex: number
): boolean {
  const flags = HEAD_WRITE_FLAGS.get(head);
  if (!flags) {
    return false;
  }
  for (const token of tokens.slice(headIndex + 1)) {
    for (const flag of flags) {
      if (matchesFlag(token, flag)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The effect of ONE candidate head at `headIndex`, or `null` when this token is
 * not a recognized command (so the caller keeps scanning past it as a wrapper).
 */
function headEffect(tokens: string[], headIndex: number): CommandEffect | null {
  const head = headToken(tokens[headIndex]);
  if (MUTATING_HEADS.has(head) || writesViaFlag(head, tokens, headIndex)) {
    return CommandEffect.Mutating;
  }
  if (STREAM_PROCESSOR_HEADS.has(head)) {
    // Not in place (checked above), so it only writes to stdout.
    return CommandEffect.ReadOnly;
  }
  const mixed = MIXED_MODE_READ_SUBCOMMANDS.get(head);
  if (mixed) {
    // A mixed-mode tool always DECIDES here — an unrecognized subcommand is
    // `Unknown`, never a wrapper to scan past, so `git <anything-else>` can
    // never be laundered into read-only by a later token.
    return subcommandPaths(tokens, headIndex).some((path) => mixed.has(path))
      ? CommandEffect.ReadOnly
      : CommandEffect.Unknown;
  }
  return READ_ONLY_HEADS.has(head) ? CommandEffect.ReadOnly : null;
}

/** Classifies one already-quote-blanked segment (no `&&`/`|`/`;` inside). */
function segmentEffect(segment: string): CommandEffect | "neutral" {
  const tokens = segmentTokens(segment);
  const start = firstNonEnvIndex(tokens);
  if (start >= tokens.length || NEUTRAL_HEADS.has(headToken(tokens[start]))) {
    return "neutral";
  }
  // The budget counts CANDIDATE HEADS, not flags: a wrapper's own options
  // (`env -i …`, `nice -n 10 …`) must not exhaust the scan before the real
  // command is reached.
  let examined = 0;
  for (let i = start; i < tokens.length && examined < MAX_WRAPPER_TOKENS; i++) {
    if (tokens[i].startsWith("-")) {
      continue;
    }
    examined++;
    const effect = headEffect(tokens, i);
    if (effect) {
      return effect;
    }
    // Unrecognized. Walking past it treats it as a wrapper; refuse when it names
    // a script, whose argument we cannot assume was merely handed to a wrapper.
    if (isScriptInvocation(tokens[i])) {
      return CommandEffect.Unknown;
    }
  }
  return CommandEffect.Unknown;
}

/**
 * True when the line runs a nested command whose text this module never reads.
 * Neither command substitution (`$(…)`, backticks) nor process substitution
 * (`<(…)`, `>(…)`) is a segment separator, so the nested command hides completely
 * behind whichever head resolves first: in `echo $(rm -rf build)` and in
 * `cat <(rm -rf build)` the outer head decides and the `rm` is never seen.
 *
 * Only SINGLE quotes make these literal — `"$(…)"` still executes — so only
 * single-quoted spans are dropped before looking.
 */
function hasNestedCommand(command: string): boolean {
  return NESTED_COMMAND_RE.test(command.replace(SINGLE_QUOTED_SPAN_RE, ""));
}

/**
 * True when a stream processor's SCRIPT writes a file or shells out.
 *
 * `sed`/`awk` are read-only only because they normally write to stdout, but a
 * script can write (`sed -n '1w marker'`, `awk '{print > "out"}'`) or execute
 * (`awk 'BEGIN{system("rm -rf x")}'`). Checked against the RAW line, because the
 * script lives inside quotes that token scanning deliberately blanks.
 */
function hasStreamProcessorScriptWrite(command: string): boolean {
  return (
    STREAM_PROCESSOR_INVOCATION_RE.test(command) &&
    SCRIPT_WRITE_RE.test(command)
  );
}

/**
 * Classify a shell command line's effect. Pure and deterministic.
 *
 * A line is `ReadOnly` only when at least one segment is recognized read-only and
 * NO segment is unknown or mutating — an unrecognized segment anywhere forces
 * `Unknown`, because a command we cannot read might do anything. Any recognized
 * mutating segment, write flag, mutating argument form, or file redirection makes
 * the whole line `Mutating`; that verdict is reached before the substitution veto
 * so an observed mutation keeps its evidence even when the line also nests a
 * command.
 */
export function classifyCommandEffect(command: string): CommandEffect {
  const trimmed = command.trim();
  if (!trimmed) {
    return CommandEffect.Unknown;
  }
  const masked = blankQuotedSpans(trimmed);
  if (MUTATING_ARGUMENT_RE.test(masked) || REDIRECT_WRITE_RE.test(masked)) {
    return CommandEffect.Mutating;
  }
  if (hasStreamProcessorScriptWrite(trimmed)) {
    return CommandEffect.Mutating;
  }
  let sawReadOnly = false;
  for (const segment of splitSegments(masked)) {
    if (!segment.trim()) {
      continue;
    }
    const effect = segmentEffect(segment);
    if (effect === CommandEffect.Mutating) {
      return CommandEffect.Mutating;
    }
    if (effect === CommandEffect.Unknown) {
      return CommandEffect.Unknown;
    }
    if (effect === CommandEffect.ReadOnly) {
      sawReadOnly = true;
    }
  }
  if (!sawReadOnly || hasNestedCommand(trimmed)) {
    return CommandEffect.Unknown;
  }
  return CommandEffect.ReadOnly;
}

/**
 * True when `token` names a command this module RECOGNIZES — one that therefore
 * CONSUMES its arguments rather than executing them.
 *
 * Exported for the wrapper scan in `test-invocation.ts`. That scan walks past
 * unrecognized leading tokens on the assumption they might be wrappers, which is
 * only safe while the token is genuinely unknown: `ls .venv/bin/pytest` lists a
 * file and `cat vitest.config.mts` reads one, so continuing past either and
 * resolving the ARGUMENT as a command invents an invocation that never happened.
 * Any head answered here ends the scan.
 */
export function isRecognizedCommandHead(token: string): boolean {
  const head = headToken(token);
  return (
    READ_ONLY_HEADS.has(head) ||
    MUTATING_HEADS.has(head) ||
    NEUTRAL_HEADS.has(head) ||
    STREAM_PROCESSOR_HEADS.has(head) ||
    MIXED_MODE_READ_SUBCOMMANDS.has(head)
  );
}
