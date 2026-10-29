import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const PREVIEW_SCHEMA = "preview_feature_branch_abc123";
const DATABASE_URL_WITH_SCHEMA =
  "postgresql://user:pass@db.example.com:5432/closedloop?schema=public&sslmode=require";

const spawnSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

const runSeedProgramMock = vi.fn();
vi.mock("../seed/program", () => ({
  runSeedProgram: (...args: unknown[]) => runSeedProgramMock(...args),
}));

const { describePreviewSeedFailure, runPreviewSeed, runPreviewSeedInProcess } =
  await import("../preview-seed");

function makeResult(
  overrides: Partial<SpawnSyncReturns<string>>
): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  } as SpawnSyncReturns<string>;
}

afterEach(() => {
  spawnSyncMock.mockReset();
  runSeedProgramMock.mockReset();
  vi.restoreAllMocks();
});

describe("describePreviewSeedFailure — status null with no error", () => {
  it("falls back to 'unknown' when status is null and there is no error", () => {
    // pins current behavior; looks odd because a null status with no `error`
    // field is not something spawnSync documents as a real outcome, but the
    // `result.status ?? "unknown"` fallback exists precisely for this shape.
    expect(describePreviewSeedFailure(makeResult({ status: null }), 5000)).toBe(
      "failed with exit code unknown"
    );
  });
});

describe("runPreviewSeed — default deps (no logger/spawnSyncFn injected)", () => {
  it("uses the real node:child_process spawnSync and console when deps are omitted", () => {
    spawnSyncMock.mockReturnValue(makeResult({ status: 0 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    runPreviewSeed(DATABASE_URL_WITH_SCHEMA, PREVIEW_SCHEMA);

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Running seed for preview schema")
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("runPreviewSeed — stdout/stderr passthrough", () => {
  it("writes non-empty stdout and stderr to the process streams", () => {
    spawnSyncMock.mockReturnValue(
      makeResult({ stdout: "seed output\n", stderr: "seed warning\n" })
    );
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const logger = { log: vi.fn(), warn: vi.fn() };

    runPreviewSeed(DATABASE_URL_WITH_SCHEMA, PREVIEW_SCHEMA, {
      spawnSyncFn: spawnSyncMock,
      logger,
    });

    expect(stdoutWrite).toHaveBeenCalledWith("seed output\n");
    expect(stderrWrite).toHaveBeenCalledWith("seed warning\n");
  });

  it("does not write to the process streams when stdout/stderr are empty", () => {
    spawnSyncMock.mockReturnValue(makeResult({ stdout: "", stderr: "" }));
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const logger = { log: vi.fn(), warn: vi.fn() };

    runPreviewSeed(DATABASE_URL_WITH_SCHEMA, PREVIEW_SCHEMA, {
      spawnSyncFn: spawnSyncMock,
      logger,
    });

    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
  });
});

describe("runPreviewSeedInProcess", () => {
  it("declines for a null schema without importing the seed program", async () => {
    const result = await runPreviewSeedInProcess(
      DATABASE_URL_WITH_SCHEMA,
      null
    );

    expect(result).toEqual({ ran: false, reason: "not_a_preview_schema" });
    expect(runSeedProgramMock).not.toHaveBeenCalled();
  });

  it("declines for a non-preview schema without importing the seed program", async () => {
    const result = await runPreviewSeedInProcess(
      DATABASE_URL_WITH_SCHEMA,
      "public"
    );

    expect(result).toEqual({ ran: false, reason: "not_a_preview_schema" });
    expect(runSeedProgramMock).not.toHaveBeenCalled();
  });

  it("returns ok:true with the summary on a successful seed run", async () => {
    const summary = {
      organizationId: "org_1",
      userId: "user_1",
      elapsedMs: 42,
    };
    runSeedProgramMock.mockResolvedValue({ exitCode: 0, summary });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await runPreviewSeedInProcess(
      DATABASE_URL_WITH_SCHEMA,
      PREVIEW_SCHEMA,
      {},
      logger
    );

    expect(result).toEqual({ ran: true, ok: true, summary });
    expect(runSeedProgramMock).toHaveBeenCalledTimes(1);
    const call = runSeedProgramMock.mock.calls[0][0];
    expect(call.env.PGSCHEMA).toBe(PREVIEW_SCHEMA);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("in-process")
    );
  });

  it("returns ok:false with the seed's own error text when exitCode is non-zero", async () => {
    runSeedProgramMock.mockResolvedValue({
      exitCode: 1,
      error: "guard failed: non-empty org",
    });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await runPreviewSeedInProcess(
      DATABASE_URL_WITH_SCHEMA,
      PREVIEW_SCHEMA,
      {},
      logger
    );

    expect(result).toEqual({
      ran: true,
      ok: false,
      error: "guard failed: non-empty org",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("guard failed: non-empty org")
    );
  });

  it("falls back to a generic message when exitCode is 0 but no summary is returned", async () => {
    // pins current behavior; looks odd because exitCode:0 normally means
    // success, but the type allows a summary-less success shape and the
    // fallback text exists to describe exactly that combination.
    runSeedProgramMock.mockResolvedValue({ exitCode: 0 });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await runPreviewSeedInProcess(
      DATABASE_URL_WITH_SCHEMA,
      PREVIEW_SCHEMA,
      {},
      logger
    );

    expect(result).toEqual({
      ran: true,
      ok: false,
      error: "seed exited without a summary",
    });
  });
});
