/**
 * @file collector-manager-batch-resume.ts
 * @description ISS-5161: the DURABLE mid-source resume cursor for BATCH
 * harnesses. Extracted from `collector-manager-low-duty-pacing.ts` (which now
 * owns only the pure yield-gate arithmetic) because persistence is a different
 * responsibility with its own boundary, format version, and failure modes.
 *
 * ## Why a batch harness needs its own resumability
 *
 * The engine's per-file resumability — `cache.markSeenWith(source, …)` plus the
 * throttled flush in `CollectorManager.importSources`, whose comment says it
 * exists "so a long first-launch backfill resumes after a kill/restart instead
 * of restarting from zero" — is gated on `!collector.batch`. OpenCode is the
 * only batch harness: `listSources()` returns ONE sentinel (the whole
 * `opencode.db`) and `parse(sentinel)` loads the entire corpus, so there is no
 * per-file marker to write and the engine's resumability is skipped for it by
 * construction. Its only durable marker is the collector's own store
 * fingerprint, which is all-or-nothing: it is advanced by `markSourceImported`
 * only after the WHOLE corpus imports.
 *
 * ISS-5028 added a resume cursor so a MID-SOURCE yield does not replay the
 * already-imported prefix on the next quantum. That cursor was in-memory only,
 * so it survived a yield but not the process. A backfill interrupted by a quit,
 * a crash, or an OS restart therefore came back with an empty cursor AND an
 * unadvanced fingerprint: the store was re-listed, re-parsed in full, and every
 * already-imported session was replayed before the pass could reach new work.
 * On a machine used the way the low-duty pass is designed for — the app quit and
 * relaunched daily, the yield firing whenever the watcher queue is non-empty — a
 * corpus large enough not to finish in one uninterrupted pass never finishes at
 * all. Persisting the cursor closes that: the same fast-forward that already
 * bounds a batch import at ceil(sessions / quantum) resumes now also spans a
 * restart, so progress is strictly forward across process lifetimes.
 *
 * ## Why session identity, and why it is safe
 *
 * A cursor keyed on the source SNAPSHOT cannot work: sustained writes are what
 * change the snapshot, so a snapshot-keyed cursor is invalidated exactly when it
 * is needed. Keying on SESSION IDENTITY survives the store changing underneath
 * the pass.
 *
 * Skipping a re-parsed session is safe only because the skip is scoped to a
 * source that is still MID-PASS: the cursor is dropped at a DURABLE terminal
 * outcome, so it can only ever suppress a replay for a source that has not
 * finished, never across a completed pass.
 *
 * The other half of that safety is the store FINGERPRINT, and it is the one
 * non-obvious thing about this module. `markSourceImported` refuses to advance a
 * fingerprint that moved under the pass (see `opencode-collector.ts`), but that
 * only covers a move that happened AFTER this pass captured its snapshot. It
 * cannot cover a move that happened BEFORE — between the quantum that recorded a
 * session id and the quantum that wants to skip it — because the later quantum
 * re-lists and captures its own snapshot, so there is nothing left to refuse.
 * That gap is reachable across a restart (an edit made while the app was CLOSED
 * is already baked into the new snapshot) and, per ISS-5161 review H2, equally
 * reachable in-process (a live-watcher import runs between two low-duty quanta,
 * and the resumed quantum's snapshot is fresh).
 *
 * So a cursor may fast-forward only while the store still carries the exact
 * fingerprint its ids were recorded under — memory and disk alike, see
 * {@link BatchResumeCursors.validateEntry}. The fingerprint is pinned when the
 * entry is created and never advanced: advancing it would let a prefix recorded
 * before a move be laundered into a cursor that looks unmoved. When the store
 * has moved, the entry is dropped and the prefix is replayed once — the
 * pre-ISS-5028 behavior, which costs time and never correctness.
 *
 * What that gate costs, stated plainly (ISS-5161 review): on OpenCode the
 * MID-SOURCE yield and the fingerprint are driven by the same files.
 * `shouldYieldMidSource` fires only when the harness watcher has a pending live
 * event (`collector-manager-low-duty-pacing.ts`), those events come from the
 * `opencode.db` / `-wal` / `-shm` watch match, and that is exactly the set
 * `sourceFingerprint()` hashes as `name:mtimeMs:size`. So a mid-source yield
 * implies one of those files just moved, and the resumed quantum's fresh
 * snapshot usually will NOT match: the IN-PROCESS fast-forward across such a
 * yield is expected not to survive, and the prefix is replayed. That is the
 * intended trade, not an oversight — the store moving is precisely the condition
 * under which skipping a re-parsed session could seal an edit away. It does not
 * touch the case ISS-5161 exists for: a quit/relaunch does not itself write to
 * the store, so a cursor loaded from disk against an unmoved store still
 * fast-forwards the whole backfill prefix. Narrowing the key to per-SESSION
 * content — so an untouched session still fast-forwards while its neighbor is
 * rewritten — is the real fix for the in-process case and is deliberately out of
 * scope here: it cannot reuse `sourceFingerprint()`, whose all-or-nothing
 * semantics `listSources` and `markSourceImported` also depend on.
 *
 * Scoped to BATCH collectors by the caller for the same reason as before: the
 * cost this exists to avoid — replaying thousands of already-imported sessions —
 * is a batch-source property. A file harness re-parses one transcript, where the
 * replay is cheap and the cursor would only add risk.
 *
 * ## Bounds
 *
 * One entry per in-flight source, dropped at that source's DURABLE terminal
 * outcome, and cleared wholesale on stop. {@link MAX_SESSION_IDS_PER_SOURCE}
 * caps the recorded ids for a single source so a pathological corpus cannot grow
 * the map or the persisted file without limit; past the cap the cursor simply
 * stops fast-forwarding (those sessions are re-read and re-imported, which is
 * correct, only slower), which is the honest degradation rather than a silent
 * unbounded write.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Bump when the persisted cursor format changes so a differently-shaped file
 * from an older build is discarded wholesale rather than mis-parsed. A discarded
 * cursor costs one replayed prefix, never correctness.
 */
