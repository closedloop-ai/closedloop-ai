import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SESSION_LIMIT_STALE_AFTER_MS,
  SessionLimitSnapshotSource,
  SessionLimitsSnapshotStore,
} from "../src/main/session-limits/snapshot-store.js";
import type { UsageFetchLike } from "../src/main/session-limits/usage-api-client.js";
import { UsageApiService } from "../src/main/session-limits/usage-api-service.js";

const TOKEN = "sk-ant-oat01-CANARY-TOKEN-DO-NOT-LEAK";
const T0 = 1_800_000_000_000;

const USAGE_BODY = {
  five_hour: { utilization: 42, resets_at: "2026-08-07T15:00:00.000Z" },
  seven_day: { utilization: 0, resets_at: null },
};

function okFetch(): UsageFetchLike {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(USAGE_BODY),
    });
}

/** A service wired to a private store with fully-controlled timers/clock. */
function makeService(
  options: {
    fetchImpl?: UsageFetchLike;
    token?: string | null;
    nowMs?: () => number;
    /** Labs gate; the existing tests exercise the ENABLED feature. */
    isEnabled?: () => boolean;
    /** Counts credential reads so the gate can be proven to suppress them. */
    onTokenRead?: () => void;
  } = {}
) {
  const store = new SessionLimitsSnapshotStore();
  const timers: Array<{ handler: () => void; ms: number; cleared: boolean }> =
    [];
  const outcomes: Array<{ ok: boolean; reason?: string }> = [];
  const service = new UsageApiService({
    isEnabled: options.isEnabled ?? (() => true),
    client: {
      readAccessToken: () => {
        options.onTokenRead?.();
        return options.token === undefined ? TOKEN : options.token;
      },
      fetchImpl: options.fetchImpl ?? okFetch(),
      nowIso: () => new Date(T0).toISOString(),
    },
    store,
    nowMs: options.nowMs ?? (() => T0),
    intervalMs: 1000,
    setIntervalFn: (handler, ms) => {
      const entry = { handler, ms, cleared: false };
      timers.push(entry);
      return entry as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: (handle) => {
      (handle as unknown as { cleared: boolean }).cleared = true;
    },
    onResult: (outcome) => {
      outcomes.push(
        outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason }
      );
    },
  });
  return { service, store, timers, outcomes };
}

test("a successful capture is recorded under the usage_api source", async () => {
  const { service, store } = makeService();
  assert.equal(await service.refreshNow(), true);
  const resolved = store.resolve(T0);
  assert.ok(resolved);
  assert.equal(resolved?.source, SessionLimitSnapshotSource.UsageApi);
  assert.equal(resolved?.fiveHour?.utilization, 42);
  // A genuine 0% survives as a real value, not as an absent window.
  assert.equal(resolved?.sevenDay?.utilization, 0);
  service.dispose();
});

test("usage_api outranks a same-age statusline sample", async () => {
  const { service, store } = makeService();
  store.record({
    source: SessionLimitSnapshotSource.Statusline,
    fetchedAtMs: T0,
    limits: {
      fiveHour: { utilization: 99, resetsAt: null },
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      extraUsage: null,
      fetchedAt: new Date(T0).toISOString(),
    },
  });
  await service.refreshNow();
  const resolved = store.resolve(T0);
  assert.equal(resolved?.source, SessionLimitSnapshotSource.UsageApi);
  assert.equal(resolved?.fiveHour?.utilization, 42);
  service.dispose();
});

test("no credential: nothing recorded, feature hidden, nothing thrown", async () => {
  const { service, store, outcomes } = makeService({ token: null });
  await assert.doesNotReject(() => service.refreshNow());
  assert.equal(await service.refreshNow(), false);
  // Absence — not a zero, not an empty bar.
  assert.equal(store.resolve(T0), null);
  assert.deepEqual(outcomes.at(-1), { ok: false, reason: "no_credential" });
  service.dispose();
});

test("start() fires an immediate capture and registers exactly one interval", async () => {
  const { service, store, timers } = makeService();
  service.start();
  // Let the immediate refresh settle.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.ms, 1000);
  assert.ok(store.resolve(T0));
  service.dispose();
});

test("start() is idempotent — a second call adds no second timer", () => {
  const { service, timers } = makeService();
  service.start();
  service.start();
  assert.equal(timers.length, 1);
  service.dispose();
});

test("dispose() clears the timer and stops further captures", async () => {
  const { service, timers, store } = makeService();
  service.start();
  await new Promise((resolve) => setImmediate(resolve));
  service.dispose();
  assert.equal(timers[0]?.cleared, true);
  store.clear();
  // Post-disposal refreshes are no-ops, so nothing is recorded again.
  assert.equal(await service.refreshNow(), false);
  assert.equal(store.resolve(T0), null);
});

test("dispose() before start() is safe, and start() afterwards is inert", () => {
  const { service, timers } = makeService();
  assert.doesNotThrow(() => service.dispose());
  service.start();
  assert.equal(timers.length, 0);
});

