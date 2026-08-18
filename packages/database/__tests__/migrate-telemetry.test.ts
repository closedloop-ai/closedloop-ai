import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverMigrateDeployFailure } from "../scripts/migrate-deploy-recovery";
import {
  isTransientConnectionError,
  withRetry,
} from "../scripts/migrate-retry";
import {
  __resetMigrateTelemetryForTests,
  type BuildMigrateEventInput,
  buildMigrateEvent,
  createMigrateRunRecorder,
  flushMigrateTelemetry,
  type MigrateDeployEvent,
  MigrateGateOutcome,
  MigrateOutcome,
  MigrateResetKind,
  type MigrateTelemetryEnv,
  readMigrateTelemetryEnv,
  recordMigrateEvent,
} from "../scripts/migrate-telemetry";
import {
  type MigrationLockClient,
  SerializeLockContendedError,
  withMigrationSerializeLock,
} from "../scripts/migration-lock";
import {
  applyMigrationsToSchema,
  type MigrationPipelineDeps,
} from "../scripts/migration-pipeline";

afterEach(() => {
  __resetMigrateTelemetryForTests();
  vi.restoreAllMocks();
});

const PGHOST_HASH_PATTERN = /^[0-9a-f]{12}$/;
const ADVISORY_LOCK_MESSAGE_PATTERN = /advisory lock/;

const TELEMETRY_ENV: MigrateTelemetryEnv = {
  pgdatabase: "app",
  pghost_hash: "abc123abc123",
  vercel_env: "production",
  git_ref: "main",
  commit_sha: "deadbeef",
  deployment_id: "dpl_1",
};

function makeBuildInput(
  overrides: Partial<BuildMigrateEventInput> = {}
): BuildMigrateEventInput {
  return {
    env: TELEMETRY_ENV,
    schema: "preview_x",
    isPreview: true,
    startedAt: "2026-07-28T00:00:00.000Z",
    durationMs: 1234,
    atHeadSkip: false,
    gateOutcome: MigrateGateOutcome.Acquired,
    gateWaitMs: 5,
    migrateStartedAt: "2026-07-28T00:00:00.100Z",
    migrateMs: 900,
    resetKind: MigrateResetKind.None,
    outcome: MigrateOutcome.Ok,
    attempts: 1,
    invalidIndexes: null,
    ...overrides,
  };
}

describe("readMigrateTelemetryEnv (ISS-4392) — no secret in payload", () => {
  it("hashes PGHOST (never the raw host) and omits DATABASE_URL entirely", () => {
    const env = readMigrateTelemetryEnv({
      PGHOST: "my-db.rds.amazonaws.com",
      PGDATABASE: "app",
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_SHA: "sha1",
      VERCEL_DEPLOYMENT_ID: "dpl_9",
      DATABASE_URL:
        "postgresql://u:SUPERSECRETTOKEN@my-db.rds.amazonaws.com:5432/app",
    } as NodeJS.ProcessEnv);

    expect(env.pghost_hash).not.toBe("my-db.rds.amazonaws.com");
    expect(env.pghost_hash).toMatch(PGHOST_HASH_PATTERN);
    expect(env.pgdatabase).toBe("app");
    expect(env.deployment_id).toBe("dpl_9");

    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain("SUPERSECRETTOKEN");
    expect(serialized).not.toContain("my-db.rds.amazonaws.com");
  });

  it("falls back deployment_id to VERCEL_URL and nulls missing fields", () => {
    const env = readMigrateTelemetryEnv({
      VERCEL_URL: "api-stage-abc.vercel.app",
    } as NodeJS.ProcessEnv);
    expect(env.deployment_id).toBe("api-stage-abc.vercel.app");
    expect(env.pgdatabase).toBeNull();
    expect(env.pghost_hash).toBeNull();
  });
});

describe("buildMigrateEvent (ISS-4392)", () => {
  it("maps every field and stamps the discriminator", () => {
    const event = buildMigrateEvent(
      makeBuildInput({ atHeadSkip: true, outcome: MigrateOutcome.P1002 })
    );
    expect(event.event).toBe("migrate_deploy");
    expect(event.at_head_skip).toBe(true);
    expect(event.outcome).toBe("p1002");
    expect(event.pghost_hash).toBe("abc123abc123");
    expect(event.pgdatabase).toBe("app");
    // Stable dedup id (deployment:schema:started_at) so the drain + POST copies
    // collapse to one via count_distinct downstream.
    expect(event.migrate_run_id).toBe(
      "dpl_1:preview_x:2026-07-28T00:00:00.000Z"
    );
    // No credential can appear — the builder has no databaseUrl input.
    expect(JSON.stringify(event)).not.toContain("postgres");
  });
});

