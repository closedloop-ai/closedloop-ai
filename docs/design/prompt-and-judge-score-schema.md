# Database Design: Prompt Table & Judge Score Normalization

**Status:** Proposal
**Date:** 2026-02-23
**Branch:** `feature/persist-code-judge-and-prompts-in-db`

---

## 1. Problem Statement

Today, judge evaluation data is stored as opaque JSON blobs in `ArtifactEvaluation.reportData`. This makes it impossible to:

1. **Link judge scores to prompt versions** — we extract prompts from GitHub Actions artifacts (`promptsExtractor`) but never persist them to the database. The `PromptsSnapshot` is parsed and discarded.
2. **Query individual metric scores** — answering "what is the average clarity score across all PRDs?" requires deserializing every `reportData` blob in application code (see `judgesAnalyticsService.extractJudgeScores`).
3. **Track prompt evolution** — there is no way to correlate score changes with prompt changes over time.

## 2. Current Schema

### ArtifactEvaluation (existing)

```
model ArtifactEvaluation {
  id          String   @id @default(uuid(7)) @db.Uuid
  artifactId  String   @map("artifact_id") @db.Uuid
  actionRunId String?  @map("action_run_id") @db.Uuid
  reportId    String   @map("report_id")
  reportData  Json     @map("report_data")        // ← opaque JudgesReport blob
  createdAt   DateTime @default(now()) @map("created_at")

  artifact Artifact @relation(...)

  @@unique([artifactId, reportId])
  @@map("artifact_evaluations")
}
```

### PromptInfo (existing TypeScript type, NOT in DB)

```typescript
// packages/api/src/types/prompt.ts
type PromptInfo = {
  promptType: PromptType;  // "AGENT" | "JUDGE"
  name: string;
  description: string;
  model: string;
  tools: string[];
  file_path: string;
  content: string;
  sha: string;            // Git blob SHA-1
};
```

### MetricStatistics (existing TypeScript type, NOT in DB)

```typescript
// packages/api/src/types/evaluation.ts
type MetricStatistics = {
  metric_name: string;
  threshold: number;
  score: number;
  justification: string;
};
```

### Ingestion Flow (existing)

```
GitHub Actions artifact (.zip)
  → promptsExtractor → PromptsSnapshot (parsed, NOT persisted)
  → judgesReportExtractor → JudgesReport
      → judgesReportHandler → ArtifactEvaluation.reportData (JSON blob)
      → codeJudgesReportHandler → ArtifactEvaluation.reportData (JSON blob)
```

### Read Path (existing)

- `artifactsService.getJudgesFeedback()` — loads `ArtifactEvaluation.reportData`, casts to `JudgesReport`, returns verbatim.
- `judgesAnalyticsService.getAggregateStats()` — loads ALL evaluations for an org/date range, deserializes every `reportData` in memory, extracts scores via `extractJudgeScores()`, computes aggregates in TypeScript.

---

## 3. Proposed Schema

### 3.1 New Enum: `PromptType`

```prisma
enum PromptType {
  AGENT
  JUDGE
}
```

### 3.2 New Table: `Prompt`

Stores immutable snapshots of agent/judge prompt files. Each unique `(organizationId, sha)` pair produces exactly one row. Version is auto-incremented within the `(organizationId, name, promptType)` group.

```prisma
model Prompt {
  id             String     @id @default(uuid(7)) @db.Uuid
  organizationId String     @map("organization_id") @db.Uuid
  promptType     PromptType @map("prompt_type")
  name           String                              // Display name from frontmatter
  description    String     @db.Text                 // Description from frontmatter
  model          String                              // Claude model identifier (e.g., "sonnet", "opus")
  tools          String[]                             // Tool names from frontmatter
  filePath       String     @map("file_path")        // Relative path (e.g., "agents-snapshot/judges/clarity.md")
  content        String     @db.Text                 // Full raw file content including frontmatter
  sha            String                              // Git blob SHA-1 — deduplication key
  version        Int                                 // Auto-incremented per (org, name, promptType)
  createdAt      DateTime   @default(now()) @map("created_at")

  // Relations
  organization Organization @relation(fields: [organizationId], references: [id])
  judgeScores  JudgeScore[]

  @@unique([organizationId, sha])                    // Dedup: same content = same row
  @@index([organizationId, name, promptType])        // Version lookup
  @@map("prompts")
}
```

