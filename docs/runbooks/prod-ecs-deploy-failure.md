# Runbook: Prod ECS Deploy Failure (MCP or Relay)

**When this fires:** a production release has advanced the `production` branch and Vercel prod (app/api/web) is live, but the prod ECS deploy for `mcp-server` or `relay-host` did not reach `success`. The deploy check turns red via `Enforce ECS Outcomes`; Vercel is NOT rolled back (PRD-188 FR-5).

Owner: Platform / SRE on-call.

## 1. Expect exactly one terminal Slack message

Per the single-terminal-Slack-message invariant, every deploy produces exactly one terminal Slack post in the release thread.

- **ECS partial failure** — from the `Enforce ECS Outcomes` step in `deploy-production.yml`. Uses the canonical shape below. Includes Vercel live-app URLs plus per-service ECS lines with run URLs.
- **Other failures** (merge / health check / deploy_pr / poll API error) — from `Post Failure Report`. Now includes MCP/relay lines appended below the diagnosis report.

### Canonical ECS partial-failure message shape

This is the single source of truth for the message rendered by `Assemble ECS Failure Message` (T-3.4b). `deploy-production.yml` reproduces this shape inline; any change to the shape must update both sides.

```
❌ *Deploy failed* — prod ECS partial failure

*PR:* $PR_URL
*Run:* $RUN_URL

*Live apps (Vercel):*
  ▲ *app:* https://app.closedloop.ai
  ▲ *web:* https://marketing.closedloop.ai
  ▲ *api:* https://api.closedloop.ai/health

*ECS services (prod):*
  <emoji> *mcp-server (prod):* <conclusion> — <mcp_run_url>
  <emoji> *relay-host (prod):* <conclusion> — <relay_run_url>

*Note:* Vercel prod is live and has not been rolled back (PRD-188 FR-5). Investigate the failing ECS run(s) via the links above.
```

Emoji map: `success=✅`, `failure=❌`, `timed_out=⚠️`, `cancelled=⊘`, `not_triggered=⊘`, other=`❓`.

## 2. Release artifact status

- **`release-metadata.json`** — **IS uploaded** as a workflow artifact even on ECS partial failure. Contains `components.mcpServer.{imageDigest, commitRef, ecsConclusion}` and `components.relay.{imageDigest, commitRef, ecsConclusion}`. Download from the failing run's Artifacts section for audit/rollback digests.
- **GitHub Release object** — **NOT created** on ECS partial failure. A release marks a fully clean cut; an ECS partial failure is not that. Either cut the release manually after remediation (`gh release create`) using the persisted artifact, or let the next clean deploy supersede.

## 3. Diagnostic steps

1. **Open the failing GH Actions run** from the Slack run-URL link.
2. **Check the `Register task definition pinned to SHA` step** output for the new task definition ARN — confirm the image ends in `:<the_prod_commit_sha>` (not any legacy mutable tag).
3. **Check the `Deploy new task definition` step** — this is the step that does `aws ecs update-service --task-definition <ARN>` and then `aws ecs wait services-stable`. Common causes:
   - Tasks failing to start (pull errors, missing env vars, bad task-def JSON, unhealthy health check).
   - `services-stable` timeout (ECS rolled back to previous task def).
4. **Check CloudWatch logs** for the ECS service (`cl-ai-prod-mcp-server` or `cl-ai-prod-relay-host`). Stream: `/ecs/<service-name>` in account `959853091217`.
5. **Verify image exists in ECR**: `aws ecr describe-images --repository-name cl-ai-mcp-server --image-ids imageTag=<commit_sha>` (or `cl-ai-relay-host`). Both workflows push only `:<github.sha>` — no `:latest`.

## 4. Remediation

Do not auto-rollback Vercel; MCP/relay are rolled forward or an out-of-band fix is cut (PRD-188 FR-5).

Pick one of:

### 4a. Redeploy the same SHA (most common)

If the failure was infrastructure-flavoured (task placement / pull / healthcheck timing) and the image itself is good:

```bash
# Locate the current task-def the service is pinned to — register-task-definition
# may have already produced the right revision; this just re-rolls it.
gh workflow run build-mcp-server.yml -f environment=prod
# or for relay:
gh workflow run build-relay.yml -f environment=prod
```

The `workflow_dispatch` path triggers the same SHA-pinned register-and-update flow against prod, independent of the `production` branch.

### 4b. Deploy a known-good prior SHA

If the current image is genuinely broken and you need to roll backward:

```bash
# From a local checkout of the last known-good commit:
git checkout <good_sha>
gh workflow run build-mcp-server.yml -f environment=prod
# Verify in ECR, then wait for services-stable via gh run watch.
```

Because every build registers a new task-definition revision pinned to `:<github.sha>`, rolling backward is a deterministic re-run of a prior build — there is no need to manipulate `:latest` (and there is no `:latest` to manipulate; these workflows do not publish it).

### 4c. Cut the GitHub release manually (optional)

If audit trail requires a `gh release` object for this deploy (rather than waiting for the next clean deploy to supersede):

```bash
gh run download <failing_run_id> --name release-metadata
RELEASE_TAG="deploy-$(date -u +%Y%m%d-%H%M%S)"
gh release create "$RELEASE_TAG" \
  --title "Production Deploy $RELEASE_TAG (ECS partial)" \
  --notes "Prod ECS partial failure; see run <failing_run_url>. Remediated via <remediation_run_url>." \
  release-metadata.json
```

## 5. What NOT to do

- **Do not `--force-new-deployment`** on the prod ECS service. These workflows no longer use that path — they register SHA-pinned task definitions. `--force-new-deployment` would roll over to whatever task-def the service is currently pinned to, which is the broken one.
- **Do not push `:latest`** manually. These workflows deliberately publish only `:<github.sha>` to prevent stage-to-prod contamination via a mutable floating tag. Don't reintroduce `:latest`.
- **Do not roll back Vercel** unless the failure is user-visible on the app/api surface. The whole point of `Enforce ECS Outcomes` is that Vercel stays up; only the GitHub check turns red.

## 6. Escalation

If neither 4a nor 4b resolves within 30 minutes, page the platform on-call rotation. Include the Slack thread link, the failing run URL, and the release-metadata artifact (digests + ecsConclusion).

## 7. Related references

- PRD-188 "Gate prod MCP and prod relay deploys on the Vercel production app/api deploy"
- PLN-311 T-3.1 / T-3.4b / T-3.4c (polling, assemble, enforce steps)
- PLN-311 T-1.7 (image-tag isolation + SHA-pinned task-def registration)
- PLN-311 Phase 6 (conformance fixes from PR #893 review)
- `.github/workflows/deploy-production.yml` — `Poll ECS Workflow Runs`, `Assemble ECS Failure Message`, `Enforce ECS Outcomes`
