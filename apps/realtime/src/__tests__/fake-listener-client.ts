import { EventEmitter } from "node:events";
import { REALTIME_SIGNAL_CHANNEL } from "@repo/realtime-contract/signal";
import { vi } from "vitest";
import type { ListenOnlyClient } from "../signal/listen-only-client";

/** Stands in for a listen-only `pg.Client`; each instance is one connection. */
export class FakeListenerClient extends EventEmitter {
  readonly statements: string[] = [];
  connectError: Error | undefined;
  readonly connect = vi.fn(() =>
    this.connectError ? Promise.reject(this.connectError) : Promise.resolve()
  );
  readonly query = vi.fn((statement: string) => {
    this.statements.push(statement);
    return Promise.resolve();
  });
  readonly end = vi.fn(async () => undefined);

  notify(payload: string, channel = REALTIME_SIGNAL_CHANNEL): void {
    this.emit("notification", { processId: 1, channel, payload });
  }

  /** A backend terminated by the server, as pg reports it. */
  terminate(): void {
    const error = Object.assign(new Error("terminating connection"), {
      code: TERMINATED_BY_ADMINISTRATOR,
    });
    this.emit("error", error);
    this.emit("end");
  }
}

/** SQLSTATE admin_shutdown, what `pg_terminate_backend` produces. */
export const TERMINATED_BY_ADMINISTRATOR = "57P01";

/** Hands out a new fake per connect, keeping every one for assertions. */
export function fakeClientFactory(): {
  clients: FakeListenerClient[];
  openClient: () => ListenOnlyClient;
  failNext: (error: Error) => void;
} {
  const clients: FakeListenerClient[] = [];
  const failures: Error[] = [];
  return {
    clients,
    failNext: (error) => {
      failures.push(error);
    },
    openClient: () => {
      const client = new FakeListenerClient();
      client.connectError = failures.shift();
      clients.push(client);
      return client;
    },
  };
}
