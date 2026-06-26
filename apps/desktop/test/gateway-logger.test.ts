import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";
import { GatewayLogger, type LogEntry } from "../src/main/gateway-logger.js";

function makeLogger() {
  const persisted: LogEntry[] = [];
  const logger = new GatewayLogger((entry) => {
    persisted.push(entry);
  });
  return { logger, persisted };
}

afterEach(() => {
  mock.restoreAll();
});

describe("GatewayLogger", () => {
  test("dedupes consecutive messages, caps the buffer, and tees to the persistent sink", () => {
    mock.method(console, "log", () => {});
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
    mock.method(console, "log", () => {});
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
