import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMigrateTelemetryForTests,
  buildMigrateEvent,
  createMigrateRunRecorder,
  cutMigrateRunsAtDeadline,
  DD_LOG_INTAKE_TIMEOUT_MS,
  flushMigrateTelemetry,
  type MigrateDeployEvent,
  MigrateExecutor,
  MigrateGateOutcome,
  MigrateOutcome,
  MigrateResetKind,
  readMigrateTelemetryEnv,
  recordMigrateEvent,
} from "../migrate-telemetry";

const BASE_ENV: MigrateDeployEventTestEnv = {
  pgdatabase: "cl",
  pghost_hash: "abc123",
  vercel_env: "preview",
  git_ref: "refs/heads/feat",
  commit_sha: "deadbeef",
  deployment_id: "dep_1",
};

// A minimal alias so the fixture above type-checks against the module's own
// `MigrateTelemetryEnv` shape without importing it twice under two names.
type MigrateDeployEventTestEnv = {
  pgdatabase: string | null;
  pghost_hash: string | null;
  vercel_env: string | null;
  git_ref: string | null;
  commit_sha: string | null;
  deployment_id: string | null;
};

function baseBuildInput() {
  return {
    env: BASE_ENV,
    schema: "preview_abc",
    isPreview: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 100,
    atHeadSkip: false,
    gateOutcome: MigrateGateOutcome.Acquired,
    gateWaitMs: 5,
    migrateStartedAt: "2026-01-01T00:00:01.000Z",
    migrateExecutor: MigrateExecutor.PrismaCli,
    migrateMs: 50,
    resetKind: MigrateResetKind.None,
    outcome: MigrateOutcome.Ok,
    attempts: 1,
    invalidIndexes: null,
  };
}

beforeEach(() => {
  __resetMigrateTelemetryForTests();
});

