/**
 * ISS-4767: structured recognition of a Claude Code slash-command invocation.
 *
 * When a user types `/resume`, the harness re-injects the turn as a run of
 * sibling wrapper tags rather than as prose:
 *
 * ```
 * <command-name>/resume</command-name>
 * <command-message>resume</command-message>
 * <command-args></command-args>
 * ```
 *
 * Read one tag at a time that run is three unrelated harness wrappers, which is
 * how the session-detail trace ended up folding it into three opaque chips
 * ("Command", "Command", "Command arguments") that say nothing about which
 * command ran. Read as a unit it is a single fact: *this turn invoked
 * `/resume`*.
 *
 * This module owns that reading. It is the one place that decides where an
 * invocation starts and ends and which field is which, so the parser's
 * `slashCommands` metadata and the trace renderer's command chip cannot drift
 * apart in how they INTERPRET the markup — the two consumers (the desktop DB
 * importer and the cloud session-detail renderer) both run the same harness
 * cores precisely to avoid that class of divergence.
 *
 * That is a guarantee about the recognizer, not about the two consumers'
 * outputs being element-for-element equal. Each applies it to its own text and
 * then filters differently, by design:
 *  - the renderer skips invocations inside fenced/inline code (a model quoting
 *    `<command-name>` in a code sample is documentation, not an invocation),
 *    while the parser scans the raw turn text;
 *  - the parser scans the FULL turn text, while the renderer renders the
 *    byte-truncated `NormalizedMessage.text`.
 * So a chip count and a `slashCommands` length can legitimately differ; what
 * cannot differ is where a given invocation starts, ends, and what its name,
 * message, and args are.
 *
 * Surface-agnostic and pure by construction: `packages/lib` is a leaf with
 * `"types": []`, so nothing here may reach for React, the DOM, or Node.
 */

/**
 * The wrapper tags that make up one invocation block. `command-name` is the
 * only required member — a run without it is not a slash command and is left to
 * the generic harness-tag folding.
 */
const COMMAND_TAG_RE =
  /<(command-name|command-message|command-args)>([^<]*)<\/\1>/g;

/** Only whitespace may sit between the tags of a single invocation run. */
const WHITESPACE_ONLY_RE = /^\s*$/;

/**
 * A trailing invocation field whose CLOSING tag was cut off upstream. The
 * renderer sees `NormalizedMessage.text` after `truncateText`'s 4,096-byte cap
 * (`packages/lib/parser-utils.ts`), and that cut can land inside the run's last
 * field. Anchored to end-of-text, so a well-formed pair never reaches it.
 */
const UNTERMINATED_COMMAND_TAG_RE =
  /^\s*<(command-name|command-message|command-args)>([^<]*)$/;

export const COMMAND_NAME_TAG = "command-name";
export const COMMAND_MESSAGE_TAG = "command-message";
export const COMMAND_ARGS_TAG = "command-args";

/**
 * One recognized slash-command invocation. `start`/`end` are indices into the
 * source text so a caller can splice the block out and keep the surrounding
 * prose, and `message`/`args` are `null` — not `""` — when the harness emitted
 * the tag with no content, so "absent" and "empty" stay distinguishable.
 */
export type SlashCommandInvocation = {
  name: string;
  message: string | null;
  args: string | null;
  start: number;
  end: number;
};

type CommandTagMatch = {
  tag: string;
  content: string;
  start: number;
  end: number;
};

/**
 * Normalize a `<command-name>` body to its canonical `/foo` form. The harness
 * usually re-injects the leading slash, but not always.
 *
 * ISS-4767 — extraction parity with the regex this replaced
 * (`/<command-name>([^<]+)<\/command-name>/g`): identical on EVERY input,
 * including the degenerate whitespace-only `<command-name>   </command-name>`
 * that old scan turned into a meaningless `"/"` entry. That entry is kept
 * rather than dropped, so the recognizer changes no already-persisted value and
 * DATA_REVISION needs no bump.
 *
 * Keeping it is not cosmetic. `commandCandidates`
 * (`apps/desktop/src/main/database/component-invocation-command-candidates.ts`)
 * walks `slashCommands` with `flatMap((command, index) => …)` and feeds that
 * INDEX to `commandUserTurnId`, which falls back to
 * `command:${index}:${timestamp}:${key}` for a command with no `userTurnId`.
 * That string is persisted as `externalInvocationId` and as the Components-tab
 * UserTurn `anchorValue`, so dropping an earlier entry would silently renumber
 * every later userTurnId-less command in the session. Array POSITION is part of
 * the contract even where the value is not.
 *
 * The RENDERER does not want a `"/"` chip, so it filters these out with
 * {@link isNamedSlashCommandInvocation} — a display decision at the display
 * layer, not a change to what the parser records.
 */