const PERSIST_VERSION = 2;

/**
 * Throttle for the in-loop flush, mirroring the catchup cache's flush interval in
 * `CollectorManager.importSources`. The cursor is also flushed at every yield,
 * every terminal outcome, and on stop; this interval is what covers a hard kill
 * (SIGKILL, force-quit, power loss) that never reaches any of those.
 */
const FLUSH_INTERVAL_MS = 10_000;

/**
 * Ceiling on session ids recorded for ONE source. Sized well above any realistic
 * OpenCode corpus so the cap is a backstop, not a behavior the normal path hits.
 */
export const MAX_SESSION_IDS_PER_SOURCE = 100_000;

/**
 * Ceiling on distinct source keys loaded from disk. Only in-flight sources hold a
 * cursor, and there is one batch harness, so this is a backstop against a file
 * that accumulated orphans (a store deleted, or a collector toggled off, before
 * its source ever reached a terminal outcome) rather than a normal-path limit.
 */
export const MAX_CURSOR_SOURCES = 64;

/**
 * ISS-5161 (wongk review): byte ceiling applied BEFORE the file is read, so an
 * oversized or corrupt cursor can never be materialized and walked on the
 * Electron main thread. The collection caps below bound what this module
 * WRITES, but they are enforced by validation — which only runs after the whole
 * payload has already been read and parsed — so they cannot bound an
 * adversarial or corrupt file. This can, and it is the only bound that runs
 * before any allocation proportional to the file.
 *
 * Sized at ~2x the largest file this module can legitimately produce for one
 * saturated source ({@link MAX_SESSION_IDS_PER_SOURCE} ids at a generous ~70
 * bytes of JSON each), because only in-flight sources hold a cursor and there
 * is one batch harness. A file above it is treated exactly like any other
 * unreadable cursor: reported, and resumed without (the prefix replays once).
 */
