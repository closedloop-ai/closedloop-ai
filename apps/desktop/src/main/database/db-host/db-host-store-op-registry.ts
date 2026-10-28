import { z } from "zod";
import type { LocalPriorityWriteResult } from "../../../shared/local-priority-write-contract.js";
import { effectiveDataRevision } from "../../collectors/engine/effective-data-revision.js";
import {
  listPackSessions,
  listPacks,
  listSkillInvocations,
  listSkills,
  PackStoreReadOp,
  type PackStoreReadResult,
} from "../../packs/pack-store.js";
import { setEffectiveParsePolicy } from "../../parse-policy/effective-parse-policy.js";
import {
  PARSE_POLICY_SET_STORE_OP,
  readParsePolicy,
} from "../../parse-policy/parse-policy.js";
import {
  branchListSnapshotRequestSchema,
  readBranchListSnapshot,
} from "../branch-list-snapshot-read.js";
import {
  INGEST_BATCH_RESUME_CURSOR_WRITE_OP,
  ingestBatchResumeCursorWriteArgsSchema,
  writeIngestBatchResumeCursor,
} from "../ingest-batch-resume-cursor-store.js";
import {
  LOCAL_BRANCH_PRIORITY_WRITE_STORE_OP,
  LOCAL_SESSION_PRIORITY_WRITE_STORE_OP,
  localBranchPriorityWriteArgsSchema,
  localSessionPriorityWriteArgsSchema,
  writeLocalBranchPriority,
  writeLocalSessionPriority,
} from "../local-priority-store.js";
import {
  recordThreadViewed,
  SESSION_VIEWERSHIP_RECORD_STORE_OP,
  sessionViewershipRecordArgsSchema,
} from "../session-viewership-store.js";
import type { SqliteAgentDatabase } from "../sqlite.js";

export type DbHostStoreOpRegistry = Record<
  string,
  (db: SqliteAgentDatabase, args: unknown[]) => Promise<unknown>
>;

/** Prefix for clone-safe store operations sent through DB-host invoke IPC. */
export const DB_HOST_STORE_OP_PREFIX = "store:";

/** Side-effect-free read operations installed into the DB-host registry. */
const sideEffectFreeStoreOps: DbHostStoreOpRegistry = {
  "branches.listSnapshot": (db, args) => {
    const request = branchListSnapshotRequestSchema.parse(args[0]);
    return readBranchListSnapshot(db.prisma, request);
  },
};

/**
 * Execute a production `store:` IPC operation, resolving the ops this module
 * owns before the registry the worker injects.
 *
 * `storeKey` is sliced off an IPC-supplied string, so neither lookup may reach an
 * INHERITED member: on a plain object literal `store:constructor` resolves to
 * `Object` and `store:__proto__` to `Object.prototype`, both truthy, so the
 * not-found guard below is skipped and the op is called. {@link childStoreOps}
 * is prototype-less; `registry` is a literal the worker injects, so it is read
 * through `Object.hasOwn`.
 */
export function dispatchDbHostStoreOp(
  registry: DbHostStoreOpRegistry,
  db: SqliteAgentDatabase,
  op: string,
  args: unknown[]
): Promise<unknown> {
  if (!op.startsWith(DB_HOST_STORE_OP_PREFIX)) {
    throw new Error(`db-host store op must use ${DB_HOST_STORE_OP_PREFIX}`);
  }
  const storeKey = op.slice(DB_HOST_STORE_OP_PREFIX.length);
  const storeOp =
    childStoreOps[storeKey] ??
    (Object.hasOwn(registry, storeKey) ? registry[storeKey] : undefined);
  if (!storeOp) {
    throw new Error(`db-host store op not found: ${op}`);
  }
  return storeOp(db, args);
}

/**
 * The lone argument both id-taking pack reads accept. `z.string()` and not
 * `.min(1)`: an empty name already resolves to an empty result set in both
 * queries, and rejecting it here would turn a benign no-match into a thrown op.
 */
const packStoreIdArgsSchema = z.tuple([z.string()]);

/**
 * ISS-6753 — the Packs/Skills page reads, which run on the READER POOL
 * (`prisma.read`) rather than the writer-bound `prisma.client`. Why that routing
 * is right is recorded once, on `PackReaderPrisma` in `packs/pack-store.ts`.
 *
 * They are `store:` ops for the same reason the sibling `branches.listSnapshot`
 * is. `DbHostPrisma` (main's view through the db-host proxy) deliberately omits
 * `read`, because its callback cannot be structured-cloned across IPC, so the
 * whole read executes HERE, in the db-host process that owns the connections.
 *
 * They run UNGATED, like every store op outside `HEAVY_STORE_OPS`
 * (`db-host-op-lanes.ts` routes the store surface exclusive-or-immediate, and
 * `db-host-op-lane-registry.ts` states `store:` ops are outside the bounded
 * lane's key space). Their ADMISSION is therefore unchanged — a
 * `prisma.client.$queryRawUnsafe` forwarded through the generic invoke path was
 * ungated too — but the connection they contend for is not: an unbounded pack
 * scan now occupies one of the reader connections the BOUNDED_READ_OPS
 * `dashboard.*` reads draw from, so a bounded read can wait on it while holding
 * its own permit. That is the ISS-5941 "heavy ops that reach the worker outside
 * a named namespace" gap, recorded rather than claimed away; closing it needs a
 * bounded lane for the store surface, not an edit here.
 */