export function normalizeSlashCommandName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Find every slash-command invocation block in `text`, in source order.
 *
 * A block is a maximal run of adjacent `command-*` wrapper tags separated only
 * by whitespace, with each tag appearing at most once — a repeated tag starts
 * the next invocation, so back-to-back commands stay two facts rather than
 * collapsing into one. Runs carrying no non-empty `<command-name>` are dropped:
 * they are ordinary harness wrappers, not a command invocation, and callers
 * keep folding them the generic way.
 *
 * A final field whose closer was cut by upstream truncation is absorbed into
 * the run it belongs to — see {@link absorbTruncatedTrailingField}.
 */
export function findSlashCommandInvocations(
  text: string
): SlashCommandInvocation[] {
  const invocations: SlashCommandInvocation[] = [];
  let run: CommandTagMatch[] = [];
  for (const match of collectCommandTags(text)) {
    if (!continuesRun(text, run, match)) {
      pushInvocation(invocations, run);
      run = [];
    }
    run.push(match);
  }
  pushInvocation(invocations, run);
  absorbTruncatedTrailingField(invocations, run, text);
  return invocations;
}

/**
 * Extends the last invocation over a trailing `command-*` field whose closing
 * tag upstream truncation removed.
 *
 * Without this, `<command-name>/review</command-name><command-args>--fix pack`
 * (cut mid-args) recognizes only the name — and the caller's generic
 * unterminated-tag folding then renders the orphaned tail as a SECOND chip, so
 * one invocation reads as two. Absorbing it keeps the run one fact and leaves
 * nothing for that fallback to pick up, because the block now ends at the end
 * of the text.
 *
 * Deliberately narrow:
 *  - only a field that DIRECTLY follows the run (whitespace only in between)
 *    and extends to end-of-text, so nothing mid-document is swallowed;
 *  - only a field the run does not already carry — a repeat starts a new
 *    invocation, and that rule must not be lost to a truncation;
 *  - a truncated `<command-name>` is NOT absorbed by the empty run before it
 *    (`pushInvocation` requires a name), so a half-read command name never
 *    becomes a chip claiming a command the user may not have typed.
 */
function absorbTruncatedTrailingField(
  invocations: SlashCommandInvocation[],
  run: readonly CommandTagMatch[],
  text: string
): void {
  const last = invocations.at(-1);
  const runEnd = run.at(-1)?.end;
  if (!last || runEnd === undefined || last.end !== runEnd) {
    return;
  }
  const match = UNTERMINATED_COMMAND_TAG_RE.exec(text.slice(runEnd));
  if (!match || run.some((member) => member.tag === match[1])) {
    return;
  }
  const content = nonEmptyContent(match[2]);
  if (match[1] === COMMAND_MESSAGE_TAG) {
    last.message = content;
  }
  if (match[1] === COMMAND_ARGS_TAG) {
    last.args = content;
  }
  last.end = text.length;
}

function continuesRun(
  text: string,
  run: readonly CommandTagMatch[],
  match: CommandTagMatch
): boolean {
  const previous = run.at(-1);
  if (previous === undefined) {
    return false;
  }
  if (run.some((member) => member.tag === match.tag)) {
    return false;
  }
  return WHITESPACE_ONLY_RE.test(text.slice(previous.end, match.start));
}

function collectCommandTags(text: string): CommandTagMatch[] {
  const matches: CommandTagMatch[] = [];
  for (const match of text.matchAll(COMMAND_TAG_RE)) {
    const start = match.index ?? 0;
    matches.push({
      tag: match[1],
      content: match[2],
      start,
      end: start + match[0].length,
    });
  }
  return matches;
}

function pushInvocation(
  invocations: SlashCommandInvocation[],
  run: readonly CommandTagMatch[]
): void {
  const first = run.at(0);
  const last = run.at(-1);
  if (!(first && last)) {
    return;
  }
  const rawName = findTagContent(run, COMMAND_NAME_TAG);
  // Parity with the replaced `<command-name>([^<]+)</command-name>` scan: it
  // required at least one character, so a truly EMPTY tag produced no entry —
  // but a whitespace-only one did, and dropping that here would renumber the
  // persisted `slashCommands` positions (see `normalizeSlashCommandName`).
  if (rawName === null || rawName.length === 0) {
    return;
  }
  invocations.push({
    name: normalizeSlashCommandName(rawName),
    message: nonEmptyContent(findTagContent(run, COMMAND_MESSAGE_TAG)),
    args: nonEmptyContent(findTagContent(run, COMMAND_ARGS_TAG)),
    start: first.start,
    end: last.end,
  });
}

/**
 * Whether an invocation names a command a reader would recognize, i.e. its
 * `<command-name>` was not whitespace-only. The parser keeps those degenerate
 * entries for positional stability; a RENDERER should skip them rather than
 * show a chip labelled `"/"`.
 */
export function isNamedSlashCommandInvocation(
  invocation: SlashCommandInvocation
): boolean {
  return invocation.name !== "/";
}

function findTagContent(
  run: readonly CommandTagMatch[],
  tag: string
): string | null {
  return run.find((match) => match.tag === tag)?.content ?? null;
}

function nonEmptyContent(content: string | null): string | null {
  if (content === null) {
    return null;
  }
  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}
