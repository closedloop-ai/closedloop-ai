/**
 * FEA-2870 / FEA-3616: single source of truth for classifying a session as
 * headless (fully autonomous, launched non-interactively) vs. human-interactive,
 * from the harness calling params captured at parse time.
 *
 * A headless session's initial prompt still emits user-type events, and an
 * automated driver (a scheduled `/loop`, an SDK/exec worker, an agent-to-agent
 * reviewer) keeps injecting more `user`-role prompts as the run proceeds. Those
 * agent-authored prompts are NOT human steering, so turn-count heuristics that
 * key off the `user` role misclassify the whole run as human-steered and inflate
 * `humanTurns`. The calling params are the reliable signal, so the write-time
 * `is_human` classification, the per-turn heatmap buckets, and the read-time
 * autonomy score all gate on this one helper.
 *
 * Entrypoint families observed across the corpus (Claude + Codex), verified
 * against the signed per-dossier golden oracles:
 * - interactive (a human at a keyboard): `cli`, `codex-tui`, `codex_cli_rs`,
 *   `codex_vscode`, and — CRITICALLY — `codex_sdk_ts` (the Codex VS Code /
 *   Conductor IDE transport: it carries `sdk` in its name but is a person typing
 *   in the IDE; golden dossiers `019effc3` / `019f0041` sign its prompts as
 *   GENUINE human turns).
 * - autonomous (non-interactive, scripted/injected prompts): Claude's SDK
 *   launchers `sdk-ts` / `sdk-cli` (prefix `sdk-`), and Codex's exec family
 *   `codex_exec` / `claude-codex-exec` / `codex-exec` (token `exec`).
 *
 * FEA-3616 fix: the write-side rollup previously matched `entrypoint` with an
 * EXACT allow-list (`IN ('sdk-ts')`), so `sdk-cli` and the whole `exec` family
 * (`codex_exec`, `claude-codex-exec`, …) slipped through as human-interactive and
 * their scripted / agent-to-agent prompts inflated `humanTurns` (and the run
 * scored as human). It now shares THIS predicate — the same
 * `sdk-`-prefix-OR-`exec`-token rule the per-turn read path already used — so the
 * rollup, the buckets, and this helper agree and the full autonomous family is
 * covered WITHOUT sweeping in the interactive `codex_sdk_ts` IDE transport.
 * `permissionMode === "bypassPermissions"` stays an exact-match automation
 * signal.
 *
 * `HEADLESS_ENTRYPOINT_PREFIXES` / `HEADLESS_ENTRYPOINT_TOKENS` are the SSOT the
 * write-side SQL predicate (`headlessMetadataSql`) is built from, so the SQL, the
 * buckets, and this JS helper can never drift.
 */
export const HEADLESS_ENTRYPOINT_PREFIXES = ["sdk-"] as const;
export const HEADLESS_ENTRYPOINT_TOKENS = ["exec"] as const;
export const HEADLESS_PERMISSION_MODES = ["bypassPermissions"] as const;

export type HeadlessSignal = {
  entrypoint?: string | null;
  permissionMode?: string | null;
};

/**
 * True when the `entrypoint` string marks an SDK/exec-launched (non-interactive)
 * run: it starts with a headless SDK prefix (`sdk-…`) OR contains an autonomous
 * token (`exec`). Case-insensitive. Mirrors the SQL predicate in
 * `headlessMetadataSql`. Deliberately excludes the interactive `codex_sdk_ts` IDE
 * transport (contains `sdk` but is NOT `sdk-`-prefixed).
 */
export function isHeadlessEntrypoint(
  entrypoint: string | null | undefined
): boolean {
  if (entrypoint === null || entrypoint === undefined) {
    return false;
  }
  const normalized = entrypoint.toLowerCase();
  return (
    HEADLESS_ENTRYPOINT_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix)
    ) || HEADLESS_ENTRYPOINT_TOKENS.some((token) => normalized.includes(token))
  );
}

/** True when the calling params mark the session as headless/autonomous. */
export function isHeadlessSession(signal: HeadlessSignal): boolean {
  const permissionMode = signal.permissionMode ?? null;
  return (
    isHeadlessEntrypoint(signal.entrypoint ?? null) ||
    (permissionMode !== null &&
      (HEADLESS_PERMISSION_MODES as readonly string[]).includes(permissionMode))
  );
}
