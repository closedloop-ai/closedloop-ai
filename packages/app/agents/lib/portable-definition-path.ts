/**
 * ISS-4805 — the ONE rule for rendering a definition-file path on the
 * org-shared Agents catalog.
 *
 * A definition path is captured on whichever machine discovered the file, so it
 * routinely arrives as an absolute per-user path
 * (`/Users/<someone>/Code/proj/.claude/skills/foo/SKILL.md`). Every member of the
 * org sees this catalog, so publishing that verbatim leaks a teammate's username
 * and their machine's directory layout, and tells the reader nothing actionable
 * — the prefix does not resolve on their machine.
 *
 * Dropping the path entirely is the other failure: the location is the single
 * most useful thing the header and the evidence list can say about a definition,
 * and for the common production case (an absolute `installPath`) suppressing it
 * would blank that line for nearly every component.
 *
 * So neither: keep the portion that IS portable. An agent-config root
 * (`.claude`, `.codex`, `.agents`, `.opencode`) is the same relative anchor on
 * every machine in the org, so the tail from that segment down
 * (`.claude/skills/foo/SKILL.md`) carries the whole locator with none of the
 * machine identity. A path with no such anchor has no portable part to show and
 * yields `null` so the caller can fall back to a locator that is portable (the
 * identity key) rather than print a private prefix.
 *
 * Used by the detail-header subtitle (`agent-slug-label.ts`) and the invocation
 * evidence list (`invocation-evidence-list.tsx`) so the two cannot make
 * different claims about where the same definition lives.
 */

/**
 * The org-shared rendering of `value`, or `null` when nothing about it is
 * portable.
 *
 * - A workspace-relative path is already portable and is returned trimmed.
 * - A machine-absolute path is reduced to the tail from its first agent-config
 *   root segment.
 * - A machine-absolute path with no agent-config root returns `null`.
 */
export function portableDefinitionPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (!isMachineAbsolutePath(trimmed)) {
    return trimmed;
  }
  return agentConfigTail(trimmed);
}

/**
 * Whether `value` is rooted on the capturing machine rather than the workspace —
 * POSIX (`/Users/…`), a home shorthand (`~/…`), a Windows drive (`C:\…`), or a
 * UNC share (`\\host\…`).
 */
export function isMachineAbsolutePath(value: string): boolean {
  return MACHINE_ABSOLUTE_PATH.test(value);
}

const MACHINE_ABSOLUTE_PATH = /^(?:[/~\\]|[A-Za-z]:[/\\])/;

/** Path separator — accept both so a Windows capture reads the same as a POSIX one. */
const PATH_SEPARATOR = /[/\\]/;

/**
 * The directory names that anchor a harness's definition tree. Each is the same
 * relative root on every machine, which is exactly what makes the tail below it
 * safe to publish. Kept as a Set for an O(1) segment test.
 */
const AGENT_CONFIG_ROOTS = new Set([
  ".claude",
  ".codex",
  ".agents",
  ".opencode",
]);

/**
 * The tail of `value` from its FIRST agent-config root segment, joined with `/`
 * so a Windows capture renders identically to a POSIX one. `null` when the path
 * contains no such segment.
 *
 * First rather than last: a plugin-vendored definition nests one config root
 * inside another (`…/.claude/plugins/cache/<plugin>/.claude/skills/…`), and the
 * outer one is the segment that makes the whole locator readable.
 */
function agentConfigTail(value: string): string | null {
  const segments = value.split(PATH_SEPARATOR);
  const anchor = segments.findIndex((segment) =>
    AGENT_CONFIG_ROOTS.has(segment)
  );
  return anchor === -1 ? null : segments.slice(anchor).join("/");
}
