/**
 * @file command-tokens.ts
 * @description FEA-4010 (AA-09, test detection): the shared LEXICAL layer for
 * reading a shell command line — quote blanking, segment splitting, token
 * normalization, and the wrapper scan that finds the command actually being run.
 *
 * Extracted from `command-semantics.ts` (AA-04) when a second consumer appeared:
 * test detection has to answer "what program is this line RUNNING?", which is the
 * same question the effect classifier already answers before deciding what that
 * program DID. Copying the tokenizer instead would have duplicated the subtle
 * parts — the quote filler that preserves token identity, the `&`-vs-`2>&1`
 * separator rule, the flag-value skip that keeps `git -C <dir> status` resolving —
 * and let the two copies drift silently apart.
 *
 * This module is deliberately vocabulary-FREE. It knows shell grammar, not
 * programs: no command names, no ecosystems, no organizations. Callers bring their
 * own taxonomy and ask this layer only where the tokens are. That split is what
 * keeps the generality contract checkable — there is nothing here to over-fit.
 */

/** A single- or double-quoted span, whose CONTENT must not be scanned. */
const QUOTED_SPAN_RE = /'[^']*'|"[^"]*"/g;

/**
 * What quoted content is replaced with. Deliberately a NON-whitespace,
 * non-operator placeholder: it preserves both the span's length AND its
 * single-token identity, so blanking `"foo bar"` cannot split one argument into
 * two phantom tokens (which spaces would) and cannot introduce a shell operator
 * (which the raw text might).
 */
const QUOTE_FILLER_CHAR = "_";

/** A leading `VAR=value` environment assignment. */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Runs of whitespace separating tokens. */
const WHITESPACE_RE = /\s+/;

/** The redirection characters a lone `&` must not be torn out of (`2>&1`, `&>f`). */
const REDIRECTION_ADJACENT = new Set([">", "&"]);

/**
 * The standard system executable directories, the only paths whose contents are
 * assumed to be the well-known program of that name. Deliberately not a list of
 * one machine's layout: these are the FHS/macOS locations every POSIX system has.
 */
const SYSTEM_BIN_DIR_RE =
  /^\/(?:usr\/(?:local\/)?)?s?bin\/$|^\/opt\/homebrew\/(?:s?bin)\/$/;

/** A token naming a program by PATH, or by a script filename. */
const SCRIPT_INVOCATION_RE = /\/|\.(?:sh|bash|zsh|py|rb|pl|mjs|cjs|js)$/;

/**
 * The PACKAGE-MANAGER binary directories, where a dependency's own executables
 * are installed under their published names: npm/pnpm/yarn's `node_modules/.bin`,
 * Python's virtualenv `bin`, Composer's `vendor/bin`.
 *
 * These are the one path family where a basename IS evidence of the program:
 * `.venv/bin/pytest` is pytest by the packaging tool's own contract, not by
 * coincidence of naming. That is a narrower claim than trusting any path, which
 * is why `./tools/cat` still resolves to nothing — see {@link headToken}.
 */
const PACKAGE_BIN_DIR_RE =
  /(?:^|\/)(?:node_modules\/\.bin|\.?venv\/bin|env\/bin|vendor\/bin)\/$/;

/**
 * The start of a heredoc (`<<EOF`, `<<-'EOF'`, `<< "EOF"`), capturing its
 * delimiter. `<<<` is a here-STRING, which is a single-line argument rather than
 * a body, so it is excluded.
 *
 * Both guards are load-bearing. A lookAHEAD alone cannot exclude `<<<`: the match
 * simply retries one character later, and from the third `<` the lookahead sees
 * whatever follows and passes, so `grep foo <<< 'haystack'` captured `haystack` as
 * a delimiter and swallowed every line after it. The lookBEHIND is what makes the
 * exclusion hold at every offset.
 */
