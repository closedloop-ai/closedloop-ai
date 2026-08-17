/**
 * @file opencode-materializer.ts
 * @description FEA-3932: materialize OpenCode sessions from the foreign
 * `opencode.db` into deterministic, line-delimited JSON files the transcript
 * archive lane can byte-delta sync. OpenCode is a BATCH harness — its canonical
 * store is a single SQLite DB, which the raw-`.jsonl` byte lane cannot upload —
 * so the desktop parses the DB (`collectors/opencode`) and writes a per-session
 * projection here; the cloud renderer reads it back with the SHARED record
 * schema (`@repo/lib/harness/opencode`).
 *
 * Layout under the materialized root `<stateDir>/transcript-materialized/opencode`:
 *   <externalSessionId>/main.jsonl                (root session, `main` file key)
 *   <externalSessionId>/subagent:<childId>.jsonl  (each nested subagent chain)
 * where `externalSessionId = session.sessionId` (already `opencode-<id>`) and a
 * child session (`opencode.db` `parent_id`) files under its ROOT session's
 * `externalSessionId` so the whole session graph archives under one identity
 * (decision #3). When the DB predates the `parent_id` column there is no
 * subagent concept at all, so every session is legitimately a root `main` file
 * (documented fallback). A linkage read that FAILED is NOT that case: the
 * materializer bails without writing, pruning, or checkpointing so the next
 * sweep retries (ISS-4649).
 *
 * Revision-gated: the DB + WAL/SHM fingerprint (name:mtimeMs:size — the same
 * model as `opencode-collector.ts`), prefixed by
 * {@link OPENCODE_PROJECTION_REVISION} so a build whose projection FORMAT
 * changed re-derives even against an untouched store, is persisted; an unchanged
 * fingerprint skips the whole rewrite so no re-upload is triggered. Each
 * per-session write is
 * best-effort — one bad session never throws into the sweep — but the fingerprint
 * is advanced ONLY when every expected projection published AND the stale-file
 * prune ran clean, so a partial failure (a transient write error, or one session
 * that could not serialize) leaves the checkpoint unadvanced and the next
 * unchanged-DB sweep re-attempts the skipped session instead of returning early.
 * Projections for sessions deleted or reparented in `opencode.db` since the last
 * run are pruned so a stale file cannot keep archiving under an old identity —
 * and that prune is SCOPED whenever the session load was SHORT (ISS-5238 F3), so
 * the projections owned by the sessions that failed to parse are preserved
 * (a session lost upstream would otherwise look exactly like a deleted one and
 * have its still-correct projection deleted) while every OTHER session's stale
 * projection is still pruned. Scoping rather than skipping matters because a
 * malformed row is durable: a store-wide skip would let the checkpoint advance
 * with the prune disabled for the whole store until that row is repaired.
 *
 * Deterministic output: records are emitted in a stable order and JSON keys are
 * insertion-ordered by the shared builders, so an unchanged DB produces
 * byte-identical files (idempotent; no spurious byte-delta re-uploads).
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildOpencodeApiErrorRecord,
  buildOpencodeMessageRecord,
  buildOpencodeSessionRecord,
  buildOpencodeTokenRecord,
  buildOpencodeToolErrorRecord,
  buildOpencodeToolUseRecord,
  buildOpencodeTurnDurationRecord,
  type OpencodeMaterializedRecord,
  serializeOpencodeMaterializedRecord,
} from "@repo/lib/harness/opencode/opencode-materialized-record";
import type { NormalizedSession } from "@repo/lib/harness/types";
import {
  getOpenCodeDbWatchFiles,
  getOpenCodeHome,
} from "../collectors/opencode/opencode-home.js";
import type {
  OpencodeDroppedSession,
  OpencodeSessionLoad,
} from "../collectors/opencode/opencode-parse-failure.js";
import {
  loadOpencodeSessionsFromDb,
  type OpencodeParentLinkRead,
  OpencodeParentLinkReadStatus,
  readSessionParentLinks,
} from "../collectors/opencode/opencode-parser.js";
import {
  isChildSession,
  OPENCODE_SESSION_ID_PREFIX,
  rawSessionId,
  resolveRootRawId,
} from "../collectors/opencode/opencode-session-graph.js";
import {
  subagentFileKey,
  TRANSCRIPT_MAIN_FILE_KEY,
} from "./transcript-sync-types.js";

/**
 * Projection-format revision, folded into the checkpoint fingerprint.
 *
 * ISS-5238 (wongk review): the fingerprint was `name:mtimeMs:size` over the DB
 * files ONLY, so it answered "did `opencode.db` change?" and nothing else. An
 * install upgrading to a build with a CORRECTED serializer — or a corrected
 * parser feeding it — matched its old checkpoint against an untouched store,
 * returned early, and kept serving the stale `.jsonl` the cloud rejects until
 * the user happened to touch that OpenCode store again. This lane has no second
 * repair path: unlike sessions, which `DATA_REVISION` rebuilds on boot, the
 * fingerprint IS the only gate here, and `DATA_REVISION` does not reach it.
 *
 * BUMP THIS whenever the projection this module emits can change for an
 * UNCHANGED `opencode.db` — the BYTES (a serializer or record-shape change here,
 * or a parser change that alters the parsed session content those records are
 * built from, i.e. alongside a `DATA_REVISION` bump) or the IDENTITY the bytes
 * are filed under (a change to `resolveTarget`/the root walk that moves a
 * session's `(externalSessionId, fileKey)`). Both leave an install serving a
 * pre-upgrade layout the current build would never produce, and the fingerprint
 * gate is the only thing that would otherwise re-derive it. One bump invalidates
 * every existing checkpoint exactly once; the re-derived body is then
 * byte-compared before any write, so an unchanged projection costs no rewrite
 * and no re-upload.
 *
 * Revision history:
 *  1. ISS-5238 (F5) — `resolveOpencodeDiffStats` stops emitting a NaN/negative
 *     `diffStats`. A `NaN` serialized as `null` into the session header line,
 *     which the cloud's `diffStatsSchema` (`z.number()`) rejects, discarding the
 *     ENTIRE session. Existing projections carry that header until re-derived.
 *  2. ISS-5337 (review) — an IDENTITY change, not a byte change: a malformed
 *     PARENT CYCLE now re-roots to the lexicographically smallest id on the
 *     cycle instead of to whichever member the walk entered at, so a store
 *     carrying one files its children under a different `externalSessionId`.
 *     Without this bump, such an install's fingerprint still matches and it
 *     keeps serving the pre-upgrade layout — the one the collector lane never
 *     produced — until its `opencode.db` happens to change again, which is the
 *     opposite of the cross-lane parity that re-root exists to establish.
 */
