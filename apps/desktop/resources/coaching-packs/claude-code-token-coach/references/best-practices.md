# Token-optimization best practices: catalog, signals, and rubric

This is the methodology behind `scripts/analyze.py`. Practices are split into
two tiers, and the distinction matters:

- **Scored practices** — habits the *developer* directly controls: session
  hygiene (`/clear`, `/compact`), model choice (`/model`), and how they phrase
  asks. These produce the grade.
- **Agent behavior observations** — Claude's own in-the-moment choices (which
  tools it picks, whether it batches calls, re-reads files, spawns subagents).
  The developer can't control these per-call, so grading them would be
  misleading. They are reported unscored, and when a pattern is frequent the
  report suggests the one real lever: a steering rule in CLAUDE.md.

Weights sum to 100 across scored practices and live in `analyze.py:WEIGHTS`.
Thresholds live in `analyze.py:THRESHOLDS`; prices in `analyze.py:PRICING`.
All are meant to be tuned per team.

## Contents

Scored: 1. Cache efficiency (25) · 2. Targeted reads (18) · 3. Output size
discipline (17) · 4. Context discipline (15) · 5. Model efficiency (13) ·
6. Tool error rate (12)

Observations (unscored): 7. Native search · 8. Redundant reads · 9. Parallel
batching · 10. Subagent offloading

11. Partially / not trackable (qualitative notes)

---

# Scored practices

## 1. Cache efficiency — weight 25

**Why.** Prompt caching is the single biggest lever. A cache read costs ~10% of
a normal input token; a cache write costs ~25% more. If your stable prefix
(system prompt, CLAUDE.md, tool defs, earlier turns) stays put, most input
tokens come back as cheap cache reads. Churning the prefix — swapping MCP
servers mid-session, editing CLAUDE.md mid-task, frequent restarts — forces
re-creation at full freight.

**User lever.** Keep CLAUDE.md and the tool/MCP set stable within a session;
finish a task before reconfiguring.

**Signal.** Across all `assistant` turns, cache-read share =
`cache_read / (cache_read + cache_creation + input)`.

**Score.** `min(100, share / 0.90 * 100)` — 90%+ read share earns full marks.

## 2. Targeted reads — weight 18

**Why.** Reading a whole large file pulls every line into context (and into the
cache write). The developer steers this: "look at how `login()` validates
tokens" produces a scoped read; "read auth.py and tell me what you think"
produces a whole-file dump.

**User lever.** Phrase asks around symbols/behaviors, not whole files; say
"just the relevant part" when pointing Claude at big files.

**Signal.** `Read` results above `large_read_tokens` (default 2000, ~4
chars/token) count as large; `offset`/`limit` reads are bounded.

**Score.** `(1 − large_reads / reads) * 100`.

## 3. Output size discipline — weight 17

**Why.** Tool outputs land in context verbatim and get re-billed every later
turn. One unfiltered test run or build log can cost more than the work itself.
The developer steers this: "run the tests and show failures only" vs "run the
tests".

**User lever.** Ask for filtered output; put output-capping rules in CLAUDE.md
(e.g. "pipe long command output through tail -50").

**Signal.** `tool_result` blocks above `oversized_output_tokens` (default 5000).

**Score.** `100 − (oversized/total) * 500`, floored at 0.

## 4. Context discipline — weight 15

**Why.** Letting one session accumulate unrelated work bloats every subsequent
turn and eventually triggers auto-compaction, which is lossy and itself
token-heavy. This is the most directly user-controlled practice there is:
`/clear` between unrelated tasks resets context to near zero.

**User lever.** `/clear` between tasks; `/compact <focus note>` before being
forced into auto-compaction.

**Signal.** Peak per-session cumulative input and count of compaction `system`
events.

**Score.** Start at 100; −20 per compaction (cap −40); −30 if peak session
input exceeds `big_session_tokens` (default 1,000,000).

## 5. Model efficiency / right-sizing — weight 13

**Why.** Opus costs 5× Sonnet on input, output, and cache. Running trivial work
on Opus is pure waste. Model choice is fully user-controlled (`/model`).

**User lever.** Default to Sonnet; escalate to Opus for genuinely hard
reasoning/refactoring; Haiku for trivial edits.

**Signal.** The `model` field on each assistant turn classifies the tier.
Per-turn cost is estimated from `message.usage` × `PRICING` (cache-write at
1.25×, cache-read at 0.10×). A turn is flagged "likely didn't need Opus" if it
ran on Opus **and** had no tool calls, no extended thinking, and a short answer
(< `simple_turn_output_tokens`, default 400). Savings = Opus cost − Sonnet cost
for those turns.

**Why a heuristic, not a verdict.** No ground-truth task difficulty exists in
the transcript, so this deliberately under-flags: it only marks structurally
trivial turns and will miss "hard but short" answers. Present as "consider",
not "you were wrong".