const HEREDOC_START_RE = /(?<!<)<<-?(?!<)\s*(['"]?)([A-Za-z_][\w-]*)\1/;

/**
 * How many leading unrecognized tokens may be skipped to find the real command.
 * Covers one- and two-token wrappers without scanning into a command's own
 * arguments.
 */
export const MAX_WRAPPER_TOKENS = 3;

/**
 * Blanks the CONTENT of quoted spans, preserving length and the quotes so token
 * positions are unchanged. Without this, searching for a conflict marker
 * (`rg "^(<<<<<<<|=======|>>>>>>>)"`) reads as a redirection.
 *
 * Every classifier reading a command line for what it DID or RAN has the same
 * obligation: a tool name inside a search pattern is text being looked for, not a
 * tool being run.
 */
export function blankQuotedSpans(command: string): string {
  return command.replace(QUOTED_SPAN_RE, (span) => {
    const last = span.at(-1) ?? "";
    const filler = QUOTE_FILLER_CHAR.repeat(Math.max(0, span.length - 2));
    return `${span[0]}${filler}${last}`;
  });
}

/**
 * The comparable name of a command token.
 *
 * A leading path is stripped only for the STANDARD system directories, so
 * `/bin/cat` and `/usr/bin/git` read as `cat` and `git`. Any other path-qualified
 * token keeps its path and therefore matches no vocabulary, which routes it out as
 * unrecognized: a basename is not evidence of behaviour, so `./tools/cat` must not
 * inherit coreutils `cat`'s semantics.
 */
export function headToken(token: string): string {
  const lastSlash = token.lastIndexOf("/");
  if (lastSlash < 0) {
    return token.toLowerCase();
  }
  const directory = token.slice(0, lastSlash + 1);
  if (!SYSTEM_BIN_DIR_RE.test(directory)) {
    return token.toLowerCase();
  }
  return token.slice(lastSlash + 1).toLowerCase();
}

/** True for a leading `VAR=value` environment assignment. */
function isEnvAssignment(token: string): boolean {
  return ENV_ASSIGNMENT_RE.test(token);
}

/**
 * True for a token shaped like a FLAG'S VALUE rather than a subcommand name:
 * a path, a `key=value`, or a revision. Used only to skip a global option's
 * argument (`git -C <dir> status`, `pnpm -C <dir> test`) while looking for the
 * operation. A bare word is never skipped, which is the whole point.
 */
function isFlagValueShaped(token: string): boolean {
  return (
    token.includes("/") ||
    token.includes("=") ||
    token.includes(":") ||
    token.includes(".")
  );
}

/**
 * True for an unrecognized token that names a SCRIPT or a program by path.
 *
 * The wrapper scan walks past tokens it does not recognize, which is what lets
 * `<unknown sandbox proxy> grep …` resolve. The scan cannot tell a wrapper that
 * EXECUTES its argument from a program that merely CONSUMES it — but a bespoke
 * script is far likelier to be the second, and it is the shape whose behaviour we
 * can least predict.
 */
export function isScriptInvocation(token: string): boolean {
  return SCRIPT_INVOCATION_RE.test(token);
}

/** Index of the first token that is not a leading `VAR=value` assignment. */
export function firstNonEnvIndex(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length && isEnvAssignment(tokens[index])) {
    index++;
  }
  return index;
}

/**
 * Characters that END a word, so a `#` immediately after one still starts a new
 * one. Whitespace is the obvious boundary but not the only one: a control
 * operator ends a word with no space required, and `echo ok;# pnpm test` is a
 * comment to the shell exactly as `echo ok; # pnpm test` is.
 *
 * Redirections (`>`, `<`) and expansions (`$`, `{`) are deliberately absent —
 * `echo $#` must stay ordinary text. The safe direction is to recognize FEWER
 * comments, since each one recognized drops a command from the line.
 */
const WORD_BOUNDARY_CHARS = new Set([";", "&", "|", "(", ")"]);

/** True when a `#` at `index` opens a comment: it must start a word. */
function opensComment(command: string, index: number): boolean {
  if (command[index] !== "#") {
    return false;
  }
  const previous = command[index - 1];
  return (
    previous === undefined ||
    WHITESPACE_RE.test(previous) ||
    WORD_BOUNDARY_CHARS.has(previous)
  );
}

/** The separator length at `index`, or 0 when no separator starts there. */
function separatorLengthAt(command: string, index: number): number {
  const char = command[index];
  if (char === "\n" || char === ";" || char === "|") {
    return command[index + 1] === "|" && char === "|" ? 2 : 1;
  }
  if (char !== "&") {
    return 0;
  }
  if (command[index + 1] === "&") {
    return 2;
  }
  // A lone `&` backgrounds, but only when it is not part of `2>&1` or `&>file`.
  const previous = command[index - 1];
  const next = command[index + 1];
  const adjacent =
    (previous !== undefined && REDIRECTION_ADJACENT.has(previous)) ||
    (next !== undefined && REDIRECTION_ADJACENT.has(next));
  return adjacent ? 0 : 1;
}

/**
 * Splits a command line on the separators the SHELL would act on (`&&`, `||`,
 * `;`, `|`, `&`, newline).
 *
 * Scanned rather than `split()` on a regex, because a regex cannot see the two
 * states that decide whether a separator is live:
 *   - ESCAPED — `find . -exec rm {} \;` ends its `-exec` with a literal
 *     semicolon. Splitting there invented a second command out of one, and
 *     `echo ok \; pnpm test` fabricated a test run the shell never executes.
 *   - COMMENTED — everything after an unquoted `#` that starts a word is dropped
 *     by the shell, so `echo ok # && pnpm test` runs no test either.
 * Quote state is tracked for the same reason; the input is quote-BLANKED rather
 * than quote-stripped, so the delimiters are still present to be counted.
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote !== null) {
      current += char;
      quote = char === quote ? null : quote;
      continue;
    }
    if (char === "\\") {
      // The escape and whatever it escapes are one literal unit.
      current += char + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (opensComment(command, i)) {
      while (i < command.length && command[i] !== "\n") {
        i++;
      }
      i--;
      continue;
    }
    const separator = separatorLengthAt(command, i);
    if (separator > 0) {
      segments.push(current);
      current = "";
      i += separator - 1;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

/** Splits an already-quote-blanked segment into non-empty tokens. */
export function segmentTokens(segment: string): string[] {
  return segment.trim().split(WHITESPACE_RE).filter(Boolean);
}

/**
 * The published binary name a package-manager path names, or `null`.
 *
 * Scoped to {@link PACKAGE_BIN_DIR_RE} on purpose. A dependency's installed
 * executable carries the package's own name by the packaging tool's contract, so
 * `.venv/bin/pytest` and `node_modules/.bin/vitest` are those programs — whereas
 * a bespoke `./tools/cat` is not coreutils `cat`, which is why {@link headToken}
 * refuses paths in general.
 */
export function packageBinaryName(token: string): string | null {
  const lastSlash = token.lastIndexOf("/");
  if (lastSlash < 0) {
    return null;
  }
  const directory = token.slice(0, lastSlash + 1);
  return PACKAGE_BIN_DIR_RE.test(directory)
    ? token.slice(lastSlash + 1).toLowerCase()
    : null;
}

/**
 * Drops heredoc BODIES, keeping the command line that opened them.
 *
 * A heredoc is quoted text by another syntax: `cat > pr-body.md <<'EOF' … EOF`
 * writes a document, and whatever that document says is prose, not commands. A
 * corpus session writes a PR body whose "Test plan" section quotes
 * `npx tsx --test …`; because bodies contain newlines and newline is a segment
 * separator, that prose otherwise arrives as its own command segment and reads as
 * a test run that never happened.
 *
 * An UNTERMINATED heredoc (a truncated transcript) drops everything after it,
 * which is the safe direction: text whose delimiter never arrived cannot be
 * confidently attributed to anything.
 *
 * IDEMPOTENT: the `<<DELIM` operator is dropped along with the body it
 * introduced. Keeping it would leave an opener whose delimiter line no longer
 * exists, so a second pass would read it as unterminated and swallow every
 * command after it — the same defect this function exists to prevent, arrived at
 * by running it twice.
 */
export function stripHeredocBodies(command: string): string {
  if (!command.includes("<<")) {
    return command;
  }
  const kept: string[] = [];
  let delimiter: string | null = null;
  for (const line of command.split("\n")) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) {
        delimiter = null;
      }
      continue;
    }
    const opener = HEREDOC_START_RE.exec(line);
    delimiter = opener?.[2] ?? null;
    kept.push(opener === null ? line : line.replace(opener[0], " "));
  }
  return kept.join("\n");
}