export const MAX_CURSOR_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Zod validator for the persisted file. This is unknown JSON at a persistence
 * boundary, so it is validated rather than `typeof`-checked: a hand-edited or
 * truncated file must load as "no cursor" (replay the prefix once) and never as
 * a partially-trusted cursor that could skip sessions it never imported.
 *
 * ISS-5161 (wongk review): the collection caps are declared HERE rather than
 * applied as a post-validation `slice`, so an over-cap file is rejected as
 * invalid instead of silently truncated to an arbitrary subset. Rejection is
 * the same honest degradation as any other corrupt cursor — replay the prefix
 * once — whereas an arbitrary truncation keeps a partially-trusted cursor.
 */
const persistedCursorsSchema = z.object({
  version: z.number(),
  cursors: z
    .record(
      z.string(),
      z.object({
        /**
         * The store fingerprint these ids were recorded under. `null` only for a
         * collector that exposes no `sourceFingerprint`, which cannot be validated
         * and is therefore never honored from disk.
         */
        fingerprint: z.string().nullable(),
        sessionIds: z.array(z.string()).max(MAX_SESSION_IDS_PER_SOURCE),
      })
    )
    .refine((cursors) => Object.keys(cursors).length <= MAX_CURSOR_SOURCES, {
      message: `more than ${MAX_CURSOR_SOURCES} cursor sources`,
    }),
});

export type BatchResumeCursorsOptions = {
  /** Absolute path of the persisted cursor file; omitted = memory-only. */
  persistPath?: string;
  /**
   * The MONITORED diagnostic sink (the same `CollectorManager` logger that emits
   * `collector <key> …`). A corrupt cursor file is recoverable but is not
   * nothing: it means durable state this process wrote came back unreadable, so
   * it is reported rather than swallowed. Omitted = a no-op, as in tests.
   */
  log?: (message: string) => void;
  /** Injectable clock for the flush throttle (tests pin it). */
  now?: () => number;
};

/**
 * Session ids already imported for a source that has NOT yet reached a terminal
 * outcome, so a resumed quantum — in this process or the next one — fast-forwards
 * past them instead of replaying the prefix. See the file docstring for why the
 * key is session identity and why the skip is safe.
 */
type CursorEntry = {
  /**
   * Store fingerprint this entry's ids were recorded under. Pinned at creation
   * and never advanced — see {@link BatchResumeCursors.validateEntry}.
   */
  fingerprint: string | null;
  ids: Set<string>;
};

export class BatchResumeCursors {
  private readonly bySource = new Map<string, CursorEntry>();
  /**
   * Keys loaded from DISK that have not yet been checked against the store's
   * current fingerprint. See {@link BatchResumeCursors.validateEntry}.
   */
  private readonly awaitingValidation = new Set<string>();
  private loggedFlushFailure = false;
  private readonly persistPath: string | null;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private loaded = false;
  private dirty = false;
  private lastFlushAt: number;

  constructor(options: BatchResumeCursorsOptions = {}) {
    this.persistPath =
      typeof options.persistPath === "string" && options.persistPath.length > 0
        ? options.persistPath
        : null;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.lastFlushAt = this.now();
  }

  /**
   * Has this session already been imported by an earlier quantum of this pass?
   *
   * `currentFingerprint` is the store fingerprint captured by THIS pass's pending
   * scan. Every cursor is gated on it — see {@link validateEntry}.
   */
  isImported(
    key: string,
    source: string,
    sessionId: string,
    currentFingerprint: string | null
  ): boolean {
    this.ensureLoaded();
    const mapKey = cursorKey(key, source);
    this.validateEntry(mapKey, currentFingerprint);
    return this.bySource.get(mapKey)?.ids.has(sessionId) === true;
  }

