import { timingSafeEqual } from "node:crypto";
import { log } from "@repo/observability/log";
import { scheduleLogFlush } from "@/lib/route-utils";

/**
 * Validates a `Authorization: Bearer <CRON_SECRET>` header on a cron route.
 *
 * Returns a `Response` to short-circuit the route when validation fails
 * (500 if `CRON_SECRET` is unset, 401 otherwise), or `null` when the request
 * is authorized and the route should proceed.
 *
 * `logTag` is the route prefix used in the misconfig log line, e.g.
 * `"[timeout-loops]"`.
 */
export const validateCronSecret = (
  request: Request,
  logTag: string
): Response | null => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(`${logTag} CRON_SECRET is not configured`);
    scheduleLogFlush();
    return new Response("Internal Server Error", { status: 500 });
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  const isValid =
    authHeader.length === expected.length &&
    timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
  if (!isValid) {
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
};
