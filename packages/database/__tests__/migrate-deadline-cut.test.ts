import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetMigrateTelemetryForTests,
  cutMigrateRunsAtDeadline,
  flushMigrateTelemetry,
  type MigrateDeployEvent,
  MigrateGateOutcome,
  MigrateOutcome,
} from "../scripts/migrate-telemetry";
import {
  applyMigrationsToSchema,
  type MigrationPipelineDeps,
} from "../scripts/migration-pipeline";

const SCHEMA = "preview_deadline";
const GATE_WAIT_MS = 7;
const VERCEL_KEYED_ENV = {
  VERCEL: "1",
  DD_API_KEY: "dd-key",
  DD_SITE: "datadoghq.eu",
} as NodeJS.ProcessEnv;

const originalVercel = process.env.VERCEL;

afterEach(() => {
  __resetMigrateTelemetryForTests();
  vi.restoreAllMocks();
  if (originalVercel === undefined) {
    Reflect.deleteProperty(process.env, "VERCEL");
  } else {
    process.env.VERCEL = originalVercel;
  }
});

/**
 * Deps for one `applyMigrationsToSchema` run whose migrate is controlled by the
 * test: `reachedMigrate` resolves once the pipeline is inside `runMigrate`, and
 * the returned promise never settles — the abandoned child of a deadline cut.
 */
function makeStalledDeps(): {
  deps: Partial<MigrationPipelineDeps>;
  reachedMigrate: Promise<void>;
  settleMigrate: () => void;
} {
  let signalReached: () => void = () => undefined;
  const reachedMigrate = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  let settleMigrate: () => void = () => undefined;
  const deps: Partial<MigrationPipelineDeps> = {
    probePreviewSchemaAtHead: vi.fn(() => Promise.resolve(false)),
    assertMigrateRoleOwnsSchema: vi.fn(() => Promise.resolve()),
    prestampSkippableMigrationsViaSql: vi.fn(() => Promise.resolve()),
    plainBuildPreviewConcurrentIndexes: vi.fn(() => Promise.resolve()),
    withMigrationSerializeLock: vi.fn((opts, fn) => {
      opts.onOutcome?.(MigrateGateOutcome.Acquired, GATE_WAIT_MS);
      return fn();
    }),
    runMigrate: vi.fn(() => {
      signalReached();
      return new Promise<boolean>((resolve) => {
        settleMigrate = () => resolve(false);
      });
    }),
    cloneDataFromPublic: vi.fn(() => Promise.resolve()),
    sweepInvalidIndexes: vi.fn(() => Promise.resolve([])),
    runPreviewSeed: vi.fn(),
    readVibeEnvironmentMarker: vi.fn(() => Promise.resolve(null)),
    writeVibeEnvironmentMarker: vi.fn(() => Promise.resolve()),
  };
  return { deps, reachedMigrate, settleMigrate: () => settleMigrate() };
}

/**
 * Starts a real pipeline run and leaves it stalled inside `runMigrate`. No
 * `telemetry.emit` is injected, so the recorder uses the REAL default sink —
 * which is the whole point: the assertions read the module buffer, not a spy.
 */
async function startStalledRun(schema: string | null): Promise<{
  settleMigrate: () => void;
  finished: Promise<unknown>;
}> {
  process.env.VERCEL = "1";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const { deps, reachedMigrate, settleMigrate } = makeStalledDeps();
  const finished = applyMigrationsToSchema(
    "postgres://x",
    schema,
    undefined,
    { isNew: false },
    deps
  ).catch(() => undefined);
  await reachedMigrate;
  return { settleMigrate, finished };
}

/**
 * The same run stalled one phase LATER: the migrate RETURNS, so
 * `markMigrateDone()` has already measured `migrate_ms`, and the pipeline then
 * hangs in the plain-index build. That is a post-migrate phase the caller's
 * deadline still covers, so the recorder is still live and still cuttable.
 */
async function startStalledAfterMigrate(): Promise<void> {
  process.env.VERCEL = "1";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const { deps } = makeStalledDeps();
  let signalReachedBuild: () => void = () => undefined;
  const reachedBuild = new Promise<void>((resolve) => {
    signalReachedBuild = resolve;
  });
  applyMigrationsToSchema(
    "postgres://x",
    SCHEMA,
    undefined,
    { isNew: false },
    {
      ...deps,
      runMigrate: vi.fn(() => Promise.resolve(false)),
      plainBuildPreviewConcurrentIndexes: vi.fn(() => {
        signalReachedBuild();
        return new Promise<void>(() => undefined);
      }),
    }
  ).catch(() => undefined);
  await reachedBuild;
}

