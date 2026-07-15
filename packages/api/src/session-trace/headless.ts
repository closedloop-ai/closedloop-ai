/**
 * FEA-2870: single source of truth for classifying a session as headless
 * (fully autonomous, launched non-interactively) vs. human-interactive, from the
 * harness calling params captured at parse time.
 *
 * A headless session's initial prompt still emits user-type events, so turn-count
 * heuristics misclassify it as human-steered. The calling params are the reliable
 * signal, so both the write-time `is_human` classification and the read-time
 * autonomy score gate on this helper.
 *
 * Verified against the Claude session schema (`entrypoint: ["cli","sdk-ts"]`,
 * `permissionMode: [... "bypassPermissions" ...]`):
 * - `entrypoint === "sdk-ts"` — launched via the SDK, inherently non-interactive.
 * - `permissionMode === "bypassPermissions"` — skip-permissions automation mode.
 *
 * Codex hardcodes `entrypoint="codex"` and emits no `permissionMode`, and no
 * exec/`--full-auto` signal is currently parsed, so Codex-exec is not yet
 * detectable — extend the sets below once that signal is surfaced.
 */
export const HEADLESS_ENTRYPOINTS = ["sdk-ts"] as const;
export const HEADLESS_PERMISSION_MODES = ["bypassPermissions"] as const;

export type HeadlessSignal = {
  entrypoint?: string | null;
  permissionMode?: string | null;
};

/** True when the calling params mark the session as headless/autonomous. */
export function isHeadlessSession(signal: HeadlessSignal): boolean {
  const entrypoint = signal.entrypoint ?? null;
  const permissionMode = signal.permissionMode ?? null;
  return (
    (entrypoint !== null &&
      (HEADLESS_ENTRYPOINTS as readonly string[]).includes(entrypoint)) ||
    (permissionMode !== null &&
      (HEADLESS_PERMISSION_MODES as readonly string[]).includes(permissionMode))
  );
}