describe("recordMigrateEvent (ISS-4392) — Vercel-gated stdout", () => {
  it("emits nothing when not on Vercel (local / test env)", () => {
    const logImpl = vi.fn();
    recordMigrateEvent(buildMigrateEvent(makeBuildInput()), {
      env: {} as NodeJS.ProcessEnv,
      logImpl,
    });
    expect(logImpl).not.toHaveBeenCalled();
  });

  it("writes one structured JSON line under Vercel", () => {
    const logImpl = vi.fn();
    recordMigrateEvent(buildMigrateEvent(makeBuildInput()), {
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
      logImpl,
    });
    expect(logImpl).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logImpl.mock.calls[0][0]);
    expect(parsed.message).toBe("migrate_deploy");
    expect(parsed.event).toBe("migrate_deploy");
    expect(parsed.ddsource).toBe("migrate");
  });
});

describe("createMigrateRunRecorder (ISS-4392)", () => {
  it("accumulates signals and emits exactly one event with a deterministic duration", () => {
    const emitted: MigrateDeployEvent[] = [];
    const clock = [1000, 1100, 1400, 2000]; // start, migrateStart, migrateDone, finish
    let i = 0;
    const recorder = createMigrateRunRecorder({
      schema: "preview_x",
      isPreview: true,
      env: TELEMETRY_ENV,
      now: () => clock[i++],
      emit: (event) => emitted.push(event),
    });

    recorder.start();
    recorder.setAtHeadSkip(false);
    recorder.setGate(MigrateGateOutcome.FailOpen, 42);
    recorder.markMigrateStart();
    recorder.markMigrateDone();
    recorder.setAttempts(8);
    recorder.setResetKind(MigrateResetKind.P3009);
    recorder.finish(MigrateOutcome.P1002);

    expect(emitted).toHaveLength(1);
    const event = emitted[0];
    expect(event.duration_ms).toBe(1000); // 2000 - 1000
    expect(event.migrate_ms).toBe(300); // 1400 - 1100
    // The real migrate interval start (markMigrateStart), NOT the whole-run start.
    expect(event.migrate_started_at).toBe(new Date(1100).toISOString());
    expect(event.gate_outcome).toBe("fail_open");
    expect(event.gate_wait_ms).toBe(42);
    expect(event.attempts).toBe(8);
    expect(event.reset_kind).toBe("p3009");
    expect(event.outcome).toBe("p1002");
    expect(event.started_at).toBe(new Date(1000).toISOString());
  });

  it("defaults gate/reset/attempts and never double-emits on a second finish", () => {
    const emitted: MigrateDeployEvent[] = [];
    const recorder = createMigrateRunRecorder({
      schema: "public",
      isPreview: false,
      env: TELEMETRY_ENV,
      now: () => 0,
      emit: (event) => emitted.push(event),
    });
    recorder.start();
    recorder.setAtHeadSkip(true);
    recorder.finish(MigrateOutcome.Ok);
    recorder.finish(MigrateOutcome.OtherError);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].gate_outcome).toBeNull();
    expect(emitted[0].reset_kind).toBe("none");
    expect(emitted[0].attempts).toBeNull();
    expect(emitted[0].at_head_skip).toBe(true);
    // No migrate ran (at-head skip) → no migrate interval.
    expect(emitted[0].migrate_started_at).toBeNull();
    expect(emitted[0].migrate_ms).toBeNull();
  });
});

const VERCEL_KEYED_ENV = {
  VERCEL: "1",
  DD_API_KEY: "dd-key",
  DD_SITE: "datadoghq.eu",
} as NodeJS.ProcessEnv;

function bufferOneEvent(overrides: Partial<BuildMigrateEventInput> = {}): void {
  recordMigrateEvent(buildMigrateEvent(makeBuildInput(overrides)), {
    env: VERCEL_KEYED_ENV,
    logImpl: vi.fn(),
  });
}