const packStoreReadOps = {
  [PackStoreReadOp.ListPacks]: (db) => listPacks(db.prisma),
  [PackStoreReadOp.ListSkills]: (db) => listSkills(db.prisma),
  [PackStoreReadOp.ListSkillInvocations]: (db, args) => {
    const [name] = packStoreIdArgsSchema.parse(args);
    return listSkillInvocations(db.prisma, name);
  },
  [PackStoreReadOp.ListPackSessions]: (db, args) => {
    const [packId] = packStoreIdArgsSchema.parse(args);
    return listPackSessions(db.prisma, packId);
  },
  // ISS-6753: `satisfies`, not an annotation, so each handler's return type is
  // checked against the op's declared `PackStoreReadResult` entry. An op pointed
  // at the wrong store function is then a compile error rather than a shape the
  // main-side handler asserts with `as` and the renderer receives.
} satisfies {
  [K in PackStoreReadOp]: (
    db: SqliteAgentDatabase,
    args: unknown[]
  ) => Promise<PackStoreReadResult[K]>;
};

/**
 * ISS-9839 — the ISS-5161 batch-resume cursor flush, a `store:` op for the same
 * reason as the viewership capture below: `DbHostPrisma` (main's view through
 * the proxy) omits `write`, and the collector engine that flushes this cursor
 * runs in MAIN.
 */
const ingestBatchResumeCursorStoreOps: DbHostStoreOpRegistry = {
  [INGEST_BATCH_RESUME_CURSOR_WRITE_OP]: async (db, args) => {
    const [payload] = ingestBatchResumeCursorWriteArgsSchema.parse(args);
    await writeIngestBatchResumeCursor(db.prisma, payload);
    return null;
  },
} satisfies Record<
  typeof INGEST_BATCH_RESUME_CURSOR_WRITE_OP,
  (db: SqliteAgentDatabase, args: unknown[]) => Promise<null>
>;

/**
 * ISS-7830 — the thread-viewership capture, a `store:` op because it WRITES:
 * `DbHostPrisma` (main's view through the proxy) omits `write`, so the insert has
 * to execute here, in the process that owns the writer connection.
 */
const sessionViewershipStoreOps: DbHostStoreOpRegistry = {
  [SESSION_VIEWERSHIP_RECORD_STORE_OP]: (db, args) => {
    const [sessionId, viewedAt] = sessionViewershipRecordArgsSchema.parse(args);
    return recordThreadViewed(db.prisma, sessionId, viewedAt);
  },
} satisfies Record<
  typeof SESSION_VIEWERSHIP_RECORD_STORE_OP,
  (db: SqliteAgentDatabase, args: unknown[]) => Promise<boolean>
>;

/**
 * ISS-10332 — the local-mode priority writes, `store:` ops because they WRITE.
 * The args are re-parsed here: the db-host child is a process boundary.
 */
const localPriorityStoreOps: DbHostStoreOpRegistry = {
  [LOCAL_SESSION_PRIORITY_WRITE_STORE_OP]: (db, args) => {
    const [request, writtenAt] =
      localSessionPriorityWriteArgsSchema.parse(args);
    return writeLocalSessionPriority(db.prisma, request, writtenAt);
  },
  [LOCAL_BRANCH_PRIORITY_WRITE_STORE_OP]: (db, args) => {
    const [request, writtenAt] = localBranchPriorityWriteArgsSchema.parse(args);
    return writeLocalBranchPriority(db.prisma, request, writtenAt);
  },
} satisfies Record<
  | typeof LOCAL_SESSION_PRIORITY_WRITE_STORE_OP
  | typeof LOCAL_BRANCH_PRIORITY_WRITE_STORE_OP,
  (
    db: SqliteAgentDatabase,
    args: unknown[]
  ) => Promise<LocalPriorityWriteResult>
>;

/**
 * The ops this module owns, in one prototype-less table. A merged lookup rather
 * than a `??` chain per domain: the chain grew one clause every time a domain
 * was added, and a key present in two of them resolved by clause order with no
 * diagnostic. Later spreads still win a collision — but there is now one place
 * to look for one.
 */
/**
 * ISS-12552 (PRD-800 "Rollout"): main's settled parse-policy flip. The
 * store thread is where every import, live-hook write and revision stamp
 * reads its process-local policy. Answers the revision it now stamps.
 */
const parsePolicyStoreOps: DbHostStoreOpRegistry = {
  [PARSE_POLICY_SET_STORE_OP]: (_db, args) => {
    setEffectiveParsePolicy(readParsePolicy(args[0]));
    return Promise.resolve(effectiveDataRevision());
  },
};

const childStoreOps: DbHostStoreOpRegistry = Object.assign(
  Object.create(null),
  sideEffectFreeStoreOps,
  parsePolicyStoreOps,
  packStoreReadOps,
  sessionViewershipStoreOps,
  ingestBatchResumeCursorStoreOps,
  localPriorityStoreOps
);
