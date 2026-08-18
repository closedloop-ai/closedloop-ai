/**
 * @file parse-claude-model-switch-label.ts
 * @description FEA-4376: extract the human-readable model NAME echoed by a
 * `/model` slash-command switch, split out of the grandfathered
 * `parse-claude.ts` (PR #3903 review) so that over-ceiling file shrinks rather
 * than grows. Pure string helper — no transcript state, no I/O.
 */

/**
 * FEA-4376: the `/model` slash command echoes the switched-to model as
 * `<local-command-stdout>Set model to <label></local-command-stdout>`. The
 * `<label>` is the human-readable model NAME the user picked (e.g.
 * `Opus 4.8 (1M context)`), sometimes wrapped in ANSI bold (`ESC[1m … ESC[22m`,
 * which may arrive with the ESC byte already stripped to a bare `[1m … [22m`)
 * and suffixed ` (default)`. Captured group 1 is the raw label; ANSI wrappers
 * and the trailing default marker are stripped by `extractModelSwitchLabel`.
 * Non-greedy so the closing tag (or a trailing newline) bounds the label.
 */
const SET_MODEL_STDOUT_RE =
  /Set model to\s+(.+?)\s*(?:<\/local-command-stdout>|[\r\n]|$)/;
// The ANSI ESC (``, char code 27) is a control character, so it cannot be
// written as a literal inside a regex literal (Biome `noControlCharactersInRegex`).
// Build the patterns from strings via `RegExp` instead.
const ESC = String.fromCharCode(27);
// An ESC-prefixed bold marker is unambiguously ANSI (a model id never contains a
// raw ESC), so it is always stripped: `ESC[1m` / `ESC[22m`.
const ANSI_ESC_BOLD_MARKER_RE = new RegExp(`${ESC}\\[(?:1|22)m`, "g");
// A bare (ESC-less) `[1m`/`[22m` is ambiguous: `[1m` is also the semantic
// 1M-context alias suffix that is part of a real model id (e.g.
// `claude-sonnet-4-6[1m]`, `claude-opus-4-8[1m]`). Only strip the bare markers
// when they form an actual PAIRED wrapper (`[1m … [22m`) — the closing `[22m`
// proves it was a bold wrapper, not the alias suffix (which never carries a
// paired `[22m`). PR #3903 review (wongk): a lone `[1m` must survive verbatim.
const BARE_BOLD_PAIR_RE = /\[1m([\s\S]*?)\[22m/g;
const MODEL_DEFAULT_SUFFIX_RE = /\s*\(default\)\s*$/;
// PR #3903 review (wongk): the label is unbounded transcript text, but the
// historical-parse-worker `.strict()` schema caps `model` at 8,192 chars — a
// longer label would make `safeParse` reject the ENTIRE source payload (the
// FEA-3701 class of silent whole-source drop). A model NAME is never this long,
// so a label exceeding the cap is garbage: reject it (return null) rather than
// assign a poisoned `modelSwitchLabel`.
const MAX_MODEL_LABEL_LENGTH = 8192;

/**
 * FEA-4376: pull the human-readable model NAME out of a `/model` command's
 * `Set model to <label>` stdout echo. Returns the cleaned label (ANSI-bold
 * wrappers removed, trailing ` (default)` dropped, trimmed) or `null` when the
 * stdout is not a model-switch echo, the label is empty, or the cleaned label
 * exceeds the worker-boundary length cap (`MAX_MODEL_LABEL_LENGTH`). The
 * returned value is a DISPLAY NAME, NOT a wire model id — it must never be used
 * to synthesize a priceable `tokensByModel`/cost key (see the caller for the
 * last-wins-fallback discipline).
 */
export function extractModelSwitchLabel(stdout: string): string | null {
  const match = SET_MODEL_STDOUT_RE.exec(stdout);
  if (!match) {
    return null;
  }
  const label = match[1]
    .replace(ANSI_ESC_BOLD_MARKER_RE, "")
    // Unwrap only paired bare markers, keeping the wrapped content; a lone `[1m`
    // (the 1M-context alias) is left intact.
    .replace(BARE_BOLD_PAIR_RE, "$1")
    .replace(MODEL_DEFAULT_SUFFIX_RE, "")
    .trim();
  if (label.length === 0 || label.length > MAX_MODEL_LABEL_LENGTH) {
    return null;
  }
  return label;
}
