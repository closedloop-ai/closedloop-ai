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
 * ## Where it is persisted
 *
 * ISS-9839: in SQLite, alongside the session data the cursor names, rather than
 * in a JSON file in the ingest state dir. The medium reaches this module only as
 * {@link BatchResumeCursorStore} — a narrow injected port — because `collectors/`
 * may not import `agentDatabase` or `@repo/database` (ISS-9837 R1c).
 *
 * ## Bounds
 *
 * One entry per in-flight source, dropped at that source's DURABLE terminal
 * outcome, and cleared wholesale on stop. {@link MAX_SESSION_IDS_PER_SOURCE}
 * caps the recorded ids for a single source so a pathological corpus cannot grow
 * the map or the persisted payload without limit; past the cap the cursor simply
 * stops fast-forwarding (those sessions are re-read and re-imported, which is
 * correct, only slower), which is the honest degradation rather than a silent
 * unbounded write.
 */
import { z } from "zod";

/**
 * Bump when the persisted cursor format changes so a differently-shaped payload
 * from an older build is discarded wholesale rather than mis-parsed. A discarded
 * cursor costs one replayed prefix, never correctness.
 *
 * ISS-9839 (ISS-9837 R3): WHOLE-STORE, deliberately. A version discriminates a
 * FORMAT, and a format is a property of the store rather than of a row, so this
 * is one value for the whole persisted payload and never a per-row column.
 * Per-row versioning is the option with the data-loss shape: it makes selective
 * retention of rows a newer build misreads easy.
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
 * Ceiling on distinct source keys loaded from the persisted payload. Only
 * in-flight sources hold a cursor, and there is one batch harness, so this is a
 * backstop against a payload that accumulated orphans (a store deleted, or a collector toggled off, before
 * its source ever reached a terminal outcome) rather than a normal-path limit.
 */
export const MAX_CURSOR_SOURCES = 64;

/**
 * ISS-5161 (whitlockk review): byte ceiling applied BEFORE the payload is read, so
 * an oversized or corrupt cursor can never be materialized and walked on the
 * Electron main thread. The collection caps below bound what this module
 * WRITES, but they are enforced by validation — which only runs after the whole
 * payload has already been read and parsed — so they cannot bound an
 * adversarial or corrupt payload. This can, and it is the only bound that runs
 * before any allocation proportional to it. That is why the port asks
 * {@link BatchResumeCursorStore.byteLength} before
 * {@link BatchResumeCursorStore.read}.
 *
 * Sized at ~2x the largest payload this module can legitimately produce for one
 * saturated source ({@link MAX_SESSION_IDS_PER_SOURCE} ids at a generous ~70
 * bytes of JSON each), because only in-flight sources hold a cursor and there
 * is one batch harness. A payload above it is treated exactly like any other
 * unreadable cursor: reported, and resumed without (the prefix replays once).
 */
export const MAX_CURSOR_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * Zod validator for the persisted cursor map. This is unknown JSON at a
 * persistence boundary, so it is validated rather than `typeof`-checked: a
 * hand-edited or truncated payload must load as "no cursor" (replay the prefix
 * once) and never as a partially-trusted cursor that could skip sessions it
 * never imported.
 *
 * ISS-5161 (whitlockk review): the collection caps are declared HERE rather than
 * applied as a post-validation `slice`, so an over-cap payload is rejected as
 * invalid instead of silently truncated to an arbitrary subset. Rejection is
 * the same honest degradation as any other corrupt cursor — replay the prefix
 * once — whereas an arbitrary truncation keeps a partially-trusted cursor.
 *
 * ISS-9839: the format version is no longer inside this object — it is the
 * store-wide {@link PersistedBatchResumeCursors.version}, checked before this
 * runs, so a foreign format never reaches the shape validator at all.
 */
