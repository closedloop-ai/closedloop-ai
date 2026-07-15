# @closedloop-ai/telemetry-contract

Canonical v0.10.0 telemetry attribute names, schemas, span envelopes, and consumer helpers for ClosedLoop App, Resource, Span, GenAI, Sync, Permission, and IPC perf telemetry contracts.

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

`emit(schemaName, { name, attributes })` is a typed channel wrapper. It enforces schema-specific exact keys at compile time, including prebuilt attribute variables with extra keys, and it does not call Zod or `validate()` at runtime. Direct `emit()` requires `configureTelemetryEmitChannel(channel)` first; production symphony-alpha callers should use the `@repo/observability/telemetry/contract` adapter, which binds the helper to the existing `log.info()` channel.

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
`https://closedloop.ai/schemas/telemetry-contract/sync/v0.3.schema.json`. The
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
`sync.ts` and `permission.ts`.

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
cl-tofu) controls Datadog trace-ingest cost with a `tail_sampling` processor.
That policy is a single source of truth here (FEA-1992):

- `collector-tail-sampling-policy.ts` holds the typed
  `CollectorTailSamplingPolicy` SSOT (decision window, latency threshold,
  baseline sample rate, server-error range), published at the
  `./collector-tail-sampling-policy` subpath so consumers (the desktop IPC perf
  head-sampler, FEA-1997) reuse the same thresholds; `scripts/generate-collector-tail-sampling.ts`
  imports that policy and renders the otelcol fragment.
- `collector/tail-sampling.yaml` is the **generated, committed** fragment the
  cl-tofu collector config vendors into its **traces** pipeline
  (`processors: [resource, redaction, tail_sampling, batch]`).
- `scripts/check-collector-tail-sampling.ts` runs in `build` and fails on drift
  between the committed fragment and the policy SSOT.

`tail_sampling` is trace-only, so this governs the traces pipeline; logs and
metrics are unaffected. The policy keeps every error trace (span status `ERROR`
or HTTP 5xx) and every slow/p99-latency trace at 100% and samples the rest at
the baseline rate (otelcol OR semantics). Regenerate after any policy edit:

```bash
pnpm --filter @closedloop-ai/telemetry-contract generate:collector-tail-sampling
```

then commit `collector/tail-sampling.yaml` and re-vendor it into the cl-tofu
collector config.

## Collector allow-list (generated SSOT + drift guard)

The keyless-telemetry OTel Collector drops every attribute that is not on a
privacy allow-list. That allow-list is a build-artifact of this contract — a
projection of `TelemetryAttribute` — not hand-maintained config (FEA-2170). It
is generated into two committed artifacts:

- `collector/allowed-attributes.json` — a machine-readable manifest
  (`allowAllKeys: false` plus the sorted attribute keys).
- `collector/keyless-telemetry-redaction.yaml` — a ready-to-vendor otelcol
  `redaction` processor fragment. The cl-tofu collector config vendors this
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
  marker keys. The cl-tofu collector config vendors it into a `traces/posthog`
  pipeline (`[resource, redaction, filter/product_signals, batch] ->
  [otlphttp/posthog]`); `redaction` stays ahead of the filter so the privacy
  allow-list applies to the PostHog leg too.
- `collector/posthog-identity-transform.json` — a machine-readable manifest
  for the collector-side PostHog person mapping from
  `app.installation.id` to `posthog.distinct_id`.
- `collector/keyless-telemetry-posthog-identity.yaml` — a ready-to-vendor
  otelcol `transform/posthog_identity` processor fragment. The cl-tofu
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
SCHEMA_URL="https://github.com/closedloop-ai/symphony-alpha/releases/download/telemetry-contract-v0.2.0/gen-ai.schema.json"
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
- GenAI cache-token attributes are compatibility fields until the pinned OTel JS package exports them.
- `sync.event`, `sync.outcome`, `sync.payload_bytes`, and `sync.latency_ms`
  map from future Desktop sync instrumentation in
  `apps/desktop/src/main/agent-session-sync-service.ts`; they are
  transport-health-only fields and must not carry session content.
- `gen_ai.cost.usage` (per-call USD cost), `gen_ai.permission.decision`, and
  `gen_ai.permission.source` map from harness cost/permission events ingested
  by the desktop in-process OTLP receiver (PRD-468 FEA-1843).
- `harness.name` is the runtime-tool discriminator emitted by every harness
  (`claude`/`codex`/`cursor`/`copilot`/`opencode`). It is distinct from the
  CLOTS `agent.name` logical-actor attribute and is not owned by the pinned
  OTel package.
- `ipc.operation`, `ipc.payload_bytes`, `ipc.result_count`, and
  `ipc.session_count` map from the Desktop Agent Dashboard IPC perf wide events
  in `apps/desktop/src/main/agent-dashboard-design-system-runtime.ts`
  (FEA-1997); the `ipc` schema reuses `duration_ms` and the optional OTel
  `error.type`. `ipc.session_count` is the total local-store session count —
  the fleet dimension that exposes the many-sessions perf cliff.

The FEA-1980 App contract subpaths ship in `0.2.0`; the FEA-1981 Sync contract subpaths ship in `0.3.0`; the FEA-2037 Permission contract subpaths plus the `gen_ai.cost.usage` and `harness.name` attributes ship in `0.4.0` (release tag `telemetry-contract-v0.4.0`); the FEA-1986 `app.exception.origin` contract ships in `0.5.0` (release tag `telemetry-contract-v0.5.0`); the FEA-2170 collector allow-list codegen and drift guard land in `0.6.0` (release tag `telemetry-contract-v0.6.0`); the FEA-1991 collector PostHog-routing codegen and drift guard land in `0.7.0` (release tag `telemetry-contract-v0.7.0`); the FEA-1996 multiplayer `app.organization.id` attribute ships in `0.8.0` (release tag `telemetry-contract-v0.8.0`); the FEA-1997 `ipc` IPC perf wide-event subpaths plus the published `collector-tail-sampling-policy` SSOT ship in `0.9.0` (release tag `telemetry-contract-v0.9.0`). FEA-1996 and FEA-1997 both originally declared `0.8.0`; FEA-1996 merged first and published `0.8.0`, so the `ipc` subpaths and the `collector-tail-sampling-policy` SSOT — present on `main` but absent from the published `0.8.0` artifact — are republished as the additive-minor `0.9.0` (FEA-2198). The FEA-2184 collector-side PostHog identity transform artifacts ship in `0.9.1` (release tag `telemetry-contract-v0.9.1`). The FEA-3074 span envelope and span-aware emit helpers ship in `0.10.0` (release tag `telemetry-contract-v0.10.0`) while preserving the flat public `span.schema.json` asset. The generated `collector/*` artifacts are committed in-repo for cross-repo vendoring and are intentionally not packed into the published tarball (`files: ["dist"]`), so they do not change the published package surface. Publication is handled only by the existing main-branch GitHub Packages workflow after merge; consumers should pin the published package version after that workflow completes.

Only compiled JavaScript, declarations, generated schema assets, and the copied
dist sample ship. Source files, scripts, tests, sourcemaps, declaration maps,
source-map footer comments, and embedded source payloads are forbidden from the
packed package.
