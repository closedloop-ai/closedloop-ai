/**
 * @file collector-manager-options.ts
 * @description The injected-dependency contract for `CollectorManager` — every
 * sink, seam, gate, and bound the engine is constructed with. Extracted from
 * `collector-manager.ts` so that file shrinks rather than grows: this is a
 * pure declaration surface (no behavior), and it is the piece that grows every
 * time a new capture sink or bound is threaded into the manager.
 */
import type { ImportIngestFailure } from "@closedloop-ai/telemetry-contract/app";
import type { Importer } from "../../dashboard/agent-dashboard-db-types.js";
import type { captureInvocationDefinitionEvidence } from "../../packs/definition-content-collector.js";
import type { OpencodeWithheldSubagentReport } from "../opencode/opencode-withheld-subagents.js";
import type { Harness, HarnessCollector } from "../types.js";
import type { CollectionMode } from "./collection-mode.js";
import type { BatchResumeCursorStore } from "./collector-manager-batch-resume.js";
import type { E2eAbandonHistoricalPass } from "./e2e-boot-import-abandon-seam.js";
import type { HistoricalParseRunner } from "./historical-parse-runner.js";
import type { IngestStoreProvider } from "./ingest-store-port.js";
import type { HarnessWatcherOptions } from "./watcher.js";

