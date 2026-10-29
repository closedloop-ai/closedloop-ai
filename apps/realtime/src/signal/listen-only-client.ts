import { REALTIME_SIGNAL_CHANNEL } from "@repo/realtime-contract/signal";
import type pg from "pg";

export const LISTEN_STATEMENT = `LISTEN ${REALTIME_SIGNAL_CHANNEL}`;

/** The only surface the listener has; `query` accepts one statement. */
export type ListenOnlyClient = Pick<pg.Client, "connect" | "end" | "on"> & {
  query(statement: typeof LISTEN_STATEMENT): Promise<unknown>;
};

export class ListenOnlyViolation extends Error {
  constructor(attempted: string) {
    super(`The LISTEN connection refused ${attempted}`);
    this.name = "ListenOnlyViolation";
  }
}

/**
 * PLN-2105 decision 2: the listener's connection can issue nothing but
 * `LISTEN realtime_signal`, so it can never sit in a transaction and stall the
 * notification queue that every notifying API transaction commits into. Any
 * other statement, and any client member outside the listener's surface,
 * throws. Liveness comes from TCP keepalive and the `error` and `end` events,
 * never from a probe query.
 */
export function listenOnly(client: pg.Client): ListenOnlyClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === "query") {
        return (statement: unknown, ...rest: unknown[]) => {
          if (statement !== LISTEN_STATEMENT || rest.length > 0) {
            throw new ListenOnlyViolation("a statement other than LISTEN");
          }
          return target.query(LISTEN_STATEMENT);
        };
      }
      if (typeof property === "symbol") {
        return Reflect.get(target, property, target);
      }
      // Read when the client is awaited or returned from an async function.
      if (property === "then") {
        return undefined;
      }
      if (!LISTENER_SURFACE.has(property)) {
        throw new ListenOnlyViolation(`access to ${property}`);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_target, property) {
      throw new ListenOnlyViolation(`assignment to ${String(property)}`);
    },
  });
}

const LISTENER_SURFACE: ReadonlySet<string> = new Set(["connect", "end", "on"]);
