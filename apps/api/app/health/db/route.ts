import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
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
  waitUntil(log.flush());

  return Response.json(result, { status: result.ok ? 200 : 503 });
};
