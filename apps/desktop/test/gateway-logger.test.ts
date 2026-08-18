import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, describe, test } from "node:test";
import { vi } from "vitest";
import { handleUncaughtException } from "../src/main/lifecycle/error-handlers.js";
import {
  ConsoleChannel,
  type ConsoleSink,
  GatewayLogger,
  installConsoleStreamErrorGuard,
  type LogEntry,
} from "../src/main/logging/gateway-logger.js";
import {
  isBrokenPipeError,
  isOutputStreamBrokenPipeError,
  isOutputStreamClosed,
} from "../src/shared/broken-pipe.js";

const WRITE_EPIPE_RE = /write EPIPE/;
const CONSOLE_STREAM_ERROR_RE = /stderr stream error: something else/;
const SINK_FAILED_RE = /persistent log sink failed/;
const DISK_FULL_RE = /disk full/;
const SUPPRESSED_BROKEN_PIPE_RE = /suppressed broken-pipe write/;

/** An output stream that has gone away — the ISS-5089 shutdown condition. */
const CLOSED_STREAM = { destroyed: true, writable: false };
/** An output stream still accepting writes. */
const LIVE_STREAM = { destroyed: false, writable: true };
/**
 * Closed-stream codes that a NON-stdio fault raises just as readily: an fs
 * descriptor closed underneath a read, a destroyed socket, a child's stdin
 * written after end. `EPIPE` is deliberately absent — it is covered by its own
 * suppressed/not-suppressed pair.
 */
const BROKEN_PIPE_CODES_NOT_FROM_STDIO = [
  "EBADF",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
] as const;

function makeLogger(consoleSink?: ConsoleSink) {
  const persisted: LogEntry[] = [];
  const logger = new GatewayLogger((entry) => {
    persisted.push(entry);
  }, consoleSink);
  return { logger, persisted };
}

/** A console sink whose writes fail with EPIPE once shutdown has begun. */
function makeShutdownConsoleSink() {
  const written: string[] = [];
  let closed = false;
  const write = (_prefix: unknown, message: unknown) => {
    if (closed) {
      const error: NodeJS.ErrnoException = new Error("write EPIPE");
      error.code = "EPIPE";
      error.syscall = "write";
      throw error;
    }
    written.push(String(message));
  };
  return {
    closePipe: () => {
      closed = true;
    },
    sink: { error: write, log: write, warn: write } satisfies ConsoleSink,
    written,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GatewayLogger", () => {
  test("dedupes consecutive messages, caps the buffer, and tees to the persistent sink", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { logger, persisted } = makeLogger();

    logger.info("test", "same");
    logger.info("test", "same");
    for (let i = 0; i < 505; i++) {
      logger.info("test", `message-${i}`);
    }

    const entries = logger.getEntries();
    assert.equal(entries.length, 500);
    assert.equal(entries[0].message, "message-5");
    assert.equal(persisted.length, 506);
    assert.equal(persisted[0].message, "same");
    assert.equal(persisted[0].session, "current");
  });

  test("does not invoke lazy debug formatting when verbose logging is off", () => {
    const { logger, persisted } = makeLogger();
    let invoked = false;

    logger.debug("expensive", () => {
      invoked = true;
      return "formatted";
    });

    assert.equal(invoked, false);
    assert.deepEqual(logger.getEntries(), []);
    assert.deepEqual(persisted, []);
  });

  test("invokes lazy debug formatting when verbose logging is on", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { logger, persisted } = makeLogger();

    logger.setVerbose(true);
    persisted.length = 0;
    logger.clear();
    logger.debug("expensive", () => "formatted");

    assert.equal(logger.getEntries()[0].message, "formatted");
    assert.equal(persisted[0].message, "formatted");
  });

  test("seeds previous-session entries without teeing them back to disk", () => {
    const { logger, persisted } = makeLogger();

    logger.seedPreviousSessionEntries([
      {
        timestamp: "2026-05-08T12:00:00.000Z",
        level: "warn",
        tag: "desktop",
        message: "from previous boot",
      },
    ]);

    assert.deepEqual(logger.getEntries(), [
      {
        timestamp: "2026-05-08T12:00:00.000Z",
        level: "warn",
        tag: "desktop",
        message: "from previous boot",
        session: "previous",
      },
    ]);
    assert.deepEqual(persisted, []);
  });
});