const persistedCursorsSchema = z
  .record(
    z.string(),
    z.object({
      /**
       * The store fingerprint these ids were recorded under. `null` only for a
       * collector that exposes no `sourceFingerprint`, which cannot be validated
       * and is therefore never honored from a persisted payload.
       */
      fingerprint: z.string().nullable(),
      sessionIds: z.array(z.string()).max(MAX_SESSION_IDS_PER_SOURCE),
    })
  )
  .refine((cursors) => Object.keys(cursors).length <= MAX_CURSOR_SOURCES, {
    message: `more than ${MAX_CURSOR_SOURCES} cursor sources`,
  });

/**
 * The persisted payload: the store's FORMAT version plus the serialized cursor
 * map. One value for the whole store — see {@link PERSIST_VERSION}.
 */
export type PersistedBatchResumeCursors = {
  version: number;
  cursors: string;
};

/**
 * ISS-9839 (ISS-9837 R1c): the narrow durable-backing port. `collectors/` may
 * not import `agentDatabase` or `@repo/database`, so the runtime injects the
 * implementation — the same shape `CollectorManager` already uses for
 * `importer` and `emit`.
 *
 * Every method is async because the desktop store is Prisma over libSQL, where
 * a write is a write-back rather than the `writeFileSync` this replaced. That
 * costs nothing the guarantee depended on; see {@link BatchResumeCursors.flush}.
 */
export type BatchResumeCursorStore = {
  /**
   * Byte size of the persisted payload, or `null` when nothing is persisted
   * yet. Asked BEFORE {@link BatchResumeCursorStore.read} so an oversized
   * payload is never materialized — see {@link MAX_CURSOR_PAYLOAD_BYTES}.
   */
  byteLength: () => Promise<number | null>;
  read: () => Promise<PersistedBatchResumeCursors | null>;
  write: (payload: PersistedBatchResumeCursors) => Promise<void>;
};

