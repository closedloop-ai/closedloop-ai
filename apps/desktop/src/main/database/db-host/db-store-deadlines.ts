/**
 * @file db-store-deadlines.ts
 * @description PLN-1837 §1.8 — how long the dispatcher waits for the store
 * worker, BY OP CLASS.
 *
 * ## Why not one number
 *
 * The obvious move was to copy `PAYLOAD_WORKER_REQUEST_TIMEOUT_MS = 30_000`
 * from `agent-session-sync-payload-worker-runner.ts`, which is the repo's other
 * request/response worker. That would be wrong here, and the review that caught
 * it named why: the store already runs against `TRANSACTION_MAX_WAIT_MS =
 * 30_000` and `TRANSACTION_TIMEOUT_MS = 120_000` inside Prisma, and the open,
 * import, and backfill paths can all legitimately exceed 30 s. A deadline that
 * fires on valid work is worse than no deadline — it converts a slow import
 * into a killed process, which is the failure this whole milestone exists to
 * stop.
 *
 * ## These are HANG BACKSTOPS, not budgets
 *
 * Every value below sits ABOVE the worst case its class can legally reach, so tripping one always means a bug on
 * the worker side, never a busy machine. Do not tighten one to "make things
 * feel snappier" — nothing user-facing waits on these; they exist so a wedged
 * loop eventually becomes a restart instead of a permanent hang.
 *
 * ## Semantics: NO REPLY, not "no progress"
 *
 * Each deadline measures the wall time from the dispatcher posting the request
 * to the worker's correlated reply arriving. There is no heartbeat: a store op
 * is a single call whose only observable is its result, so "no progress" has
 * nothing to key on. Consequence, stated rather than buried: a genuinely
 * long-running op is indistinguishable from a wedged one, which is exactly why
 * the values are sized as ceilings on legal work.
 *
 * ## The one carve-out: queued behind a heavy op
 *
 * That wall time is honest only while the store thread could actually have
 * answered. After §1.2 the dispatcher stays responsive during a synchronous
 * libSQL call, so it can post a read that then sits UNSEEN in the port buffer
 * for as long as the call runs — the store thread has no loop turns to take it.
 * Measuring that read against its own five minutes would let it trip while an
 * import is running well inside the hour below, and `die()` takes the import
 * down with the process: a read's backstop killing a legal write is the exact
 * failure this milestone exists to stop.
 *
 * So `db-store-client` arms an op posted WHILE a heavy op is in flight against
 * {@link STORE_HEAVY_DEADLINE_MS}, and re-arms it to its own budget the moment
 * the last heavy op settles — the first instant the store could have picked it
 * up. An op posted BEFORE the heavy one is ahead of it in the buffer, so it
 * keeps its own budget.
 *
 * ## What a trip does
 *
 * ISS-8773: it fails THAT op and nothing else. The worker is kept, because a
 * timeout is not in fact the signature of a wedged loop — it is equally the
 * signature of a slow one, and the section above says so. Death now belongs to
 * {@link STORE_UNRESPONSIVE_DEADLINE_MS}, and only there does §1.3 still apply:
 * the dispatcher exits, `DbHostClient.handleExit` rejects the pending invokes
 * with a typed `DbHostExitError` and re-forks, and the FEA-3628 single-writer
 * invariant holds by construction because the replacement writer cannot exist
 * until the OS has reclaimed the terminated one.
 */

import { HEAVY_STORE_OPS } from "./db-host-op-lanes.js";
import { DB_HOST_STORE_OP_PREFIX } from "./db-host-store-op-registry.js";

/**
 * Opening the store: migrations plus the six awaited boot heals in `sqlite.ts`.
 * On a large corpus after a schema change this is the slowest thing the process
 * ever does, and it happens exactly once per fork.
 *
 * ISS-9197: alone among the deadlines here, a trip of this one is no longer
 * final. It still ends in `die()` and still takes the process — nothing about
 * this module changes — but the BOOT path now classifies the resulting failure
 * apart from a deterministic open failure and retries it on a bounded ladder
 * (`agent-dashboard-runtime-bootstrap.ts`), because a deadline is a function of
 * store size, migration count and machine load rather than of the store's
 * contents. Do not answer a report of this deadline tripping by raising this
 * number: the margin shrinks monotonically as a store grows, so that moves the
 * cliff without removing it. The coupling worth removing is the six awaited
 * heals above, which is a larger change than the retry and is not this one.
 */
export const STORE_OPEN_DEADLINE_MS = 10 * 60 * 1000;

/**
 * A generic invoke — every dotted runtime path and every non-heavy store op.
 *
 * Derived from the layer below it: Prisma's own `TRANSACTION_TIMEOUT_MS` is
 * 120 s (`prisma-client.ts`), so a transaction that is going to fail on its own
 * has already done so by then. The margin above it covers queueing behind the
 * write queue plus the two structured clones.
 */
export const STORE_INVOKE_DEADLINE_MS = 5 * 60 * 1000;

/**
 * The corpus-scale ops — the two transcript backfills plus everything in
 * {@link HEAVY_OP_REASONS}. These are measured in minutes on a real store and
 * have no upper bound derivable from the code: a user with a 20k-tool-use
 * session, a large plugin corpus, or a slow network is inside the contract. An
 * hour is a backstop against a loop that will never terminate, and nothing else.
 *
 * Do not name an op here without adding it to a heavy set — this docstring said
 * "the pack scan, the catalog fetch" for a while when the derivation covered
 * neither, so both ran on the 5-minute budget whose trip restarts the host.
 */
export const STORE_HEAVY_DEADLINE_MS = 60 * 60 * 1000;

