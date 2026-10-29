import { EventEmitter } from "node:events";
import type { CounterRedis } from "../redis/connections";
import { CLAIM_LAPSED_SCRIPT, RELEASE_SCRIPT } from "../redis/connections";

/**
 * An in-memory stand-in for the commands the connection counter issues. It
 * shares its data between every client made from one {@link FakeRedisStore},
 * so two counters on one store model two instances on one Redis.
 */
export class FakeRedisStore {
  readonly hashes = new Map<string, Map<string, string>>();
  readonly sortedSets = new Map<string, Map<string, number>>();
  readonly sets = new Map<string, Set<string>>();

  client(): FakeRedisClient {
    return new FakeRedisClient(this);
  }
}

export class FakeRedisClient extends EventEmitter implements CounterRedis {
  status = "ready";
  /** When set, every command waits on it: a stalled Redis. */
  stall: Promise<void> | undefined;
  /** When set, the release script rejects with it. */
  failRelease: Error | undefined;
  /** When set, reading an instance's key set (the sweep's first step) rejects. */
  failSweep: Error | undefined;
  readonly store: FakeRedisStore;

  constructor(store: FakeRedisStore) {
    super();
    this.store = store;
  }

  async hincrby(key: string, field: string, increment: number) {
    await this.stall;
    const hash = this.hash(key);
    const next = Number(hash.get(field) ?? "0") + increment;
    hash.set(field, String(next));
    return next;
  }

  async hgetall(key: string) {
    await this.stall;
    return Object.fromEntries(this.store.hashes.get(key) ?? []);
  }

  async hdel(key: string, field: string) {
    await this.stall;
    const hash = this.store.hashes.get(key);
    const removed = hash?.delete(field) ? 1 : 0;
    if (hash?.size === 0) {
      this.store.hashes.delete(key);
    }
    return removed;
  }

  async eval(script: string, _numKeys: number, ...args: string[]) {
    await this.stall;
    if (script === CLAIM_LAPSED_SCRIPT) {
      return this.claimLapsed(args);
    }
    if (script !== RELEASE_SCRIPT) {
      throw new Error("unexpected script");
    }
    if (this.failRelease) {
      throw this.failRelease;
    }
    const [key, field] = args;
    const hash = this.hash(key);
    const count = Number(hash.get(field) ?? "0");
    if (count <= 1) {
      await this.hdel(key, field);
      return 0;
    }
    return await this.hincrby(key, field, -1);
  }

  async zadd(key: string, score: number, member: string) {
    await this.stall;
    const set = this.store.sortedSets.get(key) ?? new Map<string, number>();
    set.set(member, score);
    this.store.sortedSets.set(key, set);
    return 1;
  }

  async zrangebyscore(key: string, min: number | string, max: number | string) {
    await this.stall;
    const set = this.store.sortedSets.get(key) ?? new Map<string, number>();
    return [...set]
      .filter(
        ([, score]) => inBound(score, min, "min") && inBound(score, max, "max")
      )
      .map(([member]) => member);
  }

  async srem(key: string, member: string) {
    await this.stall;
    const set = this.store.sets.get(key);
    const removed = set?.delete(member) ? 1 : 0;
    if (set?.size === 0) {
      this.store.sets.delete(key);
    }
    return removed;
  }

  async sadd(key: string, member: string) {
    await this.stall;
    const set = this.store.sets.get(key) ?? new Set<string>();
    const added = set.has(member) ? 0 : 1;
    set.add(member);
    this.store.sets.set(key, set);
    return added;
  }

  async smembers(key: string) {
    await this.stall;
    if (this.failSweep) {
      throw this.failSweep;
    }
    return [...(this.store.sets.get(key) ?? [])];
  }

  async del(key: string) {
    await this.stall;
    const removed =
      Number(this.store.hashes.delete(key)) +
      Number(this.store.sets.delete(key)) +
      Number(this.store.sortedSets.delete(key));
    return removed;
  }

  /** Synchronous after the stall, so it is atomic like the script. */
  private claimLapsed([key, member, at]: string[]): number {
    const leases = this.store.sortedSets.get(key);
    const lease = leases?.get(member);
    if (lease === undefined || lease >= Number(at)) {
      return 0;
    }
    leases?.delete(member);
    return 1;
  }

  private hash(key: string): Map<string, string> {
    const hash = this.store.hashes.get(key) ?? new Map<string, string>();
    this.store.hashes.set(key, hash);
    return hash;
  }
}

/** Redis score bounds: a number is inclusive, `(n` exclusive, `±inf` open. */
function inBound(score: number, bound: number | string, side: "min" | "max") {
  if (bound === "+inf" || bound === "-inf") {
    return true;
  }
  const exclusive = typeof bound === "string" && bound.startsWith("(");
  const value = Number(exclusive ? String(bound).slice(1) : bound);
  if (side === "min") {
    return exclusive ? score > value : score >= value;
  }
  return exclusive ? score < value : score <= value;
}
