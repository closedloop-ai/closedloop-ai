# Runtime V2 (Loops) — Deploy Plan

> **Branch:** `runtimev2` (symphony-alpha) + `runtimev2` (cl-tofu-aws-live)
> **Target:** Stage first, then Prod
> **Date:** February 17, 2026

---

## Dependency Graph

```
                    ┌─────────────┐
                    │  KMS Key    │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
      ┌──────────────┐  ┌──────────┐  ┌─────────────────┐
      │ Loop State   │  │   ECS    │  │  RDS Postgres   │
      │ S3 Bucket    │  │ Compute  │  │  (IAM updates)  │
      └──────┬───────┘  └────┬─────┘  └────────┬────────┘
             │               │                  │
             └───────┬───────┘                  │
                     │        ┌─────────────────┘
                     ▼        ▼
              ┌──────────────────────┐
              │   Vercel API Env     │
              │  (consumes outputs)  │
              └──────────┬───────────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
         ┌────────┐ ┌────────┐ ┌────────┐
         │ DB     │ │ ECR    │ │ Vercel │
         │Migrate │ │ Image  │ │ Deploy │
         └────────┘ └────────┘ └────────┘
```

---

## Order of Operations

### Phase 0: Pre-Flight (Both Environments)

| # | Task | How to verify | Risk |
|---|------|---------------|------|
| 0.1 | **Merge IaC PR** — open PR from `runtimev2` → `main` in `cl-tofu-aws-live`, review, merge | PR merged, CI green | Low — IaC is declarative, merge doesn't apply anything |
| 0.2 | **Add new secrets to Secrets Manager** in both accounts | `aws secretsmanager get-secret-value --secret-id vercel/env-secrets` includes the new keys | Medium — secrets must exist before Terragrunt reads them |
| 0.3 | **App code PR ready** — open PR from `runtimev2` → `main` in `symphony-alpha`, mark as draft | PR exists, reviewed, lint/typecheck/tests green | Low |

**Secrets to add** to `vercel/env-secrets` in Secrets Manager (both stage + prod):

| Key | How to generate | Notes |
|-----|-----------------|-------|
| `CLOSEDLOOP_RUNNER_JWT_SECRET` | `openssl rand -base64 48` | Different value per environment |
| `CRON_SECRET` | `openssl rand -base64 32` | Used by Vercel cron to authenticate `/cron/*` routes |

---

### Phase 1: Stage — Infrastructure (cl-tofu-aws-live)

Run from the **stage account** (`661041595751`). Apply in dependency order:

| # | Step | Command | Depends on | Estimated time |
|---|------|---------|------------|----------------|
| 1.1 | **Apply KMS Key** | `cd stage/kms-key && terragrunt apply` | Nothing (new resource) | ~1 min |
| 1.2 | **Apply Loop State Bucket** | `cd stage/loop-state-bucket && terragrunt apply` | 1.1 (KMS key ARN) | ~1 min |
| 1.3 | **Apply ECS Compute** | `cd stage/ecs-compute && terragrunt apply` | 1.1 (KMS key ARN), VPC (exists) | ~3-5 min (ASG + capacity provider) |
| 1.4 | **Apply RDS Postgres** (update) | `cd stage/rds-postgres && terragrunt apply` | 1.2, 1.3 (needs ECS + bucket ARNs) | ~2-3 min (IAM policy updates only) |
| 1.5 | **Apply Vercel API env vars** | `cd stage/vercel/api && terragrunt apply` | 1.2, 1.3, 1.4 (consumes all outputs) | ~1 min |

**Verify after Phase 1:**
- [ ] `aws ecs describe-clusters --clusters cl-ai-stage-compute` → ACTIVE, 1 registered instance
- [ ] `aws s3 ls s3://cl-ai-stage-loop-state` → bucket exists, empty
- [ ] `aws ecr describe-repositories --repository-names cl-ai-claude-runner` → repository exists
- [ ] Vercel dashboard → stage API project shows ECS_CLUSTER_NAME, LOOP_STATE_BUCKET etc.

---

### Phase 2: Stage — Container Image

