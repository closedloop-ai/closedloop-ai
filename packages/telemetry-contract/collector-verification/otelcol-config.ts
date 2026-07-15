import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { isRecord } from "../scripts/collector-codegen-common";
import { CollectorTailSamplingPath } from "../scripts/generate-collector-tail-sampling";

/**
 * Builds the otelcol-contrib config used by the tail-sampling mechanical
 * verification (FEA-2182).
 *
 * The verification must exercise the EXACT `tail_sampling` block that is
 * committed (and vendored cross-repo into cl-tofu), not a freshly rendered one —
 * so we read `collector/tail-sampling.yaml` and splice its processor block,
 * verbatim, into a minimal traces pipeline:
 *
 *   otlp(http) → tail_sampling → file
 *
 * Redaction and batch are deliberately omitted: this isolates the processor
 * under test, and the `test.scenario` marker attribute survives to the file
 * exporter for ground-truth grouping. The collector's own internal metrics are
 * exposed on a Prometheus endpoint so the run can read
 * `otelcol_processor_tail_sampling_*` decision counters.
 */

export type VerificationEndpoints = {
  /** OTLP/HTTP receiver port (container-internal). */
  readonly otlpHttpPort: number;
  /** Prometheus internal-telemetry port (container-internal). */
  readonly metricsPort: number;
  /** Absolute container path the file exporter writes retained traces to. */
  readonly exportFilePath: string;
};

export const DEFAULT_VERIFICATION_ENDPOINTS: VerificationEndpoints = {
  otlpHttpPort: 4318,
  metricsPort: 8888,
  exportFilePath: "/output/traces.json",
};

function readCommittedFragment(): string {
  const fragmentUrl = new URL(
    `../${CollectorTailSamplingPath.Fragment}`,
    import.meta.url
  );
  return readFileSync(fileURLToPath(fragmentUrl), "utf-8");
}

/** Extract the `tail_sampling` processor block from a committed fragment source. */
export function parseTailSamplingProcessor(
  fragmentSource: string
): Record<string, unknown> {
  const parsed: unknown = YAML.parse(fragmentSource);
  const block = isRecord(parsed) ? parsed.tail_sampling : undefined;
  if (!isRecord(block)) {
    throw new Error(
      'Committed tail-sampling fragment does not contain a "tail_sampling" block.'
    );
  }
  return block;
}

/**
 * Render the full verification collector config as YAML. Pure in its inputs
 * (fragment source + endpoints) so it is unit-testable without disk.
 */
export function renderVerificationCollectorConfig(
  fragmentSource: string,
  endpoints: VerificationEndpoints = DEFAULT_VERIFICATION_ENDPOINTS
): string {
  const tailSampling = parseTailSamplingProcessor(fragmentSource);

  const config = {
    receivers: {
      otlp: {
        protocols: {
          http: { endpoint: `0.0.0.0:${endpoints.otlpHttpPort}` },
        },
      },
    },
    processors: {
      tail_sampling: tailSampling,
    },
    exporters: {
      file: { path: endpoints.exportFilePath },
    },
    service: {
      telemetry: {
        metrics: {
          // Prometheus pull endpoint exposing the collector's own internal
          // metrics, including otelcol_processor_tail_sampling_* counters.
          readers: [
            {
              pull: {
                exporter: {
                  prometheus: {
                    host: "0.0.0.0",
                    port: endpoints.metricsPort,
                  },
                },
              },
            },
          ],
        },
      },
      pipelines: {
        traces: {
          receivers: ["otlp"],
          processors: ["tail_sampling"],
          exporters: ["file"],
        },
      },
    },
  };

  return YAML.stringify(config, { indent: 2 });
}

/** Convenience: render the config from the committed fragment on disk. */
export function buildVerificationCollectorConfig(
  endpoints: VerificationEndpoints = DEFAULT_VERIFICATION_ENDPOINTS
): string {
  return renderVerificationCollectorConfig(readCommittedFragment(), endpoints);
}