/** A bare (non-flag) token after a head, with its index in the token array. */
export type BareToken = { token: string; index: number };

/**
 * The BARE tokens following `headIndex` — a tool's operation words, with flags
 * and a leading flag VALUE skipped.
 *
 * Deliberately NOT "any of the following tokens". A read word that appears AFTER
 * an operation must not launder the line (`git add status`), so callers match an
 * anchored path built from the FIRST tokens, never a set membership test over all
 * of them. The leading flag-value skip is what keeps `git -C <dir> status` and
 * `pnpm -C <dir> test` resolving, and it applies only while nothing has been found
 * yet: once the operation word is in hand, later path-shaped arguments are its
 * arguments, not more operation words.
 *
 * Absent a declared arity, a token is a flag's value only when it BOTH follows a
 * flag and is value-shaped. Either test alone is wrong: shape alone swallowed the
 * operation itself whenever it was namespaced (`pnpm test:node` resolved to
 * nothing, making every `test:*` script invisible), while position alone would
 * swallow `pytest` in `python3 -m pytest`, where the flag's value IS the program.
 *
 * `valueFlags` lifts that guess for options whose arity the caller KNOWS from the
 * tool's published contract. Shape cannot decide a plain-word value: without a
 * declared arity `pnpm --filter desktop run test` reads `desktop` as the operation
 * and resolves to nothing, while `pnpm --filter @repo/app test` resolves — the
 * scoped name is eaten only because it happens to contain a slash. Two spellings
 * of one command, opposite verdicts, on an accident of punctuation.
 */
export function bareTokensAfter(
  tokens: string[],
  headIndex: number,
  limit: number,
  valueFlags?: ReadonlySet<string>
): BareToken[] {
  const found: BareToken[] = [];
  let priorFlag: string | null = null;
  for (let i = headIndex + 1; i < tokens.length && found.length < limit; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) {
      priorFlag = token;
      continue;
    }
    // A declared value-taking option consumes its argument whatever it looks
    // like, at any position — the arity is the tool's own contract, not a guess.
    if (priorFlag !== null && valueFlags?.has(priorFlag)) {
      priorFlag = null;
      continue;
    }
    if (found.length === 0 && priorFlag !== null && isFlagValueShaped(token)) {
      priorFlag = null;
      continue;
    }
    found.push({ token: token.toLowerCase(), index: i });
    priorFlag = null;
  }
  return found;
}
