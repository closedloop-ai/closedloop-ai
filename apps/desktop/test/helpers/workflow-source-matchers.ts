/**
 * Deciding, from GitHub workflow SOURCE, whether a step actually RUNS a
 * command.
 *
 * Split out of `run-node-tests-job-cap.test.ts` (ISS-6410 review, wongk): that
 * guard is only ever as good as this decision, and a decision with its own
 * defeat space deserves its own module and its own counterfactuals.
 *
 * The hole this closes: checking only that the command appears somewhere in
 * `run`, followed by a token boundary, accepts text that never executes. A
 * commented-out invocation, an echoed one, and a heredoc body all leave the
 * boundary check green after the real command is gone. So the command has to
 * sit at a COMMAND POSITION in an EXECUTABLE line, not merely occur in one.
 *
 * Deliberately strict rather than clever: an unrecognized wrapper (`time …`,
 * `xvfb-run …`) reads as "does not run the command", which fails loudly and
 * asks to be taught. The failure that matters is the other direction.
 */

/** What may follow the command: end of segment, whitespace, or a redirect. */
const COMMAND_BOUNDARY = new Set([
  "",
  " ",
  "\t",
  "\r",
  "\n",
  "|",
  "&",
  ";",
  ">",
  "<",
]);

/** Shell operators that end one command and start the next. */
const SEGMENT_BREAK = new Set(["&", "|", ";", "(", ")"]);

/** `FOO=bar ` prefixes, which precede a command without being one. */
const LEADING_ASSIGNMENTS = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

/** `<<EOF`, `<<-EOF`, `<<'EOF'` — but never `<<<` (a herestring). */
const HEREDOC_OPENER = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

const WHITESPACE = /\s/;

/** `line` up to the first unquoted `#` that starts a token. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (
      char === "#" &&
      (index === 0 || WHITESPACE.test(line.charAt(index - 1)))
    ) {
      return line.slice(0, index);
    }
  }
  return line;
}

/**
 * The lines of `run` that the shell executes, with comments stripped and
 * heredoc BODIES dropped. The opener line itself stays: `cat <<EOF > f` is a
 * command, only the text it writes is not.
 */
function executableLines(run: string): string[] {
  const lines: string[] = [];
  let heredocDelimiter: string | undefined;
  for (const raw of run.split("\n")) {
    if (heredocDelimiter !== undefined) {
      if (raw.trim() === heredocDelimiter) {
        heredocDelimiter = undefined;
      }
      continue;
    }
    const line = stripComment(raw);
    heredocDelimiter = HEREDOC_OPENER.exec(line)?.[2];
    lines.push(line);
  }
  return lines;
}

/** `line` split at the shell operators, honoring quotes. */
function commandSegments(line: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (quote !== undefined) {
      current += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (SEGMENT_BREAK.has(char)) {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

/** Regex metacharacters a glob carries literally. */
const GLOB_SPECIALS = /[.+^${}()|[\]\\]/g;

/** A dorny/paths-filter glob as a whole-path RegExp; `**` spans separators. */
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob.charAt(index);
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char !== "*") {
      source += char.replace(GLOB_SPECIALS, String.raw`\$&`);
      continue;
    }
    if (glob.charAt(index + 1) === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    source += "[^/]*";
  }
  return new RegExp(`^${source}$`);
}

/**
 * Whether `changedPath` actually TRIGGERS a dorny/paths-filter rule list — the
 * decision, not the presence of a literal.
 *
 * `.github/AGENTS.md` asks a filter to be proven with a representative real
 * changed path, and asserting a glob exists is not that: an added exclusion
 * leaves every literal in place while the lane it gates stops running
 * (ISS-6410 review). A `!` negation reaching the path therefore fails the
 * guard, so a human looks rather than the lane silently skipping.
 */
export function pathTriggersFilter(
  patterns: readonly string[],
  changedPath: string
): boolean {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const glob = negated ? pattern.slice(1) : pattern;
    if (!globToRegExp(glob).test(changedPath)) {
      continue;
    }
    if (negated) {
      return false;
    }
    matched = true;
  }
  return matched;
}

/**
 * True when `run` invokes `command` — at the head of an executable command
 * segment, ending at a token boundary so a lane narrowed to `${command}:node`
 * no longer counts.
 */
export function runsCommand(run: string, command: string): boolean {
  for (const line of executableLines(run)) {
    for (const segment of commandSegments(line)) {
      const invocation = segment.trimStart().replace(LEADING_ASSIGNMENTS, "");
      if (
        invocation.startsWith(command) &&
        COMMAND_BOUNDARY.has(invocation.charAt(command.length))
      ) {
        return true;
      }
    }
  }
  return false;
}
