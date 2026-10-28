import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_CONNECTIONS_PER_ORG,
  DEFAULT_MAX_CONNECTIONS_PER_USER,
} from "../env";
import {
  ADMISSION_TIMEOUT_MS,
  CLAIM_LAPSED_SCRIPT,
  CONNECTION_UNCOUNTED_EVENT,
  type ConnectionCounter,
  createConnectionCounter,
  HEARTBEAT_TIMEOUT_MS,
  INSTANCE_TTL_MS,
  INSTANCES_KEY,
  instanceKeysKey,
  orgConnectionsKey,
  userConnectionsKey,
} from "../redis/connections";
import { FakeRedisStore } from "./fake-redis";

const ORG_A = "0190a2b4-0000-7000-8000-00000000000a";
const ORG_B = "0190a2b4-0000-7000-8000-00000000000b";
const CAPS = {
  perUser: DEFAULT_MAX_CONNECTIONS_PER_USER,
  perOrg: DEFAULT_MAX_CONNECTIONS_PER_ORG,
};

let store: FakeRedisStore;
let clock: number;

beforeEach(() => {
  store = new FakeRedisStore();
  clock = 1_000_000;
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function counterFor(
  instanceId: string,
  caps = CAPS,
  client = store.client()
): ConnectionCounter {
  return createConnectionCounter({
    redis: client,
    instanceId,
    caps,
    onHeartbeat: () => undefined,
    now: () => clock,
  });
}

function field(key: string, instanceId: string): string | undefined {
  return store.hashes.get(key)?.get(instanceId);
}

/** Lets the fire-and-forget releases settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("connection counts", () => {
  it("increments this instance's user and org fields on admission and removes them on release", async () => {
    const counter = counterFor("i-1");
    const first = await counter.admit({ sub: "user_a", org: ORG_A });
    const second = await counter.admit({ sub: "user_a", org: ORG_A });

    expect(field(userConnectionsKey("user_a"), "i-1")).toBe("2");
    expect(field(orgConnectionsKey(ORG_A), "i-1")).toBe("2");

    if (!(first.admitted && second.admitted)) {
      throw new Error("expected both admitted");
    }
    first.release();
    await settle();
    expect(field(userConnectionsKey("user_a"), "i-1")).toBe("1");
    second.release();
    await settle();
    expect(store.hashes.has(userConnectionsKey("user_a"))).toBe(false);
    expect(store.hashes.has(orgConnectionsKey(ORG_A))).toBe(false);
  });

  it("admits the user's connections up to the default cap and refuses the next, leaving the count at the cap", async () => {
    const counter = counterFor("i-1");
    for (let index = 0; index < DEFAULT_MAX_CONNECTIONS_PER_USER; index += 1) {
      expect(
        (await counter.admit({ sub: "user_a", org: ORG_A })).admitted
      ).toBe(true);
    }

    const refused = await counter.admit({ sub: "user_a", org: ORG_A });
    await settle();

    expect(refused.admitted).toBe(false);
    expect(field(userConnectionsKey("user_a"), "i-1")).toBe(
      String(DEFAULT_MAX_CONNECTIONS_PER_USER)
    );
    expect(field(orgConnectionsKey(ORG_A), "i-1")).toBe(
      String(DEFAULT_MAX_CONNECTIONS_PER_USER)
    );
    // Another user of the same org is unaffected.
    expect((await counter.admit({ sub: "user_b", org: ORG_A })).admitted).toBe(
      true
    );
  });

  it("refuses past the org cap and gives the user count back", async () => {
    const counter = counterFor("i-1", { perUser: 20, perOrg: 2 });
    await counter.admit({ sub: "user_a", org: ORG_A });
    await counter.admit({ sub: "user_b", org: ORG_A });

    const refused = await counter.admit({ sub: "user_c", org: ORG_A });
    await settle();

    expect(refused.admitted).toBe(false);
    expect(store.hashes.has(userConnectionsKey("user_c"))).toBe(false);
    expect(field(orgConnectionsKey(ORG_A), "i-1")).toBe("2");
    expect((await counter.admit({ sub: "user_c", org: ORG_B })).admitted).toBe(
      true
    );
  });

  it("enforces a cap across two instances sharing Redis", async () => {
    const first = counterFor("i-1", { perUser: 3, perOrg: 100 });
    const second = counterFor("i-2", { perUser: 3, perOrg: 100 });
    await first.heartbeat();
    await second.heartbeat();
    await first.heartbeat();

    await first.admit({ sub: "user_a", org: ORG_A });
    await first.admit({ sub: "user_a", org: ORG_A });
    expect((await second.admit({ sub: "user_a", org: ORG_A })).admitted).toBe(
      true
    );
    expect((await second.admit({ sub: "user_a", org: ORG_A })).admitted).toBe(
      false
    );
    expect((await first.admit({ sub: "user_a", org: ORG_A })).admitted).toBe(
      false
    );
  });

  it("stops counting a crashed instance once its heartbeat lapses, and sweeps its fields", async () => {
    const survivor = counterFor("i-1", { perUser: 2, perOrg: 100 });
    const crashed = counterFor("i-2", { perUser: 2, perOrg: 100 });
    await crashed.heartbeat();
    await survivor.heartbeat();
    await crashed.admit({ sub: "user_a", org: ORG_A });
    await crashed.admit({ sub: "user_a", org: ORG_A });
    expect((await survivor.admit({ sub: "user_a", org: ORG_A })).admitted).toBe(
      false
    );

    // i-2 stops heartbeating; i-1 keeps going past i-2's lapse.
    clock += INSTANCE_TTL_MS + 1;
    await survivor.heartbeat();
    await settle();

    expect((await survivor.admit({ sub: "user_a", org: ORG_A })).admitted).toBe(
      true
    );
    expect(field(userConnectionsKey("user_a"), "i-2")).toBeUndefined();
    expect(field(orgConnectionsKey(ORG_A), "i-2")).toBeUndefined();
    expect(store.sets.has(instanceKeysKey("i-2"))).toBe(false);
    expect(store.sortedSets.get(INSTANCES_KEY)?.has("i-2")).toBe(false);
    expect(store.sortedSets.get(INSTANCES_KEY)?.has("i-1")).toBe(true);
  });

  it("keeps a live peer's counts through a Redis outage longer than a TTL, and sweeps the peer only once it stays silent a TTL after", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const survivorClient = store.client();
    const survivor = counterFor("i-1", CAPS, survivorClient);
    const peer = counterFor("i-2");
    await survivor.heartbeat();
    await peer.heartbeat();
    await peer.admit({ sub: "user_a", org: ORG_A });
    // i-1 has reached Redis for a full TTL before the outage.
    clock += INSTANCE_TTL_MS;
    await survivor.heartbeat();
    await peer.heartbeat();

    let restore: () => void = () => undefined;
    survivorClient.stall = new Promise((resolve) => {
      restore = resolve;
    });
    const lost = survivor.heartbeat();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);
    await lost;
    clock += INSTANCE_TTL_MS + 1;
    survivorClient.stall = undefined;
    restore();

    await survivor.heartbeat();
    await settle();

    expect(field(userConnectionsKey("user_a"), "i-2")).toBe("1");
    expect(field(orgConnectionsKey(ORG_A), "i-2")).toBe("1");
    expect(store.sortedSets.get(INSTANCES_KEY)?.has("i-2")).toBe(true);

    clock += INSTANCE_TTL_MS;
    await survivor.heartbeat();
    await settle();

    expect(field(userConnectionsKey("user_a"), "i-2")).toBeUndefined();
    expect(store.sortedSets.get(INSTANCES_KEY)?.has("i-2")).toBe(false);
  });

  it("stops counting a lapsed instance's fields even before a sweep removes them", async () => {
    const survivorClient = store.client();
    const survivor = counterFor(
      "i-1",
      { perUser: 2, perOrg: 100 },
      survivorClient
    );
    const crashed = counterFor("i-2", { perUser: 2, perOrg: 100 });
    await crashed.heartbeat();
    await survivor.heartbeat();
    await crashed.admit({ sub: "user_a", org: ORG_A });
    await crashed.admit({ sub: "user_a", org: ORG_A });

    clock += INSTANCE_TTL_MS + 1;
    survivorClient.failSweep = new Error("sweep blocked");
    await survivor.heartbeat();
    await settle();

    expect((await survivor.admit({ sub: "user_a", org: ORG_A })).admitted).toBe(
      true
    );
    expect(field(userConnectionsKey("user_a"), "i-2")).toBe("2");

    // The claimed sweep is finished by the next heartbeat.
    survivorClient.failSweep = undefined;
    await survivor.heartbeat();
    await settle();
    expect(field(userConnectionsKey("user_a"), "i-2")).toBeUndefined();
    expect(store.sets.has(instanceKeysKey("i-2"))).toBe(false);
  });

  it("leaves a peer that beats after the lapse snapshot its lease and its fields", async () => {
    const survivorClient = store.client();
    const survivor = counterFor("i-1", CAPS, survivorClient);
    const peer = counterFor("i-2");
    await survivor.heartbeat();
    await peer.heartbeat();
    await peer.admit({ sub: "user_a", org: ORG_A });
    clock += INSTANCE_TTL_MS + 1;
    const snapshot = survivorClient.zrangebyscore.bind(survivorClient);
    vi.spyOn(survivorClient, "zrangebyscore").mockImplementation(
      async (key, min, max) => {
        const members = await snapshot(key, min, max);
        if (min === "-inf") {
          await peer.heartbeat();
        }
        return members;
      }
    );
    const evals = vi.spyOn(survivorClient, "eval");

    await survivor.heartbeat();
    await vi.waitFor(() =>
      expect(evals).toHaveBeenCalledWith(
        CLAIM_LAPSED_SCRIPT,
        1,
        INSTANCES_KEY,
        "i-2",
        String(clock)
      )
    );
    expect(await evals.mock.results[0]?.value).toBe(0);

    expect(field(userConnectionsKey("user_a"), "i-2")).toBe("1");
    expect(field(orgConnectionsKey(ORG_A), "i-2")).toBe("1");
    expect(store.sortedSets.get(INSTANCES_KEY)?.has("i-2")).toBe(true);
    expect(store.sets.get(instanceKeysKey("i-2"))?.size).toBe(2);
  });

  it("drops a key from this instance's key set once it holds nothing under it, refused or released", async () => {
    const counter = counterFor("i-1", { perUser: 20, perOrg: 1 });
    const admitted = await counter.admit({ sub: "user_a", org: ORG_A });
    const refused = await counter.admit({ sub: "user_b", org: ORG_A });
    await settle();

    expect(refused.admitted).toBe(false);
    expect(store.sets.get(instanceKeysKey("i-1"))).toEqual(
      new Set([userConnectionsKey("user_a"), orgConnectionsKey(ORG_A)])
    );

    if (admitted.admitted) {
      admitted.release();
    }
    await settle();
    expect(store.sets.has(instanceKeysKey("i-1"))).toBe(false);
  });

  it("keeps a key registered when an admission starts while its last release is in flight", async () => {
    const counter = counterFor("i-1");
    const first = await counter.admit({ sub: "user_a", org: ORG_A });
    if (!first.admitted) {
      throw new Error("expected admitted");
    }

    first.release();
    const second = await counter.admit({ sub: "user_a", org: ORG_A });
    await settle();

    expect(second.admitted).toBe(true);
    expect(field(userConnectionsKey("user_a"), "i-1")).toBe("1");
    expect(store.sets.get(instanceKeysKey("i-1"))).toEqual(
      new Set([userConnectionsKey("user_a"), orgConnectionsKey(ORG_A)])
    );
  });

  it("sends no heartbeat while the client has not started connecting", async () => {
    const client = store.client();
    client.status = "wait";
    const counter = counterFor("i-1", CAPS, client);

    await counter.heartbeat();
    expect(store.sortedSets.has(INSTANCES_KEY)).toBe(false);

    client.status = "ready";
    await counter.heartbeat();
    expect(store.sortedSets.get(INSTANCES_KEY)?.has("i-1")).toBe(true);
  });

  it("admits uncounted while Redis is not connected, and its release writes nothing", async () => {
    const client = store.client();
    client.status = "reconnecting";
    const counter = counterFor("i-1", CAPS, client);

    const admission = await counter.admit({ sub: "user_a", org: ORG_A });

    expect(admission.admitted).toBe(true);
    expect(store.hashes.size).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: CONNECTION_UNCOUNTED_EVENT })
    );
    if (admission.admitted) {
      admission.release();
    }
    await settle();
    expect(store.hashes.size).toBe(0);
  });

  it("warns about uncounted admissions once per heartbeat, not once per admission", async () => {
    const client = store.client();
    client.status = "reconnecting";
    const counter = counterFor("i-1", CAPS, client);
    const uncountedWarnings = () =>
      vi
        .mocked(log.warn)
        .mock.calls.filter(
          ([, fields]) =>
            (fields as { event?: string } | undefined)?.event ===
            CONNECTION_UNCOUNTED_EVENT
        ).length;

    await counter.admit({ sub: "user_a", org: ORG_A });
    await counter.admit({ sub: "user_b", org: ORG_A });
    expect(uncountedWarnings()).toBe(1);

    client.status = "ready";
    await counter.heartbeat();
    client.status = "reconnecting";
    await counter.admit({ sub: "user_c", org: ORG_A });
    expect(uncountedWarnings()).toBe(2);
  });

  it("admits uncounted when Redis stalls past the deadline, then gives back the late count", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = store.client();
    let unstall: () => void = () => undefined;
    client.stall = new Promise((resolve) => {
      unstall = resolve;
    });
    const counter = counterFor("i-1", CAPS, client);

    const pending = counter.admit({ sub: "user_a", org: ORG_A });
    await vi.advanceTimersByTimeAsync(ADMISSION_TIMEOUT_MS);
    const admission = await pending;

    expect(admission.admitted).toBe(true);
    client.stall = undefined;
    unstall();
    vi.useRealTimers();
    for (let index = 0; index < 20; index += 1) {
      await settle();
    }
    expect(store.hashes.has(userConnectionsKey("user_a"))).toBe(false);
    expect(store.hashes.has(orgConnectionsKey(ORG_A))).toBe(false);
  });

  it("retries a release that failed once the next heartbeat succeeds", async () => {
    const client = store.client();
    const counter = counterFor("i-1", CAPS, client);
    const admission = await counter.admit({ sub: "user_a", org: ORG_A });
    client.failRelease = new Error("connection lost");
    if (admission.admitted) {
      admission.release();
    }
    await settle();
    expect(field(userConnectionsKey("user_a"), "i-1")).toBe("1");

    client.failRelease = undefined;
    await counter.heartbeat();
    await settle();

    expect(store.hashes.has(userConnectionsKey("user_a"))).toBe(false);
    expect(store.hashes.has(orgConnectionsKey(ORG_A))).toBe(false);
  });
});
