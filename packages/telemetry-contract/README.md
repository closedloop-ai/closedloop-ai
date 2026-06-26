# @closedloop-ai/telemetry-contract

Canonical v0.5 telemetry attribute names, schemas, and consumer helpers for ClosedLoop App, Resource, Span, GenAI, Sync, and Permission telemetry contracts.

Import exact subpaths:

```ts
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { AppTelemetrySchema } from "@closedloop-ai/telemetry-contract/app";
import { ResourceTelemetrySchema } from "@closedloop-ai/telemetry-contract/resource";
import { SpanTelemetrySchema } from "@closedloop-ai/telemetry-contract/span";
import { GenAiTelemetrySchema } from "@closedloop-ai/telemetry-contract/gen-ai";
import { SyncTelemetrySchema } from "@closedloop-ai/telemetry-contract/sync";
import { PermissionTelemetrySchema } from "@closedloop-ai/telemetry-contract/permission";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import type { SchemaShape } from "@closedloop-ai/telemetry-contract/schema-shape";
import { validate } from "@closedloop-ai/telemetry-contract/validate";
import { createEmit } from "@closedloop-ai/telemetry-contract/emit";
import { appPayload, spanPayload, genAiPayload, syncPayload, permissionPayload } from "@closedloop-ai/telemetry-contract/test-fixtures";
```

There is intentionally no root import. Use direct subpaths so consumers depend only on the contract group they need.

`validate(payload, schemaName)` is for dev, test, and other non-hot paths. It returns `{ ok: true, value }` when the existing strict Zod schema accepts the payload, or `{ ok: false, errors }` when validation fails. Error objects include schema name, path, attribute path, code, and message; they do not include raw received values. Unknown attributes are closed-world failures.

`emit(schemaName, { name, attributes })` is a typed channel wrapper. It enforces schema-specific exact keys at compile time, including prebuilt attribute variables with extra keys, and it does not call Zod or `validate()` at runtime. Direct `emit()` requires `configureTelemetryEmitChannel(channel)` first; production symphony-alpha callers should use the `@repo/observability/telemetry/contract` adapter, which binds the helper to the existing `log.info()` channel.

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
```

Generated JSON Schema files are published at:

- `@closedloop-ai/telemetry-contract/schemas/app.schema.json`
- `@closedloop-ai/telemetry-contract/schemas/resource.schema.json`
- `@closedloop-ai/telemetry-contract/schemas/span.schema.json`
- `@closedloop-ai/telemetry-contract/schemas/gen-ai.schema.json`
- `@closedloop-ai/telemetry-contract/schemas/sync.schema.json`
- `@closedloop-ai/telemetry-contract/schemas/permission.schema.json`

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

Run the PR-diff gate before opening a schema PR:

```bash
pnpm --filter @closedloop-ai/telemetry-contract check:schema-update -- --base origin/main --head HEAD
```

The gate also protects ClosedLoop compatibility attributes. When adding a
`ClosedLoopCompatibilityAttribute`, update
`CompatibilityAttributeProducerMapping` in the same file with non-empty
`producer`, `sourceField`, and `reason` fields. Those fields identify the
current producer, the source payload field, and why the attribute remains a
ClosedLoop compatibility field instead of an OTel-owned attribute.

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

The FEA-1980 App contract subpaths ship in `0.2.0`; the FEA-1981 Sync contract subpaths ship in `0.3.0`; the FEA-2037 Permission contract subpaths plus the `gen_ai.cost.usage` and `harness.name` attributes ship in `0.4.0` (release tag `telemetry-contract-v0.4.0`); the FEA-1986 `app.exception.origin` contract ships in `0.5.0` (release tag `telemetry-contract-v0.5.0`). Publication is handled only by the existing main-branch GitHub Packages workflow after merge; consumers should pin the published package version after that workflow completes.

Only compiled JavaScript, declarations, generated schema assets, and the copied
dist sample ship. Source files, scripts, tests, sourcemaps, declaration maps,
source-map footer comments, and embedded source payloads are forbidden from the
packed package.
