import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush } from "@/lib/route-utils";
import { githubRepoSyncStateBootstrapService } from "./service";

const LOG_PREFIX = "[bootstrap-repo-sync-states]";

export const maxDuration = 300;

export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, LOG_PREFIX);
  if (denied) {
    return denied;
  }
  try {
    const summary = await githubRepoSyncStateBootstrapService.run();
    log.info(`${LOG_PREFIX} bootstrap completed`, summary);
    scheduleLogFlush();
    return new Response(
      `OK: selected ${summary.orgsSelected}, bootstrapped ${summary.orgsBootstrapped}, failed ${summary.orgsFailed}, repos ${summary.reposMaterialized}, deadline ${summary.stoppedOnDeadline}`,
      { status: 200 }
    );
  } catch (error) {
    log.error(`${LOG_PREFIX} bootstrap failed`, { error: parseError(error) });
    scheduleLogFlush();
    return new Response("bootstrap-repo-sync-states failed", { status: 500 });
  }
};
