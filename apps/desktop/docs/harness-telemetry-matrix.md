# Multi-Harness Session Telemetry Matrix

> **Source:** PRD-431 ("Codex+Claude Session-Hook Telemetry Merge"), Documentation
> Requirement. This is the canonical reference for **where each session data
> point originates** — log parsing vs. event hooks — and which harnesses are
> supported at each level.
>
> This is **session telemetry** (the harness session pipeline that fills the
> sessions table and its screens). It is distinct from the product-analytics /
> Datadog events documented in [`event-taxonomy.md`](./event-taxonomy.md).

## The two ingestion paths

Every harness session in the desktop SQLite database is populated by one or both
of these paths, which converge on the same tables (`sessions`, `agents`,
`events`, `token_usage`):

| Path | Trigger | Code | Nature |
|------|---------|------|--------|
| **Log parsing** | A watcher tails the harness's on-disk session/rollout files | `collectors/<harness>/<harness>-parser.ts` → `importSession()` (`database/sqlite.ts`) | **Retroactive** — works after the fact, backfills history, runs without harness cooperation |
| **Event hooks** | The harness fires lifecycle hooks that POST to the in-process listener (`127.0.0.1:4820`, `/api/hooks/event`) | `agent-monitor-listener.ts` → `processEvent()` → `handleHook()` (`database/sqlite.ts`) | **Real-time** — live status, captures intent the logs may not (e.g. waiting-for-input). **Claude Code only.** |

> **Decision (supersedes the original PRD-431 plan): Codex uses log parsing only.**
> PRD-431 originally proposed merging a Codex *event-hook* path alongside the
> existing rollout-log path. The team decided **not** to adopt Codex hooks and to
> continue parsing Codex session logs. The Codex hook scaffolding (handler,
> listener route, installer, `codexOptIn` flag) and the planned cross-path dedup
> were therefore removed — Codex is single-path, so there is nothing to
> de-duplicate. **Event hooks are now a Claude-Code-only mechanism.**

## Harness support matrix

| Harness | Log parsing | Event hooks | Tier |
|---------|:-----------:|:-----------:|------|
| **Claude Code** | ✅ `claude-parser` | ✅ installed by default (`enabled` flag) | **GA** — full dual capture |
| **Codex** | ✅ `codex-parser` | ❌ not used (by decision) | **Beta** — logs only |
| **Cursor** | ✅ `cursor-parser` | ❌ | Labs (flagged) |
| **Copilot** | ✅ `copilot-parser` | ❌ | Labs (flagged) |
| **OpenCode** | ✅ `opencode-parser` | ❌ | Labs (flagged) |

Claude Code is the only harness that emits hooks; every other harness — Codex
included — is captured entirely through log parsing.

> **Two different harness enums.** Session-telemetry collectors use the `Harness`
> union (`collectors/types.ts`: claude · codex · cursor · copilot · opencode).
> Loop *observability adapters* use the separate `LoopHarness` enum
> (`packages/loops-api`: claude · codex · cursor · opencode — **Copilot is not a
> member**). Copilot therefore has session-log capture but no loop-observability
> adapter entry.

## Metric coverage matrix

Which path each metric originates from, per harness. ✅ = captured · ❌ = not
captured by that path · — = N/A.

### Captured via **log parsing** (all collectors, retroactive)

| Metric | Claude | Codex | Cursor | Copilot | OpenCode |
|--------|:------:|:-----:|:------:|:-------:|:--------:|
| Session record (start/end, cwd, status) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Model attribution | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool calls | ✅ | ✅ | ✅ | ✅ | ✅ |
| Token usage / cost (`token_usage`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Turn durations | ✅ | ✅ | ✅ | ✅ | ✅ |
| API / tool errors | ✅ | ✅ | ✅ | ✅ | ✅ |
| Skills (`skillName` on tool use) | ✅ | ❌ | ❌ | ❌ | ❌ |
| MCP server / method attribution | ❌ | ✅ | ❌ | ❌ | ❌ |
| Subagents (Agent/Task spawns) | ✅ | — | — | — | — |

### Captured via **event hooks** (real-time, Claude Code only)

| Metric | Claude |
|--------|:------:|
| Session lifecycle (`SessionStart` / `SessionEnd`) | ✅ |
| Live status (`UserPromptSubmit`, waiting-for-input, compaction) | ✅ |
| Tool calls (`PreToolUse` / `PostToolUse`) | ✅ |
| Subagent completion (`SubagentStop`) | ✅ |
| Token usage / cost | ✅ (transcript extract) |
| Skills | ✅ (Skill tool call) |

> No other harness emits hooks. Codex, Cursor, Copilot, and OpenCode are captured
> entirely through log parsing, so for those harnesses every row comes from the
> log path and there is only ever one source per event — no cross-path
> de-duplication is involved.

## Known gaps / follow-ups

- **Plugins are not captured by any path** (neither log parsing nor hooks) for
  any harness today. PRD-431 listed plugin capture as a target; it is unbuilt.
- **Codex completeness rests entirely on the rollout-log parser.** Since there is
  no hook path for Codex, any metric the rollout format does not expose (e.g.
  skills) is simply unavailable for Codex — extend `codex-parser.ts` to add
  coverage rather than expecting hooks to fill the gap.

## Maintenance

Update this matrix when:

- a new harness collector is added (`defaultCollectors` in
  `collectors/collector-manager.ts`);
- hook support changes (`agent-monitor-hooks*.ts`) — currently Claude-only;
- a parser starts/stops capturing a metric (the per-collector `*-parser.ts`).