**Key design decisions:**

| Decision | Rationale |
|---|---|
| `sha` as dedup key scoped to org | Same prompt content in different orgs gets separate rows (org isolation). Within an org, identical content is never duplicated. |
| `version` auto-incremented | Computed at insert time: `MAX(version WHERE org+name+type) + 1`. Gives human-readable version numbers like v1, v2, v3 per judge. |
| `tools` as `String[]` | Postgres native array — simpler than Json for a flat list. Supports `@> ARRAY['Read']` containment queries. |
| `content` as `Text` | Full prompt including frontmatter. Enables content diff between versions without external storage. |
| Immutable rows | Prompts are never updated — a new SHA means a new row with a new version. This preserves history. |

### 3.3 New Table: `JudgeScore`

Stores one row per metric per judge per evaluation. This is the fully normalized representation of what's currently inside `ArtifactEvaluation.reportData → stats[] → metrics[]`.

```prisma
model JudgeScore {
  id            String   @id @default(uuid(7)) @db.Uuid
  evaluationId  String   @map("evaluation_id") @db.Uuid
  promptId      String?  @map("prompt_id") @db.Uuid   // nullable for backfill (see §5)
  caseId        String   @map("case_id")               // Judge name from CaseScore.case_id
  metricName    String   @map("metric_name")            // From MetricStatistics.metric_name
  threshold     Float
  score         Float
  justification String   @db.Text
  finalStatus   Int      @map("final_status")           // EvalStatus: 1=Failed, 2=NeedsImprovement, 3=Passed
  createdAt     DateTime @default(now()) @map("created_at")

  // Relations
  evaluation ArtifactEvaluation @relation(fields: [evaluationId], references: [id], onDelete: Cascade)
  prompt     Prompt?            @relation(fields: [promptId], references: [id], onDelete: SetNull)

  @@unique([evaluationId, caseId, metricName])         // One score per metric per judge per evaluation
  @@index([promptId])                                   // "All scores for this prompt version"
  @@index([evaluationId])                               // "All scores for this evaluation"
  @@index([caseId, createdAt])                          // "Score trend for judge X over time"
  @@map("judge_scores")
}
```

**Key design decisions:**

| Decision | Rationale |
|---|---|
| `promptId` nullable | Historical evaluations (backfilled from `reportData`) won't have matching prompts since we never persisted them. Future evaluations will always have a promptId. |
| `finalStatus` on each row | Denormalized from `CaseScore.final_status`. Every metric row for the same `(evaluationId, caseId)` will share the same `finalStatus`. This avoids a third table and makes filtering by pass/fail trivial. |
| `score` and `threshold` as `Float` | Scores are continuous values (e.g., 0.85). `Float` maps to PostgreSQL `double precision`. |
| `onDelete: Cascade` from evaluation | If an evaluation is deleted, its scores are meaningless. |
| `onDelete: SetNull` from prompt | If a prompt is deleted (unlikely), preserve the score data with a null reference. |

### 3.4 Modified Table: `ArtifactEvaluation`

Add the `JudgeScore` relation. The `reportData` column is **retained temporarily** during migration (see §5) and dropped in a follow-up migration after backfill is verified.

```prisma
model ArtifactEvaluation {
  id          String   @id @default(uuid(7)) @db.Uuid
  artifactId  String   @map("artifact_id") @db.Uuid
  actionRunId String?  @map("action_run_id") @db.Uuid
  reportId    String   @map("report_id")
  reportData  Json?    @map("report_data")             // ← nullable during transition, dropped later
  createdAt   DateTime @default(now()) @map("created_at")

  // Relations
  artifact    Artifact     @relation(fields: [artifactId], references: [id], onDelete: Cascade)
  judgeScores JudgeScore[]                              // ← NEW

  @@unique([artifactId, reportId])
  @@map("artifact_evaluations")
}
```

---

## 4. Entity Relationship Diagram

