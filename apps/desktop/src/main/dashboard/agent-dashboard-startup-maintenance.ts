/**
 * @file agent-dashboard-startup-maintenance.ts
 * @description ISS-4771: the three best-effort one-shot startup maintenance
 * passes the Agent Dashboard runtime runs behind its background-work gate —
 * seeding the local `pack_catalog`, scanning the installed pack inventory, and
 * backfilling `~/.claude/plans`. Extracted out of
 * `agent-dashboard-design-system-runtime.ts`; each pass still swallows its own
 * failure into a log line so a failed pass can never break boot.
 */

import path from "node:path";
import { app } from "electron";
import catalogSeed from "../packs/catalog-seed.json" with { type: "json" };
import type {
  AgentDashboardLog,
  InvokeStoreOp,
} from "./agent-dashboard-runtime-options.js";

/**
 * Seed the local `pack_catalog`. Never throws — a failed pass must not break
 * boot — so it reports the outcome instead.
 *
 * ISS-6170: the return value is load-bearing, not decoration. Callers use the
 * seed as the signal that `pack_catalog` is POPULATED, and an install failing
 * with `ENOTFOUND` against an empty catalog is transient rather than a pack this
 * build cannot install. Swallowing the failure and still announcing readiness
 * told the required-plugin installer the opposite and let it latch a legitimately
 * installable pack as permanently dead.
 */
export async function seedAgentDashboardCatalog(
  invokeStoreOp: InvokeStoreOp,
  log: AgentDashboardLog
): Promise<boolean> {
  try {
    // FEA-2038: upsertCatalogSeed uses prisma.write — runs in the DB host. The
    // seed doc is plain JSON, so it forwards as a structured-clone-safe arg.
    await invokeStoreOp("catalog.seed", [catalogSeed]);
    log("agent-dashboard", "Catalog seed applied");
    return true;
  } catch (e) {
    log(
      "agent-dashboard",
      `Catalog seed failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return false;
  }
}

export async function scanAgentDashboardPacks(
  invokeStoreOp: InvokeStoreOp,
  log: AgentDashboardLog
): Promise<void> {
  try {
    // FEA-2038: runPackScanner uses prisma.write — runs in the DB host. The
    // cooperative-delay callback can't cross IPC; the scanner runs off the main
    // thread there, so no pause is needed.
    await invokeStoreOp("packScanner.run");
    log("agent-dashboard", "Pack scanner completed");
  } catch (e) {
    log(
      "agent-dashboard",
      `Pack scanner failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

export async function backfillClaudePlans(
  invokeStoreOp: InvokeStoreOp,
  log: AgentDashboardLog
): Promise<void> {
  try {
    const plansDir = path.join(
      process.env.CLAUDE_HOME || path.join(app.getPath("home"), ".claude"),
      "plans"
    );
    // FEA-2038: upsertPlans uses prisma.write — the extract + batched upsert
    // runs wholly in the DB host (plansDir is a serializable string arg).
    const count = (await invokeStoreOp("plans.backfill", [plansDir])) as number;
    if (count > 0) {
      log("agent-dashboard", `Backfilled ${count} plans from ~/.claude/plans/`);
    }
  } catch (e) {
    log(
      "agent-dashboard",
      `Plan backfill failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