describe("GatewayLogger EPIPE safety on shutdown (ISS-5089)", () => {
  test("does not throw when console egress fails, and still records the entry", () => {
    const { closePipe, sink, written } = makeShutdownConsoleSink();
    const { logger, persisted } = makeLogger(sink);

    logger.info("gateway", "before shutdown");
    closePipe();

    // Ctrl-C closed the terminal; the shutdown path keeps logging.
    assert.doesNotThrow(() => logger.info("gateway", "during shutdown"));

    assert.deepEqual(written, ["before shutdown"]);
    assert.deepEqual(
      persisted.map((entry) => entry.message),
      ["before shutdown", "during shutdown"]
    );
    assert.deepEqual(
      logger.getEntries().map((entry) => entry.message),
      ["before shutdown", "during shutdown"]
    );
  });

  test("latches console egress off after a broken pipe instead of retrying per entry", () => {
    const { closePipe, sink } = makeShutdownConsoleSink();
    const { logger, persisted } = makeLogger(sink);
    closePipe();

    logger.error("gateway", "first after close");
    assert.equal(logger.isConsoleEgressClosed(ConsoleChannel.Stderr), true);

    // Subsequent entries never touch the dead sink again, but stay durable.
    assert.doesNotThrow(() => logger.warn("gateway", "second after close"));
    assert.deepEqual(
      persisted.map((entry) => entry.message),
      ["first after close", "second after close"]
    );
  });

  test("a dead stdout does not silence a healthy stderr", () => {
    // `desktop-dev | head` closes stdout while stderr is still a live terminal.
    // A process-wide latch would blind the operator to every warning and error
    // for the rest of the run.
    const written: string[] = [];
    let stdoutClosed = false;
    const { logger } = makeLogger({
      error: (_prefix: unknown, message: unknown) => {
        written.push(`err:${String(message)}`);
      },
      log: (_prefix: unknown, message: unknown) => {
        if (stdoutClosed) {
          const error: NodeJS.ErrnoException = new Error("write EPIPE");
          error.code = "EPIPE";
          throw error;
        }
        written.push(`out:${String(message)}`);
      },
      warn: (_prefix: unknown, message: unknown) => {
        written.push(`warn:${String(message)}`);
      },
    });

    stdoutClosed = true;
    logger.info("gateway", "info after stdout closed");
    logger.warn("gateway", "warn after stdout closed");
    logger.error("gateway", "error after stdout closed");

    assert.equal(logger.isConsoleEgressClosed(ConsoleChannel.Stdout), true);
    assert.equal(logger.isConsoleEgressClosed(ConsoleChannel.Stderr), false);
    assert.deepEqual(written, [
      "warn:warn after stdout closed",
      "err:error after stdout closed",
    ]);
  });

  test("an EPIPE at shutdown is recorded but never reported as an application crash", async () => {
    // The bridge logs THROUGH this logger (startup.ts wires
    // `log: (msg) => gatewayLog.error("uncaught", msg)`), so an unguarded
    // console write here re-enters the handler that is already running.
    const { closePipe, sink } = makeShutdownConsoleSink();
    const { logger, persisted } = makeLogger(sink);
    closePipe();

    const exits: number[] = [];
    const emitted: unknown[] = [];
    const dialogs: string[] = [];
    const epipe: NodeJS.ErrnoException = new Error("write EPIPE");
    epipe.code = "EPIPE";
    epipe.syscall = "write";

    await assert.doesNotReject(() =>
      handleUncaughtException(epipe, {
        emitException: (error) => emitted.push(error),
        exit: (code) => exits.push(code),
        log: (msg) => logger.error("uncaught", msg),
        // The pipe this write died on is gone — that is what attributes the
        // error to stdout/stderr rather than to some unrelated descriptor.
        outputStreams: [CLOSED_STREAM, LIVE_STREAM],
        showDialog: (title) => dialogs.push(title),
      })
    );

    // The handler's own record survived to the durable sink...
    assert.equal(persisted.length, 1);
    assert.match(persisted[0].message, WRITE_EPIPE_RE);
    assert.match(persisted[0].message, SUPPRESSED_BROKEN_PIPE_RE);
    // ...and an expected shutdown is not a crash: no telemetry, no dialog, no
    // exit — and nothing recursed back through the logger to get there.
    assert.deepEqual(exits, []);
    assert.deepEqual(emitted, []);
    assert.deepEqual(dialogs, []);
  });

  test("a genuine uncaught exception is still reported as a crash", async () => {
    // The broken-pipe suppression above must not blanket-suppress real faults.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { logger } = makeLogger();
    const exits: number[] = [];
    const emitted: unknown[] = [];

    await handleUncaughtException(new Error("genuinely broken"), {
      emitException: (error) => emitted.push(error),
      exit: (code) => exits.push(code),
      log: (msg) => logger.error("uncaught", msg),
    });

    assert.deepEqual(exits, [1]);
    assert.equal(emitted.length, 1);
  });

  for (const code of BROKEN_PIPE_CODES_NOT_FROM_STDIO) {
    test(`a ${code} fault still crashes while stdout and stderr are healthy`, async () => {
      // The process-wide branch cannot key off the code alone: EBADF and the
      // destroyed-stream codes are equally what an unrelated descriptor, socket,
      // or child stdin looks like. Suppressing those would skip the fatal path
      // and leave the process alive after a real uncaught exception.
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { logger } = makeLogger();
      const exits: number[] = [];
      const emitted: unknown[] = [];
      const error: NodeJS.ErrnoException = new Error(`unrelated ${code}`);
      error.code = code;

      await handleUncaughtException(error, {
        emitException: (err) => emitted.push(err),
        exit: (exitCode) => exits.push(exitCode),
        log: (msg) => logger.error("uncaught", msg),
        outputStreams: [LIVE_STREAM, LIVE_STREAM],
      });

      assert.deepEqual(exits, [1]);
      assert.equal(emitted.length, 1);
    });
  }

  test("the same broken-pipe code IS suppressed once an output stream is gone", async () => {
    // The mirror of the case above: identical error, different attribution.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { logger } = makeLogger();
    const exits: number[] = [];
    const emitted: unknown[] = [];
    const error: NodeJS.ErrnoException = new Error("write EBADF");
    error.code = "EBADF";

    await handleUncaughtException(error, {
      emitException: (err) => emitted.push(err),
      exit: (exitCode) => exits.push(exitCode),
      log: (msg) => logger.error("uncaught", msg),
      outputStreams: [LIVE_STREAM, CLOSED_STREAM],
    });

    assert.deepEqual(exits, []);
    assert.deepEqual(emitted, []);
  });

  test("a persistent-sink failure is announced once, not swallowed or repeated", () => {
    const consoleWrites: string[] = [];
    const sink = {
      error: (_prefix: unknown, message: unknown) => {
        consoleWrites.push(String(message));
      },
      log: (_prefix: unknown, message: unknown) => {
        consoleWrites.push(String(message));
      },
      warn: (_prefix: unknown, message: unknown) => {
        consoleWrites.push(String(message));
      },
    };
    const logger = new GatewayLogger(() => {
      throw new Error("disk full");
    }, sink);

    assert.doesNotThrow(() => logger.info("gateway", "first"));
    assert.doesNotThrow(() => logger.info("gateway", "second"));

    // The entries still buffer, and the operator is told once that the durable
    // record is gone — not on every entry, and not never.
    assert.deepEqual(
      logger.getEntries().map((entry) => entry.message),
      ["first", "second"]
    );
    const announcements = consoleWrites.filter((line) =>
      SINK_FAILED_RE.test(line)
    );
    assert.equal(announcements.length, 1);
    assert.match(announcements[0], DISK_FULL_RE);
  });

  test("a throwing onChange callback does not escape clear or seed either", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { logger } = makeLogger();
    logger.setOnChange(() => {
      throw new Error("renderer gone");
    });

    assert.doesNotThrow(() => logger.info("gateway", "during teardown"));
    assert.doesNotThrow(() => logger.clear());
    assert.doesNotThrow(() =>
      logger.seedPreviousSessionEntries([
        {
          level: "warn",
          message: "from previous boot",
          tag: "desktop",
          timestamp: "2026-05-08T12:00:00.000Z",
        },
      ])
    );
  });
});

