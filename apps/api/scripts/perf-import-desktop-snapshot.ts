/**
 * ISS-5288 — seed the throwaway `closedloop_perf` database with the REAL
 * sessions from a desktop SQLite snapshot, in-process, through the api's own
 * ingest fold (Tamsin ruling, 2026-08-18).
 *
 * No desktop app, no sync route, no sockets, no auth. Each batch is handed
 * straight to `handleDesktopAgentSessionsEvent` — the exact function the sync
 * route's service calls — so the perf database is filled by the code under test
 * rather than by hand-rolled inserts that could drift from it.
 *
 * Two files land beside each other: the `--out` JSON summary, and a 0600
 * `credentials.json` carrying the `sk_live` bearer the measurement recipes
 * authenticate with (`just profile-web-stack` / `just profile-api` read
 * `.apiBearer` from it). The bearer is minted through the production
 * `apiKeysService` and is NEVER logged — only its path is.
 *
 * REFUSES BEFORE ANY DATABASE WRITE unless every one of these holds:
 *   - `DATABASE_URL` resolves to localhost / 127.0.0.1
 *   - `DATABASE_URL` names exactly the `closedloop_perf` database
 *   - `--snapshot` is a readable SQLite file holding a desktop schema
 *   - the `--out` directory is git-ignored (fail-CLOSED on any git failure)
 * All but the snapshot check live in `perf-import-desktop-snapshot-guards.ts`: a
 * mistyped host must never write session rows into a shared database, and a path
 * git would commit is not an acceptable home for a live bearer.
 *
 * NO INGEST GATE IS STUBBED. ISS-8022 removed a fail-closed PostHog rollout flag
 * that was unanswerable on an offline perf host, and ISS-11449 retired the
 * DB-backed org session-sync policy this import used to enable on the perf org.
 * Nothing is supplied to the handler now: the Zod parse and the whole
 * persistence fold run exactly as production does.
 *
 * RUN UNDER `--conditions=react-server`, as `pnpm perf:import-desktop-snapshot`
 * does. No module in the current graph carries `import "server-only"` — whose
 * `default` export throws by design outside Next — so the flag is DEFENSIVE:
 * this script reaches deep into the agent-sessions service graph, and one new
 * dependency edge is all it takes for the marker to reappear. Same flag and same
 * reason as the sweep in `.github/workflows/ready-to-enqueue.yml`.
 *
 * Usage (from `apps/api`):
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/closedloop_perf \
 *   npx tsx --conditions=react-server scripts/perf-import-desktop-snapshot.ts \
 *     --snapshot <path to agent-dashboard.sqlite> \
 *     --out ../../.perf/datasets/<run>/import-summary.json
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { Result } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { z } from "zod";
import { apiKeysService } from "@/app/api-keys/service";
import {
  DesktopAgentSessionsRateLimiter,
  handleDesktopAgentSessionsEvent,
} from "@/lib/desktop-agent-sessions-handler";
import { desktopAgentSessionsPayloadObjectSchema } from "@/lib/desktop-agent-sessions-schema";
import {
  checkDatabaseUrl,
  checkOutPathIsGitIgnored,
  GuardRefusalCode,
  PERF_API_KEY_NAME,
  type Refusal,
  type ResolvedIdentity,
  resolveIdentity,
  writeCredentialsFile,
} from "./perf-import-desktop-snapshot-guards";
import {
  mapSnapshotSession,
  type SkipTally,
} from "./perf-import-desktop-snapshot-mapping";
import {
  loadSnapshotBundles,
  openSnapshot,
  readSnapshotSessionIds,
} from "./perf-import-desktop-snapshot-reads";

/** Machine name of the deterministic compute target every import writes through. */
export const PERF_IMPORT_MACHINE_NAME = "perf-import";

/** Default sessions per batch. Bounded further by {@link BATCH_BYTE_BUDGET}. */
export const DEFAULT_BATCH_SIZE = 100;

