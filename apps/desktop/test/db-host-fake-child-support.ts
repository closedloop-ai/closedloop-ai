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