const OPENCODE_PROJECTION_REVISION = 2;

/**
 * Per-session serialized-body ceiling (256 MiB). A pathological session must not
 * be allowed to build an unbounded string and spike the heap of whatever process
 * hosts the pass. A session whose projection would exceed this is skipped
 * (logged, fingerprint withheld) — the archive lane's own
 * `TRANSCRIPT_SYNC_MAX_FILE_BYTES` backstop would dead-letter such a file
 * downstream anyway, so there is no point materializing it. Set far above any
 * realistic OpenCode session; only a runaway trips it.
 */
const TRANSCRIPT_MATERIALIZE_MAX_SESSION_BYTES = 256 * 1024 * 1024;

/**
 * The channel prefix the shared OpenCode loader stamps on diagnostics raised for
 * THIS lane. The loader defaults to the collector's monitored import-failure
 * event, which would misattribute a transcript-sync degradation to the collector.
 */
const MATERIALIZE_LOAD_LOG_PREFIX = "opencode materialize load";

/** Injectable seams so the materializer is unit-testable without real disk/DB. */
export type OpencodeMaterializerDeps = {
  /**
   * Parse every session from `opencode.db` (default: the real DB loader).
   *
   * ISS-5238 (F3): this returns the LOAD, not a bare array, because the prune
   * below deletes every projection the load did not account for. A session the
   * parser dropped is indistinguishable from one deleted out of `opencode.db`
   * unless the loader says which is which.
   */
  loadSessions?: () => OpencodeSessionLoad;
  /**
   * Read `(id, parent_id)` linkage, REPORTING WHY it is empty (default: the real
   * DB reader). ISS-4649 (wongk review): this deliberately does NOT use the
   * legacy `loadSessionParentLinksFromDb` shim, which flattens a FAILED read to
   * the same `[]` a legacy no-`parent_id` DB yields. On this caller that
   * conflation is destructive, not just lossy: an empty map re-files every
   * subagent as its own root `main.jsonl`, `pruneStaleProjections` then deletes
   * the `subagent:<childId>.jsonl` files that were correct one tick ago, and
   * because every write "succeeded" the fingerprint advances — so the next sweep
   * matches the checkpoint, returns early, and the flattened graph is frozen in
   * until the DB's mtime/size moves again.
   */
  readParentLinks?: () => OpencodeParentLinkRead;
  /** OpenCode data dir holding `opencode.db` + WAL/SHM (default: live home). */
  openCodeHome?: () => string;
  /** Filesystem seam (default: real `node:fs`). */
  fsImpl?: OpencodeMaterializerFs;
  /** Best-effort diagnostic sink. */
  log?: (message: string) => void;
};