/**
 * Soft byte ceiling for one batch's serialized sessions. The in-process fold has
 * no HTTP body limit, so this bounds peak memory rather than satisfying a route
 * cap; a single session larger than the budget still ships alone rather than
 * being split, because chunking is a producer concern this lane does not own.
 */
export const BATCH_BYTE_BUDGET = 3_000_000;

/** Snapshot-specific refusals, alongside the shared {@link GuardRefusalCode} set. */
export const ImportRefusalCode = {
  SnapshotMissing: "snapshot_missing",
  SnapshotUnreadable: "snapshot_unreadable",
  SnapshotNotDesktopSchema: "snapshot_not_desktop_schema",
  OutDirectoryMissing: "out_directory_missing",
} as const;
export type ImportRefusalCode =
  | (typeof ImportRefusalCode)[keyof typeof ImportRefusalCode]
  | GuardRefusalCode;

export type ImportRefusal = { code: ImportRefusalCode; message: string };

export type ImportArgs = {
  snapshot: string;
  out: string;
  organizationId?: string;
  userId?: string;
  batchSize: number;
};

/** Basename of the bearer handoff, written beside `--out`. */
export const PERF_CREDENTIALS_FILENAME = "credentials.json";

/**
 * The bearer handoff `just profile-web-stack` and `just profile-api` read. Key
 * names are the published contract — `apiBearer` is what those recipes `jq` out.
 */
export type PerfImportCredentials = {
  apiBearer: string;
  organizationId: string;
  userId: string;
};

export type ImportEnv = Readonly<Record<string, string | undefined>>;

/** One batch's outcome, as the fold reported it. */
export type BatchOutcome = {
  batchIndex: number;
  sentSessions: number;
  accepted: boolean;
  acceptedSessionCount?: number;
  reason?: string;
  detail?: string;
};

export type ImportSummary = {
  snapshot: string;
  organizationId: string;
  userId: string;
  computeTargetId: string;
  sessionsRead: number;
  sessionsSent: number;
  sessionsSkipped: number;
  batches: number;
  accepted: number;
  rejected: number;
  sessionsPersisted: number;
  skips: SkipTally;
  rejections: BatchOutcome[];
  elapsedMs: number;
};

const ARG_OPTIONS = {
  snapshot: { type: "string" },
  out: { type: "string" },
  "organization-id": { type: "string" },
  "user-id": { type: "string" },
  "batch-size": { type: "string" },
} as const;

const argsSchema = z.object({
  snapshot: z.string().min(1),
  out: z.string().min(1),
  organizationId: z.uuid().optional(),
  userId: z.uuid().optional(),
  batchSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(DEFAULT_BATCH_SIZE),
});

function refuse(code: ImportRefusalCode, message: string): ImportRefusal {
  return { code, message };
}

/** `{ key: value }` when the value is present, `{}` when it is not. */
function optional<K extends string>(
  key: K,
  value: string | undefined
): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/** Parse argv into a validated {@link ImportArgs}. Unknown flags are rejected. */
export function parseImportArgs(
  argv: string[]
): Result<ImportArgs, ImportRefusal> {
  const parsed = safeParseArgv(argv);
  if (!parsed.ok) {
    return parsed;
  }
  const values = parsed.value;
  const candidate = {
    snapshot: values.snapshot,
    out: values.out,
    ...optional("organizationId", values["organization-id"]),
    ...optional("userId", values["user-id"]),
    ...optional("batchSize", values["batch-size"]),
  };
  const validated = argsSchema.safeParse(candidate);
  if (!validated.success) {
    return Result.err(
      refuse(
        GuardRefusalCode.ArgsInvalid,
        `invalid arguments: ${z.prettifyError(validated.error)}`
      )
    );
  }
  return Result.ok(validated.data);
}

