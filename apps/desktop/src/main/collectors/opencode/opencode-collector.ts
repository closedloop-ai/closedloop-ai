/**
 * @file opencode-collector.ts
 * @description The OpenCode HarnessCollector (FEA-1503). OpenCode is a BATCH
 * harness: its canonical store is a single foreign SQLite DB (`opencode.db`),
 * read in one load. To avoid re-loading the whole DB on every catchup tick, the
 * collector self-fingerprints the DB + WAL/SHM siblings (name:mtimeMs:size) and
 * skips the load when the fingerprint is unchanged.
 *
 * ISS-8561: a live install has exactly one such store, but golden mode hands the
 * collector one per staged opencode dossier. Everything below is therefore
 * PER STORE — the fingerprint, the seal gate, the continuation — and the source
 * a hook is given is what selects the state it reads.
 *
 * Fingerprint logic ported from `scripts/agent-monitor-opencode/opencode-import.js`
 * (FEA-1316 / FEA-1334), logic preserved: the in-memory high-water-mark is
 * seeded from a persisted file so a fresh process also skips the cold-start load
 * when the DB is untouched. Only the fingerprint/idempotency concern is ported —
 * the dbModule write path stays in the shared `importSession` write-sink.
 */
import fs from "node:fs";
import path from "node:path";
import type { HistoricalParseWorkerResumePoint } from "../engine/historical-parse-worker-protocol.js";
import {
  type BatchHarnessCollector,
  CollectorParseScope,
  type CollectorParseSideReport,
  type NormalizedSession,
} from "../types.js";
import {
  getOpenCodeDbPath,
  getOpenCodeDbWatchFiles,
  getOpenCodeHome,
} from "./opencode-home.js";
import type { OpencodeSessionLoad } from "./opencode-parse-failure.js";
import {
  loadOpencodeSessionsFromDb,
  type OpencodeParentLinkRead,
  OpencodeParentLinkReadStatus,
  readSessionParentLinks,
} from "./opencode-parser.js";
import { foldOpencodeSubagents } from "./opencode-subagent-fold.js";
import type {
  OpencodeWithheldSubagentReport,
  OpencodeWithheldSubagentRoot,
} from "./opencode-withheld-subagents.js";

