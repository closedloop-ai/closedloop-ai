/**
 * The parse-quality half of the harness-parser output contract, split out of
 * `types.ts` (which carries it as `NormalizedSession.parseQuality`): every
 * parser's account of the transcript lines it could not use.
 */

/**
 * FEA-2771: Parse-quality signal for a streamed JSONL transcript. Parsers skip
 * any line that fails `JSON.parse`, which silently drops that line's messages +
 * token usage. This exposes how many lines were dropped and, critically, whether
 * the only dropped line was the FINAL one — the benign shape of a transcript
 * truncated mid-write (an in-progress session). A malformed line anywhere before
 * the end is real corruption that lost a turn with no other signal (`apiErrors`
 * stays empty). Consumers derive the mid-file corruption count as
 * `malformedLines - (truncatedFinalLine ? 1 : 0)`; any positive value is a
 * data-integrity warning.
 *
 * FEA-2905: `totalLines`/`malformedLines` aggregate the session's MAIN
 * transcript plus its subagent sidecar files (`subagents/agent-*.jsonl`), whose
 * folded token usage is merged into the parent — so a corrupt subagent line is
 * surfaced rather than dropping tokens under a clean parse. Each subagent file's
 * own benign trailing truncation is discounted the same way the main file's is
 * (see `truncatedFinalLine`), so only genuine mid-file corruption in a subagent
 * raises the parent's `malformedLines`. `truncatedFinalLine` remains a property
 * of the main transcript's final line only.
 */
