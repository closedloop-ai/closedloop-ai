/**
 * @file artifact-ref-shell-quotes.ts
 * @description The shell-quote-aware primitives the artifact-ref extractor
 * gates its git-command detection on (FEA-2531 hardening, FEA-2791 argv arm).
 *
 * Extracted from `artifact-ref-extractor.ts` (ISS-7571) because they are one
 * cohesive unit of pure string/position logic with no extractor dependencies,
 * because being module-private there made them impossible to unit-test
 * directly, and because that file is over the 1,000-line ceiling and the
 * direction of travel is down.
 */
import type { NormalizedToolUse } from "@repo/lib/harness/types";
import { shellCommandArgv } from "./parser-utils.js";

// --- Shell-quote awareness (FEA-2531 hardening) ---
//
// The branch/commit/push regexes historically matched git-command text
// ANYWHERE in a shell command — including inside a quoted argument of a
// DIFFERENT command (`rg "…git push origin feat|…"`, `tsx -e "…'git push
// origin feat/x','git…'"`). Those matches minted phantom branches with real
// push evidence. Captures are now position-checked against the command's
// quoted spans; boolean command-shape gates run against a quote-stripped
// copy. Command-boundary anchoring was rejected instead: wrappers like
// `rtk git push …` (a Bash-hook rewrite present in real transcripts) sit
// before the git token, so an anchor would drop genuine evidence.

export type QuotedSpan = { start: number; end: number };

/**
 * Spans of `cmd` inside single-/double-quoted shell strings, inclusive of the
 * quote marks; `end` is exclusive. Two-state scanner: backslash escapes are
 * honored outside quotes and inside double quotes (POSIX-ish); single-quoted
 * content is literal until the closing quote. An unterminated quote extends
 * to end-of-string (conservative: everything after it is treated as quoted).
 */
export function findQuotedSpans(cmd: string): QuotedSpan[] {
  const spans: QuotedSpan[] = [];
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch !== "'" && ch !== '"') {
      i += 1;
      continue;
    }
    const start = i;
    i += 1;
    while (i < cmd.length && cmd[i] !== ch) {
      i += ch === '"' && cmd[i] === "\\" ? 2 : 1;
    }
    i = i < cmd.length ? i + 1 : cmd.length;
    spans.push({ start, end: i });
  }
  return spans;
}

/**
 * `cmd` with quoted-span CONTENT blanked to spaces (quote marks kept, length
 * preserved) so command-shape gates like GIT_PUSH_CMD_RE cannot fire on text
 * embedded inside another command's argument.
 */
export function stripQuotedContent(cmd: string, spans: QuotedSpan[]): string {
  if (spans.length === 0) {
    return cmd;
  }
  const chars = cmd.split("");
  for (const span of spans) {
    const hasClosingQuote =
      span.end - span.start >= 2 && cmd[span.end - 1] === cmd[span.start];
    const contentEnd = hasClosingQuote ? span.end - 1 : span.end;
    for (let j = span.start + 1; j < contentEnd; j++) {
      chars[j] = " ";
    }
  }
  return chars.join("");
}

/**
 * Quoted spans for a shell tool use: real shell quotes (findQuotedSpans) PLUS,
 * for argv-shaped input (Codex `exec_command`, MCP argv commands), each
 * non-first argv element that itself contains whitespace OR a shell separator
 * (`;`, `|`, `&`). `shellCommand`'s `join(" ")` erases argument boundaries, so
 * a bundled element like `"git push origin feat/x"` in
 * `["rg", "git push origin feat/x"]` reads as bare command structure and would
 * mint a phantom `feat/x` branch — the exact case the string form
 * (`rg "git push origin feat/x"`) rejects because the argument is quoted.
 * Separators get the same treatment (PR #6160 review): argv is execve-style —
 * no shell ever splits it — so `--glob=foo;git` is one literal argument, and
 * letting the join read its tail as a `git push` command minted a phantom
 * branch. Marking such an element quoted neutralizes it identically. A plain
 * element (`["git","push","origin","feat/x"]`) stays visible, so genuine argv
 * git pushes are still detected (FEA-2791). The span begins at the join
 * separator preceding the element so `stripQuotedContent` — which preserves a
 * span's boundary chars as if they were quote marks — blanks the whole element.
 */