| # | Step | How | Depends on | Estimated time |
|---|------|-----|------------|----------------|
| 2.1 | **Build + push claude-runner image** | Trigger `build-container.yml` workflow via `workflow_dispatch` from `runtimev2` branch (or merge to main first for auto-trigger on `containers/claude-runner/**`) | 1.3 (ECR repo exists) | ~5 min |
| 2.2 | **Verify image in ECR** | `aws ecr describe-images --repository-name cl-ai-claude-runner --query 'imageDetails[*].imageTags'` | 2.1 | Immediate |

**Important:** The build workflow pushes to **both** stage and prod ECR. If you want to test in stage before pushing to prod, temporarily remove the prod matrix entry from the workflow, or just accept that the image landing in prod ECR is harmless until prod ECS references it.

---

### Phase 3: Stage — Application Code

| # | Step | How | Depends on | Estimated time |
|---|------|-----|------------|----------------|
| 3.1 | **Merge app PR to main** | Merge `runtimev2` → `main` in symphony-alpha | Phase 0.3 (PR reviewed) | Immediate |
| 3.2 | **Run database migrations** | `cd packages/database && pnpm prisma migrate deploy` against **stage** DB | 3.1 (code merged) | ~30 sec |
| 3.3 | **Deploy API to stage** | Push to Vercel (auto-deploy from main, or manual deploy) | 3.1, 3.2 (migrations applied) | ~3 min |
| 3.4 | **Deploy frontend to stage** | Same Vercel pipeline | 3.1 | ~3 min |

**Verify after Phase 3:**
- [ ] `GET /api/loops` returns `200` with empty array (authenticated)
- [ ] `GET /cron/timeout-loops` returns `200` (with valid CRON_SECRET header)
- [ ] Loops page renders in the app (even if no loops exist yet)
- [ ] Settings > API Key page renders, can set/validate a key

---

### Phase 4: Stage — End-to-End Verification

| # | Test | Expected outcome | Severity if fails |
|---|------|-----------------|-------------------|
| 4.1 | **Set an Anthropic API key** via Settings | Key stored encrypted, last-four shown | Blocker |
| 4.2 | **Create a Loop** (Plan command on a repo) | Loop transitions: PENDING → CLAIMED → RUNNING | Blocker |
| 4.3 | **SSE stream connects** | Events appear in real-time in the UI | Blocker |
| 4.4 | **Loop completes** | Status → COMPLETED, metadata (tokens, files) populated | Blocker |
| 4.5 | **Loop creates a PR** (if applicable) | prUrl, prNumber, branchName saved on loop record | High |
| 4.6 | **Resume a loop** | New loop created with parentLoopId, downloads parent state | High |
| 4.7 | **Cancel a loop** | ECS task stopped, status → CANCELLED | High |
| 4.8 | **Timeout cron** | Stale RUNNING loop → TIMED_OUT after 55 min (or simulate) | Medium |
| 4.9 | **Usage endpoint** | `GET /api/loops/usage` returns token/cost aggregates | Medium |
| 4.10 | **Audit log** | Loop events visible on detail page | Medium |
| 4.11 | **Negative: cross-org isolation** | Loop not visible to different org | Blocker |
| 4.12 | **Negative: invalid API key rejected** | Validation returns clear error | High |

**If any blocker fails:** Stop. Fix in stage before proceeding to prod.

---

### Phase 5: Prod — Infrastructure (cl-tofu-aws-live)

Identical to Phase 1 but in the **prod account** (`959853091217`):

| # | Step | Command | Notes |
|---|------|---------|-------|
| 5.1 | **Apply KMS Key** | `cd prod/kms-key && terragrunt apply` | |
| 5.2 | **Apply Loop State Bucket** | `cd prod/loop-state-bucket && terragrunt apply` | 730-day retention |
| 5.3 | **Apply ECS Compute** | `cd prod/ecs-compute && terragrunt apply` | min=2, desired=5, max=20 |
| 5.4 | **Apply RDS Postgres** (update) | `cd prod/rds-postgres && terragrunt apply` | Has deletion_protection=true |
| 5.5 | **Apply Vercel API env vars** | `cd prod/vercel/api && terragrunt apply` | |

