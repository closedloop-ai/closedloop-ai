import { gatewayLog } from "../../main/gateway-logger.js";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { json } from "./response-utils.js";

let updateInProgress = false;

/**
 * @internal Test-only. Resets the in-progress mutex so tests start from a
 * clean state without cross-test pollution.
 */
export function _resetMutexForTesting(): void {
  updateInProgress = false;
}

export type UpdateAndRestartOptions = {
  isUpdateAndRestartEnabled: () => boolean;
  checkForUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>;
  applyUpdate: () => Promise<void>;
};

export function registerUpdateAndRestartRoutes(
  dispatcher: OperationDispatcher,
  options: UpdateAndRestartOptions
): void {
  dispatcher.register(
    "POST",
    "/api/gateway/update-and-restart",
    async (context) => {
      // Feature flag guard
      if (!options.isUpdateAndRestartEnabled()) {
        json(context, 501, {
          error: "feature_disabled",
          feature: "update_and_restart",
        });
        return;
      }

      // Mutex guard — prevent concurrent update attempts
      if (updateInProgress) {
        json(context, 409, { error: "update_in_progress" });
        return;
      }

      updateInProgress = true;

      // Check for available update
      let updateResult: { updateAvailable: boolean; version?: string };
      try {
        updateResult = await options.checkForUpdate();
      } catch (err) {
        updateInProgress = false;
        const message = err instanceof Error ? err.message : String(err);
        json(context, 502, { error: message });
        return;
      }

      // No update available — respond and release mutex
      if (!updateResult.updateAvailable) {
        updateInProgress = false;
        json(context, 200, {
          updateAvailable: false,
          version: updateResult.version,
        });
        return;
      }

      // Update available — flush response before applying the update so the
      // caller receives confirmation before the app restarts.
      const payload = JSON.stringify({
        updateAvailable: true,
        updateInitiated: true,
      });
      context.response.statusCode = 200;
      context.response.setHeader("content-type", "application/json");

      // Safety timeout: if response.end() callback never fires (e.g., client
      // disconnects before flush), release the mutex after 30 seconds to prevent
      // permanent deadlock.
      const safetyTimer = setTimeout(() => {
        updateInProgress = false;
      }, 30_000);

      context.response.end(payload, () => {
        clearTimeout(safetyTimer);
        // Called once the response has been flushed to the client.
        // Apply the update after a short delay so the TCP stack has time to
        // deliver the response before the process exits/restarts.
        setTimeout(() => {
          options
            .applyUpdate()
            .catch((error) => {
              const message =
                error instanceof Error ? error.message : String(error);
              gatewayLog.error(
                "update-and-restart",
                `apply-update failed: ${message}`
              );
            })
            .finally(() => {
              updateInProgress = false;
            });
        }, 500);
      });
    }
  );
}