describe("installConsoleStreamErrorGuard (ISS-5089)", () => {
  test("swallows an async broken-pipe error and closes console egress", () => {
    const stream = new EventEmitter();
    const { logger } = makeLogger();
    installConsoleStreamErrorGuard(
      [{ channel: ConsoleChannel.Stdout, stream }],
      logger
    );

    const epipe: NodeJS.ErrnoException = new Error("write EPIPE");
    epipe.code = "EPIPE";

    // With no listener Node escalates this to an uncaught exception, which is
    // exactly the ISS-5089 crash; with the guard it is absorbed — and only the
    // dead channel is latched.
    assert.doesNotThrow(() => stream.emit("error", epipe));
    assert.equal(logger.isConsoleEgressClosed(ConsoleChannel.Stdout), true);
    assert.equal(logger.isConsoleEgressClosed(ConsoleChannel.Stderr), false);
  });

  test("records a non-broken-pipe stream error instead of swallowing it", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stream = new EventEmitter();
    const { logger, persisted } = makeLogger();
    installConsoleStreamErrorGuard(
      [{ channel: ConsoleChannel.Stderr, stream }],
      logger
    );

    stream.emit("error", new Error("something else"));

    assert.equal(logger.isConsoleEgressClosed(ConsoleChannel.Stderr), false);
    assert.equal(persisted.length, 1);
    assert.match(persisted[0].message, CONSOLE_STREAM_ERROR_RE);
    assert.equal(persisted[0].level, "warn");
  });

  test("is idempotent per stream so repeated wiring cannot stack listeners", () => {
    const stream = new EventEmitter();
    const { logger } = makeLogger();

    installConsoleStreamErrorGuard(
      [{ channel: ConsoleChannel.Stdout, stream }],
      logger
    );
    installConsoleStreamErrorGuard(
      [{ channel: ConsoleChannel.Stdout, stream }],
      logger
    );

    assert.equal(stream.listenerCount("error"), 1);
  });
});