afterEach(() => {
  __resetMigrateTelemetryForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("readMigrateTelemetryEnv", () => {
  it("extracts and hashes PGHOST, with VERCEL_DEPLOYMENT_ID preferred over VERCEL_URL", () => {
    const env = readMigrateTelemetryEnv({
      PGHOST: "db.example.com",
      PGDATABASE: "cl",
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_SHA: "sha1",
      VERCEL_DEPLOYMENT_ID: "dep_a",
      VERCEL_URL: "cl.vercel.app",
    } as NodeJS.ProcessEnv);

    expect(env.pgdatabase).toBe("cl");
    expect(env.pghost_hash).toHaveLength(12);
    expect(env.vercel_env).toBe("production");
    expect(env.git_ref).toBe("main");
    expect(env.commit_sha).toBe("sha1");
    expect(env.deployment_id).toBe("dep_a");
  });

  it("falls back to VERCEL_URL when VERCEL_DEPLOYMENT_ID is unset", () => {
    const env = readMigrateTelemetryEnv({
      VERCEL_URL: "cl.vercel.app",
    } as NodeJS.ProcessEnv);
    expect(env.deployment_id).toBe("cl.vercel.app");
  });

  it("returns all nulls when PGHOST and the Vercel vars are absent", () => {
    const env = readMigrateTelemetryEnv({} as NodeJS.ProcessEnv);
    expect(env).toEqual({
      pgdatabase: null,
      pghost_hash: null,
      vercel_env: null,
      git_ref: null,
      commit_sha: null,
      deployment_id: null,
    });
  });
});

describe("buildMigrateEvent", () => {
  it("assembles every field from the input, deriving migrate_run_id and invalid_index_count", () => {
    const event = buildMigrateEvent({
      ...baseBuildInput(),
      invalidIndexes: ["idx_a", "idx_b"],
    });

    expect(event.migrate_run_id).toBe(
      "dep_1:preview_abc:2026-01-01T00:00:00.000Z"
    );
    expect(event.invalid_index_count).toBe(2);
    expect(event.invalid_indexes).toEqual(["idx_a", "idx_b"]);
    expect(event.event).toBe("migrate_deploy");
    expect(event.schema).toBe("preview_abc");
  });

  it("defaults migrate_run_id's deployment/schema segments and invalid_index_count when unset", () => {
    const event = buildMigrateEvent({
      ...baseBuildInput(),
      env: { ...BASE_ENV, deployment_id: null },
      schema: null,
      invalidIndexes: null,
    });

    expect(event.migrate_run_id).toBe(
      "unknown:public:2026-01-01T00:00:00.000Z"
    );
    expect(event.invalid_index_count).toBeNull();
    expect(event.invalid_indexes).toBeNull();
  });
});

describe("recordMigrateEvent", () => {
  it("is a no-op outside a Vercel build (env.VERCEL unset)", () => {
    const logImpl = vi.fn();
    recordMigrateEvent(buildMigrateEvent(baseBuildInput()), {
      env: {} as NodeJS.ProcessEnv,
      logImpl,
    });
    expect(logImpl).not.toHaveBeenCalled();
  });

  it("buffers and logs a structured line when running under Vercel", () => {
    const logImpl = vi.fn();
    const event = buildMigrateEvent(baseBuildInput());

    recordMigrateEvent(event, {
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
      logImpl,
    });

    expect(logImpl).toHaveBeenCalledTimes(1);
    const line = JSON.parse(logImpl.mock.calls[0][0] as string);
    expect(line.ddsource).toBe("migrate");
    expect(line.service).toBe("api");
    expect(line.level).toBe("info");
    expect(line.status).toBe("info");
    expect(line.migrate_run_id).toBe(event.migrate_run_id);
  });

  it("uses DD_SERVICE from env when present", () => {
    const logImpl = vi.fn();
    recordMigrateEvent(buildMigrateEvent(baseBuildInput()), {
      env: { VERCEL: "1", DD_SERVICE: "custom-svc" } as NodeJS.ProcessEnv,
      logImpl,
    });
    const line = JSON.parse(logImpl.mock.calls[0][0] as string);
    expect(line.service).toBe("custom-svc");
  });

  it("warns once (not twice) when the stdout sink throws", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const logImpl = vi.fn(() => {
      throw new Error("stdout broke");
    });
    const env = { VERCEL: "1" } as NodeJS.ProcessEnv;
    const event = buildMigrateEvent(baseBuildInput());

    recordMigrateEvent(event, { env, logImpl });
    recordMigrateEvent(event, { env, logImpl });

    const sinkFailedWarnings = warnSpy.mock.calls.filter(([line]) =>
      String(line).includes("sink_failed")
    );
    expect(sinkFailedWarnings).toHaveLength(1);
  });
});

describe("recordMigrateEvent — default logImpl", () => {
  it("uses console.log when logImpl is omitted", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    recordMigrateEvent(buildMigrateEvent(baseBuildInput()), {
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});

describe("flushMigrateTelemetry", () => {
  const noopStdout = { writableLength: 0, write: vi.fn() };
  const immediateDeadline = (_ms: number, onFire: () => void) => onFire();
  const neverFiringDeadline = () => undefined;

  it("drains stdout and skips the POST when DD_API_KEY is unset", async () => {
    recordMigrateEvent(buildMigrateEvent(baseBuildInput()), {
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
      logImpl: vi.fn(),
    });
    const fetchImpl = vi.fn();

    await flushMigrateTelemetry({
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
      stdoutImpl: noopStdout,
      scheduleDeadline: neverFiringDeadline,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs the batched events to the intake when DD_API_KEY is present", async () => {
    recordMigrateEvent(buildMigrateEvent(baseBuildInput()), {
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
      logImpl: vi.fn(),
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);

    await flushMigrateTelemetry({
      env: { DD_API_KEY: "key123" } as NodeJS.ProcessEnv,
      fetchImpl,
      stdoutImpl: noopStdout,
      scheduleDeadline: neverFiringDeadline,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://http-intake.logs.datadoghq.com/api/v2/logs");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["DD-API-KEY"]).toBe(
      "key123"
    );
    expect(init.redirect).toBe("error");
  });

  it("does not POST when the buffer is empty even with DD_API_KEY set", async () => {
    const fetchImpl = vi.fn();
    await flushMigrateTelemetry({
      env: { DD_API_KEY: "key123" } as NodeJS.ProcessEnv,
      fetchImpl,
      stdoutImpl: noopStdout,
      scheduleDeadline: neverFiringDeadline,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses DD_SITE when it is an allowed site", async () => {
    recordMigrateEvent(buildMigrateEvent(baseBuildInput()), {
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
      logImpl: vi.fn(),
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);

    await flushMigrateTelemetry({
      env: {
        DD_API_KEY: "key123",
        DD_SITE: "datadoghq.eu",
      } as NodeJS.ProcessEnv,
      fetchImpl,
      stdoutImpl: noopStdout,
      scheduleDeadline: neverFiringDeadline,
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://http-intake.logs.datadoghq.eu/api/v2/logs"
    );
  });

  it("warns once and skips the POST when DD_SITE is not an allowed site", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    recordMigrateEvent(buildMigrateEvent(baseBuildInput()), {
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
      logImpl: vi.fn(),
    });
    const fetchImpl = vi.fn();

    await flushMigrateTelemetry({
      env: {
        DD_API_KEY: "key123",
        DD_SITE: "attacker.example",
      } as NodeJS.ProcessEnv,
      fetchImpl,
      stdoutImpl: noopStdout,
      scheduleDeadline: neverFiringDeadline,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some(([line]) =>
        String(line).includes("attacker.example")
      )
    ).toBe(true);
  });

  it("warns once on a non-2xx intake response", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    recordMigrateEvent(buildMigrateEvent(baseBuildInput()), {
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
      logImpl: vi.fn(),
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500 } as Response);

    await flushMigrateTelemetry({
      env: { DD_API_KEY: "key123" } as NodeJS.ProcessEnv,
      fetchImpl,
      stdoutImpl: noopStdout,
      scheduleDeadline: neverFiringDeadline,
    });

    expect(
      warnSpy.mock.calls.some(([line]) => String(line).includes("500"))
    ).toBe(true);
  });

  it("warns once (generic, no raw error text) when the POST transport rejects", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    recordMigrateEvent(buildMigrateEvent(baseBuildInput()), {
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
      logImpl: vi.fn(),
    });
    const fetchImpl = vi.fn().mockRejectedValue(new Error("DD-API-KEY=leak"));

    await flushMigrateTelemetry({
      env: { DD_API_KEY: "key123" } as NodeJS.ProcessEnv,
      fetchImpl,
      stdoutImpl: noopStdout,
      scheduleDeadline: neverFiringDeadline,
    });

    const flushWarnings = warnSpy.mock.calls.map(([line]) => String(line));
    expect(flushWarnings.some((l) => l.includes("transport error"))).toBe(true);
    expect(flushWarnings.some((l) => l.includes("leak"))).toBe(false);
  });

  it("drains a non-empty stdout by writing an empty chunk", async () => {
    const write = vi.fn((_chunk: string, cb: () => void) => cb());
    await flushMigrateTelemetry({
      env: {} as NodeJS.ProcessEnv,
      stdoutImpl: { writableLength: 10, write },
      scheduleDeadline: neverFiringDeadline,
    });
    expect(write).toHaveBeenCalledWith("", expect.any(Function));
  });

  it("resolves quietly when the stdout drain throws", async () => {
    const write = vi.fn(() => {
      throw new Error("stream closed");
    });
    await expect(
      flushMigrateTelemetry({
        env: {} as NodeJS.ProcessEnv,
        stdoutImpl: { writableLength: 10, write },
        scheduleDeadline: neverFiringDeadline,
      })
    ).resolves.toBeUndefined();
  });

  it("resolves as soon as the injected deadline fires, ahead of a never-settling POST", async () => {
    recordMigrateEvent(buildMigrateEvent(baseBuildInput()), {
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
      logImpl: vi.fn(),
    });
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));

    await expect(
      flushMigrateTelemetry({
        env: { DD_API_KEY: "key123" } as NodeJS.ProcessEnv,
        fetchImpl,
        stdoutImpl: noopStdout,
        scheduleDeadline: immediateDeadline,
      })
    ).resolves.toBeUndefined();
  });

  it("clears the buffer even when the flush ultimately fails", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    recordMigrateEvent(buildMigrateEvent(baseBuildInput()), {
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
      logImpl: vi.fn(),
    });

    await flushMigrateTelemetry({
      env: {} as NodeJS.ProcessEnv,
      scheduleDeadline: () => {
        throw new Error("scheduler exploded");
      },
    });

    expect(
      warnSpy.mock.calls.some(([line]) => String(line).includes("flush_failed"))
    ).toBe(true);

    // A second flush with a working scheduler proves the buffer was cleared
    // by the failed attempt above (nothing left to POST).
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await flushMigrateTelemetry({
      env: { DD_API_KEY: "key123" } as NodeJS.ProcessEnv,
      fetchImpl,
      stdoutImpl: noopStdout,
      scheduleDeadline: neverFiringDeadline,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("respects DD_LOG_INTAKE_TIMEOUT_MS as the deadline argument", async () => {
    const scheduleDeadline = vi.fn((_ms: number, onFire: () => void) =>
      onFire()
    );
    await flushMigrateTelemetry({
      env: {} as NodeJS.ProcessEnv,
      stdoutImpl: noopStdout,
      scheduleDeadline,
    });
    expect(scheduleDeadline).toHaveBeenCalledWith(
      DD_LOG_INTAKE_TIMEOUT_MS,
      expect.any(Function)
    );
  });

  it("uses process.env as the default env when deps.env is omitted", async () => {
    const original = {
      VERCEL: process.env.VERCEL,
      DD_API_KEY: process.env.DD_API_KEY,
      DD_SITE: process.env.DD_SITE,
    };
    process.env.VERCEL = "1";
    process.env.DD_API_KEY = "process-env-key";
    Reflect.deleteProperty(process.env, "DD_SITE");
    try {
      const logImpl = vi.fn();
      recordMigrateEvent(buildMigrateEvent(baseBuildInput()), { logImpl });
      const fetchImpl = vi.fn(() =>
        Promise.resolve({ ok: true, status: 200 } as Response)
      );

      await flushMigrateTelemetry({
        fetchImpl,
        stdoutImpl: noopStdout,
        scheduleDeadline: neverFiringDeadline,
      });

      // VERCEL from process.env lets the record log; DD_API_KEY from
      // process.env makes the flush POST.
      expect(logImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith(
        expect.stringContaining("/api/v2/logs"),
        expect.objectContaining({
          headers: expect.objectContaining({ "DD-API-KEY": "process-env-key" }),
        })
      );
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("uses the real global fetch when fetchImpl is omitted", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    recordMigrateEvent(buildMigrateEvent(baseBuildInput()), {
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
      logImpl: vi.fn(),
    });

    await flushMigrateTelemetry({
      env: { DD_API_KEY: "key123" } as NodeJS.ProcessEnv,
      stdoutImpl: noopStdout,
      scheduleDeadline: neverFiringDeadline,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("uses the real setTimeout-based deadline when scheduleDeadline is omitted", async () => {
    vi.useFakeTimers();
    try {
      recordMigrateEvent(buildMigrateEvent(baseBuildInput()), {
        env: { VERCEL: "1" } as NodeJS.ProcessEnv,
        logImpl: vi.fn(),
      });
      const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));

      const flushed = flushMigrateTelemetry({
        env: { DD_API_KEY: "key123" } as NodeJS.ProcessEnv,
        fetchImpl,
        stdoutImpl: noopStdout,
      });
      await vi.advanceTimersByTimeAsync(DD_LOG_INTAKE_TIMEOUT_MS);

      await expect(flushed).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createMigrateRunRecorder", () => {
  const env = BASE_ENV;

  function makeClock(startMs: number, ...rest: number[]) {
    const values = [startMs, ...rest];
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
  }

  it("emits a fully-populated event through the recorder lifecycle", () => {
    const emit = vi.fn();
    const now = makeClock(1000, 1100, 1300, 1500);
    const recorder = createMigrateRunRecorder({
      schema: "preview_x",
      isPreview: true,
      env,
      now,
      emit,
    });

    recorder.start();
    recorder.setAtHeadSkip(false);
    recorder.setGate(MigrateGateOutcome.Acquired, 10);
    recorder.markMigrateStart();
    recorder.setMigrateExecutor(MigrateExecutor.SqlReplay);
    recorder.markMigrateDone();
    recorder.setAttempts(2);
    recorder.setResetKind(MigrateResetKind.P3005);
    recorder.setInvalidIndexes(["idx_bad"]);
    recorder.finish(MigrateOutcome.Ok);

    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0][0] as MigrateDeployEvent;
    expect(event.schema).toBe("preview_x");
    expect(event.gate_outcome).toBe(MigrateGateOutcome.Acquired);
    expect(event.gate_wait_ms).toBe(10);
    expect(event.migrate_executor).toBe(MigrateExecutor.SqlReplay);
    expect(event.reset_kind).toBe(MigrateResetKind.P3005);
    expect(event.attempts).toBe(2);
    expect(event.invalid_index_count).toBe(1);
    expect(event.outcome).toBe(MigrateOutcome.Ok);
    expect(event.duration_ms).toBe(500);
    expect(event.migrate_ms).toBe(200);
  });

  it("reports duration_ms 0 and a fresh started_at when finish is called before start", () => {
    const emit = vi.fn();
    const now = makeClock(2000);
    const recorder = createMigrateRunRecorder({
      schema: null,
      isPreview: false,
      env,
      now,
      emit,
    });

    recorder.finish(MigrateOutcome.OtherError);

    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0][0] as MigrateDeployEvent;
    expect(event.duration_ms).toBe(0);
    expect(event.started_at).toBe(new Date(2000).toISOString());
    expect(event.outcome).toBe(MigrateOutcome.OtherError);
  });

  it("finish is idempotent: a second call never emits again", () => {
    const emit = vi.fn();
    const recorder = createMigrateRunRecorder({
      schema: "preview_y",
      isPreview: true,
      env,
      now: () => 1,
      emit,
    });
    recorder.start();
    recorder.finish(MigrateOutcome.Ok);
    recorder.finish(MigrateOutcome.Ok);

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("swallows and warns once when the injected emit throws", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const emit = vi.fn(() => {
      throw new Error("emit broke");
    });
    const recorder = createMigrateRunRecorder({
      schema: "preview_z",
      isPreview: true,
      env,
      now: () => 1,
      emit,
    });
    recorder.start();

    expect(() => recorder.finish(MigrateOutcome.Ok)).not.toThrow();
    expect(
      warnSpy.mock.calls.some(([line]) => String(line).includes("sink_failed"))
    ).toBe(true);
  });

  it("leaves migrate_ms null when markMigrateDone is called without markMigrateStart", () => {
    const emit = vi.fn();
    const recorder = createMigrateRunRecorder({
      schema: "preview_no_start",
      isPreview: true,
      env,
      now: () => 1,
      emit,
    });
    recorder.start();
    recorder.markMigrateDone();
    recorder.finish(MigrateOutcome.Ok);

    const event = emit.mock.calls[0][0] as MigrateDeployEvent;
    expect(event.migrate_ms).toBeNull();
  });

  it("uses the default clock and default emit (recordMigrateEvent) when omitted", () => {
    // The default emit reads process.env, so VERCEL must be set there for
    // recordMigrateEvent to log.
    const previousVercel = process.env.VERCEL;
    process.env.VERCEL = "1";
    vi.useFakeTimers();
    vi.setSystemTime(new Date(5000));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const recorder = createMigrateRunRecorder({
        schema: "preview_default",
        isPreview: true,
        env,
      });
      recorder.start();
      recorder.finish(MigrateOutcome.Ok);
    } finally {
      if (previousVercel === undefined) {
        Reflect.deleteProperty(process.env, "VERCEL");
      } else {
        process.env.VERCEL = previousVercel;
      }
    }

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(line.message).toBe("migrate_deploy");
    expect(line.schema).toBe("preview_default");
    expect(line.started_at).toBe(new Date(5000).toISOString());
  });
});

describe("cutMigrateRunsAtDeadline", () => {
  it("emits a DeadlineCut event only for live runs matching the given schema", () => {
    const emitA = vi.fn();
    const emitB = vi.fn();
    const recorderA = createMigrateRunRecorder({
      schema: "preview_a",
      isPreview: true,
      env: BASE_ENV,
      now: () => 1,
      emit: emitA,
    });
    const recorderB = createMigrateRunRecorder({
      schema: "preview_b",
      isPreview: true,
      env: BASE_ENV,
      now: () => 1,
      emit: emitB,
    });
    recorderA.start();
    recorderB.start();

    const cut = cutMigrateRunsAtDeadline("preview_a");

    expect(cut).toBe(1);
    expect(emitA).toHaveBeenCalledTimes(1);
    expect((emitA.mock.calls[0][0] as MigrateDeployEvent).outcome).toBe(
      MigrateOutcome.DeadlineCut
    );
    expect(emitB).not.toHaveBeenCalled();

    // The cut run does not stop the migrate: it can still finish normally,
    // emitting a second, terminal event under the same schema.
    recorderA.finish(MigrateOutcome.Ok);
    expect(emitA).toHaveBeenCalledTimes(2);
  });

  it("returns 0 when no live run matches the schema", () => {
    expect(cutMigrateRunsAtDeadline("preview_nonexistent")).toBe(0);
  });
});

describe("__resetMigrateTelemetryForTests", () => {
  it("clears the buffer, live runs, and warn-once latches", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    recordMigrateEvent(buildMigrateEvent(baseBuildInput()), {
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
      logImpl: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    expect(
      warnSpy.mock.calls.filter(([l]) => String(l).includes("sink_failed"))
    ).toHaveLength(1);

    __resetMigrateTelemetryForTests();
    warnSpy.mockClear();

    // The warn-once latch was cleared, so the same failure warns again.
    recordMigrateEvent(buildMigrateEvent(baseBuildInput()), {
      env: { VERCEL: "1" } as NodeJS.ProcessEnv,
      logImpl: vi.fn(() => {
        throw new Error("boom again");
      }),
    });
    expect(
      warnSpy.mock.calls.filter(([l]) => String(l).includes("sink_failed"))
    ).toHaveLength(1);
  });
});
