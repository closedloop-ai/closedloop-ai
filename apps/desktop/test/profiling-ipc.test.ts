import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  installIpcProfiling,
  type ProfilingIpcMain,
  withIpcProfiling,
} from "../src/main/profiling/ipc-profiling.js";
import type { ProfilingIpcRow } from "../src/shared/profiling.js";
import { createTestClock } from "./helpers/profiling-test-helpers.js";

type Registered = Map<string, (...args: unknown[]) => unknown>;

/** A registrar with the same shape as `ipcMain`, recording what it was given. */
function createFakeIpcMain(): {
  ipcMain: ProfilingIpcMain;
  registered: Registered;
} {
  const registered: Registered = new Map();
  const ipcMain: ProfilingIpcMain = {
    handle(channel, listener) {
      registered.set(channel, listener);
    },
  };
  return { ipcMain, registered };
}

function createRecordingSink(): {
  rows: ProfilingIpcRow[];
  append(row: ProfilingIpcRow): void;
} {
  const rows: ProfilingIpcRow[] = [];
  return { rows, append: (row) => rows.push(row) };
}

describe("ipc profiling wrapper", () => {
  test("records wall time and preserves a synchronous return value", async () => {
    const { ipcMain, registered } = createFakeIpcMain();
    const sink = createRecordingSink();
    const clock = createTestClock();
    installIpcProfiling(ipcMain, sink, clock);

    ipcMain.handle("desktop:sync-op", () => {
      clock.advance(12);
      return { ok: true };
    });
    const result = await registered.get("desktop:sync-op")?.({});

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(sink.rows, [
      { channel: "desktop:sync-op", ms: 12, ts: 1_700_000_000_012 },
    ]);
  });

  test("records wall time and preserves an async resolved value", async () => {
    const { ipcMain, registered } = createFakeIpcMain();
    const sink = createRecordingSink();
    const clock = createTestClock();
    installIpcProfiling(ipcMain, sink, clock);

    ipcMain.handle("desktop:async-op", async (...args: unknown[]) => {
      await Promise.resolve();
      clock.advance(40);
      return args[1];
    });
    const result = await registered.get("desktop:async-op")?.({}, "payload");

    assert.equal(result, "payload");
    assert.equal(sink.rows.length, 1);
    assert.equal(sink.rows[0]?.channel, "desktop:async-op");
    assert.equal(sink.rows[0]?.ms, 40);
  });

  test("rethrows a synchronous handler error unchanged and still records", () => {
    const { ipcMain, registered } = createFakeIpcMain();
    const sink = createRecordingSink();
    const clock = createTestClock();
    installIpcProfiling(ipcMain, sink, clock);
    const boom = new Error("handler exploded");

    ipcMain.handle("desktop:throws", () => {
      clock.advance(3);
      throw boom;
    });

    assert.throws(
      () => registered.get("desktop:throws")?.({}),
      (error) => {
        assert.equal(error, boom, "the original error instance must propagate");
        return true;
      }
    );
    assert.deepEqual(sink.rows, [
      { channel: "desktop:throws", ms: 3, ts: 1_700_000_000_003 },
    ]);
  });

  test("rejects with the original error and still records", async () => {
    const { ipcMain, registered } = createFakeIpcMain();
    const sink = createRecordingSink();
    const clock = createTestClock();
    installIpcProfiling(ipcMain, sink, clock);
    const boom = new Error("async handler exploded");

    ipcMain.handle("desktop:rejects", async () => {
      await Promise.resolve();
      clock.advance(7);
      throw boom;
    });

    await assert.rejects(
      async () => await registered.get("desktop:rejects")?.({}),
      (error) => {
        assert.equal(error, boom);
        return true;
      }
    );
    assert.equal(sink.rows.length, 1);
    assert.equal(sink.rows[0]?.ms, 7);
  });

  test("a throwing sink cannot break the handler", async () => {
    const { ipcMain, registered } = createFakeIpcMain();
    const clock = createTestClock();
    installIpcProfiling(
      ipcMain,
      {
        append() {
          throw new Error("sink is on fire");
        },
      },
      clock
    );

    ipcMain.handle("desktop:resilient", () => "still fine");
    const result = await registered.get("desktop:resilient")?.({});

    assert.equal(result, "still fine");
  });

  test("uninstall restores the original handle", () => {
    const { ipcMain } = createFakeIpcMain();
    const original = ipcMain.handle;

    const uninstall = installIpcProfiling(ipcMain, createRecordingSink());
    assert.notEqual(ipcMain.handle, original, "expected handle to be patched");
    uninstall();

    assert.equal(ipcMain.handle, original);
  });

  test("withIpcProfiling restores the handle when the registrar throws", () => {
    const { ipcMain, registered } = createFakeIpcMain();
    const original = ipcMain.handle;
    const sink = createRecordingSink();
    const registrarError = new Error("a registrar blew up mid-block");

    assert.throws(
      () =>
        withIpcProfiling(ipcMain, sink, () => {
          ipcMain.handle("desktop:registered-before-throw", () => "ok");
          throw registrarError;
        }),
      (error) => {
        assert.equal(error, registrarError);
        return true;
      }
    );

    assert.equal(
      ipcMain.handle,
      original,
      "a throwing registrar must not leak the patch for the process lifetime"
    );
    // The handlers registered before the throw are still wrapped — the patch is
    // removed, not retroactively undone.
    assert.ok(registered.has("desktop:registered-before-throw"));
  });

  test("channels registered after uninstall are not profiled", async () => {
    const { ipcMain, registered } = createFakeIpcMain();
    const sink = createRecordingSink();
    const clock = createTestClock();

    withIpcProfiling(
      ipcMain,
      sink,
      () => {
        ipcMain.handle("desktop:inside", () => {
          clock.advance(5);
          return "inside";
        });
      },
      clock
    );
    ipcMain.handle("desktop:outside", () => {
      clock.advance(5);
      return "outside";
    });

    await registered.get("desktop:inside")?.({});
    await registered.get("desktop:outside")?.({});

    assert.deepEqual(
      sink.rows.map((row) => row.channel),
      ["desktop:inside"]
    );
  });
});
