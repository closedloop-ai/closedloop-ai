# @closedloop-ai/telemetry-contract

Canonical v0.12.0 telemetry attribute names, schemas, span envelopes, and consumer helpers for ClosedLoop App, Resource, Span, GenAI, Sync, Permission, and IPC perf telemetry contracts.

Import exact subpaths:

```ts
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { AppTelemetrySchema } from "@closedloop-ai/telemetry-contract/app";
import { ResourceTelemetrySchema } from "@closedloop-ai/telemetry-contract/resource";
import { SpanEnvelopeSchema, SpanTelemetrySchema } from "@closedloop-ai/telemetry-contract/span";
import { GenAiTelemetrySchema } from "@closedloop-ai/telemetry-contract/gen-ai";
import { SyncTelemetrySchema } from "@closedloop-ai/telemetry-contract/sync";
import { PermissionTelemetrySchema } from "@closedloop-ai/telemetry-contract/permission";
import { IpcTelemetrySchema } from "@closedloop-ai/telemetry-contract/ipc";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import type { SchemaShape } from "@closedloop-ai/telemetry-contract/schema-shape";
import { validate, validateSpanEnvelope } from "@closedloop-ai/telemetry-contract/validate";
import { createEmit, createSpanEmit } from "@closedloop-ai/telemetry-contract/emit";
import { appPayload, spanEnvelopePayload, spanPayload, genAiPayload, syncPayload, permissionPayload } from "@closedloop-ai/telemetry-contract/test-fixtures";
```

There is intentionally no root import. Use direct subpaths so consumers depend only on the contract group they need.

`validate(payload, schemaName)` is for dev, test, and other non-hot paths. It returns `{ ok: true, value }` when the existing strict Zod schema accepts the payload, or `{ ok: false, errors }` when validation fails. Error objects include schema name, path, attribute path, code, and message; they do not include raw received values. Unknown attributes are closed-world failures.

`emit(schemaName, { name, attributes })` is a typed channel wrapper. It enforces schema-specific exact keys at compile time, including prebuilt attribute variables with extra keys, and it does not call Zod or `validate()` at runtime. Direct `emit()` requires `configureTelemetryEmitChannel(channel)` first; production closedloop-ai callers should use the `@repo/observability/telemetry/contract` adapter, which binds the helper to the existing `log.info()` channel.

`SpanEnvelopeSchema` is the strict span envelope contract for connected traces. It carries `trace_id`, `span_id`, optional `parent_span_id`, span `name`, `kind`, `status`, top-level `duration_ms`, optional bounded `links`, `schema_name`, and the schema-selected `attributes` payload. `validateSpanEnvelope()` validates the envelope and then validates nested `attributes` through the same schema-name registry used by `validate()`. For `schema_name: "span"`, nested `attributes.duration_ms` must equal the top-level envelope `duration_ms`, so a span has one duration owner.

`emitSpan(envelope)` and `createSpanEmit(channel)` are typed span-channel wrappers. They pass the complete envelope to `channel.span(envelope)` and do not stamp flat log metadata or route through `info()`. Direct `emitSpan()` requires `configureTelemetrySpanEmitChannel(channel)` first.

```ts
type SpanAttributes = SchemaShape<typeof TelemetrySchemaName.Span>;

const emitWithChannel = createEmit({
  info(message, meta) {
    console.info(message, meta);
  },
});

const attributes: SpanAttributes = SpanTelemetrySchema.parse(spanPayload());
emitWithChannel(TelemetrySchemaName.Span, {
  name: "http.request",
  attributes,
});

const emitSpanWithChannel = createSpanEmit({
  span(envelope) {
    console.info(envelope.name, envelope.trace_id);
  },
});

const envelope = SpanEnvelopeSchema.parse(spanEnvelopePayload());
emitSpanWithChannel(envelope);
```

Generated JSON Schema files are published at:

- `@closedloop-ai/telemetry-contract/schemas/app.schema.json`
- `@closedloop-ai/telemetry-contract/schemas/resource.schema.json`
- `@closedloop-ai/telemetry-contract/schemas/span.schema.json`
- `@closedloop-ai/telemetry-contract/schemas/gen-ai.schema.json`
- `@closedloop-ai/telemetry-contract/schemas/sync.schema.json`
- `@closedloop-ai/telemetry-contract/schemas/permission.schema.json`
- `@closedloop-ai/telemetry-contract/schemas/ipc.schema.json`

`@closedloop-ai/telemetry-contract/schemas/span.schema.json` remains the flat
span attribute schema for backward compatibility. Span envelopes are currently
published through the `./span`, `./validate`, `./emit`, and `./schema-shape`
TypeScript subpaths, not as a replacement for the existing flat JSON Schema
asset.

The generated schema `$id` values are stable schema identifiers, not resolvable
download URLs. Consume schemas through the package subpaths above, the
installed `dist/schemas/*.schema.json` files, or the release assets. The App
schema currently uses `$id`
`https://closedloop.ai/schemas/telemetry-contract/app/v0.3.schema.json`; the
Sync schema uses `$id`
`https://closedloop.ai/schemas/telemetry-contract/sync/v0.6.schema.json`. The
GenAI and Resource schemas moved to `$id` `.../gen-ai/v0.4.schema.json` and
`.../resource/v0.4.schema.json` when the FEA-2037 harness/cost attributes
landed, and the new Permission schema uses `$id`
`https://closedloop.ai/schemas/telemetry-contract/permission/v0.4.schema.json`.
The flat Span schema still uses `$id`
`https://closedloop.ai/schemas/telemetry-contract/span/v0.1.schema.json`.

## Schema update workflow

Schema changes must keep the TypeScript/Zod source, tests, and JSON Schema
parity check together in the same pull request. For an App schema update,
edit this three-file pattern:

- `packages/telemetry-contract/app.ts`
- `packages/telemetry-contract/__tests__/app.test.ts`
- `packages/telemetry-contract/scripts/check-json-schemas.ts`

Use the equivalent mapped source and test files for Resource, Span, and GenAI
changes:

- `packages/telemetry-contract/src/resource.ts` with
  `packages/telemetry-contract/__tests__/resource.test.ts`
- `packages/telemetry-contract/src/span.ts` with
  `packages/telemetry-contract/__tests__/span.test.ts`
- `packages/telemetry-contract/src/gen-ai.ts` with
  `packages/telemetry-contract/__tests__/gen-ai.test.ts`
- `packages/telemetry-contract/sync.ts` with
  `packages/telemetry-contract/__tests__/sync.test.ts`
- `packages/telemetry-contract/permission.ts` with
  `packages/telemetry-contract/__tests__/permission.test.ts`
- `packages/telemetry-contract/ipc.ts` with
  `packages/telemetry-contract/__tests__/ipc.test.ts`

The
`scripts/check-json-schemas.ts` parity file is required whenever
`app.ts`, `src/resource.ts`, `src/span.ts`, or `src/gen-ai.ts` changes
because it proves the generated JSON Schema accepts and rejects the same edge
cases as the Zod schema. Sync and Permission changes follow the same rule for
`sync.ts` and `permission.ts`. That file is the Ajv runner; the **app** schema's
own case table lives beside it in `scripts/json-schema-parity-cases-app.ts`, so
an `app.ts` change adds its cases there. A bounded number needs THREE invalid
cases, not one — below the floor, above the cap, and fractional — because
`z.number().int()` and the two bounds generate three separate JSON Schema
keywords and a regenerated schema can lose any one of them independently.

If a Zod refinement is not represented correctly by the generated JSON Schema,
include `packages/telemetry-contract/scripts/generate-json-schemas.ts` as the
optional fourth file and update `addContractPatterns` so the generated schema
keeps the same bounded text, URL path, or other contract behavior as the Zod
source.

Run package validation before review:

```bash
pnpm --filter @closedloop-ai/telemetry-contract validate
```

Ask the telemetry-contract schema owner to review schema PRs by convention.
Ownership is not claimed through a repository ownership-file rule for this
package.

The committed `collector/` artifacts are byte-identity drift-guarded. `build`
(and `validate`) run `check:collector-allowlist`, `check:collector-posthog-routing`,
and `check:collector-tail-sampling`, each of which re-renders its artifact from
the contract SSOT and fails if the committed file is stale. The
`telemetry-contract-drift` job in `.github/workflows/pr-test.yml` runs those same
checks on every PR that touches this package, so a contract change that forgets to
regenerate its `collector/` companions is a red build — no separate schema-update
gate required.

When adding a `ClosedLoopCompatibilityAttribute`, update
`CompatibilityAttributeProducerMapping` in `src/attributes.ts` with non-empty
`producer`, `sourceField`, and `reason` fields. Those fields identify the current
producer, the source payload field, and why the attribute remains a ClosedLoop
compatibility field instead of an OTel-owned attribute. Completeness is enforced
by `__tests__/compatibility-mapping-completeness.test.ts`.

Version package changes on three axes:

- patch: documentation, validation scripts, schema-update workflow changes, or
  non-breaking schema refinements that do not require consumers to change
  payload shape
- minor: additive optional attributes or helper APIs that consumers may adopt
  gradually
- major: required attribute changes, removals, renames, or stricter validation
  that can reject payloads accepted by the previous published version

