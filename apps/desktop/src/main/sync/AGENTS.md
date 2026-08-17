# Desktop→Cloud Sync Lanes — the invariants

Rules for every desktop→cloud sync lane. The mechanics that a helper *can*
enforce live next door in [`durable-outbox.ts`](./durable-outbox.ts) and in
[`shared/sync-lane-contract.ts`](../../shared/sync-lane-contract.ts).

Read this before changing anything under `main/agent-sync/`,
`main/transcript-sync/`, `main/trace-comments/`, or the sync stores in
`main/database/` — and before adding a new lane.

## The lanes

There are five desktop-side sync state machines, and they are NOT the same shape.
Knowing which one you are in is the first step.

| Lane | Store | Shape | Status vocabulary |
| --- | --- | --- | --- |
| Session metadata | `agent_session_sync_outbox` | outbox (queue) | `pending` / `dead_lettered` |
| Invocation parts | `agent_component_invocation_sync_outbox` | outbox (queue) | `pending` / `dead_lettered` |
| Component inventory | persisted keyset cursor + in-memory dead-letter tracker | **cursor sweep** | none on disk — position only |
| Transcript archive | `transcript_sync_state` | per-file protocol **ledger** | `idle` / `queued` / `uploading` / `failed` / `dead` |
| Trace comments | `trace_comments.sync_status` | CRUD sync **on the entity row** | `local_pending*` / `sync_failed*` pairs per operation |

Only the first two are outboxes, and only they share
[`durable-outbox.ts`](./durable-outbox.ts).

The **component-inventory** lane
([`agent-session-sync-component-lane.ts`](../agent-sync/agent-session-sync-component-lane.ts))
is the odd one and the easiest to miss, because it has no status column to grep
for. It batch-reads `agent_components` rows strictly after its own persisted
keyset cursor, POSTs them, and advances the cursor on success — so its durable
state is a POSITION, not a per-row queue. Its dead-letter tracker
([`agent-component-sync-dead-letter.ts`](../agent-sync/agent-component-sync-dead-letter.ts))
is **in-memory and process-scoped**: it is the reason invariant 10 exists, and it
means a restart re-drives whatever it was holding rather than remembering it.

The **transcript** lane is a byte-offset append protocol whose columns
(`synced_byte_offset`, `synced_sha256`, `stored_etag`) are protocol state, not
queue state. The **trace-comment** lane is mutable-entity CRUD sync whose status
lives on the comment so offline authoring is atomic. **Do not fold their
vocabularies together** — `dead` (source file gone), `dead_lettered` (abandoned
this run), and the cloud's `skipped` (server-declared permanent) mean different
things operationally, and collapsing them destroys exactly the distinctions that
make an incident debuggable.

## The invariants

These hold for every lane. A change that breaks one is a data-loss bug, not a
style problem.

### 1. Advance only on a VERIFIED server ack — never on send

A durable cursor, watermark, or outbox row is advanced, cleared, or deleted ONLY
after the server has confirmed receipt. Never on enqueue, never on send, never
optimistically. This is what makes a kill mid-backfill resume per item instead of
either re-walking the whole corpus or silently skipping what was in flight.

`sqliteClearOutboxEntries` is the only clear on the session lane, and it runs on
verified ack alone. Preserve that property in any new path.

This includes the **in-memory pending tail**: a pre-ack `shift()` drops the
attempted part if `sendBatch` throws, and later accepted chunks then drain the
tail and dequeue the session with the cloud missing a slice. Keep the current
part in flight until its ack succeeds, or discard the whole tail and restart.

### 2. Everything is scoped by a target-scoped `sourceKey`

Queues, cursors, and outbox rows are keyed under a `sourceKey` that encodes the
compute target (which itself encodes account + machine). One account can never
inherit another's queue, cursor, or backoff state, and an account switch re-scopes
the lane wholesale rather than reusing stale position.

`readyOutboxWhere` bakes `sourceKey` in for this reason — it is not an optional
filter a caller may drop.

### 3. Dead-letter, never silently drop

An item the lane gives up on is RECORDED as dead-lettered with a reason, not
dropped. That is what lets the watermark advance past it (so the client stops
re-walking dead rows every restart) while keeping an eventual path back:

- the durable row/id set survives restart,
- a recovery pass re-drives expired dead-letters on a progressive backoff,
- a cold restart re-drives even a quarantined item once.

"Nothing is ever hard-dropped" is the property. If your change can make an item
unreachable by every one of those paths, it is wrong.