/** The materialized root for OpenCode projections under a state dir. */
export function opencodeMaterializedRoot(stateDir: string): string {
  return path.join(stateDir, "transcript-materialized", "opencode");
}

/** The persisted fingerprint file for the OpenCode materializer under a state dir. */
export function opencodeMaterializerFingerprintPath(stateDir: string): string {
  return path.join(stateDir, "materialize-opencode-fingerprint.txt");
}

/**
 * Serialize one `NormalizedSession` to its full ordered JSONL body (records in a
 * stable order: header, messages, tool uses, tokens, api errors, tool errors,
 * turn durations). Ends with a trailing newline so the archive lane's
 * complete-line boundary sees every record.
 */
export function serializeSessionToJsonl(session: NormalizedSession): string {
  const records: OpencodeMaterializedRecord[] = [
    buildOpencodeSessionRecord({
      sessionId: session.sessionId,
      name: session.name,
      cwd: session.cwd,
      model: session.model,
      version: session.version,
      slug: session.slug,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      userMessages: session.userMessages,
      assistantMessages: session.assistantMessages,
      thinkingBlockCount: session.thinkingBlockCount,
      permissionMode: session.permissionMode,
      entrypoint: session.entrypoint,
      fileModifiedAt: session.fileModifiedAt,
      tokensByModel: session.tokensByModel,
      messageTimestamps: session.messageTimestamps,
      diffStats: session.diffStats,
    }),
  ];
  for (const message of session.messages) {
    records.push(buildOpencodeMessageRecord(message));
  }
  for (const toolUse of session.toolUses) {
    records.push(buildOpencodeToolUseRecord(toolUse));
  }
  for (const token of session.tokenSeries) {
    records.push(buildOpencodeTokenRecord(token));
  }
  for (const apiError of session.apiErrors) {
    records.push(buildOpencodeApiErrorRecord(apiError));
  }
  for (const toolError of session.toolResultErrors) {
    records.push(buildOpencodeToolErrorRecord(toolError));
  }
  for (const turn of session.turnDurations) {
    records.push(buildOpencodeTurnDurationRecord(turn));
  }
  return `${records.map(serializeOpencodeMaterializedRecord).join("\n")}\n`;
}

/**
 * `rev:<n>` + a name:mtimeMs:size fingerprint over the DB + WAL/SHM siblings
 * (collector parity). The revision leads so a build whose projection FORMAT
 * changed cannot match a checkpoint written by the previous build against an
 * untouched store — see {@link OPENCODE_PROJECTION_REVISION}.
 */
function fingerprintDbFiles(
  home: string,
  fsImpl: NonNullable<OpencodeMaterializerDeps["fsImpl"]>
): string {
  const parts: string[] = [`rev:${OPENCODE_PROJECTION_REVISION}`];
  for (const name of getOpenCodeDbWatchFiles()) {
    try {
      const stat = fsImpl.statSync(path.join(home, name));
      parts.push(`${name}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${name}:missing`);
    }
  }
  return parts.join("|");
}

/**
 * Compute the target file key (`main` or `subagent:<rawId>`) and owning
 * externalSessionId for one session, given the parent linkage. A root session
 * owns `main`; a child owns `subagent:<its raw id>` under its ROOT's
 * externalSessionId.
 *
 * ISS-5337: the child test and the root walk come from
 * `collectors/opencode/opencode-session-graph.ts`, shared with the collector's
 * local fold. The two lanes nest differently on purpose but MUST agree on which
 * session is a child and which root owns it (`collectors/AGENTS.md` parity), and
 * `rootCache` memoizes the walk so siblings of one parent don't each re-walk the
 * chain (ISS-4649 finding 7, previously only fixed in the collector lane).
 */
function resolveTarget(
  session: NormalizedSession,
  parentById: ReadonlyMap<string, string | null>,
  rootCache: Map<string, string>
): { externalSessionId: string; fileKey: string } {
  const rawId = rawSessionId(session.sessionId);
  if (!isChildSession(rawId, parentById)) {
    return {
      externalSessionId: session.sessionId,
      fileKey: TRANSCRIPT_MAIN_FILE_KEY,
    };
  }
  const rootRawId = resolveRootRawId(rawId, parentById, rootCache);
  return {
    externalSessionId: `${OPENCODE_SESSION_ID_PREFIX}${rootRawId}`,
    fileKey: subagentFileKey(rawId),
  };
}

