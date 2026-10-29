import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { isRecord } from "../scripts/collector-codegen-common";
import { CollectorTailSamplingPath } from "../scripts/generate-collector-tail-sampling";

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

/**
 * Flush cadence pinned on the `file` exporter. otelcol's default is a full
 * second of buffering, which the runner would have to out-wait blindly; pinning
 * it here is what makes the runner's settle window a multiple of a value we set
 * rather than of an unstated collector default (ISS-9913).
 */
export const VERIFICATION_EXPORT_FLUSH_INTERVAL_MS = 100;

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
      file: {
        path: endpoints.exportFilePath,
        flush_interval: `${VERIFICATION_EXPORT_FLUSH_INTERVAL_MS}ms`,
      },
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