export type CollectorManagerOptions = {
  importer: Importer;
  /** Durable dir for the persisted state that is still a FILE (see ingest-paths). */
  stateDir: string;
  /**
   * ISS-9838: durable ports for the SQLite-backed ingest stores (catchup cache,
   * parse quarantine, Codex linkage). Every hydrate is already resolved when
   * this arrives (ISS-9837 R1), so the store constructors stay synchronous, and
   * the port keeps the `collectors/` subtree free of any DB import (R2).
   * Omitted → the stores are memory-only, exactly as an omitted persist path was.
   */
  ingestStores?: IngestStoreProvider;
  /**
   * ISS-9839 (ISS-9837 R1c): durable backing for the ISS-5161 BATCH resume
   * cursor, which lives in SQLite rather than in {@link stateDir}. Injected
   * rather than imported because `collectors/` may not reach for
   * `agentDatabase` or `@repo/database` — the same shape as `importer` and
   * `emit` above. Omitted → the cursor is memory-only, which is the
   * pre-ISS-5161 behavior (an interrupted batch backfill replays its prefix).
   */
  batchResumeCursorStore?: BatchResumeCursorStore;
  /** Push a renderer live-update after an import batch wrote rows. */
  emit: (sessionId?: string) => void;
  /**
   * FEA-1839: the live-collection mode for a harness, resolved through the
   * single-source-of-truth `getActiveCollectionMode`. A live watcher is started
   * only for harnesses in `"watcher"` mode; `"hooks"` / `"disabled"` harnesses
   * run the idempotent boot import once with no live watcher (hooks own live
   * capture — a concurrent watcher would double-count turns).
   */
  getCollectionMode: (harness: Harness) => CollectionMode;
  /**
   * FEA-3741 (slice 1): per-tool collector enable gate. When it returns `false`
   * for a harness, that harness is skipped ENTIRELY at (re)start — no live
   * watcher AND no historical/boot import — so its tool-home walk never runs.
   * Distinct from `getCollectionMode` returning `"disabled"` (which still runs
   * the idempotent boot import, as golden mode relies on). Resolved fresh at each
   * `start()` from the persisted `DesktopSettings` per-tool toggles (default ON).
   * Omitted → every harness enabled (unchanged always-on posture); golden mode
   * omits it so its staged-corpus import is untouched.
   */
  isCollectorEnabled?: (harness: Harness) => boolean;
  /**
   * FEA-1839: invoked for each session imported via a harness's LIVE WATCHER
   * (never the boot-only branch), so the mutual-exclusivity monitor can detect a
   * watcher emitting for a session the hook handler also captured.
   */
  onWatcherEmission?: (harness: Harness, externalSessionId: string) => void;
  /**
   * ISS-6336: invoked once per collector ingest failure the IMPORTER never sees
   * — a source whose historical parse threw or timed out, and a source the
   * pending scan skipped because it is quarantined. Wired to the import-health
   * tracker, which counts by reason and ships the tally on the record it already
   * emits every tick.
   *
   * Injected rather than imported so the engine keeps no static edge to the
   * telemetry RUNTIME (mirrors `emit` / `onWatcherEmission`). The reason values
   * themselves come from `collector-ingest-failure.ts`, a pure mapping module
   * inside this directory that holds no emitter and no state — naming a failure
   * is the engine's own concern; shipping it is not.
   *
   * Best-effort: a throwing sink must never fail an import pass, and an omitted
   * one restores the pre-ISS-6336 silence exactly.
   *
   * Counts and closed enums only — the reason names a KIND of failure and never
   * the source path, session id, or any transcript content (PRD-389 §8).
   */
  onIngestFailure?: (reason: ImportIngestFailure) => void;
  /**
   * ISS-8600: a harness's fast re-attach loop gave up, so its live delivery is
   * now catch-up-poll only (30 minutes on Desktop). Reported once per
   * exhaustion, never for the routine flap that recovers, and never for a
   * harness whose roots never existed — every collector is registered and
   * enabled by default, so exhaustion alone is dominated by uninstalled tools.
   * An installed harness whose watch could not be armed at all (an `fs.watch`
   * that threw on a descriptor or inotify limit) IS reported: it has no live
   * delivery, which is the condition this names.
   *
   * Injected rather than imported for the same reason `onIngestFailure` is: the
   * engine keeps no static edge to the telemetry runtime. Best-effort and
   * non-fatal — a throwing sink must never fail an import pass, and an omitted
   * one restores the pre-ISS-8600 silence exactly.
   *
   * Counts and closed enums only: the harness names WHICH collector went dark
   * and never the watch root's path (PRD-389 §8).
   */
  onWatchLost?: (harness: Harness) => void;
  /**
   * FEA-3640: invoked for each session imported via a harness's LIVE WATCHER,
   * carrying the transcript source that changed. Lets the transcript-archive
   * lane arm its shared ~5 min activity flush for EVERY watcher-mode harness
   * (previously only the Claude hook channel could, so Codex reached the cloud
   * solely via the 30-min discovery sweep).
   *
   * Injected rather than imported so the collector engine keeps no static edge
   * to the transcript lane (mirrors `emit` / `onWatcherEmission`). Best-effort
   * and non-fatal: a throwing sink must never fail an import.
   *
   * ISS-4390: `changedPaths` carries the ORIGINAL changed path(s) behind
   * `sourcePath`, which for a Codex child rollout or a Claude subagent sidecar
   * is the folded ROOT rather than the file whose bytes moved. Optional and
   * additive — omitted for boot/backfill imports, where the receiver keeps its
   * pre-ISS-4390 `main`-only behavior.
   */
  onLiveTranscriptActivity?: (
    harness: Harness,
    externalSessionId: string,
    sourcePath: string,
    changedPaths?: readonly string[]
  ) => void;
  /** Key-free diagnostic sink. */
  log?: (message: string) => void;
  /** Injectable clock (tests pin it). */
  now?: () => string;
  /** Injectable collectors (tests pass fakes). Defaults to the five real ones. */
  collectors?: HarnessCollector[];
  /** Test hook for cooperative delays used by low-duty historical imports. */
  cooperativeDelay?: (ms: number) => Promise<void>;
  /**
   * Test hook for deterministic filesystem event delivery, forwarded to each
   * harness watcher (see `createHarnessWatcher`). Production omits it and the
   * watcher uses the real recursive `fs.watch`.
   */
  watchDirectory?: HarnessWatcherOptions["watchDirectory"];
  // Yield to the renderer once before the first-pass source scan so the import
  // banner can render (and start its off-main-thread shimmer) before the
  // synchronous scan blocks the main thread. Defaults to a no-op.
  waitForRendererBackgroundSlot?: () => Promise<void>;
  /**
   * Delay historical imports after live collection starts. `null` disables the
   * historical sweep entirely; production currently starts immediately because
   * bulk parsing runs outside Electron main and DB writes yield cooperatively.
   */
  historicalImportDelayMs?: number | null;
  /** Optional per-harness stagger added to boot historical import delays. */
  historicalImportStaggerMs?: number;
  /**
   * Missed-event sweep interval for watcher-mode harnesses. Production uses a
   * low-frequency sweep so fs.watch misses heal without repeatedly scanning
   * large transcript trees.
   */
  catchupPollMs?: number | null;
  /**
   * Parser runner for automatic historical/catch-up sweeps. Production uses an
   * Electron utility process so bulk parsing cannot monopolize the main process.
   */
  historicalParseRunner?: HistoricalParseRunner;
  /**
   * FEA-1785: Fires once after every harness's initial historical import
   * settles. Used by the data-revision rebuild to begin re-deriving stale
   * sessions.
   */
  onBootImportComplete?: () => void;
  /**
   * FEA-4156: fires when the bounded boot-import watchdog gives up because the
   * import did not settle within `bootImportWatchdogMs` (a genuinely wedged
   * harness whose first-import promise never resolves). This is DISTINCT from
   * `onBootImportComplete`: the import did not complete, so the cloud-read
   * cutover must NOT run over sources that were never imported. The manager
   * instead flips a degraded `timedOut` signal (see `getIngestProgress`) so the
   * splash resolves into its graceful partial-import outcome while the
   * still-running collectors keep filling the DB.
   *
   * ISS-8601: post-boot maintenance is no longer dropped for the launch, only
   * DEFERRED. Running it as this fires would re-queue onto the wedged boundary
   * and strand the splash in Compute, so the consumer of this hook re-arms it for
   * the next renderer idle (bounded by a ceiling), by which point the splash has
   * resolved. The re-armed run does not claim the import finished.
   */
  onBootImportTimeout?: () => void;
  /**
   * ISS-6207: fires when the boot import SETTLES but at least one harness gave
   * up with source files outstanding after its bounded automatic re-drive budget
   * was spent. A third terminal outcome distinct from BOTH siblings: the import
   * did stop (unlike a live one) and it did not finish (unlike
   * `onBootImportComplete`), so post-boot maintenance and the cloud-read
   * import-complete gate must NOT fire over sources that were never imported.
   * Wired to the same deferred-startup release as `onBootImportTimeout` so a
   * partial import cannot hold best-effort work forever, and the renderer reads
   * the degraded `retriesExhausted` ingest signal (see `getIngestProgress`) to
   * resolve the splash honestly rather than claiming Ready.
   */
  onBootImportRetriesExhausted?: () => void;
  /**
   * FEA-4156: bound for the boot-import watchdog (see `BootImportLifecycle`). If a
   * harness import wedges so its first-import promise never settles, the
   * `Promise.allSettled` would stay pending forever and the first-launch import
   * splash would hang with `complete` never flipping — and the renderer's
   * per-harness stall backstop can't help while OTHER harnesses keep advancing
   * the aggregate count. After this window the watchdog surfaces `timedOut`
   * (degraded, NOT complete). An intentional pause re-arms it rather than firing,
   * and so (ISS-8058) does an import still landing sources — this is the interval
   * between wedge checks, not a deadline the import must beat.
   * Tests pin it small; defaults to 30 minutes.
   */
  bootImportWatchdogMs?: number;
  /**
   * Self-heal hook for cache/DB divergence: returns the set of session ids
   * currently present in the database. The persistent catchup cache lives in a
   * JSON file that survives a DB reset/migration/rebuild (e.g. PGlite→SQLite),
   * so a non-batch collector whose source the cache marks "unchanged" can be
   * orphaned — the cache says "seen" but the session row is gone. Loaded ONCE
   * per import pass and consulted in `collectPendingSources`: a cache-unchanged
   * source whose derived session id is absent from this set is re-imported.
   * Undefined (or a failed load) keeps the prior skip-unchanged behavior.
   */
  listExistingSessionIds?: () => Promise<ReadonlySet<string>>;
  /**
   * Deletes a local session and all derived child rows, and reports whether it
   * did. Called only when a collector positively classifies an empty parse as an
   * import artifact that current semantics fold under another source.
   *
   * ISS-8601: this caller deliberately does NOT consult the outcome — it keeps no
   * tally and makes no claim about the row, so a refusal is simply a no-op here.
   * The rebuild's two delete paths DO consult it, because they count and log.
   */
  deleteSessionRow?: (sessionId: string) => Promise<boolean>;
  /**
   * Test seam for the FEA-3294 focused post-invocation capture. Production uses
   * the exact definition collector and this is called only for a live watcher
   * event, never boot/catch-up/DATA_REVISION work.
   */
  captureInvocationDefinitionEvidence?: typeof captureInvocationDefinitionEvidence;
  /**
   * ISS-4410: per-session bound for the historical (boot/catch-up) import write.
   * `importSession` is the one unbounded `await` on the boot-import critical path
   * — unlike the parse (an Electron utility-process worker with its own 5-minute
   * timeout), it runs straight against the DB-host write queue with no timeout of
   * its own. If a single session's write never settles — a DB-host write that is
   * accepted but never completes (a wedged `wal_checkpoint`, a lock the 15s
   * `busy_timeout` does not resolve, an in-child await that never fires) — the
   * `await` at the FIRST source never returns, the per-harness first-import
   * promise never settles, and the whole 1545-session boot import is stuck at
   * `1/1545` with nothing synced. The single serial write queue means every later
   * write is blocked behind that one pending write too, so the harness makes no
   * further progress and the boot-import watchdog only ever surfaces the degraded
   * "timed out" splash — the underlying import stays wedged forever.
   *
   * Bounding each historical `importSession` lets one wedged session fail (as a
   * `failed` import: source NOT marked seen, so it retries on the next boot) and
   * the loop advance to `2/1545…` rather than the whole corpus wedging on item 1.
   * Live-watcher imports are left unbounded — they are single-session, user-driven
   * events, not a 1545-item unattended sweep. Tests pin it small; defaults to a
   * generous production value that a legitimately large single-session write
   * completes well within (see `HISTORICAL_IMPORT_SESSION_TIMEOUT_MS`). `null`
   * disables the bound entirely (restores the prior unbounded await).
   */
  historicalImportSessionTimeoutMs?: number | null;
  /**
   * ISS-4444: per-source bound (ms) for the historical PARSE await — the sibling
   * of `historicalImportSessionTimeoutMs` for the parse step. `parseSource` is the
   * OTHER unbounded `await` on the boot-import critical path: a
   * catastrophic-regex-backtrack / CPU-spin inside a parser on a pathological
   * transcript never settles and never throws, so the loop's existing try/catch
   * dead-letter `continue` (which fires only on a THROW) is unreachable and the
   * whole sweep wedges at `1/1545`. Bounding the parse lets one poison transcript be
   * dead-lettered (source left unmarked so it retries) and the loop advance. In
   * production the parse runs in the utility-process worker turn, which is killable,
   * so the bound also aborts that turn to reclaim the pegged core. Tests pin it
   * small; defaults to a generous production value (see `HISTORICAL_PARSE_TIMEOUT_MS`).
   * `null` disables the bound entirely (restores the prior unbounded parse await).
   */
  historicalParseTimeoutMs?: number | null;
  /**
   * ISS-4444: number of dead-lettered (timed-out) parse passes a source is
   * tolerated before it is QUARANTINED — persisted so it is not re-parsed on every
   * launch (which would re-wedge the worker turn and re-peg a core each boot).
   * Defaults to the conservative `DEFAULT_PARSE_QUARANTINE_MAX_ATTEMPTS` (see
   * `parse-quarantine.ts`); this injected option is the only override. Tests pin
   * it to 1 to quarantine on the first wedge.
   */
  parseQuarantineMaxAttempts?: number;
  /**
   * ISS-8982 (TEST-ONLY): invoked with the harness key immediately after
   * `beginPass` opens a TRACKED first pass with a non-empty pending set — never
   * on a live-watcher batch, and never on a pass with nothing to import — by a
   * seam that throws a recoverable `DbHostExitError` for that harness's first N
   * invocations, so the launched-app E2E can drive `RetriesExhausted` by
   * counting passes instead of racing real db-host kills.
   *
   * Built only by `createE2eBootImportAbandonFault`, and only for an UNPACKAGED
   * build launched with the E2E env var set to a small positive integer — see
   * `e2e-boot-import-abandon-seam.ts` for the gate, for why the countdown is
   * per harness, and for what the seam deliberately leaves real. `undefined` in
   * every production run, which is the only state `scanImportPass` can observe
   * there.
   */
  e2eAbandonHistoricalPass?: E2eAbandonHistoricalPass;
  /**
   * ISS-5266: durable sink for the OpenCode WITHHELD-subagent record.
   *
   * ISS-5238 (F2) withholds a dropped root's subagent sessions rather than
   * re-emitting them at top level, which is right about the session graph but
   * leaves their spend out of every roll-up with nothing to distinguish the
   * resulting under-count from a real zero. The collector owns no DB handle, so
   * the sink is injected here (mirroring `onWatcherEmission` /
   * `onLiveTranscriptActivity`) and wired by the runtime that holds the store.
   *
   * May return a promise, in which case the collector AWAITS it before its
   * parse resolves, so the record lands before `markSourceImported` seals the
   * store fingerprint. A rejection does NOT fail the import (the sessions that
   * parsed are still kept) but it DOES make the collector refuse that seal, so
   * the source is re-read and re-recorded on the next launch instead of the
   * failure being frozen behind unchanged bytes.
   *
   * Omitted — as in tests, golden mode, and any host with no store — leaves the
   * withhold on the monitored log channel alone, exactly as before this ticket.
   */
  onOpencodeSubagentsWithheld?: (
    report: OpencodeWithheldSubagentReport
  ) => void | Promise<void>;
  /**
   * ISS-5266 (whitlockk review): does this OpenCode store already have a recorded
   * withheld-scan verdict?
   *
   * The upgrade guard. An install from a pre-ISS-5266 release has an unchanged
   * store and a matching persisted fingerprint, so the collector never re-reads
   * it and never produces a verdict — leaving the new table permanently empty
   * and its emptiness indistinguishable from "nothing withheld". A store with no
   * recorded scan therefore re-reads ONCE on the first launch after upgrade.
   *
   * Synchronous because `listSources` is; the host resolves the answer once at
   * boot (one indexed read of the scan table) and closes over the result.
   * Omitted — tests, golden mode, any host with no store — assumes "scanned" and
   * keeps the pre-ticket behaviour with no rescan.
   */
  hasRecordedOpencodeWithheldScan?: (dbPath: string) => boolean;
};