> **KNOWN EXCEPTION.** Those three re-drive bullets are the SESSION lane's
> behaviour (`sqliteReEnqueueRecoveredDeadLetter`,
> `sqliteRependDeadLetteredForFormulaRewalk`). The invocation-parts lane has no
> dead-letter recovery — its loader selects `status = pending` only and nothing
> flips a row back after `deadLetterInvocationSyncPart` — and the trace-comment
> lane has no give-up state at all, so a permanently-rejected comment retries
> forever and shows as `draining` rather than ever being reported as abandoned.
> Do not cite either as evidence invariant 3 holds, and do not read the ISS-5768
> completeness indicator ("Synced with issues") as evidence of recovery — it made
> the loss VISIBLE, not recoverable. Closing it is **ISS-5855**.

### 4. Only a row-attributable failure may exhaust the budget

A failure the lane attributes to the ITEM (validation rejection, part conflict,
oversize) may burn retry budget and eventually dead-letter. A LANE-WIDE
condition — auth loss, transport error, rate limit, 5xx, a missing compute
target, an unavailable DB — must NOT. Defer with the budget intact instead.

"Attributable to the item" means REPRODUCIBLE FROM THE PERSISTED ROW, and the
envelope the lane happened to build is not part of the row. So
`agent-session-sync-validation-failure.ts` splits an ack into `Bisect` /
`ChunkEnvelope` / `Row`, because a partition varies per attempt with the
negotiated byte cap, the encoding, the activity-chunking capability, and the
source stream sizes at prepare time (ISS-5090). All three share ONE counter (two
would let a session whose shape flips between attempts hold both below their
ceilings forever); `Row` is terminal; `ChunkEnvelope` dead-letters recoverably so
the progressive ladder re-drives it, capped by `MAX_CHUNK_ENVELOPE_DEAD_LETTERS`
because each recovery resets the per-attempt budget.

Getting this wrong dead-letters healthy rows wholesale during an outage. This is
why `decideOutboxFailure` takes an explicit `permanent` flag rather than
inferring one, why `ComponentSyncSendOutcome` splits `LaneFailure` from
`BatchRejected` (ISS-4542), and why `unauthenticated` / `target_not_owned` defer
without touching a counter (FEA-3425). A bare HTTP 400 is deliberately classified
lane-wide: it is what a version-skew `schemaVersion` mismatch returns, and
dead-lettering on it would walk the whole corpus forward on one side of a skew.

> **A client-side `transport_timeout` gets a REFUNDABLE budget (ISS-5088).** The
> local deadline fired and the server never answered, so at the moment of the
> abort the lane cannot tell lane-wide from row-attributable. Defer with the
> budget intact if connectivity loss was already observed with no verified ack
> since (a `transport_unavailable` ack, a thrown non-serialization send, or
> `isHttpReady()` going false), and refund charges taken BEFORE the lane noticed
> (`noteTransportLoss`). Only an abort on a connection the lane still believes is
> healthy counts, and it stays bounded by `MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS` so
> invariant 5's terminal path is reachable. A server-answered HTTP 408
> (`ack_timeout`) is ordinary row-attributable — never collapse the two.

> **KNOWN GAP — the invocation-parts lane shares ONE counter.**
> `decideOutboxFailure` honours this invariant at the point of decision, but the
> `attemptCount` it reads is the same column `recordRetry` bumps on every
> transient failure, so an outage can pre-spend a row's budget and the FIRST
> permanent rejection dead-letters it. Closing it needs a second counter — a
> schema change on a table holding in-flight crash-recovery state — and is
> tracked as **ISS-5855**. Read with invariant 3's exception: this lane has no
> dead-letter recovery either, so an early dead-letter strands the part.
>
> `session_missing` is EXEMPT (ISS-5789): it is budgeted by the row's AGE
> (`SESSION_MISSING_MAX_RETRY_AGE_MS` in
> `agent-sync/invocation-sync-rejection-policy.ts`), not by attempt count, so no
> number of transient failures can pre-spend it. Do not rewrite it back into a
> counter — an attempt count is the defect, and summing the ladder to derive one
> also produced an off-by-one that expired the budget early. `validation_failed`,
> `part_conflict` and `generation_conflict` keep the shared counter.

### 5. Retries are bounded, and the ladder is shared

Every retry path is bounded and backs off on the shared
[`exponentialBackoffMs`](../../shared/exponential-backoff.js) ladder (FEA-3795).
Do not hand-roll `BASE * 2 ** n` — that is precisely the drift PLN-1562 cleaned
up. Mind the indexing: the shared ladder takes a **1-indexed** attempt number, so
a lane holding a 0-indexed "attempts before this failure" count passes `n + 1`.