  /**
   * Record a session this quantum imported, so a later quantum — including one in
   * a later process — skips it. Persisted on a throttle so a hard kill loses at
   * most one interval's worth of fast-forward rather than the whole pass.
   */
  noteImported(
    key: string,
    source: string,
    sessionId: string,
    currentFingerprint: string | null
  ): void {
    this.ensureLoaded();
    const mapKey = cursorKey(key, source);
    // Validating BEFORE recording is what pins the fingerprint: if the store has
    // moved since this entry was created, the prefix it holds is no longer known
    // to be current, so the entry is dropped here and the new id starts a fresh
    // one at the fingerprint actually observed. Stamping the old entry forward
    // instead would launder a stale prefix into a cursor that looks unmoved —
    // including on the next LOAD, where it is the only thing checked.
    this.validateEntry(mapKey, currentFingerprint);
    const entry = this.bySource.get(mapKey);
    if (!entry) {
      this.bySource.set(mapKey, {
        fingerprint: currentFingerprint,
        ids: new Set([sessionId]),
      });
      this.dirty = true;
      this.flushIfDue();
      return;
    }
    if (entry.ids.size >= MAX_SESSION_IDS_PER_SOURCE) {
      // Past the cap the cursor stops growing. The sessions beyond it are simply
      // re-read on the next resume, which is correct (the importer dedupes) and
      // only costs time — preferable to an unbounded map and an unbounded write.
      // The caller must stop yielding MID-SOURCE once this is true; see
      // {@link isSaturated}.
      return;
    }
    entry.ids.add(sessionId);
    this.dirty = true;
    this.flushIfDue();
  }

  /**
   * ISS-5161 (review B1 + H2): a cursor may only fast-forward while the store
   * still carries the exact fingerprint its ids were recorded under.
   *
   * `markSourceImported` refuses to advance a fingerprint that moved under the
   * pass, but that only covers a move AFTER this pass captured its snapshot. A
   * move BEFORE it — between the quantum that recorded an id and the quantum that
   * wants to skip it — is invisible to that check, because the later quantum
   * re-lists and captures its own snapshot. Review B1 found that gap across a
   * restart (an edit made while the app was CLOSED is already baked into the new
   * snapshot); review H2 found the same gap in-process, because a live-watcher
   * import runs between two low-duty quanta and the resumed quantum's snapshot is
   * equally fresh. Fast-forwarding past such a session would seal the store with
   * the edit missing — silently, until the DB's mtime/size moves again.
   *
   * So the gate is applied to every entry, memory and disk alike. On a mismatch
   * the entry is dropped and the prefix replayed once: the pre-ISS-5028 behavior,
   * which costs time and never correctness. A disk-loaded entry additionally has
   * to HAVE a fingerprint — a collector with no `sourceFingerprint` records
   * `null`, which can never be proven unmoved, so it is never honored from disk.
   */
  private validateEntry(
    mapKey: string,
    currentFingerprint: string | null
  ): void {
    const loadedFromDisk = this.awaitingValidation.delete(mapKey);
    const entry = this.bySource.get(mapKey);
    if (!entry) {
      return;
    }
    const provenUnmoved = loadedFromDisk
      ? entry.fingerprint !== null && entry.fingerprint === currentFingerprint
      : entry.fingerprint === currentFingerprint;
    if (provenUnmoved) {
      return;
    }
    this.bySource.delete(mapKey);
    this.dirty = true;
  }

  /**
   * The source reached a DURABLE terminal outcome — it will not come back in a
   * later pending scan — so its cursor is a pure orphan: drop it, from disk as
   * well as memory. Persisted eagerly rather than on the throttle so the orphan
   * cannot outlive the process that retired it.
   *
   * A source left for RETRY deliberately keeps its cursor (ISS-5161 review H3).
   * Not because that attempt imported nothing — a `failed` or `incomplete`
   * session leaves the source for retry while the REST of the batch still
   * imports and still records here — but because only a FULLY-COMMITTED session
   * is ever checkpointed, so the entry describes exactly the set that committed.
   * Dropping it there sent the next pass back to session zero on any transient
   * parse failure.
   */
  forget(key: string, source: string): void {
    this.ensureLoaded();
    const mapKey = cursorKey(key, source);
    this.awaitingValidation.delete(mapKey);
    if (!this.bySource.delete(mapKey)) {
      return;
    }
    this.dirty = true;
    this.flush();
  }

