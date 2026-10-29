/**
 * @file transcript.ts
 * @description The SSOT predicate for "this session has a parsed transcript",
 * beside `./headless` — the other metadata-derived signal the trace derivation
 * branches on.
 *
 * Moved out of `apps/desktop/src/main/database/session-trace.ts` (ISS-5636) so
 * the desktop's session-detail projection can ask the SAME question the
 * derivation asked. That projection has to know which of a session's folded
 * scalars came from this UNCAPPED message stream and which came from the
 * cap-bounded raw event read; re-declaring the test beside it would let the two
 * drift into disagreeing about the same session.
 */

/**
 * FEA-3671: SSOT predicate for "this session has a parsed transcript". The
 * parser writes the visible turn stream to `metadata.$.messages`, from which it
 * has ALREADY excluded synthetic `user`-role entries — `isMeta` slash-command
 * expansions (e.g. `/login`), compaction summaries, and non-human origins
 * (`isSyntheticUserEntry` in packages/lib/harness/claude/parse-claude.ts). So a
 * `role:"human"` message in `$.messages` is the authoritative human-turn signal.
 *
 * This mirrors, in intent, the human-turn rollup's own precedence (session-analytics-rollup.ts
 * `COALESCE(transcript_human_turns, ht.human_turns, 0)`): when a transcript
 * exists, `role:"human"` message rows are authoritative and the hook-captured
 * `event_type LIKE '%user%'|'%prompt%'` events are IGNORED for the human-turn
 * count; only a transcript-less (hook-only live) session falls back to those
 * events. The `json_type($.messages) = 'array'` test in that SQL is exactly
 * `Array.isArray(metadata?.messages)` here.
 *
 * The timeline prompt markers MUST honor the same precedence so they can't
 * disagree with humanTurns: a meta-only `/login` session parses to a transcript
 * with zero `role:"human"` messages (humanTurns=0) yet still carries
 * `UserPromptSubmit` hook events — those must NOT emit human `prompt` markers, or
 * the timeline contradicts the count (the bug Ottilie reported).
 */
export function sessionHasParsedTranscript(
  metadata: { readonly messages?: unknown } | null | undefined
): boolean {
  return Array.isArray(metadata?.messages);
}