Worked versioning examples:

| Axis | Worked example |
| --- | --- |
| package semver | Documentation, CI gate, or package-validation workflow changes use the next patch, such as `0.2.0` to `0.2.1`. Additive optional attributes or helper APIs use the next minor. Required attributes, removals, renames, or stricter validation use the next major. |
| JSON Schema `$id` version | README-only or CI-only changes keep the current `.../v0.2.schema.json` identifiers. Payload-shape changes update the schema id deliberately, for example an additive schema contract can move to `.../v0.3.schema.json`, while a breaking schema contract moves to the next major schema id. |
| OTel semantic-conventions pin | The package currently pins `@opentelemetry/semantic-conventions` to `1.39.0`. Keep that pin for compatibility-only handoff fields; when a newer pin exports a field, update the package metadata, ownership tests, schema groups, and compatibility mapping in the same PR. |

## Collector tail-sampling fragment

The keyless-telemetry OTel Collector (PRD-481 C2 / FEA-1990, deployed from
infrastructure) controls Datadog trace-ingest cost with a `tail_sampling` processor.
That policy is a single source of truth here (FEA-1992):

- `collector-tail-sampling-policy.ts` holds the typed
  `CollectorTailSamplingPolicy` SSOT (decision window, whole-trace latency
  threshold, baseline sample rate, server-error range), published at the
  `./collector-tail-sampling-policy` subpath so consumers (the desktop IPC perf
  head-sampler, FEA-1997) reuse the baseline sampling percentage — since
  ISS-9254 that is the only knob they share, because `keep-slow` reads the
  trace's own duration rather than a per-call `duration_ms`; `scripts/generate-collector-tail-sampling.ts`
  imports that policy and renders the otelcol fragment.
- `collector/tail-sampling.yaml` is the **generated, committed** fragment the
  infrastructure collector config vendors into its **traces** pipeline
  (`processors: [resource, redaction, tail_sampling, batch]`).
- `scripts/check-collector-tail-sampling.ts` runs in `build` and fails on drift
  between the committed fragment and the policy SSOT.

`tail_sampling` is trace-only, so this governs the traces pipeline; logs and
metrics are unaffected. The policy keeps every error trace (span status `ERROR`
or HTTP 5xx) and every trace whose own duration reaches the slow latency
threshold at 100%, and samples the rest at the baseline rate (otelcol OR
semantics). Regenerate after any policy edit:

```bash
pnpm --filter @closedloop-ai/telemetry-contract generate:collector-tail-sampling
```

then commit `collector/tail-sampling.yaml` and re-vendor it into the infrastructure
collector config.

### What tail sampling does to the sync measures (ISS-7497)

Read this before building a sync dashboard or alarm. The bias is correlated with
what is being measured, not random, so a confident-looking rollup can be
directionally wrong rather than merely noisy.

A `sync.batch` span is a **child** of the desktop activity-window root, and
`tail_sampling` decides per **trace**. A failed or dead-lettered batch sets span
status `ERROR`, so its window is kept whole. A successful batch trips no keep
policy of its own — the sync group does not carry `http.response.status_code`,
the only attribute key a keep policy still reads, and ISS-9254 moved `keep-slow`
off attributes onto the trace's own duration — so it survives at the baseline
rate, plus whatever an unhealthy trace-mate happens to keep beside it, plus
whatever a long activity window keeps around it. A success is therefore retained
at no known constant rate, and **no fixed reweight recovers the true one.**

**Rates are fixed, not caveated.** `sync.batch.count` (`SyncBatchCounterName`,
exported from `./sync`) counts every settled batch by `sync.outcome` and
`sync.lane` on the **metrics** pipeline, which `tail_sampling` does not touch.
Compute success rate, failure rate, dead-letter rate and their per-lane slices
from that counter. The `sync.batch` span remains the per-batch forensic record;
never derive a rate from it.

| Measure | Trustworthy? |
| --- | --- |
| Any rate, from the `sync.batch.count` **metric** | **Yes** — metrics are not tail-sampled, so numerator and denominator come from the same complete aggregate. |
| DLQ depth (`sync.dead_lettered_count`, by lane and org) | **Yes** — attached only on the dead-letter arm, whose span is `ERROR` and retained whole. |
| Failure reason mix (`sync.reason`) | **Yes** — the contract admits it only as why a batch was a `failure` or `dead_letter`. |
| Any rate, from `sync.outcome` **spans** | **No** — a whole failure numerator over a sampled success denominator. Use the counter above. |
| Latency and payload distributions (`sync.latency_ms`, `sync.payload_bytes`) | **No** fleet-wide — not the mean, and not a percentile or trend either: a success is retained whenever anything in the same activity window errored, or whenever the window itself ran long enough to trip `keep-slow`, so inclusion is correlated with health AND with window duration and no statistic over that population is unbiased. The second correlation skews this row's own measure upward: a long window is retained *because* it is long. Sound on the failure side, and individual retained values are real. |
| Freshness lag (`sync.freshest_session_lag_ms`) | **No** for any aggregate, including a threshold alarm, a minimum, a percentile or a trend — it is emitted only on the accepted-ack success path, so it sits entirely on the sampled side, and a quiet install can pass a whole alarm window with no retained sample. |

`src/sync-sampling-bias.ts` is the per-attribute form of this table and its SSOT;
the `satisfies Record<...>` there makes a sync attribute added without a stated
retention a compile error, and `__tests__/sync-sampling-bias.test.ts` pins the
certified set and proves a success span has no deterministic keep path.
`apps/desktop/test/sync-lane-cloud-health.test.ts` holds the producer half — that
no lane's success batch carries a certified-`Complete` attribute.

**What is still biased, and why it was not moved.** Distributions
(`sync.latency_ms`, `sync.payload_bytes`) and the freshness lag stay span-side.
Fixing a distribution means choosing a histogram and its buckets, and fixing
freshness means choosing gauge-versus-histogram semantics and a fleet aggregation
— each of those decides what the measure MEANS to whoever reads it, which is a
product decision rather than wiring, and ISS-7497 escalated it instead of picking
one. The counter above needed no such choice: a count of settled batches means
exactly one thing.

## Collector allow-list (generated SSOT + drift guard)

The keyless-telemetry OTel Collector drops every attribute that is not on a
privacy allow-list. That allow-list is a build-artifact of this contract — a
projection of `TelemetryAttribute` — not hand-maintained config (FEA-2170). It
is generated into two committed artifacts:

- `collector/allowed-attributes.json` — a machine-readable manifest
  (`allowAllKeys: false` plus the sorted attribute keys).
- `collector/keyless-telemetry-redaction.yaml` — a ready-to-vendor otelcol
  `redaction` processor fragment. The infrastructure collector config vendors this
  fragment instead of hand-maintaining `allowed_keys` (cross-repo follow-up).