export function shellQuotedSpans(
  tu: NormalizedToolUse,
  cmd: string
): QuotedSpan[] {
  const spans = findNeutralizedSpans(cmd);
  const argv = shellCommandArgv(tu);
  if (!argv) {
    return spans;
  }
  let offset = 0;
  for (let k = 0; k < argv.length; k++) {
    const element = argv[k];
    if (k > 0 && ARGV_NEUTRALIZE_RE.test(element)) {
      spans.push({ start: offset - 1, end: offset + element.length });
    }
    offset += element.length + 1; // element + the join separator
  }
  return spans;
}

/**
 * Whitespace or a shell separator inside a single argv element — either marks
 * a bundled literal argument whose content must not read as command structure.
 */
const ARGV_NEUTRALIZE_RE = /[\s;|&]/;

/** First match of global `re` whose match START sits outside every quoted span. */
export function matchOutsideQuotes(
  cmd: string,
  re: RegExp,
  spans: QuotedSpan[]
): RegExpMatchArray | null {
  if (spans.length === 0) {
    for (const m of cmd.matchAll(re)) {
      if (m.index !== undefined) {
        return m;
      }
    }
    return null;
  }
  const mask = new Uint8Array(cmd.length);
  for (const s of spans) {
    mask.fill(1, s.start, Math.min(s.end, cmd.length));
  }
  for (const m of cmd.matchAll(re)) {
    if (m.index !== undefined && !mask[m.index]) {
      return m;
    }
  }
  return null;
}

/**
 * ISS-8473: the spans a command-shape gate must treat as inert — real shell
 * quoting PLUS heredoc bodies. Every site that used to call
 * {@link findQuotedSpans} directly calls this instead, so the `git push` /
 * `git checkout -b` / `gh pr create` / commit patterns cannot diverge on which
 * text counts as data.
 *
 * Bodies are resolved FIRST and the quote scan then runs with them already
 * inert, because the two are not independent: a body is stdin data, so an
 * apostrophe in it (`cat <<EOF\ndon't\nEOF\ngit push origin feat/real`) is
 * ordinary prose, but a scanner that sees it as shell syntax opens a quote no
 * one closes and the unterminated-quote rule then extends that span to
 * end-of-string — blanking the REAL `git push` after the terminator. Composing
 * the two scans in the other order destroys evidence rather than merely
 * failing to neutralize a phantom, which is the asymmetry
 * {@link inertOpenerMask} is written to respect (codex-connector, PR #7209).
 */
export function findNeutralizedSpans(cmd: string): QuotedSpan[] {
  const heredocs = findHeredocSpans(cmd);
  return [...findQuotedSpansOutsideHeredocs(cmd, heredocs), ...heredocs];
}

/**
 * `cmd` with BOTH quoted spans and heredoc bodies blanked to spaces, length
 * preserved. The composition every command-shape gate wants, in one call, so
 * the gh / git / commit sites cannot drift on which of the two they remembered
 * to apply — the drift ISS-8473 found, where quoted spans were neutralized at
 * every site and heredoc bodies at none.
 */
export function stripNeutralizedContent(cmd: string): string {
  return stripQuotedContent(cmd, findNeutralizedSpans(cmd));
}

