import { getResolvedGitPathAsync } from "../../server/operations/binary-path-overrides.js";
import type { DbHostAgentDatabase } from "../database/sqlite.js";

/**
 * The Agent Dashboard's "Startup historical backfill" task, scheduled by
 * `createAgentDashboardDesignSystemRuntime` through
 * `runAfterInitialBackgroundWorkAllowed`. Moved out of that runtime (which a
 * unit test cannot build) so the git path it hands the db-host can be tested
 * (ISS-11596, PLN-2165 S21).
 */
export function createStartupHistoricalBackfillTask(options: {
  isClosed: () => boolean;
  agentDatabase: Pick<DbHostAgentDatabase, "runHistoricalBackfill">;
  log: (scope: string, message: string) => void;
}): () => Promise<void> {
  const { isClosed, agentDatabase, log } = options;

  // Resolved like every other git site, so a git path configured in Settings
  // reaches the backfill (ISS-11596 decision 2), and asynchronously, so a cold
  // login-shell probe cannot freeze the main thread.
  const runStartupHistoricalBackfill = async (): Promise<void> => {
    if (isClosed()) {
      return;
    }

    const gitPath = await getResolvedGitPathAsync();
    // The resolution yields, so a shutdown can land during it; the check above
    // and the backfill call used to share one turn.
    if (isClosed()) {
      return;
    }
    await agentDatabase
      .runHistoricalBackfill(gitPath, 50)
      .catch((e: unknown) =>
        log(
          "agent-enrichment",
          `Startup backfill failed: ${e instanceof Error ? e.message : String(e)}`
        )
      );
  };
  return runStartupHistoricalBackfill;
}
