/**
 * Type declarations for `reset-dashboard-db-lib.mjs` (ISS-5303 — tooling
 * coverage reach). The lib is plain ESM JavaScript, so this sidecar is what lets
 * the typechecked `test/` project consume it without `allowJs`. Keep the
 * signatures in step with the `@ts-check` JSDoc on the implementation.
 */

/**
 * Electron `app.getName()` for this app. Declared as the literal, not `string`:
 * the implementation exports a const literal and this value has to match the
 * directory Electron actually creates, so a consumer comparing against it should
 * be checked at compile time rather than widened to any string.
 */
export declare const APP_NAME: "Closedloop";

/** The SQLite data directory inside userData. Literal for the same reason. */
export declare const DB_DIR: "agent-dashboard.pgdata";

/**
 * Absolute path of the Agent Dashboard database directory for a platform.
 * See the implementation for the documented `XDG_CONFIG_HOME` divergence.
 */
export declare function dashboardDbPath(
  platformName?: string,
  env?: NodeJS.ProcessEnv,
  home?: string
): string;

/**
 * Recursively remove `dbPath` if it exists; a missing path is a no-op. `log` is
 * injectable so tests can assert on the report without writing to stdout.
 */
export declare function removeAll(
  dbPath: string,
  log?: (message: string) => void
): void;
