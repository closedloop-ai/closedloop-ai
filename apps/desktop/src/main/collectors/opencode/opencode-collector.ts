/**
 * @file opencode-collector.ts
 * @description The OpenCode HarnessCollector (FEA-1503). OpenCode is a BATCH
 * harness: its canonical store is a single foreign SQLite DB (`opencode.db`),
 * read in one load. To avoid re-loading the whole DB on every catchup tick, the
 * collector self-fingerprints the DB + WAL/SHM siblings (name:mtimeMs:size) and
 * skips the load when the fingerprint is unchanged.
 *
 * Fingerprint logic ported from `scripts/agent-monitor-opencode/opencode-import.js`
 * (FEA-1316 / FEA-1334), logic preserved: the in-memory high-water-mark is
 * seeded from a persisted file so a fresh process also skips the cold-start load
 * when the DB is untouched. Only the fingerprint/idempotency concern is ported —
 * the dbModule write path stays in the shared `importSession` write-sink.
 */
import fs from "node:fs";
import path from "node:path";
import type { BatchHarnessCollector, NormalizedSession } from "../types.js";
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
   * ISS-4649 (wongk review): the MONITORED diagnostic sink — the same
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
   * ISS-5266 (wongk review): has this store ALREADY produced a withheld-scan
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
  const resolveHome = (): string => opts?.dataDir ?? getOpenCodeHome();
  const resolveDbPath = (): string =>
    opts?.dataDir
      ? path.join(opts.dataDir, "opencode.db")
      : getOpenCodeDbPath();
  let ingest = createOpencodeIngestState();

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

  function ensureSeeded(): void {
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
    const dbPath = resolveDbPath();
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
   * ISS-5266: record ONE store's complete withhold set, and latch the outcome.
   *
   * The single place either path — the in-process `parse` or the replayed
   * out-of-process `applyParseSideReport` — writes the record and arms/clears
   * the flag `markSourceImported` reads. Never rejects: a failed record must not
   * fail an import whose sessions parsed fine; it must refuse the SEAL, so the
   * source is re-read and re-recorded next launch.
   */
  async function applyWithheldReport(
    report: OpencodeWithheldSubagentReport
  ): Promise<void> {
    try {
      await recordWithheld(report);
      ingest.withheldRecordFailed = false;
    } catch (error) {
      ingest.withheldRecordFailed = true;
      log(
        `collector opencode withheld-subagent record failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  function fingerprintDbFiles(): string {
    const home = resolveHome();
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

  return {
    key: "opencode",
    cacheName: "opencode",
    batch: true,

    watchRoots(): string[] {
      return [resolveHome()];
    },

    watchMatch(filename: string): boolean {
      return getOpenCodeDbWatchFiles().some(
        (n) => filename === n || filename.endsWith(`/${n}`)
      );
    },

    sourcePathsForWatchEvent(): string[] {
      return [resolveDbPath()];
    },

    listSources(): string[] {
      ensureSeeded();
      const dbPath = resolveDbPath();
      if (!fs.existsSync(dbPath)) {
        return [];
      }
      const fingerprint = fingerprintDbFiles();
      if (fingerprint === ingest.lastFingerprint) {
        return [];
      }
      return [dbPath];
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
        // ISS-4649 (wongk review): report it OURSELVES, on the monitored
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

    // ISS-5266 (wongk review): the OUT-OF-PROCESS entry to the very same
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
      if (!report.withheldOpencodeSubagents) {
        return Promise.resolve();
      }
      return applyWithheldReport(report.withheldOpencodeSubagents);
    },

    sourceFingerprint(): string {
      return fingerprintDbFiles();
    },

    // ISS-5028 (wongk review): report whether the snapshot was actually
    // committed. Refusing a moved snapshot is correct — the store changed under
    // the pass, so the import is not a complete picture of it — but the caller
    // must know, because a refused source returns as pending on the next scan
    // and must not be counted as finished for first-pass progress.
    markSourceImported(_source, snapshot): boolean {
      // ISS-5266: refuse the seal when the withhold record did not land. The
      // fingerprint is the gate that stops unchanged bytes being re-read, so
      // advancing it here would make a transient write failure permanent and
      // leave the under-count reading as a real zero forever.
      if (ingest.withheldRecordFailed) {
        return false;
      }
      const currentFingerprint = fingerprintDbFiles();
      if (
        snapshot?.fingerprint &&
        snapshot.fingerprint !== currentFingerprint
      ) {
        return false;
      }
      ingest.lastFingerprint = snapshot?.fingerprint ?? currentFingerprint;
      persistFingerprint(ingest.lastFingerprint);
      return true;
    },

    resetIngestState(): void {
      // ISS-5266 (thadeusb review): reset by RE-CONSTRUCTION, not by clearing
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
      ingest = createOpencodeIngestState();
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
      const dbPath = resolveDbPath();
      if (!fs.existsSync(dbPath)) {
        return [];
      }
      return [dbPath];
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
};

function createOpencodeIngestState(): OpencodeIngestState {
  return {
    lastFingerprint: null,
    seeded: false,
    withheldRecordFailed: false,
  };
}
