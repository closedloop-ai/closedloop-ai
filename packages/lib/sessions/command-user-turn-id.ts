type CommandTurnIdentityInput = {
  name: string;
  timestamp: string;
  userTurnId?: string | null;
  normalizedName?: string | null;
};

/** Stable user-turn identity shared by invocation materialization and traces. */
export function commandUserTurnId(
  command: CommandTurnIdentityInput,
  index: number
): string {
  return (
    command.userTurnId ??
    `command:${index}:${command.timestamp}:${normalizeCommandComponentKey(
      command.normalizedName ?? command.name
    )}`
  );
}

/**
 * The ONE slash-command component-key normalizer (ISS-4795).
 *
 * Every producer of a `command` `component_key` must route through this, or the
 * same command mints two identities and org-dedup splits it into two components
 * with two usage populations. That is exactly what happened: the definition-file
 * collector unconditionally prepended `/` to a `baseName` that a slash-command's
 * frontmatter `name` ALREADY starts with (`/` + `/build` = `//build`), while the
 * event/invocation path only prepended when missing — so `/clear` (133
 * invocations) and `//clear` (111) rendered as two unrelated rows.
 *
 * The fix is to make the leading slash a property of the KEY FORMAT rather than
 * of the caller's input: collapse whatever leading run of slashes arrives to
 * exactly one. `clear`, `/clear`, and `//clear` all normalize to `/clear`, so
 * the two producers can no longer disagree.
 */
export function normalizeCommandComponentKey(value: string): string {
  return `/${value.trim().replace(LEADING_SLASH_RUN, "")}`;
}

/**
 * Whether a normalized command key names a real command (ISS-4796).
 *
 * `normalizeCommandComponentKey` guarantees the key's SHAPE, not that it names
 * anything. A transcript can carry a truncated command-palette display string
 * (`/...`, `/…`) as if it were a slash-command name; unvalidated, those mint
 * real inventory components that sort to the top of the Commands tab (leading
 * punctuation), inflate its count, and resolve to a detail page reading "No
 * definition captured".
 *
 * A record is valid-or-absent at the ingest boundary, so admission is decided
 * here rather than filtered at render: a real command name carries at least one
 * letter or digit. That rejects the bare `/`, any pure-punctuation or ellipsis
 * placeholder, and the empty-after-slash case, without enumerating placeholder
 * spellings — `/…` and `/...` are only two of the forms a truncation can take.
 */
export function isAdmissibleCommandComponentKey(key: string): boolean {
  return COMMAND_KEY_WORD_CHAR.test(key);
}

/** Leading run of `/` characters, stripped so the key format re-adds exactly one. */
const LEADING_SLASH_RUN = /^\/+/;

/** A letter or digit in any script — the minimum for a key to name a command. */
const COMMAND_KEY_WORD_CHAR = /[\p{L}\p{N}]/u;