**Score.** `100 − (flagged/opus_turns) * 100`; no Opus usage → 100. The model
mix and estimated cost are reported regardless.

**Pricing maintenance.** `PRICING` is the single place to update rates
(currently Opus 5/25, Sonnet 3/15, Haiku 1/5 per Mtok; legacy Opus 4/4.1 were
15/75). If the user is on a subscription plan, dollar figures are notional
API-equivalent cost — still a valid relative signal.

## 6. Tool error rate — weight 12

**Why.** Every failed tool call costs a full round-trip: the call, the error,
and the retry all re-send context.

**Caveat.** This one is borderline — failures are partly Claude's mistakes
(bad edit matches) and partly user-influenced (ambiguous instructions, stale
references to renamed files, interrupting mid-edit). It stays scored at a
modest weight; demote it to an observation if your team disagrees.

**Signal.** Share of `tool_result` blocks with `is_error: true`.

**Score.** `100 − rate * 500`, floored at 0.

---

# Agent behavior observations (unscored)

These measure Claude's autonomous choices. They appear in a separate report
section with no grade. When frequent (internal score < 80), the report shows
the worst offenders and the suggested CLAUDE.md steering rule — that's the
developer's only real lever here.

## 7. Native search over Bash

**Why it matters.** `cat`/`grep`/`find` via Bash return raw, unbounded output;
native Grep/Glob/Read are scoped and cache-friendlier.

**Signal.** Bash commands matching
`\b(cat|grep|find|ls|head|tail|sed|awk|rg)\b` as a share of Bash calls.

**Suggested CLAUDE.md line.** "Prefer the Grep/Glob/Read tools over shell
`cat`/`grep`/`find`/`ls` for searching and reading files."

## 8. Redundant reads

**Why it matters.** Re-reading a file already in context re-sends it for no new
information.

**Signal.** A second `Read` of the same path with no intervening
`Edit`/`Write`/`NotebookEdit` to that path.

**Suggested CLAUDE.md line.** "Do not re-read files already in context unless
they have changed on disk."

## 9. Parallel batching

**Why it matters.** Independent tool calls issued in one turn share a single
round-trip; serializing them re-bills the context once per call.

**Signal.** Share of tool-bearing assistant messages with 2+ `tool_use` blocks.

**Suggested CLAUDE.md line.** "When tool calls are independent, issue them
together in a single message."

## 10. Subagent offloading

**Why it matters.** A subagent's noisy exploration stays in its own context;
only the conclusion returns.

**Signal.** Count of `Task` tool calls.

**Suggested CLAUDE.md line.** "For broad codebase exploration or multi-file
searches, delegate to a subagent and return only conclusions."

---

## 11. Partially / not trackable (qualitative notes only)

State these to the user as caveats; do not fabricate scores.

- **Prompt conciseness / turns-per-task.** No ground-truth task boundaries in
  the transcript, so verbosity can't be scored fairly.
- **CLAUDE.md bloat.** Lean CLAUDE.md (<~200 lines) matters but the file isn't
  reliably present in transcripts — suggest the user check its size directly.
- **MCP tool-definition overhead.** Many loaded MCP tools inflate the cached
  prefix, but schemas aren't always logged. Note as a thing to review.
- **Whether a specific Opus turn truly needed Opus.** The model-efficiency
  score is a structural heuristic, not a verdict.

---

## Tuning guide

- Weights: `analyze.py:WEIGHTS` (scored set; keep the sum at 100). Moving a
  practice between scored and observed = move its key between `WEIGHTS` and
  `OBSERVATIONS`.
- Thresholds: `analyze.py:THRESHOLDS`. Raising `large_read_tokens` makes
  targeted-reads more lenient; the `* N` multipliers set how fast a score
  drops to F.
- Prices: `analyze.py:PRICING`.

---

# Budget-request context (Claude Code Token Coach)

When this analysis backs a budget/cap-increase request, two rules keep it fair
and defensible:

1. **Only scored practices gate the decision.** The unscored observations above
   measure Claude's own choices, not the developer's habits — they inform
   coaching but must not count against a budget request.
2. **The transcript cost is an estimate.** `analyze.py` computes notional
   API-equivalent cost from token usage × `PRICING`. For the actual cap decision,
   use authoritative spend from billing or the analytics dashboard
   (`claude.ai/analytics/claude-code` or `platform.claude.com/claude-code`) and
   pass it to `build_packet.py --actual-spend`. The estimate remains a valid
   *relative* efficiency signal.

The packet's recommendation (`build_packet.py:recommend`) maps the overall grade
to Approve (A/B), Approve-with-conditions (C, or a large ask), or Coach-first
(D/F), and is meant to be tuned to your org's risk tolerance.
