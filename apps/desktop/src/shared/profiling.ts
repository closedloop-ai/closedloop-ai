/**
 * ISS-4430 — the desktop profiling capture contract.
 *
 * Every profiling code path in the app is gated on {@link ProfilingEnvVar.Dir}
 * being set: unset means the instrumentation is never installed, never
 * allocates, and never runs, so a production launch behaves exactly as it did
 * before this file existed. When it IS set, the instrumentation is fail-open —
 * a sink, clock, or profiler error is swallowed and can never change the result,
 * timing semantics, or error behavior of the operation being measured.
 *
 * This module holds only the values both processes agree on (the main process
 * and the db-host utilityProcess): the env-var names, the artifact filenames,
 * and the JSONL row shapes the `scripts/perf/` analyzers consume. It imports
 * nothing — in particular no `electron` — so the utilityProcess can load it.
 */

/** Env vars that turn profiling capture on. */
export const ProfilingEnvVar = {
  /**
   * Absolute directory profiling artifacts are written into. UNSET is the
   * production default and means "profiling is off" everywhere.
   */
  Dir: "CLOSEDLOOP_PROFILE_DIR",
  /**
   * `"1"` additionally records a Chromium content trace in the main process.
   * Separate from {@link ProfilingEnvVar.Dir} because tracing is far more
   * expensive than the JSONL/CPU capture and is only wanted for renderer work.
   */
  Trace: "CLOSEDLOOP_PROFILE_TRACE",
  /**
   * ISS-5278 — `"1"` builds the renderer against `react-dom/profiling` instead
   * of the stock production React DOM.
   *
   * This is the ONLY var here read at BUILD time rather than at launch, and it
   * is why it cannot be folded into {@link ProfilingEnvVar.Dir}: React strips
   * `<Profiler onRender>` from its production build entirely (there is no
   * `onRender` call site left in `react-dom-client.production.js`), so no launch
   * env can switch render-commit capture back on. Without this the whole
   * render-commit chain — Profiler → `useRenderCommitInstrumentation` → OTel
   * bridge → main-side sink — is silent at its very first link and
   * `render-commits.jsonl` is never written.
   */
  RendererBuild: "CLOSEDLOOP_PROFILE_RENDERER_BUILD",
} as const;

export type ProfilingEnvVar =
  (typeof ProfilingEnvVar)[keyof typeof ProfilingEnvVar];

/** Value {@link ProfilingEnvVar.Trace} must carry to enable content tracing. */
export const PROFILING_TRACE_ENABLED_VALUE = "1";

/**
 * Value {@link ProfilingEnvVar.RendererBuild} must carry to build the renderer
 * against `react-dom/profiling`.
 */
export const PROFILING_RENDERER_BUILD_ENABLED_VALUE = "1";

/**
 * Artifact filenames written under {@link ProfilingEnvVar.Dir}. The analyzers in
 * `scripts/perf/` locate artifacts by these names, so producer and consumer read
 * them from here rather than repeating the literals.
 */
export const ProfilingArtifactFile = {
  /** Per-op wall time from the db-host `measureOp` choke point. */
  DbOps: "db-ops.jsonl",
  /**
   * Per-op ADMISSION breakdown for the db-host's bounded read lane. Separate
   * from {@link ProfilingArtifactFile.DbOps} because it answers a different
   * question: `db-ops.jsonl` records how long an op TOOK, which spans the lane
   * wait, so it cannot distinguish a slow query from one that merely waited.
   */
  DbLane: "db-lane.jsonl",
  /** Per-channel wall time from the main-process IPC registration block. */
  Ipc: "ipc.jsonl",
  /** Decoded React Profiler commits forwarded over the renderer OTel bridge. */
  RenderCommits: "render-commits.jsonl",
  /** V8 CPU profile for the Electron main process. */
  MainCpuProfile: "main.cpuprofile",
  /** V8 CPU profile for the db-host utilityProcess. */
  DbHostCpuProfile: "dbhost.cpuprofile",
  /** Chromium content trace (Perfetto-readable), opt-in via the Trace env var. */
  ContentTrace: "content-trace.json",
} as const;

export type ProfilingArtifactFile =
  (typeof ProfilingArtifactFile)[keyof typeof ProfilingArtifactFile];

/** One db-host op: the dotted op path and how long it took, in wall time. */
export type ProfilingDbOpRow = {
  op: string;
  ms: number;
  ts: number;
};

/** One `ipcMain.handle` invocation on a registered channel. */
export type ProfilingIpcRow = {
  channel: string;
  ms: number;
  ts: number;
};

/**
 * One React Profiler commit, decoded out of the renderer OTel bridge's
 * positional envelope at write time so the generic JSONL analyzer sees flat,
 * uniform rows.
 *
 * `view`, `phase`, and `cause` are plain strings rather than the
 * `render-commit-event.ts` const-object types on purpose: they are decoded from
 * a renderer-supplied wire payload, so this build cannot assume the sending
 * renderer only ever emits values it knows. The analyzer groups by whatever
 * arrives.
 */
export type ProfilingRenderCommitRow = {
  view: string;
  phase: string;
  cause: string;
  actualMs: number;
  ts: number;
};