/**
 * Assert that `child` (the joined target file) stays inside `root`. Both
 * `externalSessionId` and `fileKey` derive from foreign `opencode.db` ids, so a
 * value carrying `../` (or an absolute path) could otherwise escape the
 * materialized root before mkdir/write. Verifying canonical containment at this
 * boundary — not trusting the raw id — closes that traversal hole (matches the
 * anchor guard's `isPathInside`). Throws so the per-session catch logs + skips.
 */
function assertContained(root: string, child: string): void {
  const relative = path.relative(root, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`materialize target escapes root: ${child}`);
  }
}

/**
 * Write one session's projection if its content changed. Best-effort per session.
 *
 * TRAVERSAL: the `externalSessionId`/`fileKey` come from foreign SQLite ids, so
 * the joined target is containment-checked against `root` before any mkdir/write.
 *
 * ATOMIC: publishes through a same-directory temp file plus `rename` so a
 * concurrent staging read (the archive lane's checksum/upload) never sees
 * truncated bytes from a half-finished in-place write. `rename` is atomic on the
 * same filesystem, and the materialized root and temp share a directory.
 */
function writeSessionFile(
  root: string,
  externalSessionId: string,
  fileKey: string,
  body: string,
  fsImpl: NonNullable<OpencodeMaterializerDeps["fsImpl"]>
): void {
  const dir = path.join(root, externalSessionId);
  const filePath = path.join(dir, `${fileKey}.jsonl`);
  assertContained(root, filePath);
  // Skip the write when the on-disk content already matches — keeps mtime stable
  // so the archive lane's fingerprint sees no change and does not re-upload.
  try {
    if (
      fsImpl.existsSync(filePath) &&
      fsImpl.readFileSync(filePath, "utf8") === body
    ) {
      return;
    }
  } catch {
    // Unreadable existing file: fall through and rewrite it.
  }
  fsImpl.mkdirSync(dir, { recursive: true });
  // Same-directory temp + atomic rename so a concurrent staging read never
  // observes a partially-written file. The temp is uniquely named so two
  // sweeps racing the same target don't clobber each other's temp.
  const tempPath = path.join(
    dir,
    `.${fileKey}.jsonl.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fsImpl.writeFileSync(tempPath, body);
    fsImpl.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fsImpl.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort temp cleanup; nothing else to do.
    }
    throw error;
  }
}

/** One session resolved to the projection identity it will publish under. */
type PlannedProjection = {
  session: NormalizedSession;
  externalSessionId: string;
  fileKey: string;
};

/**
 * Resolve every session to its projection identity WITHOUT touching the disk.
 *
 * ISS-5337 (review): this exists so the whole `expected` set is known before the
 * prune runs — see {@link materializeOpencodeTranscripts} for why the prune has
 * to precede the writes. Target resolution is pure map/string work
 * (`opencode-session-graph.ts`), so hoisting it out of the write loop costs
 * nothing and no longer needs the disk to be in any particular state.
 *
 * An identity is reserved in `expected` BEFORE the size gate (which lives in the
 * write phase) so an oversized session's prior valid file is not pruned.
 * `allPlanned` is `false` if any session could not be resolved — the caller
 * withholds the fingerprint. Never throws (best-effort per session).
 */
function planProjections(
  sessions: readonly NormalizedSession[],
  parentById: ReadonlyMap<string, string | null>,
  preserved: PreservedProjections,
  log: (message: string) => void
): {
  expected: Set<string>;
  planned: PlannedProjection[];
  allPlanned: boolean;
} {
  const expected = new Set<string>();
  const planned: PlannedProjection[] = [];
  // Shared for the whole pass so sibling children of one parent reuse the walk
  // (ISS-5337). Scoped to the pass, not module-level: `parentById` is rebuilt
  // from `opencode.db` on every sweep, so a cache outliving it could answer with
  // a root the linkage no longer has.
  const rootCache = new Map<string, string>();
  let allPlanned = true;
  for (const session of sessions) {
    try {
      const { externalSessionId, fileKey } = resolveTarget(
        session,
        parentById,
        rootCache
      );
      // ISS-5238 (F2, review): the collector WITHHOLDS a dropped root's children
      // rather than re-flattening them to top level, so this lane must agree on
      // what a dropped root means. Publishing them here would archive a child's
      // turns under an `externalSessionId` whose `main.jsonl` will never exist —
      // a session the desktop corpus has no record of — which is a worse lie than
      // the misattribution the withhold exists to avoid. `preserved.sessionDirs`
      // holds exactly the dropped roots' directories, and the prune skips that
      // whole directory, so an ALREADY-correct child projection there survives
      // untouched; it simply is not republished under a phantom parent.
      if (preserved.sessionDirs.has(externalSessionId)) {
        log(
          `opencode materialize withheld ${session.sessionId}: its root ${externalSessionId} failed to parse this load, so publishing it would archive a subagent under a session that has no record`
        );
        continue;
      }
      expected.add(projectionKey(externalSessionId, fileKey));
      planned.push({ session, externalSessionId, fileKey });
    } catch (error) {
      allPlanned = false;
      log(
        `opencode materialize skipped ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { expected, planned, allPlanned };
}

/**
 * Publish every planned projection, returning whether ALL of them landed
 * (withhold the fingerprint otherwise). Each session is independently guarded so
 * one bad session never aborts the batch.
 */
function writePlannedProjections(
  planned: readonly PlannedProjection[],
  root: string,
  fsImpl: NonNullable<OpencodeMaterializerDeps["fsImpl"]>,
  log: (message: string) => void
): boolean {
  let allWritesSucceeded = true;
  for (const target of planned) {
    if (!writeOnePlannedProjection(target, root, fsImpl, log)) {
      allWritesSucceeded = false;
    }
  }
  return allWritesSucceeded;
}

/**
 * Serialize and publish ONE planned projection unless its body exceeds the
 * per-session cap. Returns `false` when the session was skipped (oversize) or
 * the write threw. Never throws (best-effort per session).
 */
function writeOnePlannedProjection(
  target: PlannedProjection,
  root: string,
  fsImpl: NonNullable<OpencodeMaterializerDeps["fsImpl"]>,
  log: (message: string) => void
): boolean {
  try {
    const body = serializeSessionToJsonl(target.session);
    if (body.length > TRANSCRIPT_MATERIALIZE_MAX_SESSION_BYTES) {
      log(
        `opencode materialize skipped ${target.session.sessionId}: projection ${body.length} bytes exceeds ${TRANSCRIPT_MATERIALIZE_MAX_SESSION_BYTES}-byte cap`
      );
      return false;
    }
    writeSessionFile(
      root,
      target.externalSessionId,
      target.fileKey,
      body,
      fsImpl
    );
    return true;
  } catch (error) {
    log(
      `opencode materialize skipped ${target.session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Materialize every OpenCode session into `<root>/<externalSessionId>/<fileKey>.jsonl`.
 * Revision-gated on the DB fingerprint: returns early (writing nothing) when the
 * fingerprint is unchanged since the last run, so an untouched DB never triggers
 * a re-upload. Each session's write is guarded so one failure can't abort the
 * batch or throw into the sweep.
 *
 * ISS-5337: this is synchronous from top to bottom and, because the fingerprint
 * is store-wide, one new message re-derives the whole corpus — so it is NOT run
 * on the Electron main process. `opencode-materialize-worker.ts` is its only
 * production caller and hosts it in a utilityProcess; keep it that way rather
 * than calling it inline from the main process again.
 */
export function materializeOpencodeTranscripts(
  stateDir: string,
  deps: OpencodeMaterializerDeps = {}
): void {
  const fsImpl = deps.fsImpl ?? fs;
  const log = deps.log ?? (() => undefined);
  const loadSessions =
    deps.loadSessions ??
    (() =>
      loadOpencodeSessionsFromDb(undefined, {
        log,
        logPrefix: MATERIALIZE_LOAD_LOG_PREFIX,
      }));
  const readParentLinks = deps.readParentLinks ?? readSessionParentLinks;
  const home = (deps.openCodeHome ?? getOpenCodeHome)();

  const fingerprint = fingerprintDbFiles(home, fsImpl);
  const fingerprintPath = opencodeMaterializerFingerprintPath(stateDir);
  let lastFingerprint: string | null = null;
  try {
    lastFingerprint = fsImpl.readFileSync(fingerprintPath, "utf8");
  } catch {
    lastFingerprint = null;
  }
  if (fingerprint === lastFingerprint) {
    return;
  }

  let load: OpencodeSessionLoad;
  let parentLinkRead: OpencodeParentLinkRead;
  try {
    load = loadSessions();
    parentLinkRead = readParentLinks();
  } catch (error) {
    log(
      `opencode materialize load failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  // ISS-4649 (wongk review): a FAILED linkage read is not a legacy DB. Bail
  // BEFORE any write, prune, or checkpoint — writing on an empty map would
  // re-root every subagent, the prune would then delete the correct
  // `subagent:<childId>.jsonl` projections, and the fingerprint would advance
  // past the damage so no later sweep repairs it. Returning here leaves the
  // fingerprint unadvanced and every existing projection untouched, so the next
  // sweep retries the same DB. A genuinely `Legacy` DB (no `parent_id` column)
  // still materializes flat, which is correct for it.
  if (parentLinkRead.status === OpencodeParentLinkReadStatus.Unreadable) {
    const cause = parentLinkRead.error;
    log(
      `opencode materialize skipped: parent linkage unreadable (${cause instanceof Error ? cause.message : String(cause)}); leaving projections and fingerprint untouched`
    );
    return;
  }

  const links =
    parentLinkRead.status === OpencodeParentLinkReadStatus.Linked
      ? parentLinkRead.links
      : [];
  const parentById = new Map<string, string | null>(
    links.map((link) => [link.sessionId, link.parentId])
  );
  const root = opencodeMaterializedRoot(stateDir);

  // ISS-5238 (F3): `expected` below is built ONLY from what the load returned, so
  // a session the parser dropped is indistinguishable from one deleted out of
  // `opencode.db` — and an UNSCOPED prune would `rmSync` its previously-CORRECT
  // `main.jsonl`, then the fingerprint would advance past the damage and no later
  // sweep would repair it. That is destructive, not merely lossy, and it violates
  // the invariant this file's header states. ISS-4649 guarded the linkage read
  // returning `Unreadable`; nothing guarded the session load returning a SHORT
  // list. `preserved` is computed FIRST because the write pass consults it too:
  // a dropped root's directory takes no new publishes (F2 lane agreement).
  const preserved = buildPreservedProjections(load.droppedSessions);
  if (load.droppedSessions.length > 0) {
    log(
      `opencode materialize incomplete: ${load.droppedSessions.length} session(s) failed to parse (${load.droppedSessions.map((dropped) => dropped.sessionId).join(", ")}); preserving their existing projections and pruning the rest of the store`
    );
  }

  // Resolve every session to its projection identity first — pure map/string
  // work, no disk — so the EXPECTED set is complete before anything is deleted
  // or published.
  const { expected, planned, allPlanned } = planProjections(
    load.sessions,
    parentById,
    preserved,
    log
  );
  // Prune projections whose owning session was deleted or reparented (its file
  // key moved) so a stale file cannot keep archiving under an old identity. A
  // prune failure withholds the fingerprint so the stale file is retried on the
  // next sweep.
  //
  // ISS-5337 (review): the prune runs BEFORE the writes, and that ordering is
  // load-bearing now that the pass is hosted in a killable utilityProcess. The
  // reparent case is a delete HERE plus a write THERE, and the runner's timeout
  // and `stop()` both settle onto the same path that kills the child — so with
  // the writes first, a kill landing between them leaves the child published at
  // its NEW identity while the copy at its OLD one is still on disk. Nothing
  // downstream would notice: `listOpencodeMaterializedFiles` enumerates every
  // `.jsonl` under every session dir with no expected-set to check against, and
  // `runMaterialize` deliberately swallows the rejection, so the same sweep
  // walks straight into `discover()` and archives the session under BOTH roots
  // — verbatim the double-publish this prune exists to prevent. Deleting first
  // makes the torn state an ABSENCE instead: the fingerprint is unadvanced, so
  // the next sweep re-derives and republishes. A stale duplicate is a lie about
  // the session graph that survives to the cloud; a projection that is briefly
  // missing from a lane that is eventually consistent by construction is not.
  //
  // A lossy load SCOPES this prune, it does not skip it. A dropped session is
  // durable by construction (a retryable read failure throws out of the load
  // instead, and is caught above without checkpointing), so a store-wide skip
  // would not defer the prune for one sweep — it would disable it for the WHOLE
  // store for as long as that row exists, because the skip still lets the
  // fingerprint advance. Every OTHER session's deleted or reparented projection
  // would then keep archiving forever under its old identity, and a reparented
  // child would archive under BOTH identities (the double-publish this file's
  // header exists to prevent). `preserved` freezes only what the dropped sessions
  // themselves own, so one malformed row cannot veto the rest of the cleanup.
  const pruneClean = pruneStaleProjections(
    root,
    expected,
    preserved,
    fsImpl,
    log
  );

  // Publish LAST. Republishing the sessions that DID parse is additive and
  // cannot destroy anything.
  const writesOk = writePlannedProjections(planned, root, fsImpl, log);

  // Only advance the fingerprint when EVERY expected projection published (and
  // the plan and prune ran clean). Leaving it unadvanced on a partial failure
  // means the next unchanged-DB sweep re-attempts the skipped session instead of
  // matching the checkpoint and returning early — otherwise a transient
  // EACCES/disk-full write would strand that transcript unmaterialized until the
  // DB changes again.
  if (!(allPlanned && pruneClean && writesOk)) {
    return;
  }

  // Persist the fingerprint LAST so a crash mid-write re-materializes next run
  // (an unchanged DB then still re-derives identical bytes — idempotent).
  try {
    fsImpl.mkdirSync(path.dirname(fingerprintPath), { recursive: true });
    fsImpl.writeFileSync(fingerprintPath, fingerprint);
  } catch {
    // Best-effort: an unwritable state dir just costs one extra materialize.
  }
}

/** Stable `(externalSessionId, fileKey)` identity for the expected-projection set. */
function projectionKey(externalSessionId: string, fileKey: string): string {
  return `${externalSessionId}/${fileKey}`;
}

/**
 * Delete materialized `.jsonl` files under `root` whose `(externalSessionId,
 * fileKey)` is no longer in `expected` — the owning session was deleted, or a
 * child was reparented so its file key moved. Without this, discovery keeps
 * enumerating the old projection and the archive lane re-uploads a session that
 * no longer exists (or archives a reparented child under BOTH its old and new
 * root). Non-`.jsonl` entries are ignored, except ABANDONED publish temps, which
 * are reaped (ISS-5337 — see {@link isAbandonedPublishTemp}). Anything
 * `preserved` claims is left alone — those belong to a session this load
 * DROPPED, so `expected` cannot vouch for them and deleting them is
 * unrecoverable. Returns `false` if any enumeration/delete failed so the caller
 * can withhold the fingerprint (the stale file is retried on the next sweep). An
 * absent root (no sessions materialized yet) is a clean no-op.
 */
function pruneStaleProjections(
  root: string,
  expected: ReadonlySet<string>,
  preserved: PreservedProjections,
  fsImpl: NonNullable<OpencodeMaterializerDeps["fsImpl"]>,
  log: (message: string) => void
): boolean {
  let sessionDirs: OpencodeMaterializerDirent[];
  try {
    sessionDirs = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch {
    // Root absent (nothing materialized yet) — nothing to prune.
    return true;
  }
  let clean = true;
  for (const sessionDir of sessionDirs) {
    if (!sessionDir.isDirectory()) {
      continue;
    }
    // A dropped ROOT owns its whole directory: its own `main.jsonl` plus the
    // `subagent:*` files of children whose linkage we can no longer resolve.
    if (preserved.sessionDirs.has(sessionDir.name)) {
      continue;
    }
    if (
      !pruneSessionDir(root, sessionDir.name, expected, preserved, fsImpl, log)
    ) {
      clean = false;
    }
  }
  return clean;
}

/**
 * Prune stale `.jsonl` projections inside ONE session directory, and reap
 * abandoned publish temps. Returns `false` if the directory could not be read or
 * any projection delete failed (so the caller withholds the fingerprint). Other
 * non-`.jsonl` entries, files still in `expected`, and files `preserved` claims
 * are left untouched.
 */
function pruneSessionDir(
  root: string,
  externalSessionId: string,
  expected: ReadonlySet<string>,
  preserved: PreservedProjections,
  fsImpl: NonNullable<OpencodeMaterializerDeps["fsImpl"]>,
  log: (message: string) => void
): boolean {
  const dirPath = path.join(root, externalSessionId);
  let entries: OpencodeMaterializerDirent[];
  try {
    entries = fsImpl.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }
  let clean = true;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (isAbandonedPublishTemp(entry.name)) {
      reapAbandonedPublishTemp(dirPath, entry.name, fsImpl, log);
      continue;
    }
    if (!entry.name.endsWith(".jsonl")) {
      continue;
    }
    const fileKey = entry.name.slice(0, -".jsonl".length);
    if (expected.has(projectionKey(externalSessionId, fileKey))) {
      continue;
    }
    // A dropped CHILD keeps its `subagent:<rawId>` file under whichever root
    // still owns it — the load never republished it, so it is not in `expected`.
    if (preserved.fileKeys.has(fileKey)) {
      continue;
    }
    try {
      fsImpl.rmSync(path.join(dirPath, entry.name), { force: true });
    } catch (error) {
      clean = false;
      log(
        `opencode materialize prune failed ${externalSessionId}/${entry.name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return clean;
}

/** The `readdirSync(…, { withFileTypes: true })` entry shape this module reads. */
export type OpencodeMaterializerDirent = {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
};

/**
 * The `node:fs` surface this module actually calls, declared structurally rather
 * than as `Pick<typeof fs, …>`. The `Pick` form pulls in every `node:fs` overload
 * — including the `bigint`/`BigIntStats` and Buffer-returning ones this module
 * never invokes — so no in-memory test double can satisfy it without lying about
 * the contract. Real `node:fs` stays assignable to this narrower seam (it is
 * still the default at the `deps.fsImpl ?? fs` call site).
 */
export type OpencodeMaterializerFs = {
  existsSync: (target: string) => boolean;
  statSync: (target: string) => { mtimeMs: number; size: number };
  mkdirSync: (target: string, options: { recursive: true }) => void;
  writeFileSync: (target: string, data: string) => void;
  readFileSync: (target: string, encoding: "utf8") => string;
  renameSync: (from: string, to: string) => void;
  rmSync: (target: string, options: { force: true }) => void;
  readdirSync: (
    target: string,
    options: { withFileTypes: true }
  ) => OpencodeMaterializerDirent[];
};

/**
 * The projections a lossy load must NOT prune, scoped to the dropped sessions
 * themselves. `expected` cannot vouch for a session the parser dropped (it was
 * never republished this sweep), but its existing files are still correct and
 * deleting them is unrecoverable. Freezing only these — rather than skipping the
 * prune store-wide — keeps one malformed row from vetoing every other session's
 * cleanup for as long as that row exists in `opencode.db`.
 */
type PreservedProjections = {
  /** `externalSessionId` directories whose ROOT session was dropped. */
  sessionDirs: ReadonlySet<string>;
  /** `subagent:<rawId>` file keys of dropped children, under any root. */
  fileKeys: ReadonlySet<string>;
};

/**
 * Build the preserve set for one load. A dropped row never parsed, so its role
 * is unknown — it could own `<opencode-rawId>/main.jsonl` as a root or
 * `<some root>/subagent:<rawId>.jsonl` as a child. Both shapes are claimed.
 */
function buildPreservedProjections(
  droppedSessions: readonly OpencodeDroppedSession[]
): PreservedProjections {
  const sessionDirs = new Set<string>();
  const fileKeys = new Set<string>();
  for (const dropped of droppedSessions) {
    sessionDirs.add(`${OPENCODE_SESSION_ID_PREFIX}${dropped.sessionId}`);
    fileKeys.add(subagentFileKey(dropped.sessionId));
  }
  return { sessionDirs, fileKeys };
}

/** The `.<fileKey>.jsonl.<pid>.<ms>.tmp` publish temp, captured by owning pid. */
const PUBLISH_TEMP_RE = /\.(\d+)\.\d+\.tmp$/;

/**
 * ISS-5337: is this a publish temp left behind by a pass that no longer exists?
 *
 * `writeSessionFile` publishes through a same-directory temp + `rename` and
 * cleans the temp up in its own `catch` — which assumed the host process could
 * not vanish mid-write. Now that the pass runs in a killable utilityProcess (a
 * timeout, or `stop()` at shutdown), a SIGTERM between `writeFileSync` and
 * `renameSync` strands a temp of up to
 * {@link TRANSCRIPT_MATERIALIZE_MAX_SESSION_BYTES} that no prune, discovery, or
 * later pass would ever reclaim — and because the name embeds the pid and clock,
 * every kill strands a distinct one.
 *
 * Ownership is by pid, not age: a temp stamped with a DIFFERENT pid cannot
 * belong to the pass doing the pruning, so it is dead by construction, while the
 * running pass's own in-flight temps are never touched.
 */
function isAbandonedPublishTemp(name: string): boolean {
  const match = PUBLISH_TEMP_RE.exec(name);
  return match !== null && match[1] !== String(process.pid);
}

/**
 * Best-effort reap of one abandoned publish temp. Deliberately does NOT withhold
 * the fingerprint on failure: an orphan temp is wasted disk, not a projection
 * the archive lane can misread (discovery only enumerates `.jsonl`), so it must
 * not block a checkpoint the rest of the pass earned.
 */
function reapAbandonedPublishTemp(
  dirPath: string,
  name: string,
  fsImpl: NonNullable<OpencodeMaterializerDeps["fsImpl"]>,
  log: (message: string) => void
): void {
  try {
    fsImpl.rmSync(path.join(dirPath, name), { force: true });
  } catch (error) {
    log(
      `opencode materialize could not reap abandoned temp ${name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