export type NormalizedParseQuality = {
  /**
   * Non-empty JSONL lines the parser attempted to decode across the main
   * transcript and its subagent sidecar files.
   */
  totalLines: number;
  /**
   * Lines skipped because `JSON.parse` threw. Counts the main transcript's
   * skipped lines plus each subagent sidecar's mid-file skips (a subagent's
   * benign trailing truncation is excluded, mirroring `truncatedFinalLine`), so
   * `malformedLines - (truncatedFinalLine ? 1 : 0)` stays the count of genuinely
   * corrupt lines across the session's transcript files.
   */
  malformedLines: number;
  /**
   * True when the final non-empty line failed to parse. Expected and benign for
   * a live/truncated file; combined with `malformedLines` it separates that one
   * tolerable drop from mid-file corruption.
   */
  truncatedFinalLine: boolean;
  /**
   * FEA-3702 (Codex): count of `token_count` events whose in-band `rate_limits`
   * block WAS present but produced no structurally + semantically valid window
   * (e.g. a non-object block, or every window all-null). Each such record is
   * skipped with the last-good rate-limit snapshot PRESERVED (never zeroed), so a
   * positive value flags rate-limit data-quality loss without any turn/session
   * being dropped. Optional/additive: parsers that never observe an in-band
   * rate-limit block (Claude) omit it, and it defaults to 0 for Codex sessions
   * with no malformed blocks, so pre-existing payloads round-trip unchanged.
   */
  malformedRateLimits?: number;
  /**
   * ISS-7970: count of `pr-link` records whose `prNumber` was present as a
   * number but is not a PR identity — fractional, zero, negative, non-finite,
   * or past the persisted Int range. Each such record is dropped rather than
   * minted as a phantom `#1.5` ref at `harness_record` confidence, so a
   * positive value flags producer corruption that would otherwise be
   * indistinguishable from a session that opened no PR. Optional/additive:
   * stamped only when nonzero, so a clean transcript round-trips unchanged.
   */
  malformedPrLinkNumbers?: number;
  /**
   * FEA-3713: count of syntactically VALID JSON records the parser could not
   * route to any handler — the classifier's "unidentifiable envelope" bucket
   * (Codex `classify` → `kind:"other"`). Distinct from `malformedLines`: those
   * failed `JSON.parse`; these parsed cleanly but carry no recognizable
   * envelope/item/event type, so their content was silently dropped without
   * lowering any other parse-quality signal. Surfacing the count means a valid
   * record the parser doesn't understand can no longer be ignored invisibly, and
   * — since the count only ever grows as more unrecognized records appear —
   * appending unknown evidence can never make a session look cleaner than it is.
   *
   * Optional and emitted only when non-zero: a parser that doesn't classify
   * unknown records (the Claude core, whose unhandled entry types are by-design
   * metadata-only, not data loss) omits it, and a clean session carrying no
   * unknown records omits it too — so existing/clean payloads round-trip
   * byte-identically (no golden-snapshot churn). A future slice can extend this
   * to finer-grained unknown item/event SUBTYPES behind a known-type allowlist.
   */
  unknownRecords?: number;
  /**
   * FEA-3701: tool-output/-completion records that could not be correlated to an
   * originating call. For the Codex parser this counts MCP / function-call
   * outputs and `mcp_tool_call_end` events whose `call_id` matched no open call
   * (orphaned) — a record that, before the call-id fix, would have been
   * cross-assigned to an unrelated tool by the positional last-wins fallback.
   * Optional and omitted when zero, so a clean session round-trips unchanged and
   * only genuinely orphaned records surface the signal.
   */
  orphanedToolOutputs?: number;
  /**
   * FEA-3701: tool-output/-completion records that had NO usable identifier at
   * all and were therefore correlated by the legacy positional
   * most-recent-open-call fallback (documented compatibility path for legacy
   * identifier-free Codex data). A non-zero value means the session leaned on
   * the ambiguity-prone fallback rather than explicit call-id correlation.
   * Optional and omitted when zero.
   */
  ambiguousToolOutputs?: number;
  /**
   * ISS-6336: how many CHILD transcript files (subagent sidecar, workflow
   * journal, descendant rollout) had a benign trailing truncation of their own,
   * which the fold already discounted out of `malformedLines`.
   *
   * `totalLines` still counts those lines — it is what the parser ATTEMPTED —
   * so without this a reader cannot tell how many of them were never available
   * to be counted corrupt. Every consumer that measures corruption as a RATIO
   * needs it: the numerator is discounted per file and the denominator is not,
   * so an all-corrupt multi-file session reads as partially readable. The
   * parent's own trailing truncation stays `truncatedFinalLine`; this counts
   * only the children's.
   *
   * Optional and omitted when zero, so a single-file session and every
   * clean-child fold round-trip unchanged.
   */
  childTruncatedFinalLines?: number;
  /**
   * ISS-12036: of the genuinely corrupt lines `malformedLines` counts, how many
   * came from a folded CHILD file — a Claude subagent sidecar, or a Codex
   * `workflow-*.jsonl` journal — rather than from the session's own transcript.
   *
   * Three independent files fold into one `malformedLines` total, so
   * `session_parse_degraded` said that a session lost content and nothing said
   * WHERE. ISS-12036 could not tell a corrupting harness writer from a corrupting
   * fold, which is the first thing a fix needs to know. With this and
   * {@link foldedDescendantMalformedLines}, the session's own share is the
   * remainder, and `parseDegradedSite` names the site for telemetry.
   *
   * Counts what the fold ACTUALLY ADDED to `malformedLines` — each child's own
   * benign trailing truncation already discounted — so the three shares sum back
   * to `corruptLineCount` exactly. Optional and omitted when zero, so a
   * single-file session and every clean fold round-trip unchanged.
   */
  foldedChildMalformedLines?: number;
  /**
   * ISS-12036: of the genuinely corrupt lines `malformedLines` counts, how many
   * came from a folded DESCENDANT ROLLOUT — a Codex fork/resume child whose
   * content is merged into its root parent.
   *
   * Separate from {@link foldedChildMalformedLines} because the two are different
   * writers with different failure modes: a descendant rollout is a transcript
   * Codex wrote the same way it wrote the root, while a workflow journal is a
   * side-channel an inner agent appends to. Optional and omitted when zero.
   */
  foldedDescendantMalformedLines?: number;
};
