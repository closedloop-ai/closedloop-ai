/**
 * @file hook-identity.ts
 * @description SSOT for a Claude configured-Hook's durable, machine-independent
 * component identity (FEA-4093).
 *
 * The transcript `attachment` record for a hook firing carries only `hookName`
 * (e.g. `"PreToolUse:Bash"`, `"SessionStart:startup"`) and the shell `command`
 * that ran. `hookName` alone is NOT the configured-hook identity: in the frozen
 * corpus a single `hookName` maps to several distinct handlers — `PreToolUse:Bash`
 * runs three different commands (`rtk hook claude`,
 * `${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use-hook.sh`,
 * `${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse-hook.sh`) and `SessionStart:startup`
 * runs four. Keying the `Hook` component on `hookName` alone collapses those
 * separate handlers into one synthetic label row and leaves the real configured
 * hooks aggregating to zero.
 *
 * But the raw `command` cannot go into the durable identity either: it embeds
 * machine-specific absolute home paths (`python3 /home/testuser6/.claude/…`,
 * `~/.claude/hooks/cbm-session-reminder`). Keying on the raw command would leak
 * host paths into the component key and fragment the same logical hook across
 * machines and users.
 *
 * `normalizeHookCommand` therefore canonicalizes the command to a stable,
 * host-independent form before it enters the identity: user-home prefixes
 * (`/home/<user>/`, `/Users/<user>/`, `~/`, `$HOME/`) collapse to a `~`
 * sentinel, `${CLAUDE_PLUGIN_ROOT}` / `$CLAUDE_PLUGIN_ROOT` stays as its portable
 * token, surrounding quotes/whitespace are trimmed, and interior whitespace runs
 * are collapsed. `hookComponentKey` composes `hookName` with that normalized
 * command so distinct handlers stay distinct while the same handler on two
 * machines resolves to one identity.
 *
 * Browser-safe: pure string transforms, no Node built-ins (this package is
 * bundled into the desktop main process AND the cloud/renderer surfaces).
 */

// The literal `${CLAUDE_PLUGIN_ROOT}` shell placeholder. Built from a
// `$`-char (code 36) prefix so the source has no `${…}` sequence Biome would
// flag as a mistaken template string (`noTemplateCurlyInString`).
const CLAUDE_PLUGIN_ROOT_TOKEN = `${String.fromCharCode(36)}{CLAUDE_PLUGIN_ROOT}`;
const HOME_SENTINEL = "~";
const HOOK_KEY_SEPARATOR = " ";

// Machine-specific user-home path prefixes that must collapse to the portable
// `~` sentinel so the same handler on two machines shares one identity.
// `/home/<user>/` (Linux), `/Users/<user>/` (macOS), and an already-`~`/`$HOME`
// prefix all map to `~/`. Anchored to a whitespace/quote/start boundary so an
// unrelated interior substring is never rewritten.
const USER_HOME_PREFIX_REGEX =
  /(^|[\s"'=(])(?:\/home\/[^/\s"']+|\/Users\/[^/\s"']+|\$HOME|~)(?=\/)/g;

// `$CLAUDE_PLUGIN_ROOT` (bare) and `${CLAUDE_PLUGIN_ROOT}` (braced) both
// canonicalize to the braced token so quoting differences do not fork identity.
const BARE_PLUGIN_ROOT_REGEX = /\$CLAUDE_PLUGIN_ROOT\b/g;
const INTERIOR_WHITESPACE_REGEX = /\s+/g;

/**
 * Canonicalize a hook's shell `command` into a stable, host-independent form
 * safe to embed in a durable component identity. Returns `null` when there is no
 * usable command (identity then falls back to `hookName` alone).
 */
export function normalizeHookCommand(command: string | null): string | null {
  if (command === null) {
    return null;
  }
  let value = command.trim();
  if (value.length === 0) {
    return null;
  }
  value = value.replace(BARE_PLUGIN_ROOT_REGEX, CLAUDE_PLUGIN_ROOT_TOKEN);
  value = value.replace(
    USER_HOME_PREFIX_REGEX,
    (_match, boundary: string) => `${boundary}${HOME_SENTINEL}`
  );
  value = value.replace(INTERIOR_WHITESPACE_REGEX, HOOK_KEY_SEPARATOR).trim();
  return value.length === 0 ? null : value;
}

/**
 * Durable `Hook` component identity: `hookName`, plus the normalized command as
 * a per-handler discriminator when one is present. Keeps distinct handlers on
 * the same matcher separate without leaking machine-specific paths.
 */
export function hookComponentKey(
  hookName: string,
  command: string | null
): string {
  const name = hookName.trim();
  const normalizedCommand = normalizeHookCommand(command);
  return normalizedCommand === null
    ? name
    : `${name}${HOOK_KEY_SEPARATOR}${normalizedCommand}`;
}