describe("flushMigrateTelemetry (ISS-4392) — batched, bounded, fail-safe", () => {
  it("posts ONE batched body for a multi-event (walk) buffer and clears it", async () => {
    bufferOneEvent({ schema: "preview_a" });
    bufferOneEvent({ schema: "preview_b" });
    const fetchImpl = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(null))
    );

    await flushMigrateTelemetry({ env: VERCEL_KEYED_ENV, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://http-intake.logs.datadoghq.eu/api/v2/logs");
    expect(init.headers).toMatchObject({ "DD-API-KEY": "dd-key" });
    const body = JSON.parse(init.body as string);
    expect(body).toHaveLength(2);
    expect(body[0].message).toBe("migrate_deploy");

    // Buffer cleared: a second flush sends nothing.
    fetchImpl.mockClear();
    await flushMigrateTelemetry({ env: VERCEL_KEYED_ENV, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does NOT post when DD_API_KEY is absent (stdout-only), and CLEARS the buffer", async () => {
    bufferOneEvent();
    const fetchImpl = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(null))
    );
    // No key → no POST.
    await flushMigrateTelemetry({
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    // Proves the buffer was cleared: a subsequent KEYED flush must send nothing.
    // (If the no-key branch had left the event buffered, this would POST it.)
    await flushMigrateTelemetry({ env: VERCEL_KEYED_ENV, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does NOT post to a userinfo-style DD_SITE that is not on the allowlist (no key exfiltration)", async () => {
    bufferOneEvent();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(null))
    );
    await flushMigrateTelemetry({
      env: {
        VERCEL: "1",
        DD_API_KEY: "dd-key",
        DD_SITE: "datadoghq.com@attacker.example",
      } as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never logs the DD_API_KEY when a malformed key throws during header construction", async () => {
    bufferOneEvent();
    const secret = "bad\nkey-SUPERSECRET";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(
      (_url: string, _init: RequestInit): Promise<Response> => {
        // Mirrors Undici's "invalid header value \"<value>\"" throw.
        throw new Error(
          `Headers.append: "${secret}" is an invalid header value`
        );
      }
    );
    await flushMigrateTelemetry({
      env: {
        VERCEL: "1",
        DD_API_KEY: secret,
        DD_SITE: "datadoghq.eu",
      } as NodeJS.ProcessEnv,
      fetchImpl,
    });
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain("SUPERSECRET");
    }
  });

  it("resolves via the SINGLE deadline when BOTH the POST and stdout drain are stuck", async () => {
    bufferOneEvent();
    const fetchImpl = vi.fn(
      (_url: string, _init: RequestInit) =>
        new Promise<Response>(() => undefined)
    );
    const stdoutImpl = {
      writableLength: 5,
      // A write that never invokes its callback → drain would hang without the deadline.
      write: (_chunk: string, _cb: () => void) => undefined,
    };
    let scheduleCalls = 0;
    const scheduleDeadline = (_ms: number, onFire: () => void) => {
      scheduleCalls += 1;
      onFire();
    };
    await expect(
      flushMigrateTelemetry({
        env: VERCEL_KEYED_ENV,
        fetchImpl,
        stdoutImpl,
        scheduleDeadline,
      })
    ).resolves.toBeUndefined();
    // ONE deadline for the whole flush (not one per sink).
    expect(scheduleCalls).toBe(1);
  });

  it("does not reject when the stdout drain write throws synchronously", async () => {
    bufferOneEvent();
    const stdoutImpl = {
      writableLength: 5,
      write: (_chunk: string, _cb: () => void) => {
        throw new Error("EPIPE");
      },
    };
    await expect(
      flushMigrateTelemetry({
        env: { VERCEL: "1" } as NodeJS.ProcessEnv,
        stdoutImpl,
      })
    ).resolves.toBeUndefined();
  });

  it("swallows a throwing transport (never fails the deploy)", async () => {
    bufferOneEvent();
    const fetchImpl = vi.fn(
      (_url: string, _init: RequestInit): Promise<Response> => {
        throw new Error("intake down");
      }
    );
    await expect(
      flushMigrateTelemetry({ env: VERCEL_KEYED_ENV, fetchImpl })
    ).resolves.toBeUndefined();
  });

  it("resolves via the deadline when the transport never settles (no hang)", async () => {
    bufferOneEvent();
    // A fetch that never resolves would hang the build; the injected deadline
    // fires immediately so flush returns. No wall-clock timing is asserted.
    const fetchImpl = vi.fn(
      (_url: string, _init: RequestInit) =>
        new Promise<Response>(() => undefined)
    );
    const scheduleDeadline = (_ms: number, onFire: () => void) => onFire();

    await expect(
      flushMigrateTelemetry({
        env: VERCEL_KEYED_ENV,
        fetchImpl,
        scheduleDeadline,
      })
    ).resolves.toBeUndefined();
  });

  it("warns once when the intake returns a non-2xx (a dead sink is not silent success)", async () => {
    bufferOneEvent();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(null, { status: 503 }))
    );
    await flushMigrateTelemetry({ env: VERCEL_KEYED_ENV, fetchImpl });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("503");
  });

  it("warns once when the intake POST rejects", async () => {
    bufferOneEvent();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn((_url: string, _init: RequestInit) =>
      Promise.reject(new Error("intake unreachable"))
    );
    await flushMigrateTelemetry({ env: VERCEL_KEYED_ENV, fetchImpl });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("intake POST failed");
  });

  it("drains buffered stdout before returning (no truncation on the forced exit)", async () => {
    let drained = false;
    const stdoutImpl = {
      writableLength: 5,
      write: (_chunk: string, cb: () => void) => {
        drained = true;
        cb();
      },
    };
    await flushMigrateTelemetry({
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
      stdoutImpl,
    });
    expect(drained).toBe(true);
  });
});

// Minimal collaborator set for applyMigrationsToSchema (the emit choke point).
// Callbacks are typed via the REAL dep types (indexed access), so hook-signature
// drift fails typecheck instead of being hidden behind a cast.
function makeApplyDeps(overrides: {
  atHead?: boolean;
  gate?: MigrationPipelineDeps["withMigrationSerializeLock"];
  runMigrate?: MigrationPipelineDeps["runMigrate"];
  cloneOk?: boolean;
}): Partial<MigrationPipelineDeps> {
  const gate: MigrationPipelineDeps["withMigrationSerializeLock"] =
    overrides.gate ?? ((_opts, fn) => fn());
  const runMigrate: MigrationPipelineDeps["runMigrate"] =
    overrides.runMigrate ?? (() => Promise.resolve(false));
  return {
    probePreviewSchemaAtHead: vi.fn(() =>
      Promise.resolve(overrides.atHead ?? false)
    ),
    prestampSkippableMigrationsViaSql: vi.fn(() => Promise.resolve()),
    plainBuildPreviewConcurrentIndexes: vi.fn(() => Promise.resolve()),
    withMigrationSerializeLock: vi.fn(gate),
    runMigrate: vi.fn(runMigrate),
    cloneDataFromPublic: vi.fn(() =>
      Promise.resolve(overrides.cloneOk ?? true)
    ),
    // Stubbed like every other collaborator: the real sweep would open a live
    // connection to the fake URL these cases use.
    sweepInvalidIndexes: vi.fn(() => Promise.resolve([])),
    runPreviewSeed: vi.fn(),
  };
}

describe("applyMigrationsToSchema telemetry wiring (ISS-4392)", () => {
  it("records an at-head skip (0 locks) with outcome ok", async () => {
    const emit = vi.fn();
    await applyMigrationsToSchema(
      "postgres://x",
      "preview_x",
      undefined,
      { isNew: false, telemetry: { env: {} as NodeJS.ProcessEnv, emit } },
      makeApplyDeps({ atHead: true })
    );
    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0][0] as MigrateDeployEvent;
    expect(event.at_head_skip).toBe(true);
    expect(event.gate_outcome).toBeNull();
    expect(event.outcome).toBe("ok");
  });

  it("records gate fail_open + P1002 outcome when the migrate throws an advisory-lock error, and rethrows", async () => {
    const emit = vi.fn();
    const deps = makeApplyDeps({
      gate: (opts, fn) => {
        opts.onOutcome?.(MigrateGateOutcome.FailOpen, 7);
        return fn();
      },
      runMigrate: () =>
        Promise.reject(
          new Error("Timed out trying to acquire a postgres advisory lock")
        ),
    });

    await expect(
      applyMigrationsToSchema(
        "postgres://x",
        "preview_x",
        undefined,
        { isNew: false, telemetry: { env: {} as NodeJS.ProcessEnv, emit } },
        deps
      )
    ).rejects.toThrow(ADVISORY_LOCK_MESSAGE_PATTERN);

    const event = emit.mock.calls[0][0] as MigrateDeployEvent;
    expect(event.gate_outcome).toBe("fail_open");
    expect(event.outcome).toBe("p1002");
  });

  it("records attempts and reset_kind forwarded from the migrate hooks", async () => {
    const emit = vi.fn();
    const deps = makeApplyDeps({
      gate: (opts, fn) => {
        opts.onOutcome?.(MigrateGateOutcome.Acquired, 2);
        return fn();
      },
      runMigrate: (_u, _s, _b, hooks) => {
        hooks?.onAttempts?.(8);
        hooks?.onResetKind?.("p3009");
        return Promise.resolve(true);
      },
      cloneOk: true,
    });

    await applyMigrationsToSchema(
      "postgres://x",
      "preview_x",
      undefined,
      { isNew: false, telemetry: { env: {} as NodeJS.ProcessEnv, emit } },
      deps
    );

    const event = emit.mock.calls[0][0] as MigrateDeployEvent;
    expect(event.attempts).toBe(8);
    expect(event.reset_kind).toBe("p3009");
    expect(event.gate_outcome).toBe("acquired");
    expect(event.outcome).toBe("ok");
  });
});

