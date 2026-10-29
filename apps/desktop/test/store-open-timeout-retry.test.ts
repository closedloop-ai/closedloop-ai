/**
 * @file store-open-timeout-retry.test.ts
 * @description ISS-9197 — which boot failures terminate the Agent Monitor
 * runtime, and which one now retries.
 *
 * The policy this changes is deliberate and was right for what it was written
 * against: ISS-4714 made a boot-time DB failure terminal for the process, with
 * no crash loop, because a corrupt file, a migration refusal and a schema
 * mismatch are DETERMINISTIC — retrying reproduces them exactly and buys
 * nothing but noise. A store-open deadline was routed into that same bucket and
 * is not that: it is a function of store size, migration count and machine load
 * at that instant. The install this came from had cleared the same open in 8m05s
 * and 7m38s earlier the same week, and crossed the 600 s ceiling only on the
 * boot where two new migrations landed while the box was at load 133–145. It
 * then captured nothing, delivered nothing, and logged `drain gated: … store=false`
 * every 60 s until a human noticed.
 *
 * So every case here is about the SPLIT. A test that only proved "a timeout
 * retries" would stay green if the retry were widened to every failure, which is
 * the crash loop the original policy exists to prevent — so the deterministic
 * cases below assert the first attempt is the ONLY attempt, and they are the
 * counterfactual for the retry cases above them.
 *
 * No real database, and no real clock: the timeout is injected as the error the
 * store client actually mints (`agent-dashboard-bootstrap-fixture.ts`, pinned
 * against the real producer in `db-host-store-close-and-deadline.test.ts`), and
 * the backoff runs through the `sleepBeforeStoreOpenRetry` seam.
 */

import { AppBootFailureKind } from "@closedloop-ai/telemetry-contract/app-boot-failure-kind";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { bootstrapAgentDashboardRuntime } from "../src/main/dashboard/agent-dashboard-runtime-bootstrap.js";
import { STORE_OPEN_DEADLINE_MS } from "../src/main/database/db-host/db-store-deadlines.js";
import {
  DesktopMigrationError,
  MigrationRefusalKind,
} from "../src/main/lifecycle/migration-refusal.js";
import { READY_AGENT_MONITOR_RUNTIME_STATUS } from "../src/shared/agent-monitor-status.js";
import {
  bootstrapDeps,
  storeOpenTimeoutError,
} from "./agent-dashboard-bootstrap-fixture.js";

const createRuntime = vi.fn();

// The runtime module is dynamically imported by the boot path and pulls in the
// whole SQLite/db-host stack; mocking it is what lets the REAL bootstrap
// function run its retry loop and its REAL classification in this lane.
vi.mock(
  "../src/main/dashboard/agent-dashboard-design-system-runtime.js",
  () => ({
    createAgentDashboardDesignSystemRuntime: createRuntime,
  })
);

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/store-open-timeout-retry" },
  Notification: class {
    show() {
      return undefined;
    }
  },
}));

/** Stands in for the opened runtime; nothing here calls into it. */
const OPENED_RUNTIME = { opened: true };

/** A migration refusal — the deterministic failure the terminal policy is FOR. */
function migrationRefusal(): Error {
  return new DesktopMigrationError(
    MigrationRefusalKind.ChecksumDrift,
    "checksum drift on 0099_from_the_future"
  );
}