test("a failed refresh preserves the previous snapshot rather than erasing it", async () => {
  let fail = false;
  const { service, store } = makeService({
    fetchImpl: () =>
      fail
        ? Promise.reject(new Error("network down"))
        : Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(USAGE_BODY),
          }),
  });
  await service.refreshNow();
  assert.ok(store.resolve(T0));
  fail = true;
  assert.equal(await service.refreshNow(), false);
  // Still present, still stamped with its original capture time.
  const kept = store.resolve(T0);
  assert.equal(kept?.fiveHour?.utilization, 42);
  assert.equal(kept?.fetchedAt, new Date(T0).toISOString());
  service.dispose();
});

test("a stale snapshot is distinguishable from a fresh one by its timestamp", async () => {
  const { service, store } = makeService();
  await service.refreshNow();

  // Fresh: resolvable, and its fetchedAt equals the capture time.
  const fresh = store.resolve(T0);
  assert.equal(fresh?.fetchedAt, new Date(T0).toISOString());

  // Aged past the staleness window: the timestamp still says when it was
  // captured, so it can never be presented as "current".
  const laterMs = T0 + SESSION_LIMIT_STALE_AFTER_MS + 1;
  assert.equal(store.resolve(laterMs), null);
  const stillWithinWindow = store.resolve(
    T0 + SESSION_LIMIT_STALE_AFTER_MS - 1
  );
  assert.equal(stillWithinWindow?.fetchedAt, new Date(T0).toISOString());
  assert.notEqual(
    stillWithinWindow?.fetchedAt,
    new Date(laterMs).toISOString()
  );
  service.dispose();
});

test("the credential reaches no console output, no stored snapshot, and no failure reason", async () => {
  const captured: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const originals = methods.map((m) => [m, console[m]] as const);
  for (const m of methods) {
    (console as unknown as Record<string, unknown>)[m] = (
      ...args: unknown[]
    ) => {
      captured.push(args.map((a) => String(a)).join(" "));
    };
  }

  try {
    // Exercise the success path AND every failure path that could carry detail.
    const scenarios: UsageFetchLike[] = [
      okFetch(),
      () =>
        Promise.resolve({
          ok: false,
          status: 401,
          // A hostile/echoing vendor body must not become a leak vector either.
          json: () => Promise.resolve({ error: `bad token ${TOKEN}` }),
        }),
      () => Promise.reject(new Error(`ECONNREFUSED while sending ${TOKEN}`)),
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ error: "envelope" }),
        }),
    ];

    for (const fetchImpl of scenarios) {
      const { service, store, outcomes } = makeService({ fetchImpl });
      await service.refreshNow();

      // 1. Nothing the service stored may contain the token.
      const stored = JSON.stringify(store.resolve(T0) ?? {});
      assert.ok(
        !stored.includes(TOKEN),
        `token leaked into the stored snapshot: ${stored}`
      );

      // 2. No failure reason may contain the token — the reasons are a closed
      //    enum precisely so vendor text can never ride along.
      const reasons = JSON.stringify(outcomes);
      assert.ok(
        !reasons.includes(TOKEN),
        `token leaked into a failure reason: ${reasons}`
      );
      service.dispose();
    }

    // 3. Nothing was written to any console channel at all.
    const logged = captured.join("\n");
    assert.ok(
      !logged.includes(TOKEN),
      `token leaked into console output: ${logged}`
    );
  } finally {
    for (const [m, fn] of originals) {
      (console as unknown as Record<string, unknown>)[m] = fn;
    }
  }
});

test("Labs gate OFF: no credential read, no request, no snapshot, no timer", async () => {
  let tokenReads = 0;
  let requests = 0;
  const { service, store, timers } = makeService({
    isEnabled: () => false,
    onTokenRead: () => {
      tokenReads++;
    },
    fetchImpl: () => {
      requests++;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(USAGE_BODY),
      });
    },
  });

  service.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await service.refreshNow(), false);

  // The four things the operator required to NOT happen while the flag is off.
  assert.equal(tokenReads, 0, "credential must not be read while gated off");
  assert.equal(requests, 0, "no /usage request may be issued while gated off");
  assert.equal(store.resolve(T0), null, "no cached snapshot may be written");
  assert.equal(timers.length, 0, "no refresh timer may be scheduled");
  service.dispose();
});

test("Labs gate defaults CLOSED when the caller wires no gate at all", async () => {
  let tokenReads = 0;
  const store = new SessionLimitsSnapshotStore();
  const service = new UsageApiService({
    // `isEnabled` deliberately omitted — an unwired gate must mean disabled.
    client: {
      readAccessToken: () => {
        tokenReads++;
        return TOKEN;
      },
      fetchImpl: okFetch(),
      nowIso: () => new Date(T0).toISOString(),
    },
    store,
    nowMs: () => T0,
  });
  assert.equal(await service.refreshNow(), false);
  assert.equal(tokenReads, 0);
  assert.equal(store.resolve(T0), null);
  service.dispose();
});

test("Labs gate ON: the same wiring does capture (the gate is what differs)", async () => {
  let tokenReads = 0;
  const { service, store } = makeService({
    isEnabled: () => true,
    onTokenRead: () => {
      tokenReads++;
    },
  });
  assert.equal(await service.refreshNow(), true);
  assert.equal(tokenReads, 1);
  assert.ok(store.resolve(T0));
  service.dispose();
});