Unbounded retry is never acceptable: it is what left OpenCode rows cycling
`idle → queued → idle` forever (ISS-4647). Every terminal path must be reachable.

> **The bound applies to ADMISSION and to DRAIN FAIRNESS too, not only to the
> retry ladder (ISS-5973).** A row whose retries are perfectly bounded still never
> syncs if the step that queues it never runs, or if the drain never selects it.
>
> - **Bound any fast-path that SKIPS a lane's admission step.** An optimisation
>   whose guard never expires is a stall; `MAX_CONSECUTIVE_PROMOTION_DEFERRALS`
>   bounds the invocation lane's promotion deferral.
> - **Reserve part of every drain tick for never-attempted rows.** A strict-FIFO
>   `ORDER BY created_at ASC LIMIT n` starves its own tail — a cluster of
>   permanently-ready older rows holds the whole window every tick.
>   `loadReadyInvocationSyncOutboxParts` reserves a slice for `attempt_count = 0`
>   rows and hands an unspent reservation straight back to the FIFO half, so the
>   reservation is a FLOOR on fairness and never a ceiling on throughput. A
>   fairness policy that shrinks the window is the same starvation, reversed.
> - **A running lane with a live ready backlog that delivers nothing is
>   reported.** `detectNoProgressStall` covers it and routes through the same
>   monitored `sync.durable_cursor.stalled` event as `detectCursorStall`. It fires
>   only on `draining`, never on `idle_not_running`, and does NOT fire when the
>   whole remainder sits inside its own backoff window (`readyItemsRemaining ===
>   0`) — an unmeasured `null` is not that case and does not suppress. Progress is
>   read off the durable REMAINDER, deliberately not off `bytesSentSincePrevious`:
>   bytes on the wire with the remainder motionless is re-send amplification,
>   which this detector must keep reporting.

### 6. A retry write must never resurrect a dead-lettered row

Recording a retry updates the attempt count, deadline, and reason — never
`status`. `outboxRetryFields` omits the column by construction so this cannot be
forgotten (FEA-3659). Re-pending is a separate, explicit transition that must be
scoped `WHERE status = dead_lettered` so it cannot reset an in-flight `pending`
row's budget out from under it.

### 7. Revision-stamp what a semantics change must re-derive

A cursor records the `DATA_REVISION` (and, where relevant, the formula version)
it was written under. A cursor stamped with a stale revision loads as ABSENT, so
a parser-semantics bump triggers exactly ONE full re-walk — not a re-walk on
every restart, and not silent staleness. See the revision-constant guide in the
parent [`AGENTS.md`](../../../AGENTS.md).

### 8. The local store is a cache/queue; the server is authoritative

Losing a local sync store must be harmless — worst case a re-enumeration the
server idempotently dedupes. Never treat local delivery state as the source of
truth, and never block a core flow on it. Corollary: these tables carry no FK to
`sessions`; a row must be able to outlive a locally-deleted session, because that
straggler is exactly what the outbox exists to record.

### 9. Sync is never gated on renderer or UI state

Lane progress must not depend on a window being open, a panel being mounted, or
a renderer having subscribed. Capture and delivery are main-process concerns. A
diagnostics surface READS lane state; it must never be the thing that advances it.

**This covers the moment of `start()`, not only what happens after it.** A lane
that is never started cannot dead-letter, retry, or report — it just silently
stops existing, which is the worst failure mode in this file. So the lanes are
started by one direct, unconditional call in
`DesktopApplication.startSyncLanesAtBoot`
([`app.ts`](../app.ts) → `startAgentSessionSync`), invoked straight from `boot()`.
Their only prerequisite is the agent DB runtime, and it is satisfied LAZILY, not
by ordering: `getSyncSource()` may return null, a pass with a null source returns
without spending budget, and the 5s tick retries.

**Lazily satisfied is not the same as eventually satisfied, and ISS-5990 is the
difference.** Starting the lanes unconditionally bought nothing while the thing
that makes `getSyncSource()` stop returning null was itself gated on the renderer:
the agent-dashboard runtime is composed only by `startAgentCapture()`, reachable
at boot only from `schedulePostInitialWindowBootTasks`, whose body ran only inside
`desktopWindow.whenInitiallyShown()` — a promise armed solely by
`InitialWindowRevealGate.requestReveal()`, i.e. by the renderer's
`desktop:renderer-ready` IPC or an explicit user open. A boot where the renderer
never reported ready therefore ran four lanes forever against a null source. So
invariant 9 covers **every step a lane's delivery depends on**, not just `start()`:
if a lane cannot deliver without step X, step X may not be gated on renderer or
window state either. Admission now races the reveal against
`lifecycle/boot-admission-deadline.ts`, a bound the main process arms itself.

