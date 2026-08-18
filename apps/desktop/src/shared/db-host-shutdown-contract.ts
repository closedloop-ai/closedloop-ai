/**
 * @file db-host-shutdown-contract.ts
 * @description ISS-5262 — the main↔preload sentinel for "this db read was
 * abandoned because the app is shutting down".
 *
 * `ipcMain.handle` prints `Error occurred in handler for '<channel>'` for ANY
 * rejection a handler produces, so an in-flight `desktop:shared-agent-sessions:usage`
 * read racing the db-host teardown logged a handler error after
 * `shutdown sequence end: clean`. The handler therefore has to RESOLVE.
 *
 * It must not resolve with data. An empty usage summary is indistinguishable
 * from a real one, and a `0` token/cost total is exactly the plausible-but-wrong
 * number the repo forbids: the read never ran, so the honest answer is
 * "unknown", not "zero". This sentinel is that "unknown" — a plain,
 * structured-cloneable object carrying no payload fields at all, so it can never
 * be mistaken for a result.
 *
 * The renderer never sees it: `invokeLiveDb` in the preload recognizes the
 * sentinel and rejects with a typed error, which is bit-for-bit what the
 * renderer already observed when the handler rejected. The renderer contract —
 * and everything it renders — is deliberately unchanged; the only thing that
 * changes is that the main-process log stops contradicting itself.
 */

/**
 * Discriminator for {@link DbHostShuttingDownResult}. Namespaced so it cannot
 * collide with a real payload field on any db read channel.
 */
export const DB_HOST_SHUTTING_DOWN_STATUS = "desktop:db-host:shutting-down";

/**
 * The typed "no answer — the app is shutting down" result an ipcMain db handler
 * resolves with instead of rejecting. Deliberately payload-free.
 */
export type DbHostShuttingDownResult = {
  readonly status: typeof DB_HOST_SHUTTING_DOWN_STATUS;
};

/** The single shared instance; frozen so no caller can graft a payload onto it. */
export const DB_HOST_SHUTTING_DOWN_RESULT: DbHostShuttingDownResult =
  Object.freeze({
    status: DB_HOST_SHUTTING_DOWN_STATUS,
  });

/**
 * Message used by the preload when it converts the sentinel back to a rejection.
 *
 * It deliberately LEADS with `db-host is closed`, which is one of
 * `TRANSIENT_DB_HOST_ERROR_SIGNATURES` (`transient-db-host-error.ts`). Before
 * ISS-5262 an in-flight read racing the teardown rejected with the raw
 * `db-host exited (code: 0)` — also a transient signature — so the renderer
 * classified it as a lifecycle blip and showed the quiet reconnecting state
 * instead of the hard error card. A fresh message would have silently
 * reclassified that read as FATAL, trading a lying log for a lying UI. Keeping a
 * recognized signature is what makes "the renderer contract is unchanged" true.
 */
export const DB_HOST_SHUTTING_DOWN_MESSAGE =
  "db-host is closed — shutting down; read abandoned";

/**
 * Recognize the sentinel in an IPC result.
 *
 * Structural rather than referential: the value crossed a structured-clone
 * boundary, so it is a copy, never `DB_HOST_SHUTTING_DOWN_RESULT` itself.
 */
export function isDbHostShuttingDownResult(
  value: unknown
): value is DbHostShuttingDownResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === DB_HOST_SHUTTING_DOWN_STATUS
  );
}

/**
 * The ONE unwrap every preload bridge over a `withDb`-registered channel must
 * apply: pass a real result through, and turn the sentinel into a rejection.
 *
 * Centralized because forgetting it is silent and severe. The bridges cast the
 * IPC result (`invoke(...) as Promise<T>`), so a sentinel that slips past would
 * typecheck as `T` and reach the renderer as data — a truthy object read as a
 * successful delete, or a non-array spread into a table. Every such bridge goes
 * through here so there is one place to be right.
 */
export function rejectIfDbHostShuttingDown<TResult>(
  value: TResult | DbHostShuttingDownResult
): TResult {
  if (isDbHostShuttingDownResult(value)) {
    throw new Error(DB_HOST_SHUTTING_DOWN_MESSAGE);
  }
  return value as TResult;
}

/**
 * Every IPC channel namespace whose handlers are registered through `withDb` /
 * `withPrisma`, and which can therefore resolve {@link DB_HOST_SHUTTING_DOWN_RESULT}
 * instead of a payload.
 *
 * closedloop-ai-stage review: widening the wrapper's result to
 * `TResult | DbHostShuttingDownResult` puts a payload-free object in the
 * declared result of EVERY one of these channels — but the preload bridges then
 * cast (`invoke(...) as Promise<T>`), which erases the union again. A bridge
 * that forgot {@link rejectIfDbHostShuttingDown} therefore typechecked and
 * shipped the sentinel to a caller expecting data: a truthy object read as a
 * successful delete, a non-array spread into a table.
 *
 * A cast can never be type-checked, so the enforcement is moved one step
 * earlier — onto the CHANNEL. {@link NotDbGuarded} makes an unguarded `invoke`
 * reject any channel in these namespaces outright, so the only way to reach one
 * is through a helper that applies the unwrap. Forgetting the guard is now a
 * COMPILE error at the call site instead of a payload-free object at runtime.
 */
export type DbGuardedChannel =
  | `desktop:db:${string}`
  | `desktop:scheduled-tasks:${string}`
  | `desktop:shared-agent-sessions:${string}`
  | `desktop:shared-branches:${string}`
  | `desktop:shared-trace-comments:${string}`;

/**
 * `unknown` for a normal channel, `never` for a {@link DbGuardedChannel}.
 *
 * Intersect it with the channel parameter of any raw/unguarded `invoke`
 * (`channel: TChannel & NotDbGuarded<TChannel>`): a guarded channel literal
 * collapses the parameter to `never` and fails to compile, while every other
 * literal is unaffected.
 *
 * A value already widened to `string` still passes — TypeScript cannot know
 * which channel it holds. That is the one unavoidable hole, and it is narrow:
 * these channels are named by literals and `as const` contract objects
 * everywhere in the preload, so the check bites exactly where new bridges are
 * written.
 */
export type NotDbGuarded<TChannel extends string> =
  TChannel extends DbGuardedChannel ? never : unknown;
