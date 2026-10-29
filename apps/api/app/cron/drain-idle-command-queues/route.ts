import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { drainIdleCommandQueues } from "@/lib/desktop-command-idle-drain";
import { scheduleLogFlush } from "@/lib/route-utils";

const ROUTE_TAG = "[drain-idle-command-queues]";

/**
 * The platform ceiling this sweep runs under, which MUST exceed
 * `IDLE_DRAIN_BUDGET_MS`.
 *
 * The internal budget is checked between targets, so a tick can overshoot it by
 * one target's dispatch (a 5s relay timeout) before stopping. Inheriting the
 * platform default instead would terminate the function below its own budget,
 * so the budget could never bite and the summary line — the only record of what
 * the sweep did — would be lost with it. `cron-route.test.ts` pins the ordering.
 */
export const maxDuration = 60;

/**
 * ISS-8686: wakes backlogged compute targets that send no presence heartbeat.
 *
 * The presence trigger in `fleet-capacity-sampler.ts` covers connected targets.
 * This is the floor under the disconnected ones, whose backlog is otherwise
 * reachable only by a reconnect that may never arrive. Bounds, backoff ladder,
 * and the give-up horizon live in `desktop-command-idle-drain.ts`.
 */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, ROUTE_TAG);
  if (denied) {
    return denied;
  }

  try {
    const summary = await drainIdleCommandQueues();
    log.info(`${ROUTE_TAG} sweep complete`, summary);
    scheduleLogFlush();
    return Response.json({ ok: true, summary });
  } catch (error) {
    // A 500 trips Vercel's cron alerting but does not say which read broke, and
    // a drain built to end a stall must not itself stall unnamed.
    log.error(`${ROUTE_TAG} sweep failed`, { error });
    scheduleLogFlush();
    return new Response("drain-idle-command-queues failed", { status: 500 });
  }
};