  /**
   * Release the in-memory cursors WITHOUT discarding what is on disk. Called from
   * `stop()`, which is the ordinary quit path this store exists to survive: the
   * caller flushes first, then clears, and the next process loads the cursor back.
   *
   * ISS-5161 (review): that ordering has one failure mode. `flush()` swallows a
   * failed write and leaves `dirty` set precisely so the write is RETRIED — but
   * an unconditional clear here dropped the map and the flag together, so the
   * retry the flush-failure path promises never happened and the tail that write
   * was carrying was gone. Bounded (disk still holds the last successful flush)
   * but wrong on exactly the interruption this cursor exists for.
   *
   * So a persisted store with an outstanding write RETAINS its entries instead:
   * memory is then the only current copy, and the next `flush()` — an in-process
   * `start()`'s import loop, or a later `stop()` — writes it. Correctness is
   * unaffected either way, because every retained entry keeps the fingerprint it
   * was recorded under and `validateEntry` still gates it. A memory-only store
   * has no write to retry, so it always releases.
   */
  clear(): void {
    if (this.persistPath !== null && this.dirty) {
      return;
    }
    this.bySource.clear();
    this.awaitingValidation.clear();
    this.loaded = false;
    this.dirty = false;
  }

  /** Persist the cursors (best-effort; no-op when not dirty / memory-only). */
  flush(): void {
    if (!(this.persistPath && this.dirty)) {
      return;
    }
    // Same-directory temp file + atomic rename, and `dirty` cleared only after the
    // write succeeds (mirroring `parse-quarantine.ts`): a reader always sees either
    // the old valid file or the new complete one, never a truncated one, and a
    // failed write stays retryable.
    const tmpPath = `${this.persistPath}.${process.pid}.${this.now()}.tmp`;
    try {
      mkdirSync(path.dirname(this.persistPath), { recursive: true });
      // `Object.fromEntries`, not a `{}` accumulator: it defines own properties,
      // so a source path colliding with an inherited key cannot pollute the
      // prototype of the object being written. (Such a key is dropped by
      // `z.record` on the way back IN, so it does not round-trip — that is
      // acceptable: a dropped cursor costs one replayed prefix, never a skip.)
      const cursors = Object.fromEntries(
        [...this.bySource].map(([key, entry]) => [
          key,
          { fingerprint: entry.fingerprint, sessionIds: [...entry.ids] },
        ])
      );
      writeFileSync(
        tmpPath,
        JSON.stringify({ version: PERSIST_VERSION, cursors })
      );
      renameSync(tmpPath, this.persistPath);
      this.dirty = false;
      this.lastFlushAt = this.now();
    } catch (error) {
      // ISS-5161 (review H2): advance the throttle even on failure. `dirty` stays
      // set so the write is retried, but leaving `lastFlushAt` behind would make
      // `flushIfDue` true for EVERY subsequent session — turning a read-only state
      // dir into a per-session write storm on the import hot path. Report it once
      // per instance for the same reason: this is the monitored `collector …`
      // channel, not a per-session debug line.
      this.lastFlushAt = this.now();
      if (!this.loggedFlushFailure) {
        this.loggedFlushFailure = true;
        this.log(
          `collector batch resume cursor flush failed at ${this.persistPath}: ${errorText(error)}; the pass stays correct in memory and retries the write (further flush failures for this run are not repeated)`
        );
      }
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        /* the temp file is already gone or unremovable — nothing further to do */
      }
    }
  }

  /** Cursor entries currently held (one per in-flight source). Test observability. */
  size(): number {
    this.ensureLoaded();
    return this.bySource.size;
  }

  /**
   * ISS-5161 (wongk review): has this source's cursor hit
   * {@link MAX_SESSION_IDS_PER_SOURCE}, so it can no longer record progress?
   *
   * A mid-source yield is only progress-preserving while the cursor can record
   * what the quantum imported. Past the cap it cannot, so every resume replays
   * the same recorded prefix, imports the same small unrecorded tail, and yields
   * again before reaching anything later — a corpus above the cap would never
   * finish under a continuously pending live queue. The caller must therefore
   * stop yielding mid-source once this returns `true` and run the source to
   * completion instead; the per-session cooperative delay still keeps the main
   * thread responsive, and the SOURCE-level yield after it still runs.
   */
  isSaturated(key: string, source: string): boolean {
    this.ensureLoaded();
    const entry = this.bySource.get(cursorKey(key, source));
    return (entry?.ids.size ?? 0) >= MAX_SESSION_IDS_PER_SOURCE;
  }

  private flushIfDue(): void {
    if (this.now() - this.lastFlushAt >= FLUSH_INTERVAL_MS) {
      this.flush();
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    if (!this.persistPath) {
      return;
    }
    const raw = this.readPersistedFile(this.persistPath);
    if (raw === null) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.log(
        `collector batch resume cursor unreadable at ${this.persistPath}: ${errorText(error)}; resuming without it (the store's prefix is replayed once)`
      );
      return;
    }
    const validated = persistedCursorsSchema.safeParse(parsed);
    if (!(validated.success && validated.data.version === PERSIST_VERSION)) {
      // A different format version is expected across an upgrade and is discarded
      // silently; a same-shape file that fails validation is corrupt and reported.
      if (!validated.success) {
        this.log(
          `collector batch resume cursor invalid at ${this.persistPath}: ${validated.error.message}; resuming without it (the store's prefix is replayed once)`
        );
      }
      return;
    }
    for (const [key, entry] of Object.entries(validated.data.cursors)) {
      this.bySource.set(key, {
        fingerprint: entry.fingerprint,
        ids: new Set(entry.sessionIds),
      });
      // Loaded, but not yet trusted: it may only fast-forward once the store's
      // fingerprint proves it has not moved since this was written.
      this.awaitingValidation.add(key);
    }
  }

  /**
   * Read the persisted cursor, or `null` when there is nothing trustworthy to
   * load. Two distinctions the previous bare `catch` collapsed:
   *
   * - ISS-5161 (wongk review): only ENOENT is the ordinary first-launch case. A
   *   permission or I/O error means durable resume is silently OFF — the exact
   *   failure this cursor exists to prevent — so it goes to the MONITORED
   *   `collector …` channel rather than being swallowed as "no file yet".
   * - The size is checked before the read, so an oversized file is rejected
   *   without ever being materialized on the main thread.
   */
  private readPersistedFile(persistPath: string): string | null {
    try {
      const { size } = statSync(persistPath);
      if (size > MAX_CURSOR_FILE_BYTES) {
        this.log(
          `collector batch resume cursor oversized at ${persistPath}: ${size} bytes exceeds the ${MAX_CURSOR_FILE_BYTES}-byte ceiling; resuming without it (the store's prefix is replayed once)`
        );
        return null;
      }
      return readFileSync(persistPath, "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        this.log(
          `collector batch resume cursor unreadable at ${persistPath}: ${errorText(error)}; resuming without it (the store's prefix is replayed once, and durable resume stays off until the read succeeds)`
        );
      }
      return null;
    }
  }
}

function cursorKey(key: string, source: string): string {
  return `${key} ${source}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Node's filesystem errors carry a `code` (`ENOENT`, `EACCES`, `EIO`, …). It is
 * read through a validator rather than a `typeof` chain because the caught value
 * is `unknown` at this boundary.
 */
const nodeErrorSchema = z.object({ code: z.string() });

function errorCode(error: unknown): string | undefined {
  const parsed = nodeErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
}