```
┌──────────────┐       ┌────────────────────┐       ┌──────────────┐
│ Organization │──1:N──│      Prompt        │       │   Artifact   │
└──────────────┘       │                    │       └──────┬───────┘
                       │ id                 │              │
                       │ organizationId ────┘              │ 1:N
                       │ promptType (enum)  │              │
                       │ name               │       ┌──────┴───────────┐
                       │ description        │       │ArtifactEvaluation│
                       │ model              │       │                  │
                       │ tools[]            │       │ id               │
                       │ filePath           │       │ artifactId ──────┘
                       │ content            │       │ actionRunId      │
                       │ sha (unique/org)   │       │ reportId         │
                       │ version            │       │ reportData (→null)│
                       │ createdAt          │       │ createdAt        │
                       └────────┬───────────┘       └──────┬───────────┘
                                │                          │
                                │ 0:N                      │ 1:N
                                │                          │
                                │    ┌─────────────────┐   │
                                └────┤   JudgeScore    ├───┘
                                     │                 │
                                     │ id              │
                                     │ evaluationId ───┘  (FK → ArtifactEvaluation)
                                     │ promptId ──────┘   (FK → Prompt, nullable)
                                     │ caseId             (judge name)
                                     │ metricName
                                     │ threshold
                                     │ score
                                     │ justification
                                     │ finalStatus
                                     │ createdAt
                                     └─────────────────┘
```

---

## 5. Migration Strategy

The migration must be **non-destructive** and **reversible**. We use a three-phase approach.

### Phase 1: Schema Migration (Prisma migrate)

Create the new tables and modify `ArtifactEvaluation`:

1. Create `PromptType` enum
2. Create `prompts` table
3. Create `judge_scores` table with all indexes and constraints
4. Make `ArtifactEvaluation.reportData` nullable (it was required)

This is a standard `prisma migrate dev` operation.

### Phase 2: Data Backfill (TypeScript migration script)

A one-time script that decomposes existing `reportData` JSON blobs into `JudgeScore` rows:

```
For each ArtifactEvaluation row:
  1. Parse reportData as JudgesReport
  2. Skip if reportData is null or malformed
  3. For each CaseScore in report.stats:
     a. For each MetricStatistics in caseScore.metrics:
        - INSERT INTO judge_scores (
            evaluation_id = evaluation.id,
            prompt_id     = NULL,           -- no prompt data for historical records
            case_id       = caseScore.case_id,
            metric_name   = metric.metric_name,
            threshold     = metric.threshold,
            score         = metric.score,
            justification = metric.justification,
            final_status  = caseScore.final_status,
            created_at    = evaluation.createdAt
          )
          ON CONFLICT (evaluation_id, case_id, metric_name) DO NOTHING
  4. Log: evaluation.id, scores inserted, scores skipped
```

**Backfill considerations:**

- **Idempotent**: Uses `ON CONFLICT DO NOTHING` so it can be re-run safely.
- **Batched**: Process evaluations in batches of 100 to avoid memory pressure.
- **promptId = NULL**: We never persisted prompts historically, so no prompt linkage exists for old data.
- **Verification**: After backfill, compare row counts: `COUNT(judge_scores)` should equal `SUM(len(reportData.stats[].metrics[]))` across all evaluations.

### Phase 3: Drop `reportData` (follow-up migration)

After backfill is verified and all read/write paths have been updated:

1. A separate PR updates all consumers to read from `JudgeScore` instead of `reportData`
2. A final migration drops the `report_data` column from `artifact_evaluations`

This is intentionally a **separate PR** to allow rollback if issues are discovered.

---

## 6. Write Path Changes

### 6.1 Prompt Persistence (new handler)

Currently `promptsExtractor` parses prompts but no handler persists them. A new `promptsSnapshotHandler` will be added to the content handler registry:

```
promptsSnapshotHandler:
  key: CONTENT_KEYS.promptsSnapshot

  For each PromptInfo in snapshot.prompts:
    1. Check if Prompt exists with (organizationId, sha)
    2. If exists → reuse existing row (no insert)
    3. If not → compute version = MAX(version for org+name+type) + 1
    4. Upsert Prompt row
    5. Store promptId in a Map<filePath, promptId> for downstream use
```

### 6.2 Judge Report Persistence (modified handlers)

Both `judgesReportHandler` and `codeJudgesReportHandler` will be updated:

```
Current flow:
  upsert ArtifactEvaluation with reportData = JudgesReport JSON

New flow:
  1. Upsert ArtifactEvaluation (reportData = NULL or kept for transition)
  2. For each CaseScore in report.stats:
     a. Resolve promptId:
        - Match caseScore.case_id to a Prompt row by normalized name + org
        - Use the most recent version if multiple exist
        - NULL if no match (judge name doesn't correspond to a known prompt)
     b. For each MetricStatistics in caseScore.metrics:
        - Upsert JudgeScore row
```

