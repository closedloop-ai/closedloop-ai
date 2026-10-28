import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { githubDirtyScopeService } from "@/app/integrations/github/dirty-scope-service";

export function scheduleGitHubDirtyScopeRecoveryDrain({
  organizationId,
  targetId,
}: {
  organizationId: string;
  targetId: string;
}): void {
  waitUntil(
    Promise.resolve()
      .then(() =>
        githubDirtyScopeService.dispatchDue({
          computeTargetId: targetId,
          organizationId,
        })
      )
      .catch((error) => {
        log.warn(
          "[relaySocketEvent] GitHub dirty-scope recovery drain failed",
          {
            computeTargetId: targetId,
            error,
            organizationId,
          }
        );
      })
  );
}
