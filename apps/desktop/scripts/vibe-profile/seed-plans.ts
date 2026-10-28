import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SqliteAgentDatabase } from "../../src/main/database/sqlite.js";
import {
  extractPlansFromPlansDir,
  upsertPlans,
} from "../../src/main/plans/plan-store.js";

const planStepSchema = z.object({
  step: z.string().min(1),
  status: z.string(),
});
const updatePlanEventSchema = z.object({
  tool_input: z.object({
    explanation: z.string().optional(),
    plan: z.array(planStepSchema).min(1),
  }),
});
type PlanSnapshot = {
  readonly at: string;
  readonly explanation: string | null;
  readonly steps: readonly z.infer<typeof planStepSchema>[];
};

type UpdatePlanRow = {
  session_id: string;
  session_name: string | null;
  created_at: string;
  data: string | null;
};

const COMPLETED_STEP_STATUS = "completed";

/**
 * Plans come from the one producer Desktop has: the `plans.backfill` sweep
 * over `<CLAUDE_HOME>/plans` (`extractPlansFromPlansDir` + `upsertPlans`),
 * which also runs on every launch. The plan text is real: the step lists the
 * corpus's Codex sessions published through `update_plan`, the first one
 * written as the plan file and the last one written over it, so a session
 * whose plan moved gets a second PlanVersion the same way an edited plan file
 * does.
 */
export async function seedPlans(
  db: SqliteAgentDatabase,
  claudeHome: string
): Promise<{ plans: number; revised: number }> {
  const plansDir = path.join(claudeHome, "plans");
  mkdirSync(plansDir, { recursive: true });
  const bySession = await readPlanSnapshots(db);
  const revisions: { file: string; snapshot: PlanSnapshot; title: string }[] =
    [];
  for (const [sessionId, { title, snapshots }] of bySession) {
    const file = path.join(plansDir, `${sessionId}.md`);
    writePlanFile(file, title, snapshots[0]);
    const last = snapshots.at(-1);
    if (last && renderPlan(title, last) !== renderPlan(title, snapshots[0])) {
      revisions.push({ file, snapshot: last, title });
    }
  }
  await upsertPlans(db.prisma, extractPlansFromPlansDir(plansDir));
  for (const revision of revisions) {
    writePlanFile(revision.file, revision.title, revision.snapshot);
  }
  if (revisions.length > 0) {
    await upsertPlans(db.prisma, extractPlansFromPlansDir(plansDir));
  }
  return { plans: bySession.size, revised: revisions.length };
}

async function readPlanSnapshots(
  db: SqliteAgentDatabase
): Promise<Map<string, { title: string; snapshots: PlanSnapshot[] }>> {
  const rows = await db.prisma.client.$queryRawUnsafe<UpdatePlanRow[]>(
    `SELECT e.session_id, s.name AS session_name, e.created_at, e.data
       FROM events e JOIN sessions s ON s.id = e.session_id
      WHERE e.tool_name = 'update_plan' AND e.created_at IS NOT NULL
      ORDER BY e.session_id, e.created_at`
  );
  const bySession = new Map<
    string,
    { title: string; snapshots: PlanSnapshot[] }
  >();
  for (const row of rows) {
    const parsed = updatePlanEventSchema.safeParse(
      JSON.parse(row.data ?? "null")
    );
    if (!parsed.success) {
      continue;
    }
    const entry = bySession.get(row.session_id) ?? {
      title: row.session_name?.trim() || `Plan for session ${row.session_id}`,
      snapshots: [],
    };
    entry.snapshots.push({
      at: row.created_at,
      explanation: parsed.data.tool_input.explanation ?? null,
      steps: parsed.data.tool_input.plan,
    });
    bySession.set(row.session_id, entry);
  }
  return bySession;
}

function writePlanFile(
  file: string,
  title: string,
  snapshot: PlanSnapshot
): void {
  writeFileSync(file, renderPlan(title, snapshot));
  const at = new Date(snapshot.at);
  utimesSync(file, at, at);
}

function renderPlan(title: string, snapshot: PlanSnapshot): string {
  const steps = snapshot.steps
    .map(
      (step) =>
        `- ${step.status === COMPLETED_STEP_STATUS ? "[x]" : "[ ]"} ${step.step}`
    )
    .join("\n");
  const explanation = snapshot.explanation ? `${snapshot.explanation}\n\n` : "";
  return `# ${title}\n\n${explanation}## Steps\n\n${steps}\n`;
}
