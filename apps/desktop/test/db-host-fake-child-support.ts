/**
 * @file db-host-fake-child-support.ts
 * @description Shared typing for the fake forked db-host children the
 * `db-host-*` suites inject through `DbHostClient`'s `fork` seam.
 *
 * `DbHostProcess.on` (db-host-client.ts) is an OVERLOAD PAIR — `"message"` takes
 * `(message: unknown) => void` and `"exit"` takes `(code: number | null) => void`.
 * A fake that declares one loose `on(event: string, listener: (...args: unknown[])
 * => void)` is not assignable to it (the exit listener's `number | null` argument
 * is not `unknown`), and a fake that only models the message arm would let a
 * suite register an exit listener the real client could never deliver to.
 *
 * Modelling the pair as a discriminated tuple union keeps both arms honest AND
 * narrows inside a single implementation, so a fake can store each listener at
 * its real type without a cast:
 *
 * ```ts
 * on(...args: DbHostChildListenerArgs): unknown {
 *   if (args[0] === "message") {
 *     messageListener = args[1];
 *   } else {
 *     exitListener = args[1];
 *   }
 *   return child;
 * }
 * ```
 */

import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  type DbHostError,
  DbHostRequestKind,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";

/** Child → main message listener (`child.on("message", …)`). */
export type DbHostChildMessageListener = (message: unknown) => void;

/** Child exit listener (`child.on("exit", …)`). */
export type DbHostChildExitListener = (code: number | null) => void;

/**
 * The argument tuples `DbHostProcess.on` accepts, as a discriminated union so an
 * implementation narrows `args[1]` to the listener type the event actually
 * carries.
 */
export type DbHostChildListenerArgs =
  | ["message", DbHostChildMessageListener]
  | ["exit", DbHostChildExitListener];

/**
 * Drive a serialized child error through the REAL main-side reconstruction and
 * return the `Error` `rebuildError` produced.
 *
 * `rebuildError` is module-private to `db-host-client.ts`, and the boot path is
 * the one place a caller can observe its output directly: a Ready response
 * carrying `error` makes `start()` reject with exactly the rebuilt error. So a
 * suite that needs to assert what SURVIVES the structured-clone boundary — the
 * ISS-4714 `refusalKind`, the ISS-6337 storage-exhaustion verdict — drives it
 * through here rather than hand-building the reconstructed error it hopes
 * production would produce.
 *
 * No Electron boot: the client's `fork` seam takes the fake child below.
 */
export function captureRebuiltBootError(
  serialized: DbHostError
): Promise<unknown> {
  const posted: { kind: string; id?: number }[] = [];
  let messageListener: DbHostChildMessageListener | undefined;
  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "message") {
        messageListener = args[1];
      }
      return child;
    },
    postMessage(message: { kind: string; id?: number }) {
      posted.push(message);
    },
    kill() {
      // no-op for the fake
    },
  };
  const client = new DbHostClient({
    onEmit: () => undefined,
    onLog: () => undefined,
    fork: () => child,
  });
  const started = client.start({ dataDir: "/tmp/agent-dashboard" }).then(
    () => null,
    (error: unknown) => error
  );
  messageListener?.({
    kind: DbHostResponseKind.Ready,
    id: posted.find((message) => message.kind === DbHostRequestKind.Init)?.id,
    error: serialized,
  });
  return started;
}

/**
 * Deliver `messages` to a real `DbHostClient` exactly as a forked child posts
 * them, through the client's own `fork` seam, so a suite asserts the shipped
 * `handleMessage`. What main does with them is observed through the caller's
 * `Observability.init` and `onLog`.
 *
 * `start()` attaches the real message listener before its Ready ever arrives,
 * and the fake never answers one, so the boot promise stays pending on purpose.
 */
export function deliverChildMessages(
  messages: unknown[],
  onLog: (message: string) => void = () => undefined
): void {
  let messageListener: DbHostChildMessageListener | undefined;
  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "message") {
        messageListener = args[1];
      }
      return child;
    },
    postMessage() {
      // Main → child requests are not under test here.
    },
    kill() {
      // no-op for the fake
    },
  };
  const client = new DbHostClient({
    onEmit: () => undefined,
    onLog,
    fork: () => child,
  });
  client.start({ dataDir: "/tmp/agent-dashboard" }).catch(() => {
    // boot is not what this helper asserts
  });
  if (!messageListener) {
    throw new Error("client.start did not attach a message listener");
  }
  for (const message of messages) {
    messageListener(message);
  }
}