function safeParseArgv(
  argv: string[]
): Result<Record<string, string | undefined>, ImportRefusal> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: ARG_OPTIONS,
      allowPositionals: false,
    });
    return Result.ok(values);
  } catch (error) {
    return Result.err(
      refuse(
        GuardRefusalCode.ArgsInvalid,
        error instanceof Error ? error.message : String(error)
      )
    );
  }
}

/**
 * Refuse unless `--snapshot` is a readable regular file holding a desktop
 * snapshot.
 *
 * The probe QUERIES the schema rather than only opening the file: SQLite defers
 * header validation until the first read, so an `open` on a text file succeeds
 * and the run would fail much later, mid-import, with an opaque error. Asking
 * for the one table the import cannot proceed without turns that into a named
 * refusal before any database is touched.
 */
export function checkSnapshotPath(path: string): Result<string, ImportRefusal> {
  const resolved = resolvePath(path);
  try {
    if (!statSync(resolved).isFile()) {
      return Result.err(
        refuse(
          ImportRefusalCode.SnapshotMissing,
          `--snapshot '${resolved}' is not a regular file.`
        )
      );
    }
  } catch (error) {
    return Result.err(
      refuse(
        ImportRefusalCode.SnapshotMissing,
        `--snapshot '${resolved}' cannot be read: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
  let hasSessionsTable: boolean;
  try {
    const db = openSnapshot(resolved);
    try {
      hasSessionsTable =
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"
          )
          .get() !== undefined;
    } finally {
      db.close();
    }
  } catch (error) {
    return Result.err(
      refuse(
        ImportRefusalCode.SnapshotUnreadable,
        `--snapshot '${resolved}' is not a readable SQLite database: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
  if (!hasSessionsTable) {
    return Result.err(
      refuse(
        ImportRefusalCode.SnapshotNotDesktopSchema,
        `--snapshot '${resolved}' is a SQLite database but has no 'sessions' table — it is not a desktop snapshot.`
      )
    );
  }
  return Result.ok(resolved);
}

/**
 * Every refusal that can be decided without touching the database, in the order
 * an operator most wants to hear about them.
 */
export function runPreflight(
  argv: string[],
  env: ImportEnv
): Result<ImportArgs, ImportRefusal> {
  const args = parseImportArgs(argv);
  if (!args.ok) {
    return args;
  }
  const databaseUrl = checkDatabaseUrl(env.DATABASE_URL);
  if (!databaseUrl.ok) {
    return Result.err(databaseUrl.error as Refusal);
  }
  const snapshot = checkSnapshotPath(args.value.snapshot);
  if (!snapshot.ok) {
    return Result.err(snapshot.error);
  }
  // This run writes a LIVE `sk_live` bearer beside `--out`, hence the fail-closed
  // git-ignore refusal. Without it, pointing `--out` at a tracked directory would
  // leave a usable credential where git would commit it.
  const gitIgnored = checkOutPathIsGitIgnored(args.value.out);
  if (!gitIgnored.ok) {
    return Result.err(gitIgnored.error as Refusal);
  }
  const outDirectory = checkOutDirectoryExists(args.value.out);
  if (!outDirectory.ok) {
    return Result.err(outDirectory.error);
  }
  return Result.ok({ ...args.value, snapshot: snapshot.value });
}

/**
 * Refuse a `--out` whose directory does not exist.
 *
 * Cheap, but it has to run in PREFLIGHT: both writes happen after the org-policy
 * flip and the compute-target upsert, so discovering the missing directory at
 * write time would fail the run with a raw ENOENT having already mutated the
 * database — and, for the credentials write, after a live key was minted with
 * nowhere to put it.
 */
export function checkOutDirectoryExists(
  outPath: string
): Result<string, ImportRefusal> {
  const directory = dirname(resolvePath(outPath));
  try {
    if (statSync(directory).isDirectory()) {
      return Result.ok(directory);
    }
  } catch {
    // Fall through to the shared refusal — absent and not-a-directory are the
    // same answer to the only question being asked.
  }
  return Result.err(
    refuse(
      ImportRefusalCode.OutDirectoryMissing,
      `--out directory '${directory}' does not exist — create it before importing.`
    )
  );
}

/** Where the bearer handoff goes: beside `--out`, never inside the summary. */
export function resolveCredentialsPath(outPath: string): string {
  return join(dirname(resolvePath(outPath)), PERF_CREDENTIALS_FILENAME);
}

/**
 * Mint the `PERF_API_BEARER` the measurement recipes authenticate with, through
 * the SAME production service the live key flow calls, so the perf lane can
 * never profile a key shape that has drifted from the code under test.
 *
 * A fresh key each run is deliberate: `generate` returns the plaintext only at
 * creation, so there is no way to re-read an existing key's secret. The rows are
 * cheap and the database is throwaway.
 */
export async function mintPerfApiBearer(
  identity: ResolvedIdentity
): Promise<PerfImportCredentials> {
  const apiKey = await apiKeysService.generate(
    identity.organizationId,
    identity.userId,
    { name: PERF_API_KEY_NAME }
  );
  return {
    apiBearer: apiKey.plaintext,
    organizationId: identity.organizationId,
    userId: identity.userId,
  };
}

/**
 * The deterministic compute target every perf import writes through. The cloud
 * session rows carry a RESTRICT foreign key to it, so it has to exist before the
 * first batch. Idempotent on the model's own `(userId, machineName)` unique key,
 * so re-importing reuses the target instead of accumulating devices.
 */
export async function ensurePerfComputeTarget(
  identity: ResolvedIdentity,
  machineName: string = PERF_IMPORT_MACHINE_NAME
): Promise<string> {
  const target = await withDb((db) =>
    db.computeTarget.upsert({
      where: {
        userId_machineName: {
          userId: identity.userId,
          machineName,
        },
      },
      create: {
        organizationId: identity.organizationId,
        userId: identity.userId,
        machineName,
        platform: process.platform,
      },
      update: {},
      select: { id: true },
    })
  );
  return target.id;
}

/**
 * Group mapped sessions into batches bounded by BOTH the session count and the
 * serialized byte budget, so one metadata-heavy slice cannot balloon a batch.
 */
export function batchSessions(
  sessions: Record<string, unknown>[],
  batchSize: number
): Record<string, unknown>[][] {
  const batches: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];
  let currentBytes = 0;
  for (const session of sessions) {
    const bytes = Buffer.byteLength(JSON.stringify(session));
    const wouldOverflow =
      current.length >= batchSize ||
      (current.length > 0 && currentBytes + bytes > BATCH_BYTE_BUDGET);
    if (wouldOverflow) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(session);
    currentBytes += bytes;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/** Build one wire payload. Shape is validated by the caller, not assumed here. */
export function buildBatchPayload(
  sessions: Record<string, unknown>[]
): Record<string, unknown> {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: randomUUID(),
    syncMode: AgentSessionSyncMode.Backfill,
    sessionCount: sessions.length,
    sessions,
    // Ask the fold to echo what it actually PERSISTED. The handler documents
    // that a slice it declines to write is absent from this echo, so it is the
    // only honest per-session landed count available to the summary.
    wantsAcceptedSessionIds: true,
  };
}

export type ImportDeps = {
  handle?: typeof handleDesktopAgentSessionsEvent;
  /**
   * Wraps the fold each batch is handed to (`handle`, else the real one). The
   * perf lane passes none; the ISS-12054 vibe seed re-sends what the fold left
   * unacknowledged here.
   */
  wrapHandle?: (
    fold: typeof handleDesktopAgentSessionsEvent
  ) => typeof handleDesktopAgentSessionsEvent;
  log?: (message: string) => void;
  /**
   * Rewrites each mapped session before batching. The perf lane passes none and
   * imports the snapshot verbatim; the ISS-12017 vibe seed moves corpus time
   * to its `now` here.
   */
  transformSession?: (
    session: Record<string, unknown>
  ) => Record<string, unknown>;
  /**
   * Imports only the snapshot sessions this accepts. The perf lane imports
   * every session; the ISS-12135 vibe seed imports each person's sessions
   * under that person's own compute target.
   */
  includeSession?: (externalSessionId: string) => boolean;
};

/**
 * Read the snapshot, map it, and drive the fold batch by batch.
 *
 * Split from {@link main} so the whole import can be driven in a test without
 * re-deciding the refusals, and so a caller already holding a validated identity
 * (the integration suite) can exercise the real fold against a real database.
 */
export async function importSnapshot(
  input: {
    snapshot: string;
    identity: ResolvedIdentity;
    computeTargetId: string;
    batchSize: number;
  },
  deps: ImportDeps = {}
): Promise<ImportSummary> {
  const startedAt = Date.now();
  const fold = deps.handle ?? handleDesktopAgentSessionsEvent;
  const handle = deps.wrapHandle ? deps.wrapHandle(fold) : fold;
  const log = deps.log ?? ((message: string) => console.log(message));
  const db = openSnapshot(input.snapshot);
  const skips: SkipTally = {};
  const mapped: Record<string, unknown>[] = [];
  let sessionsRead = 0;

  try {
    const include = deps.includeSession;
    const sessionIds = readSnapshotSessionIds(db).filter(
      (id) => include === undefined || include(id)
    );
    sessionsRead = sessionIds.length;
    for (const idSlice of sliceIds(sessionIds, input.batchSize)) {
      for (const bundle of loadSnapshotBundles(db, idSlice)) {
        const session = mapSnapshotSession(bundle, skips);
        if (session !== null) {
          mapped.push(
            deps.transformSession ? deps.transformSession(session) : session
          );
        }
      }
    }
  } finally {
    db.close();
  }

  const batches = batchSessions(mapped, input.batchSize);
  // The default limiter allows 120 requests per minute per principal, which a
  // corpus-sized import exceeds. Sizing a dedicated limiter to the run keeps the
  // production limiter's behavior intact for every other caller.
  const rateLimiter = new DesktopAgentSessionsRateLimiter({
    maxRequests: batches.length + 1,
  });
  const outcomes: BatchOutcome[] = [];
  let sessionsPersisted = 0;

  for (const [batchIndex, batch] of batches.entries()) {
    const outcome = await sendBatch({
      batch,
      batchIndex,
      identity: input.identity,
      computeTargetId: input.computeTargetId,
      handle,
      rateLimiter,
    });
    outcomes.push(outcome);
    sessionsPersisted += outcome.acceptedSessionCount ?? 0;
    log(
      `batch ${batchIndex + 1}/${batches.length}: ${outcome.sentSessions} sessions -> ${describeOutcome(outcome)}`
    );
  }

  const rejections = outcomes.filter((outcome) => !outcome.accepted);
  return {
    snapshot: input.snapshot,
    organizationId: input.identity.organizationId,
    userId: input.identity.userId,
    computeTargetId: input.computeTargetId,
    sessionsRead,
    sessionsSent: mapped.length,
    sessionsSkipped: sessionsRead - mapped.length,
    batches: batches.length,
    accepted: outcomes.length - rejections.length,
    rejected: rejections.length,
    sessionsPersisted,
    skips,
    rejections,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Validate one batch against the REAL wire schema before handing it to the fold.
 *
 * The handler parses it again — this pre-parse exists so a mapping mistake is
 * reported as the field path that is wrong, instead of as the handler's
 * value-free `validation_failed` summary.
 */
async function sendBatch(input: {
  batch: Record<string, unknown>[];
  batchIndex: number;
  identity: ResolvedIdentity;
  computeTargetId: string;
  handle: typeof handleDesktopAgentSessionsEvent;
  rateLimiter: DesktopAgentSessionsRateLimiter;
}): Promise<BatchOutcome> {
  const payload = buildBatchPayload(input.batch);
  const validated = desktopAgentSessionsPayloadObjectSchema.safeParse(payload);
  if (!validated.success) {
    return {
      batchIndex: input.batchIndex,
      sentSessions: input.batch.length,
      accepted: false,
      reason: "mapping_invalid",
      detail: z.prettifyError(validated.error),
    };
  }

  const ack = await input.handle(
    payload,
    {
      organizationId: input.identity.organizationId,
      userId: input.identity.userId,
      targetId: input.computeTargetId,
    },
    { rateLimiter: input.rateLimiter }
  );

  if (ack.accepted) {
    return {
      batchIndex: input.batchIndex,
      sentSessions: input.batch.length,
      accepted: true,
      acceptedSessionCount: ack.acceptedSessionIds?.length ?? 0,
    };
  }
  return {
    batchIndex: input.batchIndex,
    sentSessions: input.batch.length,
    accepted: false,
    reason: ack.reason,
    ...(ack.detail === undefined ? {} : { detail: ack.detail }),
  };
}

function describeOutcome(outcome: BatchOutcome): string {
  if (outcome.accepted) {
    return `accepted (${outcome.acceptedSessionCount ?? 0} persisted)`;
  }
  const detail = outcome.detail ? ` — ${outcome.detail}` : "";
  return `REJECTED (${outcome.reason})${detail}`;
}

function* sliceIds(ids: string[], size: number): Generator<string[]> {
  for (let start = 0; start < ids.length; start += size) {
    yield ids.slice(start, start + size);
  }
}

function printSummary(summary: ImportSummary): void {
  console.log("");
  console.log(
    `sessions read ${summary.sessionsRead}, sent ${summary.sessionsSent}, skipped ${summary.sessionsSkipped}`
  );
  console.log(
    `batches ${summary.batches} (accepted ${summary.accepted}, rejected ${summary.rejected})`
  );
  console.log(
    `sessions persisted ${summary.sessionsPersisted} in ${summary.elapsedMs}ms`
  );
  for (const [reason, count] of Object.entries(summary.skips)) {
    console.log(`  skipped rows — ${reason}: ${count}`);
  }
  for (const rejection of summary.rejections) {
    console.error(
      `  batch ${rejection.batchIndex + 1} ${describeOutcome(rejection)}`
    );
  }
}

/** Print a refusal in the machine-greppable `REFUSED (<code>)` form and exit 1. */
function exitRefused(refusal: ImportRefusal): never {
  console.error(`REFUSED (${refusal.code}): ${refusal.message}`);
  process.exit(1);
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: ImportEnv = process.env
): Promise<void> {
  const preflight = runPreflight(argv, env);
  if (!preflight.ok) {
    exitRefused(preflight.error);
  }
  const args = preflight.value;

  const identity = await resolveIdentity({
    ...optional("organizationId", args.organizationId),
    ...optional("userId", args.userId),
  });
  if (!identity.ok) {
    exitRefused(identity.error);
  }

  console.log(
    "No ingest gate is stubbed: ISS-8022 retired the PostHog rollout flag this import used to supply, and ISS-11449 retired the org session-sync policy. Every gate runs unmodified."
  );
  const computeTargetId = await ensurePerfComputeTarget(identity.value);
  console.log(`Importing through compute target ${computeTargetId}.`);

  // Minted BEFORE the import so a run whose batches are rejected still leaves
  // the measurement recipes a usable bearer to talk to the stack with.
  const credentialsPath = await writeCredentialsFile(
    resolveCredentialsPath(args.out),
    await mintPerfApiBearer(identity.value)
  );
  console.log(
    `Wrote ${credentialsPath} (mode 0600). Contents are secret — do not echo.`
  );

  const summary = await importSnapshot({
    snapshot: args.snapshot,
    identity: identity.value,
    computeTargetId,
    batchSize: args.batchSize,
  });
  printSummary(summary);

  const summaryPath = resolvePath(args.out);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Wrote ${summaryPath}.`);

  if (summary.rejected > 0) {
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error("perf snapshot import failed:", error);
    process.exit(1);
  });
}