/**
 * Spans of `cmd` occupied by heredoc BODIES. A body is data the shell feeds to
 * a command's stdin and never executes, but a body line that BEGINS with a
 * command is positionally indistinguishable from a real invocation, so the
 * command-position anchor in `GH_PR_CREATE_REGEX` (and the unanchored push /
 * checkout / commit patterns, which predate it) mint a phantom branch from
 * `cat <<EOF\ngh pr create --head feat/x\nEOF`.
 *
 * A span runs from the newline that ENDS the opener line to the start of the
 * terminator line, so both boundary characters are newlines. That is what
 * {@link stripQuotedContent} needs — it preserves a span's first and last
 * character when they match, the way it preserves quote marks — and it is why a
 * command AFTER the terminator (`…\nEOF\ngh pr create --head x`) stays fully
 * visible and still mints.
 *
 * Handled: `<<-WORD` (the terminator may be tab-indented), quoted delimiters
 * (`<<'EOF'`, `<<"EOF"`), several heredocs opened on ONE line (their bodies
 * follow in opener order), and an unterminated heredoc (conservatively
 * neutralized to end-of-string). `<<<` is a herestring, not a heredoc, and is
 * deliberately not matched.
 */
export function findHeredocSpans(cmd: string): QuotedSpan[] {
  const spans: QuotedSpan[] = [];
  // Whole-command quote state, not per line: a quote opened on an earlier line
  // still covers its continuation lines, and scanning each line in isolation
  // read a `<<` inside such a quote as an opener.
  const inert = inertOpenerMask(cmd);
  let lineStart = 0;
  while (lineStart < cmd.length) {
    const lineEnd = lineEndIndex(cmd, lineStart);
    const delimiters =
      lineEnd === cmd.length
        ? []
        : heredocDelimitersOnLine(cmd, lineStart, lineEnd, inert);
    if (delimiters.length === 0) {
      lineStart = lineEnd + 1;
      continue;
    }
    let bodyStart = lineEnd;
    for (const delimiter of delimiters) {
      const closed = findHeredocTerminator(cmd, bodyStart + 1, delimiter);
      spans.push({ start: bodyStart, end: closed.bodyEnd });
      if (closed.terminatorLineEnd === null) {
        return spans;
      }
      bodyStart = closed.terminatorLineEnd;
    }
    lineStart = bodyStart + 1;
  }
  return spans;
}

/** A heredoc opener's delimiter word and whether `<<-` strips leading tabs. */
type HeredocDelimiter = { word: string; stripTabs: boolean };

/**
 * Where one heredoc body ends. `bodyEnd` is the start of the terminator line
 * (end-of-string when the heredoc is never closed); `terminatorLineEnd` is the
 * newline that ends that terminator line, or `null` when there is no further
 * line for a sibling heredoc on the same opener to consume.
 */
type HeredocTerminator = { bodyEnd: number; terminatorLineEnd: number | null };

function lineEndIndex(cmd: string, from: number): number {
  const newline = cmd.indexOf("\n", from);
  return newline === -1 ? cmd.length : newline;
}

function findHeredocTerminator(
  cmd: string,
  searchStart: number,
  delimiter: HeredocDelimiter
): HeredocTerminator {
  let lineStart = searchStart;
  while (lineStart <= cmd.length) {
    const lineEnd = lineEndIndex(cmd, lineStart);
    const text = cmd.slice(lineStart, lineEnd).replace(TRAILING_CR_RE, "");
    const candidate = delimiter.stripTabs
      ? text.replace(LEADING_TABS_RE, "")
      : text;
    if (candidate === delimiter.word) {
      return {
        bodyEnd: lineStart,
        terminatorLineEnd: lineEnd === cmd.length ? null : lineEnd,
      };
    }
    if (lineEnd === cmd.length) {
      break;
    }
    lineStart = lineEnd + 1;
  }
  return { bodyEnd: cmd.length, terminatorLineEnd: null };
}

/**
 * Heredoc openers on ONE line, in the order the shell will consume them.
 *
 * `inert` marks every position where a `<<` is NOT a redirection — see
 * {@link inertOpenerMask} for why each one costs real evidence when missed.
 */
