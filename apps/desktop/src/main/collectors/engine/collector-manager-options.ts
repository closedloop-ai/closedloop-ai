/**
 * @file collector-manager-options.ts
 * @description The injected-dependency contract for `CollectorManager` — every
 * sink, seam, gate, and bound the engine is constructed with. Extracted from
 * `collector-manager.ts` so that grandfathered file stays shrink-only: this is a
 * pure declaration surface (no behavior), and it is the piece that grows every
 * time a new capture sink or bound is threaded into the manager.
 */
import type { Importer } from "../../dashboard/agent-dashboard-db-types.js";
import type { captureInvocationDefinitionEvidence } from "../../packs/definition-content-collector.js";
import type { OpencodeWithheldSubagentReport } from "../opencode/opencode-withheld-subagents.js";
import type { Harness, HarnessCollector } from "../types.js";
import type { CollectionMode } from "./collection-mode.js";
import type { HistoricalParseRunner } from "./historical-parse-runner.js";
import type { HarnessWatcherOptions } from "./watcher.js";

export type CollectorManagerOptions = {
  importer: Importer;
  /** Resolve a billing mode for a harness at session creation (FEA-1434). */
  detectBillingMode: (harness: string, model?: string | null) => string;
  /** Durable dir for persisted catchup caches. */
  stateDir: string;
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
   * `onBootImportComplete`: the import did not complete, so post-boot maintenance
   * must NOT run (it would re-queue onto the wedged boundary and strand the
   * splash in Compute). The manager instead flips a degraded `timedOut` signal
   * (see `getIngestProgress`) so the splash resolves into its graceful
   * partial-import outcome while the still-running collectors keep filling the DB.
   */
  onBootImportTimeout?: () => void;
  /**
   * FEA-4156: bound for the boot-import watchdog (see `BootImportLifecycle`). If a
   * harness import wedges so its first-import promise never settles, the
   * `Promise.allSettled` would stay pending forever and the first-launch import
   * splash would hang with `complete` never flipping — and the renderer's
   * per-harness stall backstop can't help while OTHER harnesses keep advancing
   * the aggregate count. After this window the watchdog surfaces `timedOut`
   * (degraded, NOT complete). An intentional pause re-arms it rather than firing.
   * Tests pin it small; defaults to a generous production value (30 minutes).
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
   * Deletes a local session and all derived child rows. Called only when a
   * collector positively classifies an empty parse as an import artifact that
   * current semantics fold under another source.
   */
  deleteSessionRow?: (sessionId: string) => Promise<void>;
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
   * ISS-5266 (wongk review): does this OpenCode store already have a recorded
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
