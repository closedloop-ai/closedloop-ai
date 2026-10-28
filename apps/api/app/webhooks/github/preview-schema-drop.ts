import { sanitizeOperatorMessageFragment } from "@repo/database/scripts/migrate-deploy-recovery";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { PreviewSchemaSourceRepo } from "@/app/preview-schemas/constants";
import { previewSchemaCleanupService } from "@/app/preview-schemas/service";
import { isRetainedEnvironmentBranch } from "@/app/preview-schemas/service/vibe-environment-retention";
import { buildCorrelationId, notifySlack } from "@/lib/slack-notifier";

type MaybeDropParams = {
  action: string;
  branch: string | undefined;
  repoFullName: string;
};

/**
 * Fires a background schema-drop when a PR is closed on the Symphony source
 * repo. `vibe/`, `prototype/` and `functional-prototype/` branches require
 * explicit cleanup (ISS-12135, ISS-12214); other repos and non-`closed`
 * actions are no-ops.
 *
 * Uses `waitUntil` so the webhook response returns immediately; GitHub's
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

  if (isRetainedEnvironmentBranch(branch)) {
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
          // Slack is at least as widely readable as the Actions log the
          // cleanup route protects, and this is the SAME raw Prisma text
          // (ISS-7567).
          const detail = sanitizeOperatorMessageFragment(result.error);
          log.error(
            "[webhook/github] dropSchemaForBranch returned error for closed PR",
            {
              branch,
              schemaName: result.schemaName,
              error: detail,
            }
          );
          return notifySlack({
            route: "cleanup-preview-schemas:pr-close",
            message: `dropSchemaForBranch failed for branch \`${branch}\` (schema: \`${result.schemaName}\`): ${detail}`,
            correlationId: buildCorrelationId(),
          }).catch(() => {
            // Notification failed, but don't block the webhook handler
          });
        }
      })
      .catch((err) => {
        const errorMessage = sanitizeOperatorMessageFragment(parseError(err));
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