describe("isBrokenPipeError", () => {
  test("recognizes closed-stream codes and rejects everything else", () => {
    for (const code of [
      "EPIPE",
      "EBADF",
      "ERR_STREAM_DESTROYED",
      "ERR_STREAM_WRITE_AFTER_END",
    ]) {
      const error: NodeJS.ErrnoException = new Error(code);
      error.code = code;
      assert.equal(isBrokenPipeError(error), true, code);
    }

    const enoent: NodeJS.ErrnoException = new Error("nope");
    enoent.code = "ENOENT";
    assert.equal(isBrokenPipeError(enoent), false);
    assert.equal(isBrokenPipeError(new Error("no code")), false);
    assert.equal(isBrokenPipeError(null), false);
    assert.equal(isBrokenPipeError("EPIPE"), false);
  });
});

describe("isOutputStreamBrokenPipeError", () => {
  test("requires BOTH a closed-stream code and a stream that is actually gone", () => {
    const epipe: NodeJS.ErrnoException = new Error("write EPIPE");
    epipe.code = "EPIPE";
    const enoent: NodeJS.ErrnoException = new Error("nope");
    enoent.code = "ENOENT";

    assert.equal(
      isOutputStreamBrokenPipeError(epipe, [LIVE_STREAM, CLOSED_STREAM]),
      true
    );
    // Right code, healthy streams — unattributable, so not suppressible.
    assert.equal(
      isOutputStreamBrokenPipeError(epipe, [LIVE_STREAM, LIVE_STREAM]),
      false
    );
    // Dead stream, unrelated fault.
    assert.equal(
      isOutputStreamBrokenPipeError(enoent, [CLOSED_STREAM, CLOSED_STREAM]),
      false
    );
    // No stream to attribute to is not evidence of a broken pipe.
    assert.equal(isOutputStreamBrokenPipeError(epipe, []), false);
    assert.equal(
      isOutputStreamBrokenPipeError(epipe, [null, undefined]),
      false
    );
  });

  test("treats an ended-but-not-destroyed stream as closed", () => {
    const epipe: NodeJS.ErrnoException = new Error("write EPIPE");
    epipe.code = "EPIPE";

    assert.equal(isOutputStreamClosed({ writableEnded: true }), true);
    assert.equal(isOutputStreamClosed(LIVE_STREAM), false);
    assert.equal(
      isOutputStreamBrokenPipeError(epipe, [{ writableEnded: true }]),
      true
    );
  });
});