Both are generated from the `CollectorAllowedAttributeKeys` source of truth in
`src/attributes.ts` (which FEA-2163's strict per-attribute validation reuses).
Regenerate them whenever the attribute set changes and commit the result:

```bash
pnpm --filter @closedloop-ai/telemetry-contract generate:collector-allowlist
```

Two guards turn silent telemetry-drop into a red build:

- `check:collector-allowlist` runs inside `build`/`validate` and fails if the
  committed artifacts are stale, incomplete, or no longer deny-by-default.
- the `telemetry-contract-drift` PR job runs that same check on every PR that
  touches this package, so a new attribute can never silently bypass the allow-list.

## Collector PostHog routing (generated SSOT + drift guard)

The same Collector fans *product signals* out to PostHog alongside the Datadog
ops leg (PRD-481 C3 / FEA-1991). PostHog's OTLP ingestion is traces-only and
AI-observability-shaped, so the product signal is the GenAI span, marked by the
`gen_ai.request.model` discriminator. Which markers designate a product signal
is a build-artifact of this contract — a projection of
`CollectorProductSignalAttributeKeys` in `src/attributes.ts` — generated into
two committed artifacts:

- `collector/posthog-product-signals.json` — a machine-readable manifest
  (the sorted marker keys).
- `collector/keyless-telemetry-posthog-routing.yaml` — a ready-to-vendor otelcol
  `filter/product_signals` processor fragment that drops every span lacking all
  marker keys. The infrastructure collector config vendors it into a `traces/posthog`
  pipeline (`[resource, redaction, filter/product_signals, batch] ->
  [otlphttp/posthog]`); `redaction` stays ahead of the filter so the privacy
  allow-list applies to the PostHog leg too.
- `collector/posthog-identity-transform.json` — a machine-readable manifest
  for the collector-side PostHog person mapping from
  `app.installation.id` to `posthog.distinct_id`.
- `collector/keyless-telemetry-posthog-identity.yaml` — a ready-to-vendor
  otelcol `transform/posthog_identity` processor fragment. The infrastructure
  collector config vendors it only into the `traces/posthog` pipeline after
  `redaction` and `filter/product_signals`, so missing installation ids keep the
  current PostHog fallback and Datadog pipelines remain unchanged.

Regenerate them whenever the marker set changes and commit the result:

```bash
pnpm --filter @closedloop-ai/telemetry-contract generate:collector-posthog-routing
```

The guards mirror the allow-list: `check:collector-posthog-routing` runs inside
`build`/`validate` and fails on stale, empty, marker-missing, or identity-mapping
artifacts, and the `telemetry-contract-drift` PR job runs it on every PR that
touches this package.

## Routine and audit telemetry (PRD-648 D-17)

Routine executions and audit-trail records are published as the `routine.*` and
`audit.*` attribute group on the existing **app** schema (ISS-6313) — no new
schema and no new export path. The group is a projection of `TelemetryAttribute`
like every other, so `collector/allowed-attributes.json` and
`collector/keyless-telemetry-redaction.yaml` are regenerated from it rather than
hand-edited, and the drift guards fail the build if they are stale.

| Attribute | Shape | Carries |
| --- | --- | --- |
| `routine.id` | UUID pattern | The automation definition an execution belongs to |
| `routine.event` | closed enum | `scheduled`, `started`, `step_settled`, `settled` |
| `routine.trigger` | closed enum | `schedule`, `manual`, `webhook`, `api`, `unknown` |
| `routine.outcome` | closed enum | `success`, `failed`, `skipped`, `timeout`, `canceled`, `unknown` — the terminal members of the shipped `RoutineRunStatus` |
| `routine.failure_reason` | closed enum | Why a non-success execution ended that way |
| `routine.step_index` | bounded int | Zero-based step position, clamped to `ROUTINE_STEP_INDEX_MAX` |
| `duration_ms` | bounded int | Elapsed time — the canonical attribute, not a `routine.*` twin |
| `audit.event` | closed enum | `entry_recorded`, `entry_exported`, `export_failed` |
| `audit.actor_kind` | closed enum | `user`, `agent`, `system`, `unknown` — the tokens the audit ledger persists as `AuditActorType` |
| `audit.decision` | closed enum | `approved`, `rejected`, `auto_approved`, `escalated`, `expired`, `unknown` |

**What the group cannot carry.** Every member is a closed enum, a bounded count,
or an id constrained to a UUID shape. A routine's human-authored NAME, a prompt,
a repository path, and an operator identity have no field here — deliberately
absent rather than length-bounded, because a length cap does not make prose
non-sensitive. `audit.actor_kind` is a kind and never an identity, so the
human-in-the-loop ratio is measurable without the keyless lane learning who
acted.

**What enforces that, and what does not — the two halves cover different things
and neither covers the other.** KEYS are enforced in the collector: the
allow-list carries exactly these ten, and the deny-by-default `redaction`
processor drops every other key before any exporter sees it. VALUES are not.
`redaction` is a key allow-list (`allow_all_keys: false` plus `allowed_keys`)
with no value-shape facility, so once these ten keys are vendored the processor
forwards whatever a producer put on them — a routine NAME sent on `routine.id`
would be allow-listed straight through to the customer's backend. Value shape
lives only in the Zod/JSON-Schema pair, and that pair runs only when a producer
RUNS it: `emit()` and `createEmit()` are exact-key typed at COMPILE time and
deliberately do not call Zod at runtime (see the emit section above).

**So a producer of this group MUST call `validate(payload, "app")`
(`@closedloop-ai/telemetry-contract/validate`) and drop a rejected record rather
than emit it.** That is the step that turns the declared shapes into a boundary;
without it the shapes are a statement about what a correct producer sends, not a
guarantee about what arrives. The obligation is on the PRD-648 executor and
audit bot when they land — the same obligation every existing producer on this
contract already carries, and the reason `ROUTINE_STEP_INDEX_MAX` is documented
as a value producers clamp to rather than one the pipeline clamps for them.

### Customer-side ingestion

The differentiator over a vendor dashboard plus a CSV export is that these
attributes land in the customer's OWN observability stack with names they can
build on. To ingest them:

1. **Point the collector at your backend.** The keyless-telemetry collector
   (deployed from infrastructure) exports OTLP. Add your Datadog (or any OTLP) exporter
   to the traces/logs pipelines; `redaction` stays ahead of every exporter, so
   the allow-list applies to your leg too.
2. **Vendor the current allow-list.** Copy
   `collector/keyless-telemetry-redaction.yaml` into the collector config. Until
   that fragment is re-vendored, the deny-by-default `redaction` processor strips
   every `routine.*` and `audit.*` attribute **silently** — no error is raised on
   either side. Regenerating the artifact in this repo does not deploy it.
3. **Query by attribute, not by record shape.** `routine.id` is the slice key for
   per-routine success rate; `routine.outcome` plus `routine.failure_reason` give
   the failure mix; `routine.step_index` answers "do routines always die on the
   same step"; `audit.actor_kind` with `audit.decision` gives the human-oversight
   ratio. Facet on the attribute names exactly as spelled above — they are the
   published contract and are pinned by
   `__tests__/collector-allowlist.test.ts`.
4. **Treat an unknown enum value as a real bucket.** `unknown` is a published
   member of every non-discriminator enum in the group — `routine.trigger`,
   `routine.outcome`, `routine.failure_reason`, `audit.actor_kind`, and
   `audit.decision`. A newer producer degrades into it rather than omitting the
   attribute, so a monitor that filters `unknown` out will under-count. It is
   NOT a member of `routine.event` or `audit.event`: those are the discriminators
   that say which record you are looking at, and a record that cannot say what it
   is has nothing to contribute. The asymmetry is deliberate — for a described
   VALUE the strict schema would otherwise reject the entire record, so the
   catch-all is what keeps the record; for a discriminator there is no record
   worth keeping.

**These are projections of shipped vocabularies, not new ones.** `routine.outcome`
carries the terminal members of `RoutineRunStatus` (`@repo/api/src/types/routine`,
backed by the Prisma enum) and `audit.actor_kind` carries the tokens the audit
ledger persists as `AuditActorType` (`@repo/api/src/types/audit`) — spelled as
literals only because this is a leaf package that cannot import `@repo/api`, the
same arrangement `SyncLane` and `OnboardingConsentLevel` already have.

**This group has no producer yet.** ISS-6313 lands the contract; the PRD-648
routine executor and audit bot are what will emit it. When they do, they owe the
drift-guard test that holds those two enums equal to their canonical owners —
the arrangement `ImportGroupLabel` and `SyncLane` already have.

## Bash `perf.jsonl` validation sample

The package includes a source sample for Bash consumers that cannot import the
Zod schemas directly:

```bash
./samples/validate-perf-jsonl.sh --schema dist/schemas/gen-ai.schema.json perf.jsonl
```

The checkout sample runs directly from `samples/validate-perf-jsonl.sh`; no
package build is required for the script itself. Callers must provide stock
`jq` and either a local schema path or an HTTP(S) schema URL. URL schemas also
require `curl`.

The same sample is exported from installed packages as a file path:

```bash
SCHEMA_PATH="./node_modules/@closedloop-ai/telemetry-contract/dist/schemas/gen-ai.schema.json"
SAMPLE_PATH="./node_modules/@closedloop-ai/telemetry-contract/dist/samples/validate-perf-jsonl.sh"
"$SAMPLE_PATH" --schema "$SCHEMA_PATH" perf.jsonl
```

Schema files and the sample are also attached to telemetry-contract GitHub
releases:

```bash
SCHEMA_URL="https://github.com/closedloop-ai/closedloop-ai/releases/download/telemetry-contract-v0.2.0/gen-ai.schema.json"
./samples/validate-perf-jsonl.sh --schema "$SCHEMA_URL" < perf.jsonl
```

For the Sync contract release, use the `telemetry-contract-v0.3.0` release tag
and `sync.schema.json` asset.

The script is a sample file, not a published binary command. It accepts
`--schema <path-or-url>`, optional `--schema-name <name>`, and an optional
`perf.jsonl` file argument. If the file argument is omitted, rows are read from
stdin.

Missing required attributes fail on the first invalid row with this exact
format:

```text
perf.jsonl row N: missing required attribute 'X' (schema: Y)
```

For the current GenAI schema, omitting the model prints:

```text
perf.jsonl row 1: missing required attribute 'gen_ai.request.model' (schema: gen_ai)
```

If a future or temporary schema marks `gen_ai.usage.input_tokens` as required,
the same formatter prints that dotted path as `X`; v0.2 does not change token
requiredness.

URL schema fetching is fail-closed and bounded: only `http://` and `https://`
locations are accepted, redirects must remain HTTP(S), at most three redirects
are followed, connection and total transfer time are finite, retries are
disabled, schema bytes are capped at 1 MiB, temporary files are removed, and
setup failures use `perf.jsonl schema:` rather than a row-numbered diagnostic.

For `gen_ai` rows, the sample owns a narrow compatibility normalization for
legacy `perf.jsonl` aliases: `model`, `input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, and `cache_read_input_tokens`. Canonical dotted
attributes are authoritative. A legacy alias can populate a missing canonical
field, matching canonical plus legacy values validate after the legacy key is
dropped, conflicting values fail, and unknown attributes are rejected by the
generated schema's `additionalProperties: false` rule. These aliases are
compatibility shims and require human approval to remove.

The `jq` validator intentionally supports only the generated schema subset this
package emits: top-level object schemas, `required`, `properties`,
`additionalProperties: false`, scalar `type`, integer checks, `minimum`,
`maximum`, `minLength`, `maxLength`, and the contract patterns generated for
bounded text and URL paths. Unsupported schema shapes fail before row
validation.

The package pins `@opentelemetry/semantic-conventions` to `1.39.0`. Attributes classified as OTel-owned must be exported by that pinned package's stable or incubating entrypoints. ClosedLoop compatibility attributes preserve current or planned producer handoff fields that are not exported by the pinned package:

- `duration_ms` maps from current `apps/api/lib/route-utils.ts` request logs.
- `app.operating_mode` maps from future Desktop `operatingMode` lifecycle metadata.
- `app.lifecycle.event` maps from future Desktop `lifecycleEvent` lifecycle metadata.
- `app.exception.origin` maps from Desktop exception capture (`pre_init`, `main`, or `renderer`).
- `app.organization.id` maps from the Desktop authenticated organization id (multiplayer attribution, FEA-1996); set only when an API key is present, so single-player telemetry never carries it.
- `app.client.version` maps from the Desktop build version the caller attests in the `x-desktop-client-version` request header (ISS-8749), recorded on the `cl-api` request span. NOT `service.version`, which on that span is the resource attribute naming the API's own build. Caller-attested telemetry only: nothing authenticates, authorizes, scopes a tenant, or routes on it, and an older Desktop that sends no header is attributed by omission.
- GenAI cache-token attributes are compatibility fields until the pinned OTel JS package exports them.
- `sync.event`, `sync.outcome`, `sync.payload_bytes`, `sync.latency_ms`, and
  `sync.reason` map from Desktop sync instrumentation in
  `apps/desktop/src/main/agent-sync/agent-session-sync-service.ts`; they are
  transport-health-only fields and must not carry session content. `sync.reason`
  (FEA-3426) is a closed enum naming why a `failure`/`dead_letter` batch failed
  (`ack_timeout`, `rate_limited`, `ingestion_failed`, `validation_failed`,
  `feature_disabled`, `locally_oversized`, `transport_error`, `unhydratable`).
- `sync.freshest_session_lag_ms` (ISS-7496) is the desktop→cloud pipeline
  freshness measure: whole milliseconds between the newest `updatedAt` among the
  sessions the server CONFIRMED and the moment that confirmation was processed.
  It is emitted only on a confirmed delivery — never on a failure, a non-final
  chunk, or a batch whose delivered rows carried no readable timestamp — so an
  absent value means unknown, never fresh. **Before you build an alarm on it:**
  the collector tail-samples non-`ERROR` traces at
  `CollectorTailSamplingPolicy.baselineSamplingPercentage`, so these spans are a
  sample of the successful population while failures are retained whole. A
  minimum over a sample overstates the true minimum lag, and a low-traffic
  install can pass an alarm window with no retained sample while syncing
  normally. **No aggregate over this signal is sound** — not a threshold alarm,
  not a minimum, not a percentile, not a trend — because a success is retained
  whenever anything in the same activity window errored, so inclusion is
  correlated with health and no statistic over that population is unbiased. One
  retained value is still a lag that genuinely occurred; it is the population,
  not the observation, that is not real. ISS-7497 moved
  the sync RATES onto the unsampled `sync.batch.count` metric but left this
  signal span-side: making it sound means choosing gauge-versus-histogram
  semantics and a fleet aggregation, which decides what the measure MEANS, so it
  was escalated rather than picked. See “What tail sampling does to the sync
  measures” above, and `src/sync-sampling-bias.ts`.
- `gen_ai.cost.usage` (per-call USD cost), `gen_ai.permission.decision`, and
  `gen_ai.permission.source` map from harness cost/permission events ingested
  by the desktop in-process OTLP receiver (PRD-468 FEA-1843).
- `harness.name` is the runtime-tool discriminator emitted by every harness
  (`claude`/`codex`/`cursor`/`copilot`/`opencode`). It is distinct from the
  CLOTS `agent.name` logical-actor attribute and is not owned by the pinned
  OTel package.
- `ipc.operation`, `ipc.payload_bytes`, `ipc.result_count`, and
  `ipc.session_count` map from the Desktop Agent Dashboard IPC perf wide events
  in `apps/desktop/src/main/dashboard/agent-dashboard-ipc-perf.ts`
  (FEA-1997); the `ipc` schema reuses `duration_ms` and the optional OTel
  `error.type`. `ipc.session_count` is the total local-store session count —
  the fleet dimension that exposes the many-sessions perf cliff.

The FEA-1980 App contract subpaths ship in `0.2.0`; the FEA-1981 Sync contract subpaths ship in `0.3.0`; the FEA-2037 Permission contract subpaths plus the `gen_ai.cost.usage` and `harness.name` attributes ship in `0.4.0` (release tag `telemetry-contract-v0.4.0`); the FEA-1986 `app.exception.origin` contract ships in `0.5.0` (release tag `telemetry-contract-v0.5.0`); the FEA-2170 collector allow-list codegen and drift guard land in `0.6.0` (release tag `telemetry-contract-v0.6.0`); the FEA-1991 collector PostHog-routing codegen and drift guard land in `0.7.0` (release tag `telemetry-contract-v0.7.0`); the FEA-1996 multiplayer `app.organization.id` attribute ships in `0.8.0` (release tag `telemetry-contract-v0.8.0`); the FEA-1997 `ipc` IPC perf wide-event subpaths plus the published `collector-tail-sampling-policy` SSOT ship in `0.9.0` (release tag `telemetry-contract-v0.9.0`). FEA-1996 and FEA-1997 both originally declared `0.8.0`; FEA-1996 merged first and published `0.8.0`, so the `ipc` subpaths and the `collector-tail-sampling-policy` SSOT — present on `main` but absent from the published `0.8.0` artifact — are republished as the additive-minor `0.9.0` (FEA-2198). The FEA-2184 collector-side PostHog identity transform artifacts ship in `0.9.1` (release tag `telemetry-contract-v0.9.1`). The FEA-3074 span envelope and span-aware emit helpers ship in `0.10.0` (release tag `telemetry-contract-v0.10.0`) while preserving the flat public `span.schema.json` asset. The FEA-3426 `sync.reason` transport-health attribute (the closed failure/dead-letter reason enum) ships as the additive-minor `0.11.0` (release tag `telemetry-contract-v0.11.0`). The FEA-3792 `transport_unavailable` `sync.reason` value (split out of the overloaded `rate_limited` so the SLO can separate a local relay flap from a server throttle) widens the closed reason enum and ships as the additive-minor `0.12.0` (release tag `telemetry-contract-v0.12.0`), moving the sync JSON Schema `$id` to `.../sync/v0.5.schema.json`. The ISS-5088 `transport_timeout` `sync.reason` value (a client-side request abort where the server never answered, split out of `ack_timeout` so the SLO can separate a lane-wide local/network stall from a server-answered 408) widens the closed reason enum the same way and ships as the additive-minor `0.13.0` (release tag `telemetry-contract-v0.13.0`), moving the sync JSON Schema `$id` to `.../sync/v0.6.schema.json`. The ISS-5103 desktop import-health counters (the `ImportGroupLabel` and `ImportHealthEvent` closed value sets plus five optional `import.*` App attributes) and the ISS-5988 `ack_clear_failed` and `ack_omitted` `sync.reason` values ship together as the additive-minor `0.14.0` (release tag `telemetry-contract-v0.14.0`); both widen closed enums with optional, additive surface only, so the App and Sync schema `$id`s deliberately stay at `.../app/v0.3.schema.json` and `.../sync/v0.6.schema.json`. The ISS-6335 `import.outcome` App attribute (the closed `ImportOutcome` set — `imported`, `empty`, `wedged`, `error` — carried on every desktop import-health `pass` record so a healthy install with nothing to import stays distinguishable from an install whose imports never land and from a process that stopped reporting) ships as the additive-minor `0.15.0` (release tag `telemetry-contract-v0.15.0`); it is one optional, additive attribute, so the App schema `$id` deliberately stays at `.../app/v0.3.schema.json`. The ISS-6340 desktop onboarding lifecycle attributes (the closed `OnboardingStep`, `OnboardingEvent`, and `OnboardingConsentLevel` value sets plus three optional `onboarding.*` App attributes, carried over the unauthenticated keyless relay because onboarding is substantially pre-auth) ship as the additive-minor `0.17.0` (release tag `telemetry-contract-v0.17.0`); all three are optional and additive, so the App schema `$id` deliberately stays at `.../app/v0.3.schema.json`. The ISS-6332 `TelemetryServiceName` constant (the contract-owned desktop `service.name` value, moving the runtime from the hardcoded `closedloop-desktop` literal to the PRD-159 Stage 7 `cl-desktop` service tag, with a drift test pinning runtime to contract) ships as the additive-minor `0.18.0` (release tag `telemetry-contract-v0.18.0`); it exports one zero-dependency literal and adds no attribute, so every schema `$id` is unchanged. The ISS-7265 tiling-strip sync contract (one optional additive `sync.tiling_stripped_count` attribute, plus the `tiling_stripped` member widening the closed `sync.payload_shaping` enum so a payload that shipped without its activity tiling stops reporting itself as `whole`) ships as the additive-minor `0.19.0` (release tag `telemetry-contract-v0.19.0`); it is an optional attribute plus a widened closed enum with no required-field or stricter-validation change, so the Sync schema `$id` deliberately stays at `.../sync/v0.6.schema.json`, matching the `0.14.0` precedent above rather than the `0.12.0`/`0.13.0` ones that moved it. The ISS-7217/ISS-7221/ISS-7224 `cl-api` request-span attribution attributes — `app.error.source` (the closed layer-of-report enum for a 5xx), `artifact.type`, and `artifact.status` — plus the addition of the already-published `app.organization.id` to the span schema, ship as the additive-minor `0.20.0` (release tag `telemetry-contract-v0.20.0`). All four are optional span attributes, so the span schema `$id` deliberately stays at `.../span/v0.1.schema.json`; the same change narrows the span `error.type` refinement from free bounded text to an identifier shape so the keyless lane cannot carry an error message, which is a tightening of a previously-unpopulated optional attribute and not a change to any shipped producer. The ISS-7249 desktop dead-end treatment attributes (the closed `DeadEndTreatment`, `DeadEndPhase`, `DeadEndState`, `DeadEndReason`, and `DeadEndRetryOutcome` value sets plus six optional `dead_end.*` App attributes and the existing `http.response.status_code` widened onto the App group, so a rendered “we could not show you what you asked for” treatment is counted as the tracked error it is) ship as the additive-minor `0.21.0` (release tag `telemetry-contract-v0.21.0`); every one is optional and additive, so the App schema `$id` deliberately stays at `.../app/v0.3.schema.json`. ISS-7249 has now lost this race three times: it originally declared `0.18.0` and ISS-7247 merged first and took it, so it republished as `0.19.0`; ISS-7265 then merged first and took that, so it republished as `0.20.0`; and the ISS-7217/ISS-7221/ISS-7224 span-attribution contract above then merged first and took `0.20.0` too. Every one is the collision the paragraph below warns a clean auto-merge cannot catch — `package.json` merged without a conflict all three times, because both sides wrote the same literal and meant different releases, and only the prose said so. The ISS-6313 routine and audit telemetry group (PRD-648 D-17) — the closed `RoutineEvent`, `RoutineTrigger`, `RoutineOutcome`, `RoutineFailureReason`, `AuditEvent`, `AuditActorKind`, and `AuditDecision` value sets plus nine optional `routine.*`/`audit.*` App attributes and the existing `duration_ms` widened onto the App group, so a routine execution and its audit trail stream into the customer's own OTLP backend with attributes they own rather than only into a vendor dashboard and a CSV export — ships as the additive-minor `0.22.0` (release tag `telemetry-contract-v0.22.0`); every one is optional and additive, so the App schema `$id` deliberately stays at `.../app/v0.3.schema.json`. The group is contract-only: no producer emits it yet, and the regenerated `collector/*` allow-list is INERT in production until it is re-vendored into the infrastructure collector config, because the deny-by-default `redaction` processor strips unknown keys silently. The ISS-7220 sync org-attribution contract (the already-published `app.organization.id` and `app.operating_mode` added to the Sync schema, so a `sync.batch` child span carries the tenant it belongs to instead of leaving that fact only on the desktop activity root span, where a child cannot be grouped by it) ships as the additive-minor `0.23.0` (release tag `telemetry-contract-v0.23.0`); both are optional attributes already in `TelemetryAttribute` and already on the collector allow-list, with no new attribute value, no required-field change and no stricter validation, so the Sync schema `$id` deliberately stays at `.../sync/v0.6.schema.json` and the generated `collector/*` artifacts are unchanged. The org is present only once the install is authenticated AND its background `GET /me` has resolved, so an ABSENT `app.organization.id` does not mean "no tenant": `app.operating_mode` is what separates a multiplayer batch awaiting attribution from a genuinely single-player one, and a DLQ-by-org rollup that ignores it will merge the two. It follows the `0.20.0` precedent above, which added the same already-published `app.organization.id` to the span schema. ISS-7220 declared `0.23.0` while the ISS-6313 routine-and-audit group (PR #5549) was still in flight holding `0.22.0`; that group has since merged and published `0.22.0` — documented above — so `0.23.0` is the confirmed next additive-minor rather than a skipped number. The ISS-7496 `sync.freshest_session_lag_ms` attribute (one optional additive Sync attribute: whole milliseconds between the newest `updatedAt` among the sessions the server CONFIRMED and the moment that confirmation was processed, so "what is the freshest session we have?" is answerable at all) ships as the additive-minor `0.24.0` (release tag `telemetry-contract-v0.24.0`); it is one optional attribute with no required-field or stricter-validation change, so the Sync schema `$id` deliberately stays at `.../sync/v0.6.schema.json`, matching the `0.19.0` precedent. Its regenerated `collector/*` allow-list entry is likewise INERT in production until re-vendored into infrastructure. ISS-7496 declared `0.23.0` while the ISS-7220 sync org-attribution contract (PR #5562) was still in flight holding the same number; ISS-7220 merged first and published `0.23.0` — documented above — so ISS-7496 republishes as `0.24.0`. That is the same collision this paragraph records against ISS-7249 three times over: `package.json` merged with no conflict because both sides wrote `0.23.0` and meant different releases, and only this prose said so. The ISS-6334 desktop auth/pairing failure attributes (the closed `AuthOutcome` and `AuthReason` value sets plus the optional `auth.outcome` and `auth.reason` App attributes, carried on the unauthenticated keyless relay pipe so an install that can never pair is still visible) ship as the additive-minor `0.25.0` (release tag `telemetry-contract-v0.25.0`); optional, additive surface only, so the App schema `$id` deliberately stays at `.../app/v0.3.schema.json`. It has been overtaken repeatedly without ever merging — it claimed `0.16.0`, then `0.19.0`, then `0.21.0`, then `0.22.0`, while `0.17.0` (ISS-6340), `0.18.0` (ISS-6332), `0.19.0` (ISS-7265), `0.20.0` (ISS-7217/7221/7224), `0.21.0` (ISS-7249), `0.22.0` (ISS-6313), `0.23.0` (ISS-7220) and `0.24.0` (ISS-7496) each published ahead of it — so `0.25.0` is the first free additive minor. `0.16.0` is deliberately skipped rather than taken: the in-flight ISS-6334 auth-failure contract held it when ISS-6340 shipped, and a version bump is the one edit where a clean auto-merge proves nothing — both sides writing the same string is agreement on the literal and a collision in meaning. Since ISS-6334 now ships `0.25.0`, `0.16.0` is never published. The ISS-6336 collector ingest-failure signals ship as the additive-minor `0.26.0` (release tag `telemetry-contract-v0.26.0`) in two shapes, because the underlying facts are two shapes. Occurrences get the closed `ImportIngestFailure` reason set, the `ingest_failed` `ImportHealthEvent` discriminator, and the `import.ingest_failure` / `import.ingest_failed_count` pair — one record per reason per tally window. Quarantine gets a GAUGE instead, `import.sources_quarantined_parse` and `import.sources_quarantined_import`, carried on EVERY `pass` record including at zero: a source stays quarantined until its transcript changes, so an occurrence count of the passes that skip it is a sawtooth whose height tracks tick cadence and from which the level cannot be recovered, and a gauge that appeared only when non-zero would reintroduce the exact silence-vs-zero ambiguity ISS-6335 removed from this record. The desktop collectors previously emitted no telemetry at all, so a parse that threw, a quarantined source, and a session the parser could only read partially were indistinguishable from an install with no sessions. Every added attribute is optional and additive, so the App schema `$id` deliberately stays at `.../app/v0.3.schema.json`. ISS-6336 has been overtaken six times without merging: it declared `0.18.0`, then `0.19.0`, then `0.20.0`, while `0.18.0` (ISS-6332), `0.19.0` (ISS-7265), `0.20.0` (ISS-7217/7221/7224), `0.21.0` (ISS-7249), `0.22.0` (ISS-6313), `0.23.0` (ISS-7220), `0.24.0` (ISS-7496) and `0.25.0` (ISS-6334) each published ahead of it — so `0.26.0` is the first free additive minor. Its regenerated `collector/*` allow-list entries are likewise INERT in production until re-vendored into infrastructure. The ISS-6116 backfill-side import-health surface — the `sources_remaining` and `harness_not_advancing` `ImportHealthEvent` values, the optional `import.sources_remaining` App attribute, and `harness.name` widened from the Resource schema to the App schema so those two records can name the harness they describe — ships as the additive-minor `0.27.0` (release tag `telemetry-contract-v0.27.0`); every part is optional and additive (the `harness.name` value set is the Resource schema's existing closed set, now a shared `TelemetryHarnessName` const exported from the existing `./resource` subpath instead of two inline copies), so the App schema `$id` deliberately stays at `.../app/v0.3.schema.json` and no new subpath is published. ISS-6116 first declared `0.21.0`, which ISS-7249 merged first and took; `0.22.0` (ISS-6313), `0.23.0` (ISS-7220), `0.24.0` (ISS-7496) and `0.25.0` (ISS-6334) then each published ahead of it as well. `0.26.0` is skipped rather than taken because the ISS-6336 entry immediately above published it first, so `0.27.0` is the first free additive minor. That is once more the collision this paragraph keeps recording — `package.json` merges with no conflict when both sides write the same literal and mean different releases, and only this prose says so. The ISS-7497 sync rate contract — the `sync.batch.count` counter name, its strict two-attribute `SyncBatchCounterSchema`, and the `SyncOutcome` closed value set that both the span shape and the counter shape now read instead of two inline copies — ships as the additive-minor `0.28.0` (release tag `telemetry-contract-v0.28.0`). It adds no ATTRIBUTE: the counter carries `sync.outcome` and `sync.lane`, both already in `TelemetryAttribute` and already on the collector allow-list, so the generated `collector/*` artifacts are unchanged and the Sync schema `$id` deliberately stays at `.../sync/v0.6.schema.json`. It publishes no new subpath either — everything lands on the existing `./sync` entry, so the release-asset set is untouched. The counter exists because `tail_sampling` is trace-only: the `sync.batch` span is a child of the desktop activity-window root and its trace is retained whole on an ERROR status, so failures arrive complete while successes fall to the baseline, and a rate read off spans divides a whole numerator by a sampled denominator. A metric has no sampling decision in front of it, which is what makes the rate correct rather than merely askable. Distributions and the freshness lag were deliberately NOT moved with it — those need a histogram-bucket or gauge-versus-histogram choice that decides what the measure means — and that is escalated on ISS-7497 rather than picked here. `0.28.0` follows `0.27.0` (ISS-6116) on `main`; per the collision warning in this paragraph, confirm this number is still free after any rebase, because `package.json` merges cleanly when two branches write the same version string and mean different releases. The ISS-5822 worker-clamp observability signal ships as the additive-minor `0.29.0` (release tag `telemetry-contract-v0.29.0`). It adds no ATTRIBUTE: the count of sessions the historical-parse worker reduced to fit its response budget rides the existing `import.ingest_failure` / `import.ingest_failed_count` pair as one new VALUE, `session_payload_clamped`, widening the closed `ImportIngestFailure` set. That choice is the point rather than an economy — a new attribute NAME would be stripped by the collector's deny-by-default `redaction` processor until the regenerated allow-list is re-vendored into infrastructure (ISS-6974), so the signal would reach the relay and silently never reach Datadog, while a new value on an already-allow-listed attribute passes through untouched. Because no `TelemetryAttribute` changed, the generated `collector/*` artifacts are unchanged and the App schema `$id` deliberately stays at `.../app/v0.3.schema.json`. `0.29.0` follows `0.28.0` (ISS-7497) on `main`; per the collision warning above, confirm this number is still free after any rebase. The ISS-8748 authenticated-user span attribution ships as the additive-minor `0.30.0` (release tag `telemetry-contract-v0.30.0`): one optional span attribute, the pinned OTel-owned `user.id`, carrying the internal database user UUID a `cl-api` request authenticated as, so "which customers did this failure reach" is answerable at the same post-authentication boundary that already answers "which tenant". It is constrained to a UUID rather than bounded text, which is the privacy control rather than a validation nicety — an email, a display name, or a Clerk id is structurally unrepresentable, and the attribute is deliberately NOT added to the App group, so no desktop producer can begin emitting an identity nobody reviewed. Optional and additive with no required-field or stricter-validation change, so the span schema `$id` deliberately stays at `.../span/v0.1.schema.json`, matching the `0.20.0` precedent. Its regenerated `collector/*` allow-list entry is parked in `pendingVendoringKeys`, and that parking gates the KEYLESS OTLP lane ONLY: the deny-by-default `redaction` processor strips `user.id` from a relay event until the fragment is re-vendored into infrastructure. It does NOT gate the `cl-api` producer this issue adds, so do not read the parked entry as "inert in production". `logRequestCompleted` merges the schema-validated attributes onto the single structured `request_completed` log line, and every deployed log call reaches Datadog through the Vercel Log Drain (`source:vercel`) and the agentless HTTP intake in `log.ts` (`source:nodejs`) — neither of which passes the collector — so `user.id` is queryable in Datadog for `cl-api` from the moment this merges. That is safe because the privacy control travels with the PRODUCER rather than the collector: `buildRequestCompletedContractAttributes` projects the attribution through a per-attribute `SpanTelemetrySchema` parse before it returns anything, so the UUID constraint is enforced on the log lane exactly as it is on the OTLP one — a non-UUID identity is dropped by itself, never reaches the line, and does not take the tenant or the request fields down with it. `0.30.0` follows `0.29.0` (ISS-5822) on `main`; per the collision warning above, confirm this number is still free after any rebase. ISS-8948 originally declared `0.30.0` for the changes that had accumulated on `main` after `0.29.0` without a bump — ISS-8758's `pr_link_teardown_watermark` member widening the closed `ImportGroupLabel` set (its three retired labels stay in the set because an older desktop build still emits them), ISS-7291's `update.failure_reason` description naming all four `update.event` values that carry it, ISS-8074's exported `MAX_SPAN_LINKS`, ISS-7290's `toEqual` exactness pin over all 88 published `TelemetryAttribute` literals plus the `DeprecatedCodeTelemetryAttributes` map (test-only, and tests are not packed, so no published surface changed), and ISS-8015's collector-vendoring drift guard (`check:collector-vendoring` plus `collector/vendoring-state.json`, build-time only) — because the publish preflight had refused every push touching the package since 2026-08-27 and consumers stayed on the `0.29.0` artifact for a week. ISS-8748 merged first and published `0.30.0`, and the publisher packs the whole package directory from `main`, so that artifact already carries all five; what ISS-8948 still owed was this record of them, which ships as the documentation-only additive-minor `0.31.0` (release tag `telemetry-contract-v0.31.0`). No `TelemetryAttribute` was added, so the generated `collector/*` artifacts are unchanged and every schema `$id` stays where `0.29.0` left it; the widened `ImportGroupLabel` is optional additive surface, matching the `0.14.0` precedent above. `0.31.0` follows `0.30.0` (ISS-8748) on `main`; per the collision warning above, confirm this number is still free after any rebase. The ISS-8749 Desktop client attribution ships as the additive-minor `0.32.0` (release tag `telemetry-contract-v0.32.0`): the new `app.client.version` attribute, plus the already-published `app.installation.id` added to the span schema, so a `cl-api` request span names the install and the build that made the call and joins to the desktop records from the same install. `app.client.version` is a ClosedLoop compatibility attribute and is deliberately NOT `service.version`: on an API span that key is the resource attribute naming the API's OWN build, and one attribute cannot mean both the emitting service and the calling client without making every existing `service.version` query on cl-api ambiguous. Both values are CALLER-ATTESTED — read off request headers a Desktop build writes for itself — so nothing in the platform authenticates, authorizes, scopes a tenant, or routes on them; the API validates each header independently and drops what does not conform, and a Desktop build predating the change sends neither and is attributed by omission. `app.installation.id` keeps the bound the App schema already gives it rather than a stricter span-only shape, because one attribute accepting two different sets across two schemas is a contract that cannot be stated. Both are optional additive span attributes with no required-field change, so the span schema `$id` deliberately stays at `.../span/v0.1.schema.json`, matching the `0.20.0` and `0.30.0` precedents. `app.client.version` is parked in `pendingVendoringKeys`, and — exactly as for `user.id` above — that parking gates the KEYLESS OTLP lane only, not the `cl-api` producer: `buildRequestCompletedContractAttributes` projects both attested values through the same per-attribute `SpanTelemetrySchema` parse before they reach the `request_completed` log line, so they are queryable in Datadog for `cl-api` from the moment this merges and a non-conforming value is dropped by itself. ISS-8749 originally declared `0.31.0`, but ISS-8948 merged first and published `0.31.0` for its documentation-only record, so the `app.client.version` attribute republishes as the additive-minor `0.32.0` — the same collision the FEA-1996/FEA-1997 and ISS-8948 records above describe. `0.32.0` follows `0.31.0` (ISS-8948) on `main`; per the collision warning above, confirm this number is still free after any rebase. The ISS-8907 Agent Monitor boot-failure classification ships as the additive-minor `0.33.0` (release tag `telemetry-contract-v0.33.0`): the new optional `app.boot_failure.kind` App attribute and the closed `AppBootFailureKind` value set (`migration_refusal`, `module_resolution`, `unknown`) it is constrained to. It restores the distinction ISS-4714 removed with the message and the stack — a fleet-wide packaging break and a one-off local store fault had been arriving as the identical `app_exception` record, which is what ISS-8906 cost — and it is derived from the error's Node `code`, never its message, so no value of it can carry a path, a specifier, or a checksum. It publishes a NEW subpath, `./app-boot-failure-kind`, which is the one part of this release that changes the release-asset set: the value set is a leaf module rather than a member of `app.ts` for the same reason `AppExceptionOrigin` is one — the desktop producer that classifies a boot failure is imported by the db-host `utilityProcess` bundle, and a value import of `app.ts` from there would drag the whole zod-backed `AppTelemetrySchema` graph in for one frozen const object. Optional and additive with no required-field or stricter-validation change, so the App schema `$id` deliberately stays at `.../app/v0.3.schema.json`, matching the `0.14.0` precedent. `app.boot_failure.kind` is parked in `pendingVendoringKeys` and that parking DOES gate this producer, unlike the `user.id` and `app.client.version` cases above: the desktop emits it over the keyless OTLP lane only, so the deny-by-default `redaction` processor strips it until `collector/keyless-telemetry-redaction.yaml` is re-vendored into infrastructure — which is why the same classification also splits the non-refusal `exception.message`, an already-vendored key, so the distinction is readable on the day this ships. (That parking was closed by ISS-9253 on 2026-09-08; the `exception.message` split remains the half every build already in the field sends.) `0.33.0` follows `0.32.0` (ISS-8749) on `main`; per the collision warning above, confirm this number is still free after any rebase. ISS-9082 Agent Monitor capture-liveness attribute ships as the additive-minor `0.34.0` (release tag `telemetry-contract-v0.34.0`): one optional App attribute, `app.agent_monitor.runtime_status`, carrying the closed three-member `AgentMonitorRuntimeStatusKind` set (`ready`/`starting`/`failed`) on the desktop `app.lifecycle` heartbeat. It exists because every other desktop capture signal is a work OUTCOME — sync spans, `sync.batch.count`, the `import.*` counters — and absence of captured work is indistinguishable from absence of work to capture: an install that ran no agent sessions emits exactly what an install whose capture never came up emits, which is how ISS-8906 ran a full day dark while the existing heartbeat reported 559 healthy records on the affected release. This is the one attribute the subsystem reports about ITSELF, so an idle install and a dead one stop looking alike. The set is declared here rather than imported from `apps/desktop` because a published contract cannot depend on an app; the desktop producer's input field is typed with THIS union, so a desktop-side member the contract has not learned fails `tsc` at the emit site instead of failing `.strict()` in production, where it would drop the whole heartbeat and re-drop it every interval. Optional and additive with no required-field or stricter-validation change, so the App schema `$id` deliberately stays at `.../app/v0.3.schema.json`, matching the `0.14.0` and `0.15.0` precedents above. Its regenerated `collector/*` allow-list entry is parked in `pendingVendoringKeys`, and unlike the `user.id` and `app.client.version` parkings above that parking gates the ONLY lane this attribute has: the sole producer is the desktop keyless OTLP heartbeat, so the deny-by-default `redaction` processor strips it until the fragment is re-vendored into infrastructure. The vendoring hop is tracked as ISS-9129, and until it lands this attribute is INERT in production. (ISS-9253 landed that hop on 2026-09-08; the attribute reaches Datadog once the collector is rolled — see ISS-9677.) `0.34.0` follows `0.33.0` (ISS-8907) on `main`; per the collision warning above, confirm this number is still free after any rebase. The ISS-9197 `store_open_timeout` `app.boot_failure.kind` value ships as the additive-minor `0.35.0` (release tag `telemetry-contract-v0.35.0`). It adds no ATTRIBUTE: it widens the closed `AppBootFailureKind` set from three members to four, so the desktop boot path can report the one Agent Monitor open failure that CLEARS — a store-open deadline, a function of store size, migration count and machine load rather than of the store's contents — apart from the deterministic ones (`migration_refusal`, `module_resolution`) it is retried differently from. The value is a fixed literal chosen by a boolean predicate over a token the deadline timer itself mints, so like its three siblings it cannot carry a path, a specifier or a checksum into the record. Because no `TelemetryAttribute` changed, the generated `collector/*` artifacts are unchanged, the vendoring ledger is unchanged, and the App schema `$id` deliberately stays at `.../app/v0.3.schema.json` — the `0.29.0` value-only-widening precedent. Note the consequence of the parking recorded for `0.33.0`: `app.boot_failure.kind` is itself still in `pendingVendoringKeys`, so this member is INERT in production until that hop lands, and the distinction it draws is carried on the day it ships by the already-vendored `exception.message`, which the desktop producer splits per kind. (ISS-9253 landed that hop on 2026-09-08.) `0.35.0` follows `0.34.0` (ISS-9082) on `main`; per the collision warning above, confirm this number is still free after any rebase. The ISS-9254 tail-sampling recalibration ships as `0.36.0` (release tag `telemetry-contract-v0.36.0`) and is the first release on this list DECLARED non-additive — `0.26.0` also dropped a published export, `CompatibilityAttributeProducerMapping`, when ISS-6336 moved it out of `src/attributes.ts` into the unpublished `src/attribute-producer-mapping.ts`, and the entry above still records that one as additive — the undeclared precedent for this one; it had no consumer outside this package, which is presumably why nobody noticed. This one does: the `./collector-tail-sampling-policy` subpath drops `slowLatencyThresholdMs`, `slowLatencyAttributeKey` and `slowLatencyMaxMs` and gains `slowTraceLatencyThresholdMs`, because `keep-slow` stopped being a `numeric_attribute` policy over `duration_ms` and became a whole-trace `latency` policy. It stays a MINOR deliberately, and that was a ruling rather than an oversight: `0.26.0` is the one precedent this list has for a removal and it shipped as a minor, and cutting a first major after 35 deliberate minors would signal a stability commitment this package has not made and this change is not asking for. The removal is safe to ship that way because the surface has no serialized form. It is compile-time only: no wire payload, database column, or cross-process contract carries these fields, so an already-installed Desktop build is unaffected — it bundles its own copy. Every consumer is in this repo and is updated in the same commit; `pnpm turbo typecheck --filter=...@closedloop-ai/telemetry-contract` (the package plus all 40 dependents) is green. A stale external TypeScript consumer fails to compile with the removed field named, which is the loud outcome; a JavaScript one reads `undefined`, which is the quiet one and is exactly why this release is declared here instead of shipped as just another minor. Compatibility shims were considered and rejected on the merits: `slowLatencyAttributeKey` and `slowLatencyMaxMs` describe a policy the collector no longer runs, so re-exporting them would leave the SSOT asserting a mechanism that does not exist, and `slowLatencyThresholdMs` is now a desktop knob rather than a collector one, so re-exporting it would rebuild the false "these cannot drift" coupling ISS-9254 removed. Production had been running `latency` all along at a threshold chosen for a 10-second decision window, while this repo carried a `duration_ms` policy that measurement found on 57 of 33,551 desktop spans and on none of the 32,207 `sync.batch` spans — so neither shipped value was right, and the recalibrated threshold (240,000ms, retaining 32.5% of cl-desktop traces over the 7 days to 2026-09-08, against 99.9% at the deployed 2,000ms) is the third option. It is bounded above by `decision_wait`: the collector votes after 310s and can never observe a wider span of timestamps, so `assertValidPolicy` now rejects a threshold at or above the window rather than letting `keep-slow` sit configured and silent. The desktop IPC perf head-sampler keeps its own 2,000ms slow threshold, which no longer mirrors any collector policy and now lives in `apps/desktop`; it still reads `baselineSamplingPercentage` from this package. No `TelemetryAttribute` changed and no schema `$id` moved; `collector/tail-sampling.yaml` is regenerated and needs re-vendoring into infrastructure, which the ISS-9254 infrastructure PR carries. The ISS-7227 sync join key on the API request span ships as the additive-minor `0.37.0` (release tag `telemetry-contract-v0.37.0`). It adds no ATTRIBUTE: the already-published `sync.batch_id` is added to the span schema and to the `ApiSpanTelemetryAttributes` group, so a `cl-api` request span carries the client-generated batch id the desktop sync lane already stamps on its own half of the same attempt — the one value both halves can name, which is what turns a failed sync from two unrelated log lines into one query. It follows the `0.20.0`, `0.30.0`, `0.32.0` precedents above, which added the already-published `app.organization.id`, `user.id`, and `app.installation.id` to the same span schema. The span constrains it with the same `TELEMETRY_UUID_PATTERN` the Sync schema already applies rather than a span-local re-spelling, because one attribute accepting two different sets across two schemas is a contract that cannot be stated; that shared pattern is also what stops a session id, a path, or transcript text riding the join key. Because no `TelemetryAttribute` was added, the generated `collector/*` artifacts are unchanged, the vendoring ledger is unchanged, and the span schema `$id` deliberately stays at `.../span/v0.1.schema.json`. The same release closes the guard hole that hid the drift: the existing semconv guards only required an attribute to sit in at least one group, and this key was already grouped under `SyncTelemetryAttributes`, so the published inventory answered "a request span cannot carry this" for a key the API emitter stamps; the added parity assertion pins the five per-schema groups to equal the span schema's key set exactly. `0.37.0` follows `0.36.0` (ISS-9254) on `main`; per the collision warning above, confirm this number is still free after any rebase. ISS-9259 `app.boot_failure.outcome` attribute ships as the additive-minor `0.38.0` (release tag `telemetry-contract-v0.38.0`). It is the second axis on the app-exception boot record: `app.boot_failure.kind` names WHY the Agent Monitor boot failed and this one says WHETHER it cleared, because `0.35.0`'s retry ladder reports a recovery under the same `store_open_timeout` kind on purpose — the monitor that counts the kind is the one that has to see the recovery — so a healthy install and a dead one arrived with one value, and Datadog monitor 319264706 (installs per release, critical at two) counted the healthy one. Two members and no `unknown`: the producer knows which happened at every emit site, so absence means only "a producer that predates this", which is why the field is optional and never defaulted — a consumer that read absence as `failed` would recreate the defect for every installed build. The App schema `$id` stays at `.../app/v0.3.schema.json` (additive-optional field, the `0.33.0`/`0.34.0` precedent). Its regenerated `collector/*` allow-list entry is parked in `pendingVendoringKeys`: the infrastructure vendoring hop and the monitor exclusion are one PR against `example-org/infrastructure`, unapplied at merge and tracked for apply on ISS-9677, so until that apply the attribute is INERT in production. `0.38.0` follows `0.37.0` (ISS-7227) on `main`; per the collision warning above, confirm this number is still free after any rebase. The ISS-9725 `branches_list_unavailable` and `branches_list_empty` `dead_end.treatment` values ship as the additive-minor `0.39.0` (release tag `telemetry-contract-v0.39.0`). They add no ATTRIBUTE: the already-published closed `DeadEndTreatment` set widens from seven members to nine, so the Branches list can name its own unavailable and empty treatments rather than borrowing a Sessions one — the collapse this attribute exists to prevent, reproduced across surfaces instead of across states. Both values are developer-authored identifiers for a rendered state, chosen by a predicate over a read's own outcome, so like their seven siblings neither can carry a branch name, a repo path, a session id, or an error message into the record. Because no `TelemetryAttribute` changed, the generated `collector/*` artifacts are unchanged, the vendoring ledger is unchanged, and the App schema `$id` deliberately stays at `.../app/v0.3.schema.json` — the `0.35.0` value-only-widening precedent. The widening is additive on the accepting side only: the App payload schema is `.strict()` with a closed `z.enum(DeadEndTreatment)`, so a consumer still pinned to `0.38.0` rejects a record carrying either value outright, which is why the republish rather than the source change is what makes these treatments visible. `0.39.0` follows `0.38.0` (ISS-9259) on `main`; per the collision warning above, confirm this number is still free after any rebase. The ISS-8600 `watch_lost`, `materialize_failed`, and `materialize_timed_out` `import.event` values (the three harness-scoped OCCURRENCE records: a collector's live watch lost after its bounded re-attach loop gave up, and an OpenCode materialize pass that failed or outran its timeout) widen the closed `ImportHealthEvent` enum and ship as the additive-minor `0.40.0` (release tag `telemetry-contract-v0.40.0`). They carry only `import.event` and `harness.name`, both already published, so no `TelemetryAttribute` changed: the generated `collector/*` artifacts are unchanged, the vendoring ledger is unchanged, and the App schema `$id` deliberately stays at `.../app/v0.3.schema.json` — the `0.35.0` value-only-widening precedent. The widening is additive on the accepting side only: the App payload schema is `.strict()` with a closed `z.enum(ImportHealthEvent)`, so a consumer still pinned to `0.39.0` rejects a record carrying any of the three outright, which is why the republish rather than the source change is what makes these records visible. `0.40.0` follows `0.39.0` (ISS-9725) on `main`; per the collision warning above, confirm this number is still free after any rebase. The ISS-11347 `gen_ai.operation.name` attribute (closed to `chat`, the one value PostHog's OTLP ingestion turns into `$ai_generation`) is an additive optional GenAI attribute and ships as the additive-minor `0.41.0` (release tag `telemetry-contract-v0.41.0`). It is OTel-owned (`@opentelemetry/semantic-conventions/incubating` exports it at the pinned `1.39.0`), it is in the regenerated `collector/*` allow-list, and it is parked in `pendingVendoringKeys` until infrastructure vendors it; the GenAI schema `$id` stays at `.../gen-ai/v0.4.schema.json`, following the additive-optional precedent above. `0.41.0` follows `0.40.0` (ISS-8600) on `main`; confirm this number is still free after any rebase. The ISS-11345 `identity_read_failed` `auth.reason` value (a browser sign-in whose redeem succeeded but whose account could not be read back, previously reported as `unknown`) widens the closed reason enum and ships as the additive-minor `0.42.0` (release tag `telemetry-contract-v0.42.0`). `0.42.0` follows `0.41.0` (ISS-11347) on `main`; confirm this number is still free after any rebase. The ISS-12039 `dead_end.rate` log record (`DeadEndRateRecordName` / `DeadEndRateRecordSchema` in `ipc`) gives the desktop dead-end rate an unsampled numerator and denominator written by the same builds, and the closed `ipc.operation` set gains `page_data` for the Sessions page read; it adds exports to an existing subpath, one value to an existing closed set and no attribute key, and ships as the additive-minor `0.43.0` (release tag `telemetry-contract-v0.43.0`). `0.43.0` follows `0.42.0` (ISS-11345) on `main`; confirm this number is still free after any rebase. The ISS-12036 optional `import.parse_degraded_site` attribute (`ImportParseDegradedSite` in `app`, the fold site a degraded or unreadable session lost its lines at) and the ISS-11394 `AuthOutcome` and `auth.reason` widening (below) both merged to `main` after `telemetry-contract-v0.43.0` was cut from ISS-12039's commit without bumping the version, so they ship together as the additive-minor `0.44.0` (release tag `telemetry-contract-v0.44.0`, ISS-12098). `import.parse_degraded_site` is in the regenerated `collector/*` allow-list and is parked in `pendingVendoringKeys` until infrastructure vendors it. `0.44.0` follows `0.43.0` (ISS-12039) on `main`; confirm this number is still free after any rebase. The ISS-11866 (R4) optional `app.telemetry_export.dropped_*_count` attributes (five: `oversize`, `no_session`, `rate_limited`, `collector_unavailable`, `invalid`) carry the desktop keyless relay transport's per-cause drop counters, cumulative since the process started, on the lifecycle heartbeat; they ship as the additive-minor `0.45.0` (release tag `telemetry-contract-v0.45.0`). They are in the regenerated `collector/*` allow-list and declared vendored, because infrastructure allow-lists them in the same coordinated change and merges first; the App schema `$id` is unchanged. `0.45.0` follows `0.44.0` (ISS-12098) on `main`; confirm this number is still free after any rebase. The ISS-11866 (R4) optional `app.telemetry_export.sent_count` attribute (the same transport's relay-accepted export counter, cumulative per process, on the same heartbeat; Perrin Upcott, 2026-10-07: "export sent too") ships as the additive-minor `0.46.0` (release tag `telemetry-contract-v0.46.0`). It is in the regenerated `collector/*` allow-list and declared vendored, because infrastructure allow-lists it in the same coordinated change and merges first; the App schema `$id` is unchanged. `0.46.0` follows `0.45.0` (ISS-11866) on `main`; confirm this number is still free after any rebase. ISS-12212 republishes that contract unchanged as the patch `0.46.1` (release tag `telemetry-contract-v0.46.1`): only the `build` script changed, running both halves through the repo-root `scripts/run-untraced.mjs` so a CI lane's dd-trace preload stays out of the build. `0.46.1` follows `0.46.0` on `main`; confirm this number is still free after any rebase. The ISS-12421 onboarding analytics discard attributes (`onboarding_analytics.action`, `.reason`, `.original_event`, `.step`, `.flow_id`) and their enums ship as the additive minor `0.47.0` (release tag `telemetry-contract-v0.47.0`), following `0.46.1` on `main`; confirm this number is still free after any rebase. The generated `collector/*` artifacts are committed in-repo for cross-repo vendoring and are intentionally not packed into the published tarball (`files: ["dist"]`), so they do not change the published package surface. Publication is handled only by the existing main-branch GitHub Packages workflow after merge; consumers should pin the published package version after that workflow completes.

ISS-9586's optional `ipc.query_source`, `ipc.query_execution`, `ipc.query_refusal`, `ipc.matched_count`, and `ipc.scanned_count` query attributes ship together as the additive-minor `0.48.0` (release tag `telemetry-contract-v0.48.0`), following the published `0.47.0` on `main`. They preserve the existing `ipc.${operation}` span name and historical `error.type`, add only schema-validated optional fields, and do not change required fields or schema IDs. `ipc.query_source`, `ipc.query_execution`, `ipc.matched_count`, and `ipc.scanned_count` are vendored in infrastructure #608, but the manual collector-host stage/prod apply remains pending; `ipc.query_refusal` remains parked. The muted `page_data` monitor remains unarmed and ISS-12692 owns arming it.

Only compiled JavaScript, declarations, generated schema assets, and the copied
dist sample ship. Source files, scripts, tests, sourcemaps, declaration maps,
source-map footer comments, and embedded source payloads are forbidden from the
packed package.

ISS-11394 widens the closed `AuthOutcome` set with `sign_up_exchange_failed`, `sign_in_redirect_failed`, and `sign_up_redirect_failed` in the additive-minor `0.44.0` release (tag `telemetry-contract-v0.44.0`). Older Desktop builds continue emitting `sign_in_exchange_failed` for both arms, so absence of the sign-up value does not imply no sign-ups failed. Redirect failures cover a run that could not start, a browser that could not open, a callback timeout, or an unusable callback, each with its own `auth.reason` (`sign_in_start_failed`, `browser_open_failed`, `redirect_timeout`, `callback_invalid`, added to the closed `AuthReason` set in the same release), without reporting user cancellation or superseded runs. No attribute keys or schema IDs change.