/** Flush the buffer through the real POST sink and read back what it carried. */
async function flushAndReadEvents(): Promise<MigrateDeployEvent[]> {
  const fetchImpl = vi.fn((_url: string, _init: RequestInit) =>
    Promise.resolve(new Response(null))
  );
  await flushMigrateTelemetry({ env: VERCEL_KEYED_ENV, fetchImpl });
  if (fetchImpl.mock.calls.length === 0) {
    return [];
  }
  return JSON.parse(
    fetchImpl.mock.calls[0][1].body as string
  ) as MigrateDeployEvent[];
}

describe("deadline-cut migrate telemetry (ISS-6837)", () => {
  it("flushes a partial event for a run cut mid-migrate, carrying the phase detail known at cut-off", async () => {
    await startStalledRun(SCHEMA);

    expect(cutMigrateRunsAtDeadline(SCHEMA)).toBe(1);

    const events = await flushAndReadEvents();
    expect(events).toHaveLength(1);
    expect(events[0].schema).toBe(SCHEMA);
    expect(events[0].outcome).toBe(MigrateOutcome.DeadlineCut);
    // Phase detail the run HAD reached: the gate was acquired and the migrate
    // had started. `migrate_ms` stays null — the migrate never returned, and a
    // fabricated duration is exactly what this event must not carry.
    expect(events[0].gate_outcome).toBe(MigrateGateOutcome.Acquired);
    expect(events[0].gate_wait_ms).toBe(GATE_WAIT_MS);
    expect(events[0].migrate_started_at).not.toBeNull();
    expect(events[0].migrate_ms).toBeNull();
  });

  it("cuts only the schema whose caller expired, leaving a sibling run in flight", async () => {
    await startStalledRun(SCHEMA);
    await startStalledRun("preview_other");

    expect(cutMigrateRunsAtDeadline(SCHEMA)).toBe(1);

    const events = await flushAndReadEvents();
    expect(events.map((event) => event.schema)).toEqual([SCHEMA]);
    // Positive sibling: "emitted nothing" is also what a DROPPED run looks like,
    // so assert the sibling is still cuttable by its own caller's deadline.
    expect(cutMigrateRunsAtDeadline("preview_other")).toBe(1);
  });

  it("still emits the terminal event when the abandoned migrate finishes after the cut", async () => {
    const { settleMigrate, finished } = await startStalledRun(SCHEMA);
    expect(cutMigrateRunsAtDeadline(SCHEMA)).toBe(1);

    // The cut does not stop the migrate. On `main` this late finish reaches the
    // stdout sink with a COMPLETE event; suppressing it would trade real signal
    // for a partial and hide whether the run ended ok or on the P1002 storm.
    settleMigrate();
    await finished;

    const events = await flushAndReadEvents();
    expect(events.map((event) => event.outcome)).toEqual([
      MigrateOutcome.DeadlineCut,
      MigrateOutcome.Ok,
    ]);
    // One run, so `count_distinct(migrate_run_id)` still counts it once.
    expect(events[0].migrate_run_id).toBe(events[1].migrate_run_id);
    // Only the terminal row can report the migrate's real duration.
    expect(events[0].migrate_ms).toBeNull();
    expect(events[1].migrate_ms).not.toBeNull();
  });

  it("does not cut a run that already finished normally", async () => {
    process.env.VERCEL = "1";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { deps } = makeStalledDeps();
    await applyMigrationsToSchema(
      "postgres://x",
      SCHEMA,
      undefined,
      { isNew: false },
      { ...deps, runMigrate: vi.fn(() => Promise.resolve(false)) }
    );

    expect(cutMigrateRunsAtDeadline(SCHEMA)).toBe(0);

    const events = await flushAndReadEvents();
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe(MigrateOutcome.Ok);
  });

  it("carries the measured migrate_ms when the cut lands in a post-migrate phase", async () => {
    await startStalledAfterMigrate();

    // Still live, and still cut: the deadline is the caller's budget for the
    // WHOLE pipeline, so a run past `markMigrateDone()` is as cuttable as one
    // inside the migrate. Narrowing the interval to the migrate subprocess
    // would make this 0 and emit nothing for the phase that hung.
    expect(cutMigrateRunsAtDeadline(SCHEMA)).toBe(1);

    const events = await flushAndReadEvents();
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe(MigrateOutcome.DeadlineCut);
    // The other `deadline_cut` shape: `markMigrateDone()` already measured a
    // real duration, so the row reports it instead of nulling out a measurement
    // that was actually taken — and its non-nullness is what places the cut
    // downstream of the migrate.
    expect(events[0].migrate_started_at).not.toBeNull();
    expect(events[0].migrate_ms).not.toBeNull();
  });
});