export function createOpencodeCollector(opts?: {
  fingerprintPath?: string;
  /**
   * FEA-2648: override for the OpenCode data directory (the folder holding
   * `opencode.db` + its WAL/SHM siblings). Golden mode points it at a staged
   * dossier dir. Every path-dependent helper derives from it; omitted = the
   * live `getOpenCodeHome()` layout, unchanged.
   */
  dataDir?: string;
  /**
   * ISS-8561: override for SEVERAL OpenCode data directories, read by ONE
   * collector. Golden mode needs it: the corpus now holds more than one
   * opencode dossier, each staged into its own directory with its own
   * `opencode.db`, and `CollectorManager` keys its per-harness bookkeeping by
   * `collector.key` — so stacking a second `opencode` collector would collide
   * rather than add a store.
   *
   * Every store keeps its OWN ingest state (fingerprint, seal gate,
   * continuation), because those answer "has THIS store been imported" and a
   * shared answer would re-list a sealed store forever. Mutually exclusive with
   * {@link dataDir}, and rejected alongside {@link fingerprintPath}: one
   * fingerprint file cannot hold N high-water marks.
   */
  dataDirs?: readonly string[];
  /**
   * ISS-4649 (whitlockk review): the MONITORED diagnostic sink — the same
   * `CollectorManager` logger that emits `collector <key> import failed: …`.
   * The engine's per-source parse `catch` swallows a rejected parse silently
   * (a partially-written transcript mid-turn is normal there), so a refusal
   * reported only by rejecting never reaches an operator. Wired from
   * `defaultCollectors`; omitted = a no-op, as in tests and golden mode.
   */
  log?: (message: string) => void;
  /**
   * Linkage-read seam (default: the real DB reader). Exists so the
   * `Unreadable` refusal below is reachable in a test with a VALID DB — a
   * corrupt file on disk fails `loadOpencodeSessionsFromDb` first, so it can never
   * exercise this branch.
   */
  readParentLinks?: (dbPath: string) => OpencodeParentLinkRead;
  /**
   * ISS-5266: durable sink for the WITHHELD-subagent record. Injected exactly
   * like {@link log} — the collector owns no DB handle, and wiring one here
   * would give the parse path a static edge to the store. Called once per
   * completed batch load with the store's COMPLETE withhold set (see
   * {@link OpencodeWithheldSubagentReport}); omitted = a no-op, as in tests and
   * golden mode, where nothing persists.
   *
   * May return a promise. When it does, `parse` AWAITS it before resolving, so
   * the record lands BEFORE `markSourceImported` seals the store's fingerprint.
   * A detached write could fail after the fingerprint had already advanced, and
   * unchanged bytes are never re-read, so the false zero would stick forever.
   */
  recordWithheld?: (
    report: OpencodeWithheldSubagentReport
  ) => void | Promise<void>;
  /**
   * ISS-5266 (whitlockk review): has this store ALREADY produced a withheld-scan
   * verdict? Answers the upgrade question, which the fingerprint alone cannot.
   *
   * On an install that ran a PREVIOUS release, `opencode.db` is unchanged and
   * its persisted fingerprint already matches, so `listSources()` returns `[]`,
   * `parse` never runs, and no report is ever produced. The withheld table would
   * stay empty forever — and, being empty, would read as the very "nothing is
   * withheld" claim this ticket exists to stop the product making. Nothing
   * self-heals it, because healing requires the bytes to move and a store the
   * user has stopped writing to never will.
   *
   * So the FIRST launch after upgrade ignores the persisted fingerprint exactly
   * once and re-reads the store, which costs one batch load and produces the
   * missing verdict. Injected (not read from disk here) because the collector
   * owns no DB handle — same reason as {@link recordWithheld} — and SYNCHRONOUS
   * because `listSources` is; the runtime resolves the answer once at boot and
   * closes over it.
   *
   * Omitted defaults to "already scanned", so tests, golden mode, and any host
   * with no store keep the exact pre-ISS-5266 behaviour and never pay a rescan.
   */
  hasRecordedWithheldScan?: (dbPath: string) => boolean;
}): BatchHarnessCollector {
  const fingerprintPath = opts?.fingerprintPath;
  const log = opts?.log ?? (() => undefined);
  const recordWithheld = opts?.recordWithheld ?? (() => undefined);
  // Default TRUE: an absent probe must not make every host pay a rescan.
  const hasRecordedWithheldScan =
    opts?.hasRecordedWithheldScan ?? ((): boolean => true);
  const readParentLinks = opts?.readParentLinks ?? readSessionParentLinks;
  const overrideDataDirs = resolveOverrideDataDirs(opts);
  if (overrideDataDirs && overrideDataDirs.length > 1 && fingerprintPath) {
    throw new Error(
      "opencode collector: fingerprintPath holds ONE high-water mark and cannot describe multiple data dirs"
    );
  }
  const resolveHomes = (): readonly string[] =>
    overrideDataDirs ?? [getOpenCodeHome()];
  const resolveDbPaths = (): string[] =>
    overrideDataDirs
      ? overrideDataDirs.map((dir) => path.join(dir, "opencode.db"))
      : [getOpenCodeDbPath()];
  // ISS-8561: ingest state PER STORE, keyed by db path. Every field in it
  // answers a question about one store ("has this store been sealed", "did this
  // store's last load come back short"), so a single shared object cannot hold
  // the answer for two: sealing store A would leave `lastFingerprint` describing
  // A, and store B — whose bytes differ — would be re-listed forever, with A
  // re-listed again the moment B sealed.
  const ingestByStore = new Map<string, OpencodeIngestState>();

  function ingestFor(dbPath: string): OpencodeIngestState {
    const existing = ingestByStore.get(dbPath);
    if (existing) {
      return existing;
    }
    const created = createOpencodeIngestState();
    ingestByStore.set(dbPath, created);
    return created;
  }

  function loadPersistedFingerprint(): string | null {
    if (!fingerprintPath) {
      return null;
    }
    try {
      return fs.readFileSync(fingerprintPath, "utf8");
    } catch {
      return null;
    }
  }

  function persistFingerprint(fingerprint: string): void {
    if (!fingerprintPath) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(fingerprintPath), { recursive: true });
      fs.writeFileSync(fingerprintPath, fingerprint);
    } catch {
      /* best-effort — an unwritable state dir just costs one extra load */
    }
  }

  function ensureSeeded(dbPath: string): void {
    const ingest = ingestFor(dbPath);
    if (ingest.seeded) {
      return;
    }
    ingest.seeded = true;
    ingest.lastFingerprint = loadPersistedFingerprint();
    if (ingest.lastFingerprint === null) {
      // No high-water mark to suppress anything: the store is about to be read
      // in full anyway, so the verdict lands without a forced pass.
      return;
    }
    if (hasRecordedWithheldScan(dbPath)) {
      return;
    }
    // ISS-5266: the upgrade path. Drop the high-water mark ONCE so this launch
    // re-reads the store and produces the verdict a pre-ISS-5266 release could
    // not have written.
    //
    // TERMINATION. `ensureSeeded` runs at most once per process, so this can
    // force at most ONE extra batch load per launch — it is not a loop and
    // cannot repeat within a run. It converges after that load: the record and
    // its scan row commit in one transaction, `markSourceImported` then seals
    // and re-persists the fingerprint, and the next launch sees a recorded scan
    // and takes the early return above. If the record FAILS, the latch refuses
    // the seal and no scan row is written, so the next launch retries — which is
    // the intended durable retry, not an unbounded rescan. And if it fails
    // permanently the store is not wedged: sessions still import exactly as they
    // do today; the only cost is one extra load per launch.
    ingest.lastFingerprint = null;
    log(
      `collector opencode rescanning store for withheld-subagent verdict (no prior scan): ${dbPath}`
    );
  }

  /**
   * ISS-8561: which store a parse SIDE-report describes.
   *
   * The report is applied by the manager, which knows the source it just
   * parsed, so `sourcePath` is the answer whenever it is supplied. The two
   * fallbacks cover callers that predate it: with a single store there is only
   * one possible answer, and an OpenCode load always carries a withheld report
   * that names its own source. Returning `undefined` is the honest "cannot
   * tell", and the caller turns that into a refused seal rather than a guess.
   */
  function resolveReportStore(
    report: CollectorParseSideReport
  ): string | undefined {
    if (report.sourcePath) {
      return report.sourcePath;
    }
    const dbPaths = resolveDbPaths();
    if (dbPaths.length === 1) {
      return dbPaths[0];
    }
    return report.withheldOpencodeSubagents?.sourcePath;
  }

  /**
   * ISS-5266: record ONE store's complete withhold set, and latch the outcome.
   *
   * The single place either path — the in-process `parse` or the replayed
   * out-of-process `applyParseSideReport` — writes the record and arms/clears
   * the flag `markSourceImported` reads. Never rejects: a failed record must not
   * fail an import whose sessions parsed fine; it must refuse the SEAL, so the
   * source is re-read and re-recorded next launch.
   */
  async function applyWithheldReport(
    report: OpencodeWithheldSubagentReport,
    // ISS-7696: does this write own the seal latch? The RECORD is written for
    // every caller — ISS-5266 routes the rebuild's re-read through here on
    // purpose, so a rebuilt store's verdict is current rather than the last
    // import pass's. The LATCH is a different thing: it is the seal gate, and
    // the only pass that seals is the import one. Letting a rebuild clear it
    // would answer "did MY write land?" with somebody else's write.
    ownsSealLatch = true
  ): Promise<void> {
    const ingest = ingestFor(report.sourcePath);
    try {
      await recordWithheld(report);
      if (ownsSealLatch) {
        ingest.withheldRecordFailed = false;
      }
    } catch (error) {
      if (ownsSealLatch) {
        ingest.withheldRecordFailed = true;
      }
      log(
        `collector opencode withheld-subagent record failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  function fingerprintDbFiles(home: string): string {
    const parts: string[] = [];
    for (const name of getOpenCodeDbWatchFiles()) {
      try {
        const stat = fs.statSync(path.join(home, name));
        parts.push(`${name}:${stat.mtimeMs}:${stat.size}`);
      } catch {
        parts.push(`${name}:missing`);
      }
    }
    return parts.join("|");
  }

  /**
   * A source is always `<dataDir>/opencode.db`, so its directory IS the store's
   * home — which is what makes the per-source hooks below resolvable without a
   * second lookup table to keep in step with {@link resolveDbPaths}.
   */
  function fingerprintForSource(dbPath: string): string {
    return fingerprintDbFiles(path.dirname(dbPath));
  }

  return {
    key: "opencode",
    cacheName: "opencode",
    batch: true,

    watchRoots(): string[] {
      return [...resolveHomes()];
    },

    watchMatch(filename: string): boolean {
      return getOpenCodeDbWatchFiles().some(
        (n) => filename === n || filename.endsWith(`/${n}`)
      );
    },

    sourcePathsForWatchEvent(): string[] {
      return resolveDbPaths();
    },

    listSources(): string[] {
      const sources: string[] = [];
      for (const dbPath of resolveDbPaths()) {
        ensureSeeded(dbPath);
        if (!fs.existsSync(dbPath)) {
          continue;
        }
        if (
          fingerprintForSource(dbPath) === ingestFor(dbPath).lastFingerprint
        ) {
          continue;
        }
        sources.push(dbPath);
      }
      return sources;
    },

    async parse(dbPath: string): Promise<NormalizedSession[]> {
      // ISS-4544: fold OpenCode subagent sessions (rows carrying a `parent_id`)
      // into their root parent's `subagents[]` so the importer nests them at
      // parity with the Claude/Codex sub-agent roll-up. The loader stays
      // subagent-agnostic — the cloud materializer relies on it returning every
      // session as its own record — so the fold happens here, in the collector's
      // local-DB import path only.
      //
      // ISS-5238 (F1) / ISS-5161: the load can THROW when SQLite could not serve
      // the read — a corrupt store, or (see `hasSummaryColumns`) a RETRYABLE
      // schema PRAGMA failure. That must reach the engine as a rejection:
      // `markSeenOnThrow` does not mark a batch collector seen on a throw, so the
      // fingerprint stays put and the next tick retries, instead of a
      // momentarily-unreadable session being frozen out behind the unchanged-DB
      // gate. It must ALSO be reported here, on the MONITORED
      // `collector <key> import failed: …` channel, for the same reason ISS-4649
      // reports its linkage refusal below: `CollectorManager.importSources`
      // catches a per-source parse rejection and moves on WITHOUT logging (a
      // partially-written transcript mid-turn is normal there), so a refusal that
      // only rejects never reaches an operator. The synchronous call is wrapped
      // because `parse` is a Promise-returning method, so a bare sync throw here
      // would NOT arrive as a rejection; the original error rides along as
      // `cause` so the underlying SQLite failure is still available for triage.
      let load: OpencodeSessionLoad;
      try {
        load = loadOpencodeSessionsFromDb(dbPath, { log });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log(
          `collector opencode import failed: OpenCode session store unreadable at ${dbPath} (${detail}); skipping this import tick so a short read is not sealed in by the fingerprint`
        );
        return Promise.reject(
          new Error(
            `OpenCode session store unreadable at ${dbPath}; skipping this import tick so a short read is not sealed in by the fingerprint`,
            { cause: error }
          )
        );
      }
      const sessions = load.sessions;
      const parentLinks = readParentLinks(dbPath);
      if (parentLinks.status === OpencodeParentLinkReadStatus.Unreadable) {
        // ISS-4649 (finding 6): a FAILED linkage read is not a legacy DB. Folding
        // on an empty map here would import every subagent as its own top-level
        // session, and `markSourceImported` would then advance the fingerprint —
        // so `listSources` skips the unchanged DB and the flattened corpus sticks
        // until the file's mtime/size moves again. Fail the parse instead: the
        // fingerprint is not advanced, nothing wrong is persisted, and the next
        // tick retries. A genuinely legacy DB (no `parent_id` column) still folds
        // to a flat corpus, which is correct for it.
        const cause = parentLinks.error;
        const detail = cause instanceof Error ? cause.message : String(cause);
        // ISS-4649 (whitlockk review): report it OURSELVES, on the monitored
        // `collector <key> import failed: …` channel. Rejecting is not enough —
        // `CollectorManager.importSources` catches a per-source parse rejection
        // and `continue`s WITHOUT logging (a partially-written file mid-turn is
        // normal there), so the manager's own import-failure log is never
        // reached and the refusal would be invisible. `cause` still carries the
        // underlying SQLite error for triage.
        log(
          `collector opencode import failed: OpenCode parent linkage unreadable at ${dbPath} (${detail}); skipping this import tick so subagents are not flattened`
        );
        return Promise.reject(
          new Error(
            `OpenCode parent linkage unreadable at ${dbPath}; skipping this import tick so subagents are not flattened`,
            { cause }
          )
        );
      }
      const links =
        parentLinks.status === OpencodeParentLinkReadStatus.Linked
          ? parentLinks.links
          : [];
      // ISS-5238 (F2): tell the fold which roots were dropped so a dropped
      // parent's children are withheld instead of re-flattened to top level.
      // ISS-5266: the reason rides along so the durable withhold record can name
      // it, and `withheld` collects one record per withheld subtree.
      const withheld: OpencodeWithheldSubagentRoot[] = [];
      const roots = foldOpencodeSubagents(sessions, links, {
        droppedRoots: new Map(
          load.droppedSessions.map((dropped) => [
            dropped.sessionId,
            dropped.reason,
          ])
        ),
        log,
        onWithheld: (record) => withheld.push(record),
      });
      // ISS-5266: report unconditionally, INCLUDING the empty case. OpenCode is a
      // batch harness, so one load sees the whole store — an empty report is the
      // positive claim "this store withheld nothing", which is what lets the sink
      // retire a record whose root has started parsing again. Reporting only on
      // a non-empty set would leave a healed root claiming missing data forever.
      // AWAITED, not detached: `markSourceImported` seals this store's
      // fingerprint once parse resolves, and unchanged bytes are never re-read,
      // so a write that fails after the seal leaves the false zero in place
      // permanently. On failure the store is marked so the seal is REFUSED and
      // the next launch re-reads and re-records, which is the durable retry.
      await applyWithheldReport({ sourcePath: dbPath, roots: withheld });
      return roots;
    },

    // ISS-5266 (whitlockk review): the OUT-OF-PROCESS entry to the very same
    // record-and-latch path `parse` takes above.
    //
    // A historical/boot parse runs in the utility process, so `parse` — and with
    // it the record and the latch — executes on a throwaway collector instance
    // there, not on this one. This instance is the one that owns the fingerprint
    // and answers `markSourceImported`, so the report has to be replayed onto it
    // or the store is sealed over a record that was never written. Routing both
    // paths through `applyWithheldReport` means the seal gate is ONE mechanism:
    // there is no second copy of the check to drift out of step.
    applyParseSideReport(report): Promise<void> {
      // ISS-8561: attribute the report to ONE store before touching any seal
      // gate. An unattributable report is not "nothing happened" — it may be
      // describing a load that came back short, so it refuses EVERY store's
      // seal rather than letting one be sealed over a partial read. It clears
      // on the next attributable report, so this converges exactly like the
      // truncation latch it protects.
      const store = resolveReportStore(report);
      for (const dbPath of resolveDbPaths()) {
        ingestFor(dbPath).unattributedSideReport = store === undefined;
      }
      if (store === undefined) {
        log(
          "collector opencode import failed: parse side-report names no store and more than one is configured; refusing every seal this pass so a short load is not sealed in"
        );
        return Promise.resolve();
      }
      const ingest = ingestFor(store);
      // ISS-7696: the seal-gate fields belong to the IMPORT pass, which is the
      // only caller that goes on to seal. The DATA_REVISION rebuild re-reads the
      // same store through the same worker on this same instance, always from
      // offset 0 and on its own schedule, so letting its report through here
      // would overwrite an in-flight pass's verdict about a DIFFERENT window —
      // and that pass's `markSourceImported` would then seal on it. The withheld
      // record below is still WRITTEN for a rebuild — ISS-5266 routes it here on
      // purpose — but its failure LATCH is part of the same seal gate, so that
      // half is scoped too.
      const ownsSealGate = report.scope !== CollectorParseScope.Rebuild;
      if (ownsSealGate) {
        // ISS-5854: latch a budget-truncated load onto THIS instance, the one
        // that owns the fingerprint. Set before the withheld replay below so an
        // early return cannot skip it.
        ingest.truncatedByBudget = Boolean(report.droppedSessions);
        // ISS-7696: PENDING, not active. This runs before the manager has read a
        // single session out of the window it describes, so promoting it here
        // would advance the continuation past sessions the pass may never
        // import.
        ingest.pendingResumeAfter = report.resumeAfter;
      }
      if (!report.withheldOpencodeSubagents) {
        return Promise.resolve();
      }
      return applyWithheldReport(
        report.withheldOpencodeSubagents,
        ownsSealGate
      );
    },

    sourceFingerprint(source): string {
      return fingerprintForSource(source);
    },

    /**
     * ISS-7696 (whitlockk review): a continuation is only meaningful against the
     * exact store state it was earned from, so it is handed out only while that
     * state still stands.
     *
     * The worker's own index/id check (`resolveHistoricalParseResumeOffset`)
     * validates the BOUNDARY session alone, which cannot see a change EARLIER in
     * the prefix: after delivering `[A, B]`, a store that becomes `[X, B, …]`
     * still has `B` at the boundary index, so the worker would resume past an
     * `X` it never delivered, and a later whole window would seal over the hole.
     * A touched session that keeps its position is the same hole with the same
     * ending. Neither is visible at the boundary; both move the fingerprint.
     *
     * So the fingerprint is the gate and the boundary check is defence in depth.
     * A store that moved drops the cursor and the source restarts from 0, which
     * is safe in the direction that matters: re-delivery is idempotent (the
     * import path upserts on session id) and skipping is the silent loss this
     * mechanism exists to end.
     */
    resumeAfterForSource(source): HistoricalParseWorkerResumePoint | undefined {
      const confirmed = ingestFor(source).confirmedResumeAfter;
      if (!confirmed) {
        return undefined;
      }
      return confirmed.fingerprint === fingerprintForSource(source)
        ? confirmed.point
        : undefined;
    },

    // ISS-5028 (whitlockk review): report whether the snapshot was actually
    // committed. Refusing a moved snapshot is correct — the store changed under
    // the pass, so the import is not a complete picture of it — but the caller
    // must know, because a refused source returns as pending on the next scan
    // and must not be counted as finished for first-pass progress.
    markSourceImported(source, snapshot): boolean {
      const ingest = ingestFor(source);
      // ISS-7696: reaching here is the manager's statement that it ran the whole
      // session loop for the window it was handed and committed it — the
      // mid-source live yield and a failed session both return before this call.
      // So this is the one place a continuation may be promoted, and it happens
      // BEFORE the refusals below, because a refused seal over a TRUNCATED load
      // is precisely the case that must go on to ask for the suffix.
      //
      // ISS-7696 (whitlockk review): promoted WITH the fingerprint it was earned
      // against, rather than promoted bare. This runs ahead of the stale-snapshot
      // refusal below on purpose, so binding is what stops a pass whose store
      // moved underneath it from leaving a cursor that outlives the list it
      // describes; `resumeAfterForSource` re-checks the binding before handing it
      // out. Moving the promotion below that refusal instead would strand the
      // truncated case, which refuses earlier and is the one that must continue.
      // The snapshot's fingerprint is the store as the parse SAW it; the
      // `??` mirrors the `lastFingerprint` assignment below for a caller that
      // supplies no snapshot.
      ingest.confirmedResumeAfter = ingest.pendingResumeAfter
        ? {
            point: ingest.pendingResumeAfter,
            fingerprint: snapshot?.fingerprint ?? fingerprintForSource(source),
          }
        : undefined;
      // ISS-8561: refuse the seal when the last side-report could not be
      // attributed to a store — it may have described a short load of THIS one.
      if (ingest.unattributedSideReport) {
        return false;
      }
      // ISS-5266: refuse the seal when the withhold record did not land. The
      // fingerprint is the gate that stops unchanged bytes being re-read, so
      // advancing it here would make a transient write failure permanent and
      // leave the under-count reading as a real zero forever.
      if (ingest.withheldRecordFailed) {
        return false;
      }
      // ISS-5854: refuse the seal over a load the response budget cut short.
      // Refusing is what keeps `listSources` returning this sentinel: the
      // store's bytes did not change, so sealing here would freeze the
      // under-count as a real zero — the exact freeze `opencode-parse-failure.ts`
      // records being fixed once already.
      //
      // ISS-7696 made that refusal converge instead of latching forever. The
      // worker request now carries a continuation, so each refused pass asks for
      // the SUFFIX it has not seen; the load that finally carries the tail
      // reports nothing dropped, clears this flag through
      // `applyParseSideReport`, and seals. Until then the answer is still "not
      // fully imported", which is the honest one.
      if (ingest.truncatedByBudget) {
        return false;
      }
      const currentFingerprint = fingerprintForSource(source);
      if (
        snapshot?.fingerprint &&
        snapshot.fingerprint !== currentFingerprint
      ) {
        return false;
      }
      ingest.lastFingerprint = snapshot?.fingerprint ?? currentFingerprint;
      // ISS-8561: a store sealed this run is seeded BY that seal. The persisted
      // mark is a cold-start substitute for a load this process has not done,
      // so letting `ensureSeeded` run afterwards would replace a fresh in-memory
      // high-water mark with a stale file (or, with no file, with `null`) and
      // re-offer a store that was just imported.
      ingest.seeded = true;
      persistFingerprint(ingest.lastFingerprint);
      return true;
    },

    resetIngestState(): void {
      // ISS-5266 (tamsinb review): reset by RE-CONSTRUCTION, not by clearing
      // fields one at a time. The previous shape cleared `lastFingerprint` and
      // `seeded` but silently left `withheldRecordFailed` set, so a reset after
      // a failed record inherited a stale `true` and `markSourceImported`
      // refused the seal forever — the collector was supposed to start from a
      // clean slate and instead started from half of the last run's. Routing
      // both the initial value and the reset through the single
      // `createOpencodeIngestState` factory makes that class of bug
      // unrepresentable: a field added to `OpencodeIngestState` tomorrow cannot
      // compile without an initial value there, and it is therefore reset here
      // by construction, with no second site to keep in sync.
      //
      // ISS-8561: dropping the whole per-store map keeps that property — the
      // next `ingestFor` rebuilds each store's state through the same factory,
      // so no field survives a reset and none can be forgotten.
      ingestByStore.clear();
      if (!fingerprintPath) {
        return;
      }
      try {
        fs.rmSync(fingerprintPath, { force: true });
      } catch {
        /* best-effort — an uncleared fingerprint only costs another explicit reset */
      }
    },

    /**
     * FEA-1785: Return the DB path unconditionally (bypassing the fingerprint
     * gate in listSources) so the data-revision rebuild can re-derive stale
     * opencode sessions even when the underlying DB hasn't changed.
     */
    listSourcesForRebuild(): string[] {
      return resolveDbPaths().filter((dbPath) => fs.existsSync(dbPath));
    },
  };
}

/**
 * ISS-5266: the collector's COMPLETE per-run ingest state, in one object so
 * `resetIngestState` can clear it by re-construction rather than field by field.
 *
 * Every mutable value that must not survive a reset belongs here. Adding a field
 * to this type forces an initial value in {@link createOpencodeIngestState},
 * which is the same factory the reset calls — so the new field is reset for free
 * and cannot be forgotten.
 */
type OpencodeIngestState = {
  /** High-water-mark fingerprint of the last SEALED import. */
  lastFingerprint: string | null;
  /** Has the persisted fingerprint been read into memory yet this run? */
  seeded: boolean;
  /**
   * Did the last load's WITHHELD-record write fail?
   *
   * Sealing the fingerprint over a failed record freezes the very under-count
   * this ticket exists to surface: the bytes are unchanged, so the store is
   * never re-read and the missing spend keeps reading as a real zero. Refusing
   * the seal sends the source back through on the next launch, which is the
   * durable retry path.
   */
  withheldRecordFailed: boolean;
  /**
   * ISS-5854: did the last load come back with sessions dropped by the worker
   * response budget?
   *
   * Like `withheldRecordFailed`, it converges: ISS-7696 gave the worker request
   * a continuation, so each pass this flag refuses buys asks for the sessions
   * the last one could not carry, and the pass that finally carries the tail
   * arrives with nothing dropped and clears it. It describes the LAST load, so
   * it must be re-evaluated on every load rather than only when something was
   * dropped — see `applyParseSideReport`.
   */
  truncatedByBudget: boolean;
  /**
   * ISS-7696: the continuation the LAST load came back with, not yet usable.
   *
   * Two fields rather than one because the two events are separated by the whole
   * session loop: the worker states where it stopped before the manager has
   * imported anything from that window, and the manager may abandon the window's
   * tail (a mid-source live yield) or leave the source unmarked (a failed
   * session). Only `markSourceImported` — which neither of those paths reaches —
   * promotes pending to confirmed, so an unconsumed window is re-delivered
   * instead of skipped.
   */
  pendingResumeAfter: HistoricalParseWorkerResumePoint | undefined;
  /**
   * The continuation a completed pass earned, bound to the store state it was
   * earned against; what the next request carries while that state stands.
   *
   * See {@link BatchHarnessCollector.resumeAfterForSource} on this collector for
   * why the binding — not the worker's boundary check — is what makes a resume
   * skip-safe.
   */
  confirmedResumeAfter: ConfirmedResumePoint | undefined;
  /**
   * ISS-8561: could the LAST parse side-report be attributed to a store?
   *
   * With one store the answer is always yes — there is nothing else it could
   * describe. With several, a report that names no source could be about any of
   * them, including one whose load came back short, so every store refuses its
   * seal until an attributable report arrives. Like `truncatedByBudget` it
   * describes the last report rather than latching, so it converges.
   */
  unattributedSideReport: boolean;
};

function createOpencodeIngestState(): OpencodeIngestState {
  return {
    lastFingerprint: null,
    seeded: false,
    withheldRecordFailed: false,
    truncatedByBudget: false,
    pendingResumeAfter: undefined,
    confirmedResumeAfter: undefined,
    unattributedSideReport: false,
  };
}

/**
 * ISS-7696 (whitlockk review): a continuation plus the store fingerprint it was
 * earned against, kept together because neither half is safe to act on alone.
 *
 * A bare resume point is a pair of numbers that only describes the session list
 * it was taken from; carrying the fingerprint beside it is what lets
 * `resumeAfterForSource` prove that list is still the one in front of us before
 * asking the worker to slice past its prefix.
 */
type ConfirmedResumePoint = {
  point: HistoricalParseWorkerResumePoint;
  fingerprint: string;
};

/**
 * ISS-8561: normalize the two data-dir overrides into the one list the collector
 * reads, or `null` for the live `getOpenCodeHome()` layout.
 *
 * Supplying both is rejected rather than resolved by precedence: the two would
 * disagree about which stores exist, and the loser's sessions would simply never
 * be imported — a silent omission, which is the failure this corpus exists to
 * catch.
 */
function resolveOverrideDataDirs(opts?: {
  dataDir?: string;
  dataDirs?: readonly string[];
}): readonly string[] | null {
  if (opts?.dataDir !== undefined && opts?.dataDirs !== undefined) {
    throw new Error(
      "opencode collector: pass dataDir or dataDirs, never both — they would disagree about which stores exist"
    );
  }
  if (opts?.dataDirs !== undefined) {
    return opts.dataDirs;
  }
  return opts?.dataDir === undefined ? null : [opts.dataDir];
}