/**
 * How long the store may go without answering ANY correlated request before the
 * dispatcher calls it wedged — the only clock left that still ends in `die()`.
 *
 * ISS-8773 split "this op is late" from "this thread is gone". A per-op deadline
 * cannot tell them apart: a synchronous libSQL call cannot be cancelled, emits
 * no progress, and so a legitimately slow op and a wedged loop look identical at
 * this boundary. Killing the process on that ambiguity took the sync pass, the
 * dashboard's count query and three unrelated IPC handlers down with one slow
 * read. So a missed deadline now fails only its own op, and death is reserved
 * for silence.
 *
 * The value is derived, not chosen. {@link STORE_HEAVY_DEADLINE_MS} is this
 * module's declared ceiling on legal work, and `db-store-client` already
 * tolerates `STORE_HEAVY_DEADLINE_MS` of queueing plus an op's own budget on top
 * for anything posted behind a heavy op. Summing the two puts this backstop at
 * exactly the wall clock the client already waits today, so it can never convict
 * a store that is merely finishing its longest legal op.
 */
export const STORE_UNRESPONSIVE_DEADLINE_MS =
  STORE_HEAVY_DEADLINE_MS + STORE_INVOKE_DEADLINE_MS;

/**
 * The inner close ack, and the one deadline here that is a real budget.
 *
 * The arithmetic is load-bearing. `CLOSE_ACK_TIMEOUT_MS = 2000` in
 * `db-host-client.ts` is main's budget for the WHOLE close, after which it kills
 * the child regardless. The dispatcher must flush profiling, await this, kill
 * the worker, and ack main inside that 2 s, so this cannot approach it. 1500 ms
 * leaves the dispatcher's own steps room and keeps the child from being killed
 * mid-ack.
 *
 * Overrunning it is not a failure mode this changes: today a store close that
 * outlives main's budget is already killed mid-drain. The deadline just makes
 * the dispatcher stop waiting first, so it can still ack.
 */
export const STORE_CLOSE_DEADLINE_MS = 1500;

/**
 * Ops that are corpus-scale or unbounded but that {@link HEAVY_STORE_OPS} does
 * not reach — keyed by the FULL op string, mapped to why.
 *
 * Two populations end up here, and neither is derivable:
 *
 * - **Dotted invoke paths.** `importer.importSession` is the one that matters —
 *   it is the whole reason ISS-8246 exists — and it reaches the store through
 *   the generic invoke path, never through `store:`.
 * - **`store:` ops that are heavy but deliberately NOT admission-heavy.**
 *   `HEAVY_STORE_OPS` is a lane-admission decision: it holds only the two
 *   transcript backfills, because those are the ones whose memory peaks must not
 *   sum. Being cheap enough to run ungated says nothing about how LONG an op
 *   runs, and these four run long for reasons the code states in `db-store-ops.ts`.
 *
 * The value is the reason rather than a bare membership marker, because the
 * cost of getting this wrong is asymmetric and invisible: too long merely delays
 * a hang backstop, while too short converts a legitimately slow op into
 * `die()` — which under PLN-1837 §1.3 exits the whole db-host and rejects every
 * other in-flight invoke. A `ReadonlySet<string>` is still the floor and not the
 * fix (a future heavy op simply would not be listed); what this buys is that
 * adding one costs a stated rationale, and that
 * `db-host-store-relay.test.ts` asserts every entry actually resolves heavy.
 */
const HEAVY_OP_REASONS: ReadonlyMap<string, string> = new Map([
  [
    "importer.importSession",
    "one session's whole import; unbounded in tool-use count",
  ],
  [
    `${DB_HOST_STORE_OP_PREFIX}packScanner.run`,
    "the whole filesystem walk plus its writes, on the store thread",
  ],
  [
    `${DB_HOST_STORE_OP_PREFIX}packScanner.collectDefinitions`,
    "the complete-or-fall-back on-host walk: slow, but it converges",
  ],
  [
    `${DB_HOST_STORE_OP_PREFIX}catalog.fetch.run`,
    "GitHub REST network I/O runs in this process; a slow network is not a hang",
  ],
  [
    `${DB_HOST_STORE_OP_PREFIX}catalog.contents.refresh`,
    "same network-I/O class as catalog.fetch.run, per catalog entry",
  ],
  [
    `${DB_HOST_STORE_OP_PREFIX}plans.backfill`,
    "extracts and upserts every plan in the plans dir, in bounded chunks",
  ],
]);

/**
 * The deadline for one `Execute`, by op name.
 *
 * The admission-heavy store ops are DERIVED from {@link HEAVY_STORE_OPS} rather
 * than restated, so an op promoted to the heavy lane automatically gets the
 * heavy deadline too and the two cannot drift. {@link HEAVY_OP_REASONS} covers
 * what that derivation cannot see.
 *
 * A `Map` and not an object literal: `op` is an IPC-supplied string, and a plain
 * `{}` lookup answers `constructor` and `__proto__` truthily.
 */
export function storeExecuteDeadlineMs(op: string): number {
  if (HEAVY_OP_REASONS.has(op)) {
    return STORE_HEAVY_DEADLINE_MS;
  }
  if (op.startsWith(DB_HOST_STORE_OP_PREFIX)) {
    const storeKey = op.slice(DB_HOST_STORE_OP_PREFIX.length);
    return HEAVY_STORE_OPS.has(storeKey)
      ? STORE_HEAVY_DEADLINE_MS
      : STORE_INVOKE_DEADLINE_MS;
  }
  return STORE_INVOKE_DEADLINE_MS;
}

/** Every op this module deliberately holds to {@link STORE_HEAVY_DEADLINE_MS}. */
export function heavyDeadlineOps(): readonly string[] {
  return [...HEAVY_OP_REASONS.keys()];
}