**Start a new lane only from `startSyncLanesAtBoot`**, and do not move it behind
an `await` or a `.then()`. Three dead ends are recorded so they are not
rediscovered as ideas: never from `schedulePostInitialWindowBootTasks` (its body
is deferred behind the window reveal, so a lane hosted there starts late at best);
never from `startAgentCapture` (it awaits renderer readiness gates, and the
`startSessionSync` branch that awaited the unbounded
`RendererReadinessGates.whenInitialCollectorImportComplete()` was deleted by
ISS-4717 — do not reintroduce it); and never behind the collector import ("the
first-launch import finished" is not a precondition for uploading — an unparsed
local corpus means there is less to send, never a reason to stop sending).

### 10. Bound every in-memory set

Dead-letter maps, tied-top id sets, and dedupe caches accumulate from external
input and must have an explicit cap with an eviction policy (see
`MAX_DEAD_LETTERED_IDS`, `MAX_OBSERVED_TOP_IDS`, `COMPONENT_MAX_DEAD_LETTERED_IDS`).
Eviction must degrade to "re-discovered later", never to "lost".

## Recurring failure modes across lanes

- **Re-read capability, policy, and target after every await, immediately before
  send.** A support flag or policy gate captured before hydration/worker prep is
  stale if the socket reconnects to an older server, the policy closes, or the
  account switches during those awaits — the batch still POSTs under the old
  assumption. Mirror whichever pre-send freshness guard the lane already has for
  one dimension (e.g. gzip) across the others.
- **Bound a chunk by every ceiling the receiver enforces**, not just the one the
  paginator uses. A gzipped slice can satisfy byte limits and still exceed a
  row-count limit, so the API rejects the part before persistence and
  re-preparation reproduces the same invalid part until the session dead-letters.
- **A producer's protocol-version bump lands with its parser's accepted-version
  set.** Writing `protocolVersion N` while the outbox parser still compares
  against `N-1` makes every new row parse as invalid and dead-letter, so the data
  never leaves the machine. Compare against the supported-versions constant, not
  a single current version.
- **A timeout must cancel at the queue owner, not just abandon the caller's
  promise.** Abandoning a bounded import leaves the underlying invoke at the head
  of the single write queue, so every later source parks behind a never-settling
  write and times out without progress. Cancel/restart at the DB-host/write-queue
  owner and cover it with a production-shaped serialized-queue regression.
- **Counters that report lane health must not mix outcomes.** A failure count
  that includes a metrics-only failure after the primary transaction committed
  makes `attempted - failed` report zero committed work and skips cache
  invalidation.
- **When preparing base64-encoded fragment or chunk wire payloads, split only on
  valid base64 quantum boundaries** and include every server-side consistency
  dimension, such as metadata hashes, in the fragment identity so stale partial
  sets cannot collide.
- **When retrying split or fragmented sync payloads, track failures at the part
  identity that is retried**, apply bounded dead-letter or recovery behavior for
  permanent rejections, and cover that the queue unblocks after the retry
  threshold.

## Adding a new lane

If it is outbox-shaped, it MUST use `OutboxStatus` and compose
[`durable-outbox.ts`](./durable-outbox.ts) rather than re-deriving the mechanics.
Give it its own table with its own identity arity and protocol columns — a shared
table is an explicit non-goal (see below).

If it is not outbox-shaped, say so in its module header and state which of the
invariants above it satisfies by a different mechanism.

## Non-goals (PLN-1562)

Recorded so they are argued from, not rediscovered:

- **No unified sync-state table** — identity arity differs per lane, and one hot
  table on a single-writer SQLite store serializes every lane against every other.
- **No universal sync framework** — the per-lane protocol (byte-range append,
  fragment reassembly, CRUD sync) is the hard part, and a framework general enough
  to cover all three becomes a config DSL nobody can audit for crash-correctness.
- **No merged status vocabularies.** See the table above.
- **Cloud-side machines stay separate.** `SessionTranscript.uploadStatus` and the
  `AgentComponentInvocationGeneration` lifecycle are the SERVER's view of
  client-driven protocols and are intentionally asymmetric with the desktop's.

Revisit only if 2–3 more outbox-shaped lanes appear, or if genuinely cross-lane
behavior is required (shared upload budgets, cross-lane ordering, coordinated
backpressure).
