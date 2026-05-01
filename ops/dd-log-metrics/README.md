# Datadog log-metric generator artifacts (transitional)

This directory is an **audit trail of one-off Datadog API operations** we ran in late April 2026 to recover the `ca8-rmh-yhn` dashboard after the Vercel→Datadog log-drain integration broke (orphaned OAuth on the **Vercel** side — the original Vercel admin who installed the integration is no longer on the team, leaving the install in a state neither Vercel nor Datadog UI can fully manage). **The open support ticket is with Vercel, not Datadog** — Datadog correctly stopped receiving logs once Vercel stopped sending them. This directory is **not** the long-term home for Datadog configuration.

## Long-term plan: PRD-159

The canonical home for ClosedLoop Datadog state — dashboards, log-to-metric pipelines, custom log pipelines, monitors — is the [`cl-tofu-aws-live`](https://github.com/closedloop-ai/cl-tofu-aws-live) repository, managed via OpenTofu / Terragrunt under:

- `prod/datadog/dashboards/` — `datadog_dashboard` HCL
- `prod/datadog/pipelines/` — `datadog_logs_metric` + `datadog_logs_custom_pipeline` HCL
- `prod/datadog/monitors/` — `datadog_monitor` HCL

See **PRD-159** ("Observability: Datadog dashboards, pipelines, and monitors as OpenTofu") for the migration plan, which also covers the `cl-` service-tag rollout that this directory hardens against (Stage 7).

**When PRD-159 lands, this entire directory should be deleted.** The HCL resources in `cl-tofu-aws-live` will be the source of truth; these JSON files will have no remaining purpose.

## File inventory

Each file has a `_meta` block at the top describing its purpose. Summary:

| File | Type | Purpose |
|---|---|---|
| `baseline.json` | Snapshot | All 13 ClosedLoop log-based metric generators (`api.*` + `relay.*`) as fetched from the DD API, pinned at the point this PR shipped. Acts as the "starting state" for the PRD-159 OpenTofu import. |
| `patches-applied.json` | Operation log | 7 PATCH bodies sent to `/api/v2/logs/config/metrics/{id}` to recover relay/webhook generators (filter `service:api-prod` → `service:api`, group_by paths flat camelCase). |
| `rewrites.json` | Operation log | 2 PATCH bodies for `api.requests.count` + `api.errors.count`, switching their filter to `service:api "request_completed"` so they consume the new `apps/api`-emitted log line instead of Vercel platform logs. |
| `creates.json` | Operation log | 1 POST body to create `api.requests.latency.app` — a new generator that aggregates `@duration_ms` distribution. Replaces `api.requests.latency` (the original) which was locked to `@lambda.billed_duration` from the now-broken Vercel log drain. |

## Service-tag convention (12-factor)

The DD generators here filter on `service:api` because that is what the deployed `apps/api` env produces today (`DD_SERVICE=api` in Vercel). Per PLN-357 / PLN-383 / PLN-384 and PRD-159, the service tag is configuration that lives in the env, not in the generator filter. Graceful-degradation fallback when `DD_SERVICE` is unset is `cl-unknown` (PLN-384).

The PRD-159 Stage 7 rename (`api` → `cl-api`, `relay` → `cl-relay`, etc.) will be a coordinated atomic change: the env var flip and the HCL filter update in `cl-tofu-aws-live` ship together. Do NOT pre-widen these generators to `service:(api OR cl-api)` — that couples generator logic to multiple identities and undermines the 12-factor principle the surrounding work is establishing.

## How to consume these files

Each operation file has shape `{ _meta: {...}, operations: [{id, body}, ...] }`. To replay any of them:

```bash
# 1. Set DD_API_KEY (from AWS Secrets Manager: vercel/env-secrets) and DD_APP_KEY
#    (your DD application key with logs_write_config scope) in env or a temp file.
# 2. Iterate and PATCH (or POST for creates.json):
jq -c '.operations[]' ops/dd-log-metrics/<file>.json | while read row; do
  ID=$(echo "$row" | jq -r '.id')
  BODY=$(echo "$row" | jq -c '.body')
  curl -sS -X PATCH \
    -H "DD-API-KEY: $DD_API_KEY" \
    -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
    -H "Content-Type: application/json" \
    "https://api.datadoghq.com/api/v2/logs/config/metrics/$ID" \
    -d "$BODY"
done
```

## Why these aren't in `cl-tofu-aws-live` yet

1. The TF repo does not yet have the `prod/datadog/pipelines/` structure — that lands as part of PRD-159 implementation.
2. Three of the four operation-log files describe transient operations (PATCH/POST bodies sent during a specific incident); they are not declarative state.
3. Co-locating with the source code of the application that emits the logs being parsed (`apps/api`) keeps the recovery PR atomic and the audit trail close to the code change that depends on it.

When PRD-159 lands, replace this directory with HCL imports — do not migrate these files.
