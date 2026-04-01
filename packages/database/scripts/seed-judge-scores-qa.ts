/**
 * QA seeding script for PR 700 — Restore judge scores in artifact tables.
 *
 * Creates:
 *   - 1 team (linked to your org + user)
 *   - 2 projects (each assigned to the team)
 *   - 2 PRD artifacts + 2 Implementation Plan artifacts
 *   - ArtifactEvaluation + JudgeScores for each (one artifact left unevaluated)
 *
 * If no org/user exists, a placeholder org + user is created so the script
 * can run on a fresh local DB. Once you sign in via Clerk the real data will
 * co-exist alongside these records.
 *
 * Run:
 *   cd packages/database
 *   DATABASE_URL="postgresql://postgres:password@localhost:5432/symphony" \
 *     pnpm exec tsx scripts/seed-judge-scores-qa.ts
 *
 * Safe to re-run — upserts on slugs/unique keys.
 *
 * To clean up:
 *   DELETE FROM teams WHERE slug = 'qa-judge-scores-team';
 *   DELETE FROM projects WHERE slug IN ('qa-alpha-project', 'qa-beta-project');
 */

import pg, { type QueryResultRow } from "pg";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:password@localhost:5432/symphony";

/** Redacts password segment in a postgres URL for safe logging. */
const REDACT_DB_PASSWORD_IN_URL = /:[^@]+@/;

const pool = new pg.Pool({ connectionString: DB_URL });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid(): string {
  // biome-ignore lint/suspicious/noExplicitAny: runtime availability check
  return (globalThis as any).crypto.randomUUID() as string;
}

