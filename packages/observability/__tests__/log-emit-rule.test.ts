// ISS-12265. `DD_LOGS_MIN_LEVEL` and `DD_LOGS_SAMPLE_RATE` decide whether a
// `log.*` call is emitted. The decision must be the same on both sinks: the
// structured console line the Vercel drain reads, and the agentless intake
// entry. Unset, every call is emitted, as before the rule existed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { keys } from "../keys";
import { LOG_SAMPLE_RATE_KEY, LogLevel } from "../log-emit-rule";
import {
  deleteEnvForTest,
  importLogWithFetch,
  parseFlushedBody,
  stubDatadogEnv,
} from "./test-helpers";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("log emit rule", () => {
  it("emits every level on both sinks when neither key is set", async () => {
    clearInheritedEmitKeys();
    const random = vi.spyOn(Math, "random");

    const sinks = await emitEachLevel("default");

    expect(sinks.console).toEqual(messagesFor("default", LEVELS));
    expect(sinks.intake).toEqual(messagesFor("default", LEVELS));
    expect(random).not.toHaveBeenCalled();
  });

  it("drops the levels below DD_LOGS_MIN_LEVEL from both sinks and keeps the rest", async () => {
    clearInheritedEmitKeys();
    vi.stubEnv("DD_LOGS_MIN_LEVEL", LogLevel.Warn);

    const sinks = await emitEachLevel("threshold");

    const kept = messagesFor("threshold", [LogLevel.Warn, LogLevel.Error]);
    expect(sinks.console).toEqual(kept);
    expect(sinks.intake).toEqual(kept);
  });

  it("samples each call once, so both sinks keep and drop the same calls", async () => {
    clearInheritedEmitKeys();
    vi.stubEnv("DD_LOGS_SAMPLE_RATE", "0.5");
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.8)
      .mockReturnValueOnce(0.4)
      .mockReturnValueOnce(0.6);

    const sinks = await emit("sampled", [
      LogLevel.Info,
      LogLevel.Info,
      LogLevel.Error,
      LogLevel.Error,
    ]);

    const kept = ["sampled.0.info", "sampled.2.error"];
    expect(sinks.console).toEqual(kept);
    expect(sinks.intake).toEqual(kept);
  });

  it("leaves the default entry exactly as it was before the rule existed", async () => {
    clearInheritedEmitKeys();

    const sinks = await emit("unsampled", [LogLevel.Info]);

    expect(sinks.consoleLines).toEqual([
      '{"message":"unsampled.0.info","level":"info","status":"info"}',
    ]);
    expect(sinks.intakeEntries.map((entry) => Object.keys(entry))).toEqual([
      [
        "message",
        "level",
        "status",
        "service",
        "ddsource",
        "ddtags",
        "timestamp",
        "origin",
      ],
    ]);
  });

  it("stamps a rate below 1 on each kept entry in both sinks", async () => {
    clearInheritedEmitKeys();
    vi.stubEnv("DD_LOGS_SAMPLE_RATE", "0.25");
    vi.spyOn(Math, "random").mockReturnValueOnce(0.1);

    const sinks = await emit("stamped", [LogLevel.Info]);

    const consoleEntries = sinks.consoleLines.map((line) =>
      JSON.parse(String(line))
    );
    for (const entries of [consoleEntries, sinks.intakeEntries]) {
      expect(entries).toEqual([
        expect.objectContaining({
          message: "stamped.0.info",
          [LOG_SAMPLE_RATE_KEY]: 0.25,
        }),
      ]);
    }
  });

  it("drops every call from both sinks at DD_LOGS_SAMPLE_RATE=0", async () => {
    clearInheritedEmitKeys();
    vi.stubEnv("DD_LOGS_SAMPLE_RATE", "0");

    const sinks = await emitEachLevel("silenced");

    expect(sinks.console).toEqual([]);
    expect(sinks.intake).toEqual([]);
  });

  // An invalid key makes keys() throw, so these two run the raw-env branch,
  // where each key is parsed on its own: the valid one still applies.
  it("treats an invalid DD_LOGS_MIN_LEVEL as unset and still applies a valid rate", async () => {
    clearInheritedEmitKeys();
    vi.stubEnv("DD_LOGS_MIN_LEVEL", "verbose");
    vi.stubEnv("DD_LOGS_SAMPLE_RATE", "0.5");
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.8)
      .mockReturnValueOnce(0.4)
      .mockReturnValueOnce(0.6);

    const sinks = await emitEachLevel("bad-level");

    const kept = messagesFor("bad-level", [LogLevel.Debug, LogLevel.Warn]);
    expect(sinks.console).toEqual(kept);
    expect(sinks.intake).toEqual(kept);
    expect(sinks.errors.filter(isEmitRuleReport)).toEqual([
      expect.stringContaining("DD_LOGS_MIN_LEVEL"),
    ]);
  });

  it("treats an invalid DD_LOGS_SAMPLE_RATE as unset and still applies a valid level", async () => {
    clearInheritedEmitKeys();
    vi.stubEnv("DD_LOGS_MIN_LEVEL", LogLevel.Error);
    vi.stubEnv("DD_LOGS_SAMPLE_RATE", " ");
    const random = vi.spyOn(Math, "random");

    const sinks = await emitEachLevel("bad-rate");

    const kept = messagesFor("bad-rate", [LogLevel.Error]);
    expect(sinks.console).toEqual(kept);
    expect(sinks.intake).toEqual(kept);
    expect(random).not.toHaveBeenCalled();
    expect(sinks.errors.filter(isEmitRuleReport)).toEqual([
      expect.stringContaining("DD_LOGS_SAMPLE_RATE"),
    ]);
  });

  it("rejects an invalid value in the env schema the apps extend", () => {
    clearInheritedEmitKeys();
    vi.spyOn(console, "error").mockImplementation(() => {
      // createEnv prints each rejection before throwing it
    });
    for (const [key, value] of [
      ["DD_LOGS_MIN_LEVEL", "verbose"],
      ["DD_LOGS_SAMPLE_RATE", "1.5"],
      ["DD_LOGS_SAMPLE_RATE", "abc"],
      ["DD_LOGS_SAMPLE_RATE", " "],
    ]) {
      vi.stubEnv(key, value);
      expect(() => keys(), `${key}=${value}`).toThrow();
      vi.unstubAllEnvs();
    }

    vi.stubEnv("DD_LOGS_MIN_LEVEL", LogLevel.Error);
    vi.stubEnv("DD_LOGS_SAMPLE_RATE", "0");
    expect(keys()).toMatchObject({
      DD_LOGS_MIN_LEVEL: LogLevel.Error,
      DD_LOGS_SAMPLE_RATE: 0,
    });
  });
});

