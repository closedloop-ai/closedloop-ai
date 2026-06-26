import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { PreviewSchemaSourceRepo } from "@/app/preview-schemas/constants";
import { previewSchemaCleanupService } from "@/app/preview-schemas/service";
import { buildCorrelationId, notifySlack } from "@/lib/slack-notifier";

type MaybeDropParams = {
  action: string;
  branch: string | undefined;
  repoFullName: string;
};

/**
 * Fires a background schema-drop when a PR is closed on the Symphony source
 * repo. All other repos and non-`closed` actions are no-ops.
 *
 * Uses `waitUntil` so the webhook response returns immediately — GitHub's
 * delivery timeout is short and the DROP operation can be slow.
 */
export function maybeDropPreviewSchemaOnClose({
  action,
  branch,
  repoFullName,
}: MaybeDropParams): void {
  if (action !== "closed") {
    return;
  }

  if (!branch) {
    return;
  }

  if (repoFullName !== PreviewSchemaSourceRepo.fullName) {
    log.info(
      "[webhook/github] Skipping schema drop for closed PR — repo not in allowlist",
      { branch, repoFullName, allowedRepo: PreviewSchemaSourceRepo.fullName }
    );
    return;
  }

  waitUntil(
    previewSchemaCleanupService
      .dropSchemaForBranch(branch)
      .then((result) => {
        if (result.error !== null) {
          log.error(
            "[webhook/github] dropSchemaForBranch returned error for closed PR",
            {
              branch,
              schemaName: result.schemaName,
              error: result.error,
            }
          );
          return notifySlack({
            route: "cleanup-preview-schemas:pr-close",
            message: `dropSchemaForBranch failed for branch \`${branch}\` (schema: \`${result.schemaName}\`): ${result.error}`,
            correlationId: buildCorrelationId(),
          }).catch(() => {
            // Notification failed, but don't block the webhook handler
          });
        }
      })
      .catch((err) => {
        const errorMessage = parseError(err);
        log.error(
          "[webhook/github] Failed to drop preview schema for closed PR",
          { branch, error: errorMessage }
        );
        return notifySlack({
          route: "cleanup-preview-schemas:pr-close",
          message: `Unexpected exception while dropping preview schema for branch \`${branch}\`: ${errorMessage}`,
          correlationId: buildCorrelationId(),
        }).catch(() => {
          // Notification failed, but don't block the webhook handler
        });
      })
  );
}
