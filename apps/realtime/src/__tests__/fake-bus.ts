import { EventEmitter } from "node:events";
import type { BusPublisherClient, BusSubscriberClient } from "../bus/bus";

/**
 * An in-memory Redis pub/sub: every subscriber made from one hub hears what
 * any publisher made from it sends, delivered on a later tick as Redis would.
 * The hub also holds one sorted set per key, for the revocation log.
 */
export class FakeBusHub {
  readonly subscribers = new Set<FakeBusSubscriber>();
  /** Key to member to score. */
  readonly sortedSets = new Map<string, Map<string, number>>();

  publisher(): BusPublisherClient {
    const set = (key: string): Map<string, number> => {
      let members = this.sortedSets.get(key);
      if (!members) {
        members = new Map();
        this.sortedSets.set(key, members);
      }
      return members;
    };
    return {
      zadd: (key, score, member) => {
        set(key).set(member, score);
        return Promise.resolve(1);
      },
      zremrangebyscore: (key, _min, max) => {
        for (const [member, score] of set(key)) {
          if (score <= max) {
            set(key).delete(member);
          }
        }
        return Promise.resolve(0);
      },
      pexpire: () => Promise.resolve(1),
      zrangebyscore: (key, min) =>
        Promise.resolve(
          [...set(key)]
            .filter(([, score]) => score >= min)
            .sort(([, a], [, b]) => a - b)
            .map(([member]) => member)
        ),
      publish: (channel, message) => {
        const listening = [...this.subscribers].filter((subscriber) =>
          subscriber.isListening(channel)
        );
        setImmediate(() => {
          for (const subscriber of listening) {
            subscriber.emit("message", channel, message);
          }
        });
        return Promise.resolve(listening.length);
      },
    };
  }

  subscriber(): FakeBusSubscriber {
    const subscriber = new FakeBusSubscriber();
    this.subscribers.add(subscriber);
    return subscriber;
  }
}

export class FakeBusSubscriber
  extends EventEmitter
  implements BusSubscriberClient
{
  status = "ready";
  readonly channels = new Set<string>();

  subscribe(channel: string): Promise<unknown> {
    this.channels.add(channel);
    return Promise.resolve(this.channels.size);
  }

  isListening(channel: string): boolean {
    return this.status === "ready" && this.channels.has(channel);
  }

  /** A dropped connection: the subscription is gone until it reconnects. */
  disconnect(): void {
    this.status = "end";
    this.channels.clear();
    this.emit("close");
  }

  reconnect(): void {
    this.status = "ready";
    this.emit("ready");
  }
}