const LEVELS = Object.values(LogLevel);

const CONSOLE_METHODS = {
  [LogLevel.Debug]: "debug",
  [LogLevel.Info]: "info",
  [LogLevel.Warn]: "warn",
  [LogLevel.Error]: "error",
} as const satisfies Record<LogLevel, keyof Console>;

function messagesFor(prefix: string, levels: readonly LogLevel[]): string[] {
  return levels.map((level) => `${prefix}.${LEVELS.indexOf(level)}.${level}`);
}

function emitEachLevel(prefix: string) {
  return emit(prefix, LEVELS);
}

/**
 * Open both sinks, make one call per entry in `levels`, and return the messages
 * each sink received, in call order. Messages are `<prefix>.<index>.<level>`.
 */
async function emit(prefix: string, levels: readonly LogLevel[]) {
  stubDatadogEnv(100);
  vi.stubEnv("DD_LOGS_JSON", "1");
  const lines: unknown[] = [];
  const errors: string[] = [];
  for (const level of LEVELS) {
    vi.spyOn(console, CONSOLE_METHODS[level]).mockImplementation(
      (line: unknown) => {
        lines.push(line);
        if (level === LogLevel.Error && typeof line === "string") {
          errors.push(line);
        }
      }
    );
  }
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  const log = await importLogWithFetch(fetchMock);

  levels.forEach((level, index) => {
    log[level](`${prefix}.${index}.${level}`);
  });
  await log.flush();

  const ours = (message: unknown): message is string =>
    typeof message === "string" && message.startsWith(`${prefix}.`);
  const intakeEntries =
    fetchMock.mock.calls.length === 0
      ? []
      : parseFlushedBody<Record<string, unknown>>(fetchMock).filter((entry) =>
          ours(entry.message)
        );
  return {
    console: lines.map(parseMessage).filter(ours),
    intake: intakeEntries.map((entry) => entry.message),
    consoleLines: lines.filter((line) => ours(parseMessage(line))),
    intakeEntries,
    errors,
  };
}

function parseMessage(line: unknown): unknown {
  if (typeof line !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(line).message;
  } catch {
    return undefined;
  }
}

/** A test stubs the keys it is about; neither may leak in from the shell. */
function clearInheritedEmitKeys(): void {
  deleteEnvForTest("DD_LOGS_MIN_LEVEL", "DD_LOGS_SAMPLE_RATE");
}

function isEmitRuleReport(line: string): boolean {
  return line.startsWith("[observability] DD_LOGS_");
}