describe("withRetry onAttempts (ISS-4392)", () => {
  it("reports each attempt number so the caller ends holding the total consumed", async () => {
    const seen: number[] = [];
    let calls = 0;
    const result = await withRetry(
      () => {
        calls += 1;
        if (calls < 3) {
          return Promise.reject(
            Object.assign(new Error("connection reset"), {
              code: "ECONNRESET",
            })
          );
        }
        return Promise.resolve("ok");
      },
      isTransientConnectionError,
      {
        attempts: 5,
        sleep: () => Promise.resolve(),
        onAttempts: (attempt) => seen.push(attempt),
      }
    );

    expect(result).toBe("ok");
    expect(seen).toEqual([1, 2, 3]);
  });
});

function mockLockClient(connectError?: Error): MigrationLockClient {
  return {
    connect: vi.fn(() =>
      connectError ? Promise.reject(connectError) : Promise.resolve()
    ),
    query: vi.fn(() => Promise.resolve({ rows: [] })),
    end: vi.fn(() => Promise.resolve()),
  } as MigrationLockClient;
}

// These exercise the REAL leaf modules calling the hooks (not a mock stand-in),
// so removing a hook call in migration-lock / recovery fails a test.
describe("real hook emission (ISS-4392)", () => {
  it("withMigrationSerializeLock reports acquired / fail_open / fail_closed", async () => {
    const outcomes: string[] = [];
    const onOutcome = (outcome: string) => outcomes.push(outcome);

    await withMigrationSerializeLock(
      { databaseUrl: "x", createClient: () => mockLockClient(), onOutcome },
      () => Promise.resolve(true)
    );
    await withMigrationSerializeLock(
      {
        databaseUrl: "x",
        createClient: () => mockLockClient(new Error("connect boom")),
        onOutcome,
      },
      () => Promise.resolve(true)
    );
    await expect(
      withMigrationSerializeLock(
        {
          databaseUrl: "x",
          createClient: () => mockLockClient(new Error("connect boom")),
          onContended: "skip",
          onOutcome,
        },
        () => Promise.resolve(true)
      )
    ).rejects.toBeInstanceOf(SerializeLockContendedError);

    expect(outcomes).toEqual(["acquired", "fail_open", "fail_closed"]);
  });

  it("recoverMigrateDeployFailure reports reset_kind for a P3005 preview reset", async () => {
    const kinds: string[] = [];
    const didReset = await recoverMigrateDeployFailure(
      {
        databaseUrl: "x",
        schema: "preview_x",
        branch: undefined,
        error: new Error(
          "Migration failed: P3005 database schema is not empty"
        ),
      },
      {
        runMigrateDeploy: vi.fn(() => Promise.resolve()),
        resolveFailedMigration: vi.fn(() => Promise.resolve()),
        resetSchema: vi.fn(() => Promise.resolve()),
        upsertSchemaRegistry: vi.fn(() => Promise.resolve()),
        prestampSkippableMigrations: vi.fn(() => Promise.resolve()),
        registryRetrySleep: () => Promise.resolve(),
        onResetKind: (kind) => kinds.push(kind),
      }
    );

    expect(didReset).toBe(true);
    expect(kinds).toEqual(["p3005"]);
  });
});