### 6.3 Loop Artifact Ingestion

`loop-artifact-ingestion.ts` also persists `judgesReport` into `ArtifactEvaluation`. It will need the same JudgeScore fan-out logic. Since loops don't have prompts snapshots today, `promptId` will be NULL for loop-ingested evaluations until prompt extraction is added to the loop flow.

---

## 7. Read Path Changes

### 7.1 `artifactsService.getJudgesFeedback()`

**Current:** Loads `ArtifactEvaluation.reportData`, casts to `JudgesReport`.

**New:** Query `JudgeScore` rows for the evaluation, reconstruct the `JudgesReport` shape for backward-compatible API response. Alternatively, update the API response type to return structured `JudgeScore[]` directly.

### 7.2 `judgesAnalyticsService.getAggregateStats()`

**Current:** Loads all evaluations, deserializes `reportData` in memory, runs `extractJudgeScores()` to aggregate.

**New:** Direct SQL aggregation on `judge_scores` table:

```sql
SELECT
  js.case_id,
  a.type AS artifact_type,
  MIN(js.score) AS min_score,
  AVG(js.score) AS mean_score,
  MAX(js.score) AS max_score,
  STDDEV_POP(js.score) AS std_dev,
  COUNT(DISTINCT js.evaluation_id) AS evaluations_count
FROM judge_scores js
JOIN artifact_evaluations ae ON ae.id = js.evaluation_id
JOIN artifacts a ON a.id = ae.artifact_id
WHERE a.organization_id = $1
  AND js.created_at BETWEEN $2 AND $3
GROUP BY js.case_id, a.type
```

This eliminates the in-memory JSON deserialization bottleneck entirely.

### 7.3 New Query: Prompt Version Impact

With the schema in place, new analytics become possible:

```sql
-- Score trend for a judge across prompt versions
SELECT
  p.version,
  p.sha,
  AVG(js.score) AS mean_score,
  COUNT(*) AS sample_size
FROM judge_scores js
JOIN prompts p ON p.id = js.prompt_id
WHERE p.organization_id = $1
  AND p.name = 'clarity-judge'
  AND p.prompt_type = 'JUDGE'
GROUP BY p.version, p.sha
ORDER BY p.version
```

---

## 8. Row Count Estimates

Typical Symphony run produces:
- ~13 judges (plan judges) + ~11 judges (code judges) = ~24 CaseScores per evaluation
- ~1-3 metrics per CaseScore → ~24-72 JudgeScore rows per evaluation
- Conservative estimate: **~40 JudgeScore rows per ArtifactEvaluation**

At 1,000 evaluations: ~40,000 JudgeScore rows — trivial for PostgreSQL.
At 100,000 evaluations: ~4M rows — still well within comfortable range with proper indexes.

---

## 9. Index Strategy

| Table | Index | Purpose |
|---|---|---|
| `prompts` | `@@unique([organizationId, sha])` | Dedup on insert |
| `prompts` | `@@index([organizationId, name, promptType])` | Version number computation |
| `judge_scores` | `@@unique([evaluationId, caseId, metricName])` | Dedup + upsert key |
| `judge_scores` | `@@index([promptId])` | "All scores for prompt version X" |
| `judge_scores` | `@@index([evaluationId])` | "All scores for evaluation X" |
| `judge_scores` | `@@index([caseId, createdAt])` | "Score trend for judge X" |

---

## 10. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Backfill fails mid-way | Partial data in `judge_scores` | Idempotent backfill with `ON CONFLICT DO NOTHING`. Can re-run safely. |
| `reportData` dropped before all consumers updated | Read path breaks | Phase 3 is a separate PR. Column stays nullable until verified. |
| Prompt name → judge name matching is lossy | `promptId` NULL for some JudgeScores | Accept NULL as valid. The `normalizeJudgeName()` function already handles name variants. Matching heuristic: `normalizeJudgeName(prompt.name) === normalizeJudgeName(caseScore.case_id)`. |
| `version` race condition on concurrent inserts | Duplicate version numbers | Use `SELECT ... FOR UPDATE` or a Prisma transaction with serializable isolation when computing the next version. Alternatively, use a DB sequence per (org, name, type) — but that's complex. The unique constraint on `(organizationId, sha)` prevents true duplicates; worst case is a version gap. |
| Loop ingestion path lacks prompt data | JudgeScores from loops have NULL promptId | Acceptable for now. Prompt extraction can be added to the loop flow later. |

