import { log } from "@repo/observability/log";
import { scheduleLogFlush } from "@/lib/route-utils";
import { tokenMatches } from "./db-health-helpers";
import { getDatabaseHealth } from "./service";

export const dynamic = "force-dynamic";

export const GET = async (request: Request) => {
  const expectedToken = process.env.DB_HEALTH_TOKEN;
  if (!expectedToken) {
    log.error("health.db_token_missing");
    return Response.json(
      { ok: false, error: "service_unavailable" },
      { status: 503 }
    );
  }

  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;
  if (!tokenMatches(token, expectedToken)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const result = await getDatabaseHealth();

  // Serverless: ensure buffered health.db_check_failed entries are shipped to
  // Datadog before the function freezes (the flush timer is unref'd).
  // ISS-4659: routed through the shared helper rather than a bare
  // `waitUntil(log.flush())` so this route's spans flush too — it bypasses the
  // auth wrappers, so `logRequestCompleted` never runs for it.
  scheduleLogFlush();

  return Response.json(result, { status: result.ok ? 200 : 503 });
};
