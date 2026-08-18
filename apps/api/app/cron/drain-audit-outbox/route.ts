import { log } from "@repo/observability/log";
import { drainAuditOutbox } from "@/app/audit/audit-emit-service";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush } from "@/lib/route-utils";

/**
 * Cron endpoint that drains pending `audit_outbox` rows into the tamper-evident
 * ledger (FEA-3862 Slice 1c). Emit points enqueue events best-effort off the
 * user's hot path; this cron is the durability guarantee — it appends each
 * pending event under the per-org single-writer advisory lock so `seq` stays
 * gap-free. Idempotent: appended rows are deleted, so a re-run appends nothing.
 *
 * Protected by CRON_SECRET bearer token (Vercel Cron).
 */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, "[drain-audit-outbox]");
  if (denied) {
    return denied;
  }

  const summary = await drainAuditOutbox();
  log.info("[drain-audit-outbox] Drained audit outbox", summary);
  scheduleLogFlush();

  return Response.json({ ok: true, summary });
};