/**
 * One trip through the db-host's BOUNDED READ LANE, split into the three waits
 * that a single `db-ops.jsonl` duration folds together.
 *
 * The distinction this row exists to make: an op that took 9s because its SQL
 * is slow and an op that took 9s because it sat behind two other permits are
 * indistinguishable in `db-ops.jsonl`, and they have opposite fixes. `execMs`
 * is the op's own cost; `admitMs` + `queueMs` is time it spent waiting to be
 * allowed to start.
 *
 * `activeOnArrival` / `waitingOnArrival` are the lane's occupancy at the moment
 * this op arrived — the "what else was in flight" that turns a slow sample into
 * an explicable one. They are plain integers read off the lane's own counters,
 * so they cost nothing and never retain a reference to another op's data.
 */
export type ProfilingLaneRow = {
  op: string;
  /** Pre-permit memory-pressure park (FEA-3150 `admit`, step 1). */
  admitMs: number;
  /** Time blocked on a permit — the semaphore wait proper. */
  queueMs: number;
  /** Post-acquire pressure re-check; only non-zero when the acquire QUEUED. */
  reAdmitMs: number;
  /** The op itself, INCLUDING the in-permit structured clone of its result. */
  execMs: number;
  /** True when no permit was free and this op had to wait for one. */
  queued: boolean;
  activeOnArrival: number;
  waitingOnArrival: number;
  ts: number;
};

/** Any row the JSONL sink can serialize. */
export type ProfilingRow =
  | ProfilingDbOpRow
  | ProfilingIpcRow
  | ProfilingLaneRow
  | ProfilingRenderCommitRow
  | ProfilingDroppedRowsMarker;

/**
 * The marker key an analyzer looks for to detect a LOSSY capture. This is a
 * cross-PROGRAM contract: the JSONL sink writes it here, and
 * `scripts/perf/analyze-timings.ts` reads it via its own
 * `PERF_SINK_DROPPED_ROWS_FIELD` twin — the two TypeScript programs do not
 * share imports, so each side pins the literal `"perfSinkDroppedRows"` in its
 * tests. Renaming either constant's VALUE fails that side's pin test.
 */
export const PROFILING_DROPPED_ROWS_KEY = "perfSinkDroppedRows";

/**
 * Written once when a sink closes after losing rows — either shed at the buffer
 * ceiling under back-pressure, or lost with a write batch the disk rejected.
 * Its presence tells an analyzer the population it is about to compute
 * percentiles over is INCOMPLETE, so it can report the loss instead of emitting
 * a confident number derived from a partial capture.
 */
export type ProfilingDroppedRowsMarker = {
  [PROFILING_DROPPED_ROWS_KEY]: number;
  ts: number;
};

/**
 * The narrow write surface an instrumented call site needs. Consumers depend on
 * this rather than the concrete JSONL sink so a test can pass a plain recorder
 * (or a throwing one, to prove the fail-open path).
 */
export type ProfilingSink<TRow extends ProfilingRow> = {
  append(row: TRow): void;
};

/**
 * Time source, split so a duration is measured on the monotonic clock while the
 * row's `ts` stays a real wall-clock epoch an operator can correlate with logs.
 * Injectable so timing tests are deterministic instead of racing the real clock.
 */
export type ProfilingClock = {
  /** Monotonic milliseconds; only differences are meaningful. */
  nowMs(): number;
  /** Wall-clock epoch milliseconds. */
  nowEpochMs(): number;
};

/** Process clock used when a call site does not inject one. */
export const defaultProfilingClock: ProfilingClock = {
  nowMs: () => performance.now(),
  nowEpochMs: () => Date.now(),
};

/** Environment bag shape — matches `process.env` without depending on it. */
export type ProfilingEnv = Record<string, string | undefined>;

/**
 * Read the monotonic clock, returning `null` when the clock itself fails or
 * returns a non-finite value. Used by both the IPC wrapper and the db-host
 * `measureOp` extension to decide "no usable start stamp" in one place.
 */
export function readMonotonicMs(clock: ProfilingClock): number | null {
  try {
    const now = clock.nowMs();
    return Number.isFinite(now) ? now : null;
  } catch {
    return null;
  }
}

/**
 * The profile output directory, or `null` when profiling is off. This is THE
 * gate: every profiling call site asks this question first, so "is profiling
 * on?" has exactly one answer in both processes.
 */
export function resolveProfilingDir(env: ProfilingEnv): string | null {
  const dir = env[ProfilingEnvVar.Dir];
  if (typeof dir !== "string" || dir.trim() === "") {
    return null;
  }
  return dir;
}

/**
 * Describe an error for profiling log messages. Shared by the main-process and
 * db-host profiling sessions so the message format is consistent.
 */
export function describeProfilingError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when the operator additionally asked for a Chromium content trace. */
export function isProfilingTraceEnabled(env: ProfilingEnv): boolean {
  return (
    resolveProfilingDir(env) !== null &&
    env[ProfilingEnvVar.Trace] === PROFILING_TRACE_ENABLED_VALUE
  );
}

/**
 * True when the renderer should be BUILT against `react-dom/profiling`
 * (ISS-5278).
 *
 * Deliberately NOT gated on {@link resolveProfilingDir}, unlike every other
 * predicate here: this is read by `vite.renderer.config.ts` during the build,
 * where the run directory does not exist yet and
 * {@link ProfilingEnvVar.Dir} is therefore unset. Requiring both would make the
 * flag unsatisfiable and silently return the stock production renderer — the
 * exact failure this fixes.
 */
export function isProfilingRendererBuildEnabled(env: ProfilingEnv): boolean {
  return (
    env[ProfilingEnvVar.RendererBuild] ===
    PROFILING_RENDERER_BUILD_ENABLED_VALUE
  );
}