async function query<R extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<pg.QueryResult<R>> {
  const client = await pool.connect();
  try {
    return await client.query<R>(sql, params);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Resolve or create org + user
// ---------------------------------------------------------------------------

async function resolveOrg(): Promise<string> {
  // Skip placeholder orgs created by a previous run of this script
  const existing = await query<{ id: string }>(
    "SELECT id FROM organizations WHERE clerk_id NOT LIKE 'clerk_placeholder_%' ORDER BY created_at ASC LIMIT 1"
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  console.error(
    "\n❌ No real organization found in the database.\n" +
      "   The API creates your org/user automatically on the first authenticated request.\n" +
      "   Steps to fix:\n" +
      "   1. Start the local API:  just dev   (or: pnpm turbo dev --filter=api)\n" +
      "   2. Open the app at http://localhost:3000 and sign in\n" +
      "   3. Navigate to any page (this triggers the first API call)\n" +
      "   4. Re-run this script\n"
  );
  process.exit(1);
}

async function resolveUser(orgId: string): Promise<string> {
  const existing = await query<{ id: string }>(
    "SELECT id FROM users WHERE organization_id = $1 AND clerk_id NOT LIKE 'clerk_placeholder_%' ORDER BY created_at ASC LIMIT 1",
    [orgId]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  console.error(
    "\n❌ No real user found in the database for org " +
      orgId +
      ".\n" +
      "   Sign in to the app and navigate to any page, then re-run this script.\n"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Entity helpers
// ---------------------------------------------------------------------------

async function upsertTeam(
  orgId: string,
  name: string,
  slug: string
): Promise<string> {
  const existing = await query<{ id: string }>(
    "SELECT id FROM teams WHERE organization_id = $1 AND slug = $2",
    [orgId, slug]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }
  const id = uuid();
  await query(
    "INSERT INTO teams (id, organization_id, name, slug, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())",
    [id, orgId, name, slug]
  );
  return id;
}

async function upsertProject(
  orgId: string,
  userId: string,
  name: string,
  slug: string
): Promise<string> {
  const existing = await query<{ id: string }>(
    "SELECT id FROM projects WHERE organization_id = $1 AND slug = $2",
    [orgId, slug]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }
  const id = uuid();
  await query(
    `INSERT INTO projects
       (id, organization_id, name, slug, priority, status, created_by_id, settings, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'MEDIUM', 'IN_PROGRESS', $5, '{}', NOW(), NOW())`,
    [id, orgId, name, slug, userId]
  );
  return id;
}

async function linkProjectToTeam(
  projectId: string,
  teamId: string
): Promise<void> {
  await query(
    `INSERT INTO project_teams (id, project_id, team_id, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (project_id, team_id) DO NOTHING`,
    [uuid(), projectId, teamId]
  );
}

async function upsertArtifact(
  orgId: string,
  projectId: string,
  userId: string,
  type: "PRD" | "IMPLEMENTATION_PLAN",
  title: string,
  slug: string
): Promise<string> {
  const existing = await query<{ id: string }>(
    "SELECT id FROM artifacts WHERE organization_id = $1 AND slug = $2",
    [orgId, slug]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }
  const id = uuid();
  await query(
    `INSERT INTO artifacts
       (id, organization_id, project_id, type, title, slug, status, priority,
        latest_version, created_by_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'APPROVED', 'MEDIUM', 1, $7, NOW(), NOW())`,
    [id, orgId, projectId, type, title, slug, userId]
  );
  return id;
}

async function upsertEvaluation(
  orgId: string,
  artifactId: string,
  reportType: "PRD" | "PLAN",
  reportId: string
): Promise<string> {
  const existing = await query<{ id: string }>(
    "SELECT id FROM artifact_evaluations WHERE entity_id = $1 AND report_id = $2",
    [artifactId, reportId]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }
  const id = uuid();
  await query(
    `INSERT INTO artifact_evaluations
       (id, organization_id, entity_id, entity_type, artifact_id, report_type, report_id, created_at)
     VALUES ($1, $2, $3, 'ARTIFACT', $3, $4, $5, NOW())`,
    [id, orgId, artifactId, reportType, reportId]
  );
  return id;
}

async function upsertJudgeScore(
  evaluationId: string,
  caseId: string,
  metricName: string,
  score: number,
  threshold: number,
  finalStatus: "PASSED" | "NEEDS_IMPROVEMENT" | "FAILED",
  justification: string
): Promise<void> {
  await query(
    `INSERT INTO judge_scores
       (id, evaluation_id, case_id, metric_name, threshold, score, justification, final_status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (evaluation_id, case_id, metric_name) DO NOTHING`,
    [
      uuid(),
      evaluationId,
      caseId,
      metricName,
      threshold,
      score,
      justification,
      finalStatus,
    ]
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("DB:", DB_URL.replace(REDACT_DB_PASSWORD_IN_URL, ":***@"));

  // Org + user
  console.log("\nResolving org and user...");
  const orgId = await resolveOrg();
  const userId = await resolveUser(orgId);

  const orgInfo = await query<{ name: string; slug: string }>(
    "SELECT name, slug FROM organizations WHERE id = $1",
    [orgId]
  );
  const userInfo = await query<{ email: string }>(
    "SELECT email FROM users WHERE id = $1",
    [userId]
  );
  console.log(`  Org:  ${orgInfo.rows[0].name} (${orgId})`);
  console.log(`  User: ${userInfo.rows[0].email} (${userId})`);

  // Team
  const teamId = await upsertTeam(
    orgId,
    "QA Judge Scores Team",
    "qa-judge-scores-team"
  );
  console.log(`\nTeam: QA Judge Scores Team (${teamId})`);

  // Projects
  const projectAlphaId = await upsertProject(
    orgId,
    userId,
    "QA Alpha Project",
    "qa-alpha-project"
  );
  const projectBetaId = await upsertProject(
    orgId,
    userId,
    "QA Beta Project",
    "qa-beta-project"
  );
  await linkProjectToTeam(projectAlphaId, teamId);
  await linkProjectToTeam(projectBetaId, teamId);
  console.log(`Project Alpha: ${projectAlphaId}`);
  console.log(`Project Beta:  ${projectBetaId}`);

  // Artifacts
  const prdAlphaId = await upsertArtifact(
    orgId,
    projectAlphaId,
    userId,
    "PRD",
    "QA Alpha PRD",
    "qa-alpha-prd"
  );
  const planAlphaId = await upsertArtifact(
    orgId,
    projectAlphaId,
    userId,
    "IMPLEMENTATION_PLAN",
    "QA Alpha Implementation Plan",
    "qa-alpha-plan"
  );
  const prdBetaId = await upsertArtifact(
    orgId,
    projectBetaId,
    userId,
    "PRD",
    "QA Beta PRD",
    "qa-beta-prd"
  );
  const planBetaNoEvalId = await upsertArtifact(
    orgId,
    projectBetaId,
    userId,
    "IMPLEMENTATION_PLAN",
    "QA Beta Plan (No Evaluation)",
    "qa-beta-plan-no-eval"
  );
  console.log("\nArtifacts:");
  console.log(`  PRD Alpha:           ${prdAlphaId}`);
  console.log(`  Plan Alpha:          ${planAlphaId}`);
  console.log(`  PRD Beta:            ${prdBetaId}`);
  console.log(`  Plan Beta (no eval): ${planBetaNoEvalId}`);

  // Evaluations + judge scores
  //
  // PRD Alpha: 3 scores → avg 0.87 → displays 87%
  const evalPrdAlpha = await upsertEvaluation(
    orgId,
    prdAlphaId,
    "PRD",
    "qa-prd-alpha-eval-v1"
  );
  await upsertJudgeScore(
    evalPrdAlpha,
    "prd-scope-judge",
    "scope_completeness",
    0.9,
    0.7,
    "PASSED",
    "PRD scope is well-defined with clear boundaries."
  );
  await upsertJudgeScore(
    evalPrdAlpha,
    "prd-testability-judge",
    "acceptance_criteria_clarity",
    0.85,
    0.7,
    "PASSED",
    "Acceptance criteria are specific and measurable."
  );
  await upsertJudgeScore(
    evalPrdAlpha,
    "prd-dependency-judge",
    "dependency_completeness",
    0.86,
    0.7,
    "PASSED",
    "Dependencies are identified and risks noted."
  );

  // Plan Alpha: 2 scores → avg 0.72 → displays 72%
  const evalPlanAlpha = await upsertEvaluation(
    orgId,
    planAlphaId,
    "PLAN",
    "qa-plan-alpha-eval-v1"
  );
  await upsertJudgeScore(
    evalPlanAlpha,
    "plan-goal-alignment-judge",
    "goal_alignment",
    0.75,
    0.7,
    "PASSED",
    "Plan tasks map to PRD goals."
  );
  await upsertJudgeScore(
    evalPlanAlpha,
    "plan-kiss-judge",
    "simplicity",
    0.69,
    0.7,
    "NEEDS_IMPROVEMENT",
    "Some tasks could be further decomposed."
  );

  // PRD Beta: 2 scores → avg 0.48 → displays 48%
  const evalPrdBeta = await upsertEvaluation(
    orgId,
    prdBetaId,
    "PRD",
    "qa-prd-beta-eval-v1"
  );
  await upsertJudgeScore(
    evalPrdBeta,
    "prd-scope-judge",
    "scope_completeness",
    0.55,
    0.7,
    "NEEDS_IMPROVEMENT",
    "PRD lacks detail in edge cases."
  );
  await upsertJudgeScore(
    evalPrdBeta,
    "prd-testability-judge",
    "acceptance_criteria_clarity",
    0.41,
    0.7,
    "FAILED",
    "Acceptance criteria are vague."
  );

  // Plan Beta: intentionally no evaluation → score column shows —

  console.log("\nEvaluations seeded:");
  console.log(`  PRD Alpha  → eval ${evalPrdAlpha}  expected display: 87%`);
  console.log(`  Plan Alpha → eval ${evalPlanAlpha}  expected display: 72%`);
  console.log(`  PRD Beta   → eval ${evalPrdBeta}  expected display: 48%`);
  console.log("  Plan Beta  → (no evaluation)            expected display: —");

  console.log("\n✅ Done.\n");
  console.log("URLs to verify (replace <teamSlug> with your team slug):");
  console.log(
    `  Project Alpha artifacts: /teams/<teamSlug>/projects/${projectAlphaId}`
  );
  console.log(
    `  Project Beta artifacts:  /teams/<teamSlug>/projects/${projectBetaId}`
  );
  console.log(`  Team Plans page:         /teams/${teamId}/plans`);
  console.log(`  Team PRDs page:          /teams/${teamId}/prds`);
  console.log("\nCleanup SQL:");
  console.log(`  DELETE FROM teams WHERE id = '${teamId}';`);
  console.log(
    `  DELETE FROM projects WHERE slug IN ('qa-alpha-project', 'qa-beta-project');`
  );
}

main()
  .catch((e) => {
    console.error("\n❌ Seeding failed:", e.message);
    process.exit(1);
  })
  .finally(() => pool.end());