function heredocDelimitersOnLine(
  cmd: string,
  lineStart: number,
  lineEnd: number,
  inert: Uint8Array
): HeredocDelimiter[] {
  const delimiters: HeredocDelimiter[] = [];
  for (let i = lineStart; i + 1 < lineEnd; i++) {
    if (!(cmd[i] === "<" && cmd[i + 1] === "<")) {
      continue;
    }
    if (inert[i]) {
      continue;
    }
    // `<<<` is a herestring — checked on BOTH sides so neither `<` of the
    // triple can anchor a spurious opener.
    if (cmd[i - 1] === "<" || cmd[i + 2] === "<") {
      continue;
    }
    const parsed = parseHeredocDelimiter(cmd, i + 2, lineEnd);
    if (parsed) {
      delimiters.push(parsed.delimiter);
      i = parsed.end - 1;
    }
  }
  return delimiters;
}

/**
 * A per-character mask of the regions where an unquoted `<<` is not a heredoc
 * opener: shell quoting, arithmetic expansion, and comments.
 *
 * Getting this wrong is asymmetric, which is why it is computed rather than
 * approximated. A `<<` wrongly read as an opener finds no terminator, and the
 * unterminated fallback then blanks the REST OF THE COMMAND — so the mistake
 * does not merely fail to neutralize a phantom, it DELETES every genuine
 * `git push` / `gh pr create` on the following lines. Each region below was
 * measured doing exactly that: `echo $((1 << 20))`, `# see a << b`, and a
 * quoted argument whose opening quote sits on an earlier line.
 *
 * Quote state is whole-command for that last reason. The residual, stated
 * because it is a deliberate trade: a quote opened INSIDE a heredoc body can
 * extend over a later opener and suppress it, leaving that body
 * un-neutralized. That direction fails toward a phantom record — the bug this
 * narrows — rather than toward destroying evidence.
 *
 * A MASK rather than a span list, and the difference is not cosmetic: the
 * membership test runs once per character, so answering it by searching a span
 * list made this scan O(n²) in the number of quoted spans. Command text reaches
 * the extractor from a transcript with no length cap, and a command carrying
 * many short quoted arguments is the ordinary shape, not a pathological one
 * (davetho, PR #7209). A mask answers the same question in constant time.
 */
function inertOpenerMask(cmd: string): Uint8Array {
  const mask = new Uint8Array(cmd.length);
  for (const span of findQuotedSpans(cmd)) {
    mask.fill(1, span.start, Math.min(span.end, cmd.length));
  }
  let i = 0;
  while (i < cmd.length) {
    if (mask[i]) {
      i += 1;
      continue;
    }
    if (cmd[i] === "$" && cmd[i + 1] === "(" && cmd[i + 2] === "(") {
      const end = arithmeticExpansionEnd(cmd, i + 3);
      mask.fill(1, i, Math.min(end, cmd.length));
      i = end;
      continue;
    }
    if (cmd[i] === "#" && (i === 0 || WHITESPACE_RE.test(cmd[i - 1]))) {
      const end = lineEndIndex(cmd, i);
      mask.fill(1, i, Math.min(end, cmd.length));
      i = end;
      continue;
    }
    i += 1;
  }
  return mask;
}