---

## 11. Migration File Summary

### Migration 1: `add_prompt_and_judge_score_tables`

```sql
-- CreateEnum
CREATE TYPE "PromptType" AS ENUM ('AGENT', 'JUDGE');

-- CreateTable: prompts
CREATE TABLE "prompts" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "prompt_type"     "PromptType" NOT NULL,
  "name"            TEXT NOT NULL,
  "description"     TEXT NOT NULL,
  "model"           TEXT NOT NULL,
  "tools"           TEXT[] NOT NULL,
  "file_path"       TEXT NOT NULL,
  "content"         TEXT NOT NULL,
  "sha"             TEXT NOT NULL,
  "version"         INTEGER NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable: judge_scores
CREATE TABLE "judge_scores" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "evaluation_id"  UUID NOT NULL,
  "prompt_id"      UUID,
  "case_id"        TEXT NOT NULL,
  "metric_name"    TEXT NOT NULL,
  "threshold"      DOUBLE PRECISION NOT NULL,
  "score"          DOUBLE PRECISION NOT NULL,
  "justification"  TEXT NOT NULL,
  "final_status"   INTEGER NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "judge_scores_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "prompts_organization_id_sha_key"
  ON "prompts"("organization_id", "sha");

CREATE INDEX "prompts_organization_id_name_prompt_type_idx"
  ON "prompts"("organization_id", "name", "prompt_type");

CREATE UNIQUE INDEX "judge_scores_evaluation_id_case_id_metric_name_key"
  ON "judge_scores"("evaluation_id", "case_id", "metric_name");

CREATE INDEX "judge_scores_prompt_id_idx"
  ON "judge_scores"("prompt_id");

CREATE INDEX "judge_scores_evaluation_id_idx"
  ON "judge_scores"("evaluation_id");

CREATE INDEX "judge_scores_case_id_created_at_idx"
  ON "judge_scores"("case_id", "created_at");

-- Make reportData nullable (transition period)
ALTER TABLE "artifact_evaluations"
  ALTER COLUMN "report_data" DROP NOT NULL;
```

### Migration 2 (follow-up PR): `drop_report_data_column`

```sql
ALTER TABLE "artifact_evaluations" DROP COLUMN "report_data";
```

---

## 12. Files Affected

### New files
- `packages/database/prisma/migrations/<timestamp>_add_prompt_and_judge_score_tables/migration.sql`
- `apps/api/app/webhooks/github/handlers/commands/content-handlers/prompts-snapshot-handler.ts`
- `apps/api/scripts/backfill-judge-scores.ts` (one-time migration script)

### Modified files
- `packages/database/prisma/schema.prisma` — add enum, models, relations
- `packages/api/src/types/prompt.ts` — may add DB-facing types if needed
- `apps/api/app/webhooks/github/handlers/commands/content-handlers/registry.ts` — register new handler
- `apps/api/app/webhooks/github/handlers/commands/content-handlers/judges-report-handler.ts` — fan out to JudgeScore
- `apps/api/app/webhooks/github/handlers/commands/content-handlers/code-judges-report-handler.ts` — fan out to JudgeScore
- `apps/api/app/artifacts/service.ts` — `getJudgesFeedback()` reads from JudgeScore
- `apps/api/app/judges-analytics/service.ts` — replace in-memory aggregation with DB queries
- `apps/api/lib/loop-artifact-ingestion.ts` — add JudgeScore writes
- `apps/api/__tests__/fixtures/evaluation.ts` — add JudgeScore fixtures
- Test files for all modified services

---

## 13. Implementation Order

1. **Schema migration** — add tables, make reportData nullable
2. **Prompt persistence handler** — new `promptsSnapshotHandler` + register in registry
3. **Judge score write path** — update both report handlers to fan out JudgeScores
4. **Backfill script** — decompose historical reportData into JudgeScore rows
5. **Read path updates** — update `getJudgesFeedback()` and `getAggregateStats()`
6. **Loop ingestion** — update to write JudgeScores
7. **Tests** — unit tests for all new/modified code
8. **Drop reportData** (separate PR after verification)