/** Records every backoff the loop waits out, and never actually waits. */
function recordingSleep(): {
  waits: number[];
  sleep: (ms: number) => Promise<void>;
} {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

beforeEach(() => {
  createRuntime.mockReset();
});

describe("ISS-9197 — a store-open timeout is retried", () => {
  test("recovers when a later attempt opens, and never reports a failure", async () => {
    // The defect in one case. Both of the first two attempts time out exactly as
    // the observed boot did; the third opens, because the migrations that pushed
    // the first one past its deadline committed on that attempt and the retry
    // does not re-run them.
    const { waits, sleep } = recordingSleep();
    const setAgentMonitorFailed = vi.fn();
    const emitAppExceptionEvent = vi.fn();
    const registerDisabledAgentDashboardDbIpcHandlers = vi.fn();
    const statuses: unknown[] = [];
    createRuntime
      .mockRejectedValueOnce(storeOpenTimeoutError())
      .mockRejectedValueOnce(storeOpenTimeoutError())
      .mockResolvedValueOnce(OPENED_RUNTIME);

    const result = await bootstrapAgentDashboardRuntime(
      bootstrapDeps({
        sleepBeforeStoreOpenRetry: sleep,
        setAgentMonitorFailed,
        emitAppExceptionEvent,
        registerDisabledAgentDashboardDbIpcHandlers,
        setAgentMonitorRuntimeStatus: (status) => statuses.push(status),
      })
    );

    expect(result).toEqual({ ok: true, runtime: OPENED_RUNTIME });
    expect(createRuntime).toHaveBeenCalledTimes(3);
    expect(waits).toHaveLength(2);
    // The install is genuinely alive: nothing latched the terminal flag and DB
    // IPC was never left disabled. Today both of these fire on the first timeout
    // and never unfire. What the fleet is told is a separate contract — see
    // "an install that RECOVERS is visible to the fleet too" below.
    expect(setAgentMonitorFailed).not.toHaveBeenCalled();
    expect(registerDisabledAgentDashboardDbIpcHandlers).not.toHaveBeenCalled();
    expect(statuses).toEqual([READY_AGENT_MONITOR_RUNTIME_STATUS]);
    // And nothing reported it as a DOWN install: the one emit this boot spends
    // is the recovery record, never the failure one.
    expect(emitAppExceptionEvent).toHaveBeenCalledTimes(1);
    expect(emitAppExceptionEvent.mock.calls[0]?.[0]).toMatchObject({
      error: { message: expect.stringContaining("recovered") },
    });
  });

  test("backs OFF rather than retrying flat out", async () => {
    // Kills the mutation that makes every wait the same (or zero): a ladder that
    // does not lengthen is a tight loop against a machine that is already
    // saturated, which is the load the timeout is a symptom of.
    const { waits, sleep } = recordingSleep();
    createRuntime.mockRejectedValue(storeOpenTimeoutError());

    await bootstrapAgentDashboardRuntime(
      bootstrapDeps({ sleepBeforeStoreOpenRetry: sleep })
    );

    expect(waits.length).toBeGreaterThan(1);
    for (const [index, wait] of waits.entries()) {
      expect(wait).toBeGreaterThan(index === 0 ? 0 : (waits[index - 1] ?? 0));
    }
  });

  test("is BOUNDED — a timeout that never clears still terminates", async () => {
    // The half that makes the retry safe to add to a terminal-no-retry path. A
    // deadline that is really a permanent condition must land in the same
    // terminal state it lands in today, not spin forever.
    const { waits, sleep } = recordingSleep();
    const setAgentMonitorFailed = vi.fn();
    createRuntime.mockRejectedValue(storeOpenTimeoutError());

    const result = await bootstrapAgentDashboardRuntime(
      bootstrapDeps({ sleepBeforeStoreOpenRetry: sleep, setAgentMonitorFailed })
    );

    expect(result).toEqual({ ok: false });
    expect(createRuntime).toHaveBeenCalledTimes(waits.length + 1);
    expect(setAgentMonitorFailed).toHaveBeenCalledTimes(1);
  });

  test("pins the ladder itself against independently written literals", async () => {
    // marisolashgrove (#6665). The two cases above are both satisfied by `[1, 2]`
    // and by a fifteen-rung ladder: one asserts only that each wait exceeds the
    // last, the other derives its expected attempt count from `waits.length`, so
    // neither can fail on a ladder of the wrong LENGTH or the wrong SIZE. That
    // is the ISS-8773 defect exactly — a budget re-derived from the module it is
    // meant to police agrees with whatever the module says — so these numbers
    // are written out here rather than read back from
    // `STORE_OPEN_RETRY_BACKOFF_MS`.
    //
    // They are not free parameters. The ladder length IS how long an install
    // reads `starting` before it reads `failed`, which is the ~32 min this
    // ticket budgets, so changing either number changes a user-visible wait and
    // has to be a deliberate edit here.
    const { waits, sleep } = recordingSleep();
    createRuntime.mockRejectedValue(storeOpenTimeoutError());

    await bootstrapAgentDashboardRuntime(
      bootstrapDeps({ sleepBeforeStoreOpenRetry: sleep })
    );

    expect(waits).toEqual([30_000, 120_000]);
    expect(createRuntime).toHaveBeenCalledTimes(3);
    // The whole dark window: three opens that each burn the full open deadline,
    // plus the 2m30s of backoff between them. 32.5 minutes, written out.
    const backoffMs = waits.reduce((total, wait) => total + wait, 0);
    expect(backoffMs + 3 * STORE_OPEN_DEADLINE_MS).toBe(1_950_000);
  });
});

describe("ISS-9197 — a deterministic open failure still terminates at once", () => {
  // THE COUNTERFACTUAL for the block above. Collapse the two paths — retry every
  // boot failure instead of only the timeout — and every case here goes red
  // while every case above stays green.
  test.each([
    ["a migration refusal", migrationRefusal],
    [
      "a packaging break",
      () =>
        Object.assign(new Error("Cannot find module 'electron'"), {
          code: "ERR_MODULE_NOT_FOUND",
        }),
    ],
    ["an unclassified failure", () => new Error("SQLITE_BUSY")],
  ])("does not retry %s", async (_label, makeError) => {
    const { waits, sleep } = recordingSleep();
    const setAgentMonitorFailed = vi.fn();
    createRuntime.mockRejectedValue(makeError());

    const result = await bootstrapAgentDashboardRuntime(
      bootstrapDeps({ sleepBeforeStoreOpenRetry: sleep, setAgentMonitorFailed })
    );

    expect(result).toEqual({ ok: false });
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
    expect(setAgentMonitorFailed).toHaveBeenCalledTimes(1);
  });

  test("a refusal reached AFTER a timeout stops the ladder there", async () => {
    // The ladder must re-classify on every attempt, not decide once. A store that
    // times out and then refuses is a store this build cannot open; continuing to
    // retry it would be the crash loop with extra steps.
    const { waits, sleep } = recordingSleep();
    createRuntime
      .mockRejectedValueOnce(storeOpenTimeoutError())
      .mockRejectedValueOnce(migrationRefusal());

    const result = await bootstrapAgentDashboardRuntime(
      bootstrapDeps({ sleepBeforeStoreOpenRetry: sleep })
    );

    expect(result).toEqual({ ok: false });
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(waits).toHaveLength(1);
  });
});

describe("ISS-9197 — the ladder abandons itself when the app quits", () => {
  // A retry resumes minutes after it started, and `runDesktopApplicationShutdown`
  // cannot stop it: shutdown drains `getAgentDashboardRuntime()`, which stays
  // null for the whole ladder, so a bootstrap still running at teardown is
  // invisible to it. Without this guard a later attempt forks a db-host
  // utilityProcess into a quitting main process and then fires an OS
  // Notification and a tray refresh at objects teardown already destroyed —
  // the class `apps/desktop/AGENTS.md` names under Runtime discipline.
  test("stops forking once teardown begins mid-backoff", async () => {
    let shuttingDown = false;
    const setAgentMonitorFailed = vi.fn();
    const emitAppExceptionEvent = vi.fn();
    const refreshTrayState = vi.fn();
    createRuntime.mockRejectedValue(storeOpenTimeoutError());

    const result = await bootstrapAgentDashboardRuntime(
      bootstrapDeps({
        setAgentMonitorFailed,
        emitAppExceptionEvent,
        refreshTrayState,
        isShuttingDown: () => shuttingDown,
        // The quit lands DURING the first backoff — the realistic shape, since
        // the ticket's own scenario is a user giving up on a dead dashboard.
        sleepBeforeStoreOpenRetry: () => {
          shuttingDown = true;
          return Promise.resolve();
        },
      })
    );

    expect(result).toEqual({ ok: false });
    // One attempt, then the guard — not the full ladder.
    expect(createRuntime).toHaveBeenCalledTimes(1);
    // And nothing is fired at a torn-down tray, window, or user.
    expect(setAgentMonitorFailed).not.toHaveBeenCalled();
    expect(emitAppExceptionEvent).not.toHaveBeenCalled();
    expect(refreshTrayState).not.toHaveBeenCalled();
  });

  test("does not even open when teardown already began", async () => {
    const refreshTrayState = vi.fn();
    createRuntime.mockRejectedValue(storeOpenTimeoutError());

    const result = await bootstrapAgentDashboardRuntime(
      bootstrapDeps({
        isShuttingDown: () => true,
        refreshTrayState,
        // Seamed even though the guard should make it unreachable: without it, a
        // regression here runs the REAL 150s ladder and the suite reads as hung
        // rather than red.
        sleepBeforeStoreOpenRetry: () => Promise.resolve(),
      })
    );

    expect(result).toEqual({ ok: false });
    expect(createRuntime).not.toHaveBeenCalled();
    expect(refreshTrayState).not.toHaveBeenCalled();
  });

  test("closes a runtime that finished opening into a quitting process", async () => {
    // whitlockk (#6665). The guard above only stops a NEW attempt; this is the
    // attempt that was already in flight when the quit landed. An open can take
    // the whole 10-minute deadline, and `runDesktopApplicationShutdown` reaches
    // this runtime only through `getAgentDashboardRuntime()`, which stays null
    // until the caller adopts the return value — so both of teardown's lookups
    // (`beginClosing`, then `close`) miss it. Hand it back and `app.ts` publishes
    // a db-host utilityProcess and its DB IPC handlers into a process that has
    // already quit, with nothing left to close either.
    let shuttingDown = false;
    const beginClosing = vi.fn();
    const close = vi.fn(() => Promise.resolve());
    const statuses: unknown[] = [];
    // The interleaving, not merely the state: the quit lands after the open has
    // started and before it resolves, which is the only ordering that produces
    // the leak — teardown's own lookups have both already run by then.
    createRuntime.mockImplementation(async () => {
      await Promise.resolve();
      shuttingDown = true;
      return { beginClosing, close };
    });

    const result = await bootstrapAgentDashboardRuntime(
      bootstrapDeps({
        isShuttingDown: () => shuttingDown,
        setAgentMonitorRuntimeStatus: (status) => statuses.push(status),
      })
    );

    expect(result).toEqual({ ok: false });
    // Torn down here, in the order shutdown would have used.
    expect(beginClosing).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    // And never announced as up: `ready` for a runtime we just closed is the UI
    // lying about state, to a renderer that is going away.
    expect(statuses).toEqual([]);
  });

  test("a failing close on that path does not become another attempt", async () => {
    // The abandon-close runs INSIDE the retry loop's try, so a throw from it
    // would be caught and classified as an OPEN failure — and this one carries
    // the deadline token, so an unswallowed throw would start a second attempt
    // against a torn-down app: the leak, with extra steps.
    let shuttingDown = false;
    createRuntime.mockImplementation(async () => {
      await Promise.resolve();
      shuttingDown = true;
      return {
        beginClosing: () => undefined,
        close: () => Promise.reject(storeOpenTimeoutError()),
      };
    });

    const result = await bootstrapAgentDashboardRuntime(
      bootstrapDeps({
        isShuttingDown: () => shuttingDown,
        sleepBeforeStoreOpenRetry: () => Promise.resolve(),
      })
    );

    expect(result).toEqual({ ok: false });
    expect(createRuntime).toHaveBeenCalledTimes(1);
  });

  test("a quit during the ladder does not suppress an ordinary failure report", async () => {
    // The guard must be scoped to teardown and nothing else. If it leaked into
    // the normal path it would silence every terminal failure, which is the
    // invisibility ISS-9197 exists to remove.
    const setAgentMonitorFailed = vi.fn();
    const refreshTrayState = vi.fn();
    createRuntime.mockRejectedValue(storeOpenTimeoutError());

    await bootstrapAgentDashboardRuntime(
      bootstrapDeps({
        setAgentMonitorFailed,
        refreshTrayState,
        isShuttingDown: () => false,
        sleepBeforeStoreOpenRetry: () => Promise.resolve(),
      })
    );

    expect(setAgentMonitorFailed).toHaveBeenCalledTimes(1);
    expect(refreshTrayState).toHaveBeenCalledTimes(1);
  });
});

describe("ISS-9197 — an install that stays dark is visible to the fleet", () => {
  test("reports the exhausted timeout as its own boot-failure kind, once", async () => {
    // AC3. Before this the same event carried `unknown`, indistinguishable from
    // any other local fault — which is why the outage had to be read off one
    // machine's log file. The emit stays at ONE per boot however many attempts
    // ran, so the caller's cardinality contract is unchanged.
    const { sleep } = recordingSleep();
    const emitAppExceptionEvent = vi.fn();
    createRuntime.mockRejectedValue(storeOpenTimeoutError());

    await bootstrapAgentDashboardRuntime(
      bootstrapDeps({ sleepBeforeStoreOpenRetry: sleep, emitAppExceptionEvent })
    );

    expect(emitAppExceptionEvent).toHaveBeenCalledTimes(1);
    expect(emitAppExceptionEvent.mock.calls[0]?.[0]).toMatchObject({
      bootFailureKind: AppBootFailureKind.StoreOpenTimeout,
    });
  });

  test("and the message says so too, for installs older than the kind", async () => {
    // ISS-9253 vendors `app.boot_failure.kind`, so the attribute reaches Datadog
    // once the collector is rolled (ISS-9677), and then only from installs on
    // ISS-8907 or later. `exception.message` was vendored long before either and
    // is the only half an older install sends — so asserting only the kind above
    // would pin a signal part of the fleet cannot produce.
    const { sleep } = recordingSleep();
    const emitAppExceptionEvent = vi.fn();
    createRuntime.mockRejectedValue(storeOpenTimeoutError());

    await bootstrapAgentDashboardRuntime(
      bootstrapDeps({ sleepBeforeStoreOpenRetry: sleep, emitAppExceptionEvent })
    );

    const emitted = emitAppExceptionEvent.mock.calls[0]?.[0] as {
      error: Error;
    };
    expect(emitted.error.message).toBe(
      "Agent Monitor runtime failed to initialize: store open exceeded its deadline"
    );
    // ISS-4714's contract, which this new message must not regress.
    expect(emitted.error.stack).toBeUndefined();
    expect(emitted.error.message).not.toContain("600000");
  });
});

describe("ISS-9197 — an install that RECOVERS is visible to the fleet too", () => {
  // marisolashgrove (#6665). Reporting only exhaustion means the fleet's first data
  // point about a store-open deadline arrives after that install has already
  // been dark for the whole ladder — which is the blindness this ticket closes
  // one level up. `app-boot-failure-kind.ts` says the frequency of this kind
  // across the fleet measures a margin that shrinks as stores grow, and a margin
  // is only measurable while installs are still clearing it.
  test("reports the CLEARED timeout on the same event and kind, once", async () => {
    const { sleep } = recordingSleep();
    const emitAppExceptionEvent = vi.fn();
    createRuntime
      .mockRejectedValueOnce(storeOpenTimeoutError())
      .mockResolvedValueOnce(OPENED_RUNTIME);

    const result = await bootstrapAgentDashboardRuntime(
      bootstrapDeps({ sleepBeforeStoreOpenRetry: sleep, emitAppExceptionEvent })
    );

    expect(result).toEqual({ ok: true, runtime: OPENED_RUNTIME });
    expect(emitAppExceptionEvent).toHaveBeenCalledTimes(1);
    const emitted = emitAppExceptionEvent.mock.calls[0]?.[0] as {
      error: Error;
      bootFailureKind: string;
    };
    // The same kind the exhaustion path emits, deliberately: a new event would
    // need a new monitor before it was worth anything.
    expect(emitted.bootFailureKind).toBe(AppBootFailureKind.StoreOpenTimeout);
    // ISS-9259 moved the recovery/exhaustion distinction onto
    // `app.boot_failure.outcome`, so the message is no longer what separates
    // them (that axis is pinned in `boot-failure-outcome-telemetry.test.ts`).
    // It is still the whole of what Datadog can read on installs older than
    // ISS-8907, which emit no `app.boot_failure.kind` for ISS-9253 to deliver.
    // What it carries alone is the ATTEMPT, the leading indicator: an install
    // clearing on 3 is closer to the cliff than one clearing on 2.
    expect(emitted.error.message).toBe(
      "Agent Monitor runtime recovered from a store open deadline on attempt 2 of 3"
    );
    expect(emitted.error.stack).toBeUndefined();
  });

  test("and says nothing at all when the first attempt opens", async () => {
    // The counterfactual that gives the record above its meaning. This event has
    // to mean "a store-open deadline happened here"; emit it on every boot and
    // its fleet frequency is just the install count.
    const emitAppExceptionEvent = vi.fn();
    createRuntime.mockResolvedValueOnce(OPENED_RUNTIME);

    const result = await bootstrapAgentDashboardRuntime(
      bootstrapDeps({ emitAppExceptionEvent })
    );

    expect(result).toEqual({ ok: true, runtime: OPENED_RUNTIME });
    expect(emitAppExceptionEvent).not.toHaveBeenCalled();
  });
});