**Verify after Phase 5:**
- [ ] `aws ecs describe-clusters --clusters cl-ai-prod-compute` → ACTIVE, 2+ registered instances
- [ ] `aws s3 ls s3://cl-ai-prod-loop-state` → bucket exists
- [ ] Vercel dashboard → prod API project shows all ECS/S3 env vars

---

### Phase 6: Prod — Application Deploy

| # | Step | How | Notes |
|---|------|-----|-------|
| 6.1 | **Run database migrations** | `pnpm prisma migrate deploy` against **prod** DB | Same 6 migrations as stage |
| 6.2 | **Deploy API to prod** | Push to `production` branch or Vercel manual deploy | API goes live with Loop routes |
| 6.3 | **Deploy frontend to prod** | Same pipeline | Loops UI visible to users |

---

### Phase 7: Prod — Smoke Test

| # | Test | Expected |
|---|------|----------|
| 7.1 | Set API key via Settings | Encrypted, stored, last-four displayed |
| 7.2 | Create a Loop (Plan) | PENDING → RUNNING → COMPLETED |
| 7.3 | SSE stream delivers events | Real-time output in UI |
| 7.4 | Verify CloudWatch logs | `/ecs/cl-ai-prod-compute` has claude-runner logs |
| 7.5 | Verify S3 state stored | `aws s3 ls s3://cl-ai-prod-loop-state/{orgId}/` has context-pack + metadata |

---

## Rollback Plan

| Scenario | Action |
|----------|--------|
| **Stage infra fails** | `terragrunt destroy` on the failing component (KMS, S3, ECS are independent) |
| **Stage app fails** | Revert the merge commit on main, redeploy |
| **Prod infra fails** | Don't proceed to app deploy; fix infra first |
| **Prod app deploy breaks existing features** | Revert merge, redeploy from previous commit. Loop tables exist but are unused |
| **Prod loops broken but rest of app works** | Leave deployed — Loop routes are additive (new endpoints, new UI pages). Existing features unaffected. Fix forward. |
| **ECS tasks stuck running** | `aws ecs stop-task` + timeout cron handles cleanup within 5 min |

**Key safety property:** The Loop feature is entirely additive. No existing routes, tables, or UI paths were modified. The worst case for a broken Loops deploy is that Loops don't work — everything else continues unaffected.

---

## Secrets Checklist

| Secret | Stage SM | Prod SM | Vercel Stage | Vercel Prod |
|--------|----------|---------|--------------|-------------|
| `CLOSEDLOOP_RUNNER_JWT_SECRET` | [ ] | [ ] | [ ] (via TG) | [ ] (via TG) |
| `CRON_SECRET` | [ ] | [ ] | [ ] (via TG) | [ ] (via TG) |

> "via TG" = Terragrunt reads from Secrets Manager and sets on Vercel project

---

## Timing Estimate

| Phase | Duration | Can parallelize? |
|-------|----------|-----------------|
| Phase 0 (Pre-flight) | 30 min | Secrets + PR prep in parallel |
| Phase 1 (Stage infra) | 10-15 min | Steps 1.1-1.3 sequentially, then 1.4-1.5 |
| Phase 2 (Container image) | 5-8 min | After 1.3 |
| Phase 3 (Stage app) | 5-10 min | After Phase 2 |
| Phase 4 (Stage E2E) | 30-60 min | Sequential testing |
| Phase 5 (Prod infra) | 10-15 min | After Phase 4 passes |
| Phase 6 (Prod app) | 5-10 min | After Phase 5 |
| Phase 7 (Prod smoke) | 15-20 min | Sequential |
| **Total** | **~2-3 hours** | Assumes no blockers found in Stage |

---

## Post-Deploy Monitoring (First 24 Hours)

- [ ] CloudWatch: ECS task failures / OOM kills
- [ ] CloudWatch: `/ecs/cl-ai-prod-compute` log group for errors
- [ ] Vercel: API function errors/timeouts on `/api/loops/*` routes
- [ ] Database: connection pool usage (Vercel IAM auth + Prisma)
- [ ] S3: `cl-ai-prod-loop-state` bucket size growth
- [ ] Cron: `/cron/timeout-loops` running every 5 min (Vercel cron logs)
- [ ] Cost: ECS instance hours, S3 storage, KMS API calls