export type BatchResumeCursorsOptions = {
  /** Durable backing for the cursor; omitted = memory-only. */
  store?: BatchResumeCursorStore;
  /**
   * The MONITORED diagnostic sink (the same `CollectorManager` logger that emits
   * `collector <key> …`). A corrupt cursor is recoverable but is not
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
  private loggedOversizedPayload = false;
  private readonly store: BatchResumeCursorStore | null;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  /**
   * The one in-flight hydrate, memoized. The load is async now, so a second
   * caller arriving mid-read must join it rather than see a `loaded` flag the
   * first caller set before its rows arrived and read an empty map.
   */
  private loadPromise: Promise<void> | null = null;
  /**
   * Flushes are serialized on this chain. `stop()` can flush while an in-flight
   * `noteImported` is already awaiting one, and two concurrent writes would both
   * observe `dirty` before either cleared it.
   */
  private flushChain: Promise<void> = Promise.resolve();
  private dirty = false;
  private lastFlushAt: number;

  constructor(options: BatchResumeCursorsOptions = {}) {
    this.store = options.store ?? null;
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
  async isImported(
    key: string,
    source: string,
    sessionId: string,
    currentFingerprint: string | null
  ): Promise<boolean> {
    await this.ensureLoaded();
    const mapKey = cursorKey(key, source);
    this.validateEntry(mapKey, currentFingerprint);
    return this.bySource.get(mapKey)?.ids.has(sessionId) === true;
  }

  /**
   * Record a session this quantum imported, so a later quantum — including one in
   * a later process — skips it. Persisted on a throttle so a hard kill loses at
   * most one interval's worth of fast-forward rather than the whole pass.
   */
  async noteImported(
    key: string,
    source: string,
    sessionId: string,
    currentFingerprint: string | null
  ): Promise<void> {
    await this.ensureLoaded();
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
      await this.flushIfDue();
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
    await this.flushIfDue();
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
  async forget(key: string, source: string): Promise<void> {
    await this.ensureLoaded();
    const mapKey = cursorKey(key, source);
    this.awaitingValidation.delete(mapKey);
    if (!this.bySource.delete(mapKey)) {
      return;
    }
    this.dirty = true;
    await this.flush();
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
    if (this.store !== null && this.dirty) {
      return;
    }
    this.bySource.clear();
    this.awaitingValidation.clear();
    this.loadPromise = null;
    this.dirty = false;
  }

  /**
   * Persist the cursors (best-effort; no-op when not dirty / memory-only).
   *
   * ISS-9839 (ISS-9837 R4): what this store guarantees is an ORDERING invariant
   * — the cursor must never name a session whose data is not already committed —
   * and NOT a synchrony property of the `writeFileSync` this replaced. The gate
   * that enforces it is the caller's (`collector-manager.ts` checkpoints only a
   * FULLY-COMMITTED session), so an async write-back cannot violate it: a write
   * that never lands leaves the cursor BEHIND committed data, which replays a
   * prefix, never AHEAD of it, which would skip one. What the synchronous write
   * bought was a bound on that replay, and that bound was already
   * {@link FLUSH_INTERVAL_MS} rather than zero.
   *
   * Serialized through {@link BatchResumeCursors.flushChain}: two concurrent
   * writes would both observe `dirty` before either cleared it.
   */
  flush(): Promise<void> {
    const payload = this.takeDirtyPayload();
    if (payload === null) {
      return this.flushChain;
    }
    this.flushChain = this.flushChain.then(() => this.writePayload(payload));
    return this.flushChain;
  }

  /** Cursor entries currently held (one per in-flight source). Test observability. */
  async size(): Promise<number> {
    await this.ensureLoaded();
    return this.bySource.size;
  }

  /**
   * ISS-5161 (whitlockk review): has this source's cursor hit
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
  async isSaturated(key: string, source: string): Promise<boolean> {
    await this.ensureLoaded();
    const entry = this.bySource.get(cursorKey(key, source));
    return (entry?.ids.size ?? 0) >= MAX_SESSION_IDS_PER_SOURCE;
  }

  private flushIfDue(): Promise<void> {
    if (this.now() - this.lastFlushAt >= FLUSH_INTERVAL_MS) {
      return this.flush();
    }
    return Promise.resolve();
  }

  /**
   * Lazy hydrate (ISS-9837 R1b), memoized on the PROMISE rather than a flag: the
   * read is async now, so a flag set before the rows arrive would let a second
   * caller read an empty map and report a recorded session as un-imported.
   */
  private ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load();
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    const store = this.store;
    if (!store) {
      return;
    }
    const payload = await this.readPersisted(store);
    if (payload === null) {
      return;
    }
    if (payload.version !== PERSIST_VERSION) {
      // A different format version is expected across an upgrade and is
      // discarded silently — WHOLESALE, never row by row (ISS-9837 R3). It costs
      // one replayed prefix.
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.cursors);
    } catch (error) {
      this.log(
        `collector batch resume cursor unreadable: ${errorText(error)}; resuming without it (the store's prefix is replayed once)`
      );
      return;
    }
    const validated = persistedCursorsSchema.safeParse(parsed);
    if (!validated.success) {
      // A same-version payload that fails validation is corrupt, and is reported.
      this.log(
        `collector batch resume cursor invalid: ${validated.error.message}; resuming without it (the store's prefix is replayed once)`
      );
      return;
    }
    for (const [key, entry] of Object.entries(validated.data)) {
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
   * load. Two distinctions a bare `catch` would collapse:
   *
   * - ISS-5161 (whitlockk review): only "nothing persisted yet" is the ordinary
   *   first-launch case, and the port reports that as `null` rather than by
   *   throwing. A read that THROWS means durable resume is silently OFF — the
   *   exact failure this cursor exists to prevent — so it goes to the MONITORED
   *   `collector …` channel rather than being swallowed as "no cursor yet".
   * - The size is asked before the read, so an oversized payload is rejected
   *   without ever being materialized on the main thread.
   */
  private async readPersisted(
    store: BatchResumeCursorStore
  ): Promise<PersistedBatchResumeCursors | null> {
    try {
      const bytes = await store.byteLength();
      if (bytes === null) {
        return null;
      }
      if (bytes > MAX_CURSOR_PAYLOAD_BYTES) {
        this.log(
          `collector batch resume cursor oversized: ${bytes} bytes exceeds the ${MAX_CURSOR_PAYLOAD_BYTES}-byte ceiling; resuming without it (the store's prefix is replayed once)`
        );
        return null;
      }
      return await store.read();
    } catch (error) {
      this.log(
        `collector batch resume cursor unreadable: ${errorText(error)}; resuming without it (the store's prefix is replayed once, and durable resume stays off until the read succeeds)`
      );
      return null;
    }
  }

  /**
   * Serialize the current map and clear `dirty` — SYNCHRONOUSLY, on the caller's
   * own turn rather than inside the microtask that performs the write. A
   * `noteImported` that runs in between would otherwise ride along in a payload
   * the caller believed it had already committed, and `stop()`'s awaited flush
   * would report a cursor it had not actually written. `null` = nothing to
   * write.
   */
  private takeDirtyPayload(): PersistedBatchResumeCursors | null {
    if (!(this.store && this.dirty)) {
      return null;
    }
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
    // Cleared HERE rather than after the write resolves: an entry recorded while
    // that write is in flight is not in this payload, so clearing on the way out
    // would drop it. A failed write sets the flag again below.
    this.dirty = false;
    return {
      version: PERSIST_VERSION,
      cursors: JSON.stringify(cursors),
    };
  }

  private async writePayload(
    payload: PersistedBatchResumeCursors
  ): Promise<void> {
    const store = this.store;
    if (!store) {
      return;
    }
    if (this.isOverBudget(payload)) {
      return;
    }
    try {
      await store.write(payload);
      this.lastFlushAt = this.now();
    } catch (error) {
      // ISS-5161 (review H2), preserved as ISS-9837 C3: a failed write keeps
      // `dirty` so it is retried, advances the throttle anyway, and logs once.
      // Leaving `lastFlushAt` behind would make `flushIfDue` true for EVERY
      // subsequent session — turning an unwritable store into a per-session write
      // storm on the import hot path. Report it once per instance for the same
      // reason: this is the monitored `collector …` channel, not a per-session
      // debug line.
      this.dirty = true;
      this.lastFlushAt = this.now();
      if (!this.loggedFlushFailure) {
        this.loggedFlushFailure = true;
        this.log(
          `collector batch resume cursor flush failed: ${errorText(error)}; the pass stays correct in memory and retries the write (further flush failures for this run are not repeated)`
        );
      }
    }
  }

  /**
   * ISS-9839 (davetho review): the WRITE half of
   * {@link MAX_CURSOR_PAYLOAD_BYTES}. The read gate alone bounds what is
   * MATERIALIZED, not what is stored: the collection caps admit
   * {@link MAX_CURSOR_SOURCES} sources of {@link MAX_SESSION_IDS_PER_SOURCE} ids
   * each, so this module can legitimately produce a payload the reader will then
   * refuse — serialized, cloned across the db-host boundary, and persisted, only
   * to be discarded on the next launch. Refusing it here costs the same replayed
   * prefix and none of that work.
   *
   * Measured on `cursors` alone, in BYTES, because that is exactly the quantity
   * the read gate measures (`length(CAST("cursors" AS BLOB))`). A write gate
   * counting anything else would admit payloads the reader rejects, which is the
   * disagreement this exists to close.
   *
   * `dirty` is deliberately LEFT SET: entries are dropped at each source's
   * durable terminal outcome, so the next payload can be back under budget and
   * must then be written. The throttle is advanced for the same reason the
   * flush-failure path advances it — otherwise every subsequent session would
   * re-serialize an over-budget map on the import hot path.
   */
  private isOverBudget(payload: PersistedBatchResumeCursors): boolean {
    const bytes = Buffer.byteLength(payload.cursors, "utf8");
    if (bytes <= MAX_CURSOR_PAYLOAD_BYTES) {
      return false;
    }
    this.dirty = true;
    this.lastFlushAt = this.now();
    if (!this.loggedOversizedPayload) {
      this.loggedOversizedPayload = true;
      this.log(
        `collector batch resume cursor oversized: produced ${bytes} bytes, above the ${MAX_CURSOR_PAYLOAD_BYTES}-byte ceiling; not persisted (the pass stays correct in memory and the store's prefix is replayed once)`
      );
    }
    return true;
  }
}

function cursorKey(key: string, source: string): string {
  return `${key} ${source}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