/** End of a `$((` expansion (exclusive), or end-of-string when unbalanced. */
function arithmeticExpansionEnd(cmd: string, from: number): number {
  let depth = 1;
  for (let i = from; i + 1 < cmd.length; i++) {
    if (cmd[i] === "(" && cmd[i + 1] === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (cmd[i] === ")" && cmd[i + 1] === ")") {
      depth -= 1;
      if (depth === 0) {
        return i + 2;
      }
      i += 1;
    }
  }
  return cmd.length;
}

/**
 * The delimiter word of one heredoc opener, with shell quote removal.
 *
 * A delimiter is a WORD, and a shell word may mix quoted and unquoted
 * fragments: `<<E"OF"`, `<<'E'OF` and `<<E\OF` all name the terminator `EOF`.
 * Reading only the first fragment (`E`) names a terminator that never appears,
 * and the unterminated-heredoc fallback then blanks the rest of the command —
 * so a real `git push` or `gh pr create` after the genuine `EOF` line is lost
 * (davetho, PR #7209). Quotes are therefore consumed as part of the word
 * rather than ending it.
 *
 * The numeric rejection (an arithmetic shift operand, not a delimiter) applies
 * only to a wholly UNQUOTED word: `<<"2"` is a real heredoc on a delimiter that
 * happens to read as a number, and `$((1 << 2))` never quotes its operand.
 */
function parseHeredocDelimiter(
  cmd: string,
  start: number,
  lineEnd: number
): { delimiter: HeredocDelimiter; end: number } | null {
  let i = start;
  const stripTabs = cmd[i] === "-";
  if (stripTabs) {
    i += 1;
  }
  while (i < lineEnd && (cmd[i] === " " || cmd[i] === "\t")) {
    i += 1;
  }
  const word = readHeredocDelimiterWord(cmd, i, lineEnd);
  if (!word || word.text.length === 0) {
    return null;
  }
  if (!word.quoted && NUMERIC_WORD_RE.test(word.text)) {
    return null;
  }
  return { delimiter: { word: word.text, stripTabs }, end: word.end };
}

/**
 * Characters that end a heredoc delimiter word. Quotes and backslashes are
 * absent deliberately — {@link parseHeredocDelimiter} consumes them as part of
 * the word, because a quoted fragment does not terminate a shell word.
 */
const HEREDOC_DELIMITER_STOP_RE = /[\s;&|<>()`]/;
/** A numeric "delimiter" is an arithmetic shift operand, not a heredoc word. */
const NUMERIC_WORD_RE = /^\d+$/;
const WHITESPACE_RE = /\s/;
const LEADING_TABS_RE = /^\t+/;
const TRAILING_CR_RE = /\r$/;

/**
 * Quoted spans of `cmd`, scanned with the already-resolved heredoc `bodies`
 * treated as inert. Body content is blanked to spaces first — length- and
 * index-preserving, so every span this returns still addresses `cmd` — which is
 * exactly what makes punctuation inside a body unable to open a quote that runs
 * past the terminator. See {@link findNeutralizedSpans} for why that ordering
 * is load-bearing rather than incidental.
 */
function findQuotedSpansOutsideHeredocs(
  cmd: string,
  bodies: readonly QuotedSpan[]
): QuotedSpan[] {
  if (bodies.length === 0) {
    return findQuotedSpans(cmd);
  }
  return findQuotedSpans(stripQuotedContent(cmd, [...bodies]));
}

/**
 * One shell WORD from `start`, with quote removal, plus whether any fragment of
 * it was quoted — which {@link parseHeredocDelimiter} needs to tell a real
 * `<<"2"` heredoc from an arithmetic operand. `null` when a quote opens inside
 * the word and never closes on this line, which names no usable delimiter.
 */
function readHeredocDelimiterWord(
  cmd: string,
  start: number,
  lineEnd: number
): { text: string; quoted: boolean; end: number } | null {
  let i = start;
  let text = "";
  let quoted = false;
  while (i < lineEnd) {
    const ch = cmd[i];
    if (ch === "'" || ch === '"') {
      const close = cmd.indexOf(ch, i + 1);
      if (close === -1 || close >= lineEnd) {
        return null;
      }
      text += cmd.slice(i + 1, close);
      quoted = true;
      i = close + 1;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      if (i >= lineEnd) {
        break;
      }
      text += cmd[i];
      i += 1;
      continue;
    }
    if (HEREDOC_DELIMITER_STOP_RE.test(ch)) {
      break;
    }
    text += ch;
    i += 1;
  }
  return { text, quoted, end: i };
}
