import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { sweepUnackedCommands } from "@/lib/desktop-command-ack-timeout";
import { scheduleLogFlush } from "@/lib/route-utils";

const ROUTE_TAG = "[sweep-unacked-commands]";

/**
 * ISS-7223: emits the `timed_out` ack outcome for commands whose ack never came.
 *
 * Read-only with respect to command state — three bounded reads and one log line
 * per crossing. The deadline band, the per-tick cap, and the reason this sweep
 * deliberately does not retry or terminalize anything live in
 * `desktop-command-ack-timeout.ts`.
 */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, ROUTE_TAG);
  if (denied) {
    return denied;
  }

  try {
    const summary = await sweepUnackedCommands();
    log.info(`${ROUTE_TAG} sweep complete`, summary);
    scheduleLogFlush();
    return Response.json({ ok: true, summary });
  } catch (error) {
    // A 500 trips Vercel's cron alerting but does not say which read broke, and
    // a sweep built to end a silence must not itself go silent unnamed.
    log.error(`${ROUTE_TAG} sweep failed`, { error });
    scheduleLogFlush();
    return new Response("sweep-unacked-commands failed", { status: 500 });
  }
};
