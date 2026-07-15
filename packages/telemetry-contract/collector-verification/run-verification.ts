import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CollectorTailSamplingPolicy } from "../collector-tail-sampling-policy";
import {
  buildVerificationCollectorConfig,
  DEFAULT_VERIFICATION_ENDPOINTS,
} from "./otelcol-config";
import { buildScenarioTraces, type ScenarioCounts } from "./synthetic-otlp";
import {
  type DecisionMetrics,
  evaluateLegs,
  parseDecisionMetrics,
  parseExportedScenarioCounts,
  type VerificationEvaluation,
} from "./tail-sampling-metrics";

/**
 * Docker orchestration for the tail-sampling mechanical verification (FEA-2182).
 *
 * Boots a real `otel/opentelemetry-collector-contrib` binary loaded with the
 * committed `tail_sampling` fragment, pushes synthetic OTLP traffic at it, then
 * reads the collector's own decision metrics + the file-exporter output and
 * evaluates each policy leg. All pure parsing/evaluation lives in sibling pure
 * modules; this module owns only the I/O and process lifecycle.
 */

const execFileAsync = promisify(execFile);

/** Prod collector image (matches FEA-1990 sidecar). */
export const OTELCOL_IMAGE = "otel/opentelemetry-collector-contrib:0.119.0";

/**
 * Raised when the verification cannot run because of Docker infrastructure — the
 * image could not be pulled (registry/network unreachable). The `verify:` CLI
 * treats this as a SKIP (exit 0), not a failure: the daemon being up does not
 * guarantee the registry is reachable, and an unverifiable run must not be
 * reported as a behavioral failure.
 */
export class DockerInfraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DockerInfraError";
  }
}

export type RunVerificationOptions = {
  readonly counts?: ScenarioCounts;
  readonly image?: string;
  /** Override the wall-clock base used to stamp synthetic spans (testing). */
  readonly baseTimeUnixNano?: bigint;
  /** Sink for human-readable progress; defaults to silent. */
  readonly log?: (message: string) => void;
};

export type VerificationReport = {
  readonly image: string;
  readonly counts: ScenarioCounts;
  readonly totalSent: number;
  readonly evaluation: VerificationEvaluation;
  readonly rawMetrics: DecisionMetrics;
};

const DEFAULT_COUNTS: ScenarioCounts = {
  errors: 5,
  serverErrors: 5,
  slow: 5,
  baseline: 1000,
};

// `docker port` prints one `<addr>:<port>` line per bound address; capture the
// trailing port number.
const DOCKER_PORT_LINE = /:(\d+)\s*$/m;

/** Resolve the ephemeral host port Docker mapped to a container port. */
async function discoverHostPort(
  containerName: string,
  containerPort: number
): Promise<number> {
  const { stdout } = await execFileAsync("docker", [
    "port",
    containerName,
    `${containerPort}/tcp`,
  ]);
  const match = stdout.match(DOCKER_PORT_LINE);
  if (!match) {
    throw new Error(
      `could not resolve host port for container port ${containerPort}: ${stdout.trim()}`
    );
  }
  return Number(match[1]);
}

/** True when a Docker daemon is reachable. Never throws. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function posixUserArgs(): string[] {
  const getuid = process.getuid?.bind(process);
  const getgid = process.getgid?.bind(process);
  if (getuid && getgid) {
    return ["--user", `${getuid()}:${getgid()}`];
  }
  return [];
}

async function waitForHttp(
  url: string,
  timeoutMs: number,
  log: (message: string) => void
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  log(`readiness wait for ${url} timed out: ${lastError}`);
  throw new Error(`Collector endpoint ${url} not ready: ${lastError}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sum of all decisions recorded for a policy (== total traces once decided). */
function decidedCount(metrics: DecisionMetrics, policyName: string): number {
  const entry = metrics.get(policyName);
  return entry ? entry.sampledTrue + entry.sampledFalse : 0;
}

async function scrapeMetrics(metricsUrl: string): Promise<DecisionMetrics> {
  const response = await fetch(metricsUrl);
  if (!response.ok) {
    throw new Error(`metrics scrape failed: status ${response.status}`);
  }
  return parseDecisionMetrics(await response.text());
}

/**
 * Run the full verification. Resolves with a structured report; rejects only on
 * orchestration failure (Docker/IO), not on a failing leg — inspect
 * `report.evaluation.pass` for the verdict.
 */
export async function runVerification(
  options: RunVerificationOptions = {}
): Promise<VerificationReport> {
  const log = options.log ?? (() => undefined);
  const image = options.image ?? OTELCOL_IMAGE;
  const counts = options.counts ?? DEFAULT_COUNTS;

  // Synthetic traffic is a pure value — build it up front so `totalSent` has a
  // single canonical source (the payload count) instead of a re-summed literal.
  const { payloads, manifest, totalSent } = buildScenarioTraces(counts, {
    baseTimeUnixNano:
      options.baseTimeUnixNano ?? BigInt(Date.now()) * 1_000_000n,
  });

  const workDir = mkdtempSync(join(tmpdir(), "tail-sampling-verify-"));
  const configPath = join(workDir, "config.yaml");
  const outputDir = join(workDir, "output");
  const exportFileHostPath = join(outputDir, "traces.json");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(configPath, buildVerificationCollectorConfig());
  writeFileSync(exportFileHostPath, "");
  // The container may run as a different uid and must write traces.json into the
  // bind mount, so the output dir is world-writable. The parent only needs to be
  // traversable — keep it 0o755 so other local processes cannot delete its files.
  chmodSync(workDir, 0o755);
  chmodSync(outputDir, 0o777);

  // Ephemeral host ports avoid "address already in use" when runs overlap (CI
  // shards, a dev `verify:` run, repeated invocations); the actual ports are
  // resolved from Docker after start.
  const containerName = `tail-sampling-verify-${process.pid}`;
  let started = false;
  try {
    log(`pulling ${image} (cached after first run)…`);
    try {
      await execFileAsync("docker", ["pull", image], { timeout: 180_000 });
    } catch (error) {
      throw new DockerInfraError(
        `docker pull ${image} failed (registry/network unreachable) — skipping verification`,
        { cause: error }
      );
    }

    log(`starting collector container ${containerName}…`);
    // Bind to 127.0.0.1 with an OS-assigned host port: never exposed off-host,
    // never collides with a concurrent run.
    await execFileAsync("docker", [
      "run",
      "-d",
      "--name",
      containerName,
      "-p",
      `127.0.0.1::${DEFAULT_VERIFICATION_ENDPOINTS.otlpHttpPort}`,
      "-p",
      `127.0.0.1::${DEFAULT_VERIFICATION_ENDPOINTS.metricsPort}`,
      ...posixUserArgs(),
      "-v",
      `${configPath}:/etc/otelcol-contrib/config.yaml:ro`,
      "-v",
      `${outputDir}:/output`,
      image,
    ]);
    started = true;

    const hostOtlpPort = await discoverHostPort(
      containerName,
      DEFAULT_VERIFICATION_ENDPOINTS.otlpHttpPort
    );
    const hostMetricsPort = await discoverHostPort(
      containerName,
      DEFAULT_VERIFICATION_ENDPOINTS.metricsPort
    );
    const metricsUrl = `http://127.0.0.1:${hostMetricsPort}/metrics`;
    const otlpUrl = `http://127.0.0.1:${hostOtlpPort}/v1/traces`;
    await waitForHttp(metricsUrl, 30_000, log);
    log("collector ready; sending synthetic traffic…");

    await sendPayloads(otlpUrl, payloads);
    log(`sent ${payloads.length} synthetic traces; awaiting decisions…`);

    const metrics = await awaitDecisions({
      metricsUrl,
      policyName: CollectorTailSamplingPolicy.policyNames.baseline,
      totalSent,
      log,
    });

    const fileRetention = parseExportedScenarioCounts(
      readFileSync(exportFileHostPath, "utf-8")
    );
    const evaluation = evaluateLegs({
      manifest,
      metrics,
      fileRetention,
      totalSent,
    });

    return { image, counts, totalSent, evaluation, rawMetrics: metrics };
  } catch (error) {
    if (started) {
      await captureLogs(containerName, log);
    }
    throw error;
  } finally {
    if (started) {
      await execFileAsync("docker", ["rm", "-f", containerName]).catch(
        () => undefined
      );
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function sendPayloads(
  otlpUrl: string,
  payloads: readonly { resourceSpans: readonly unknown[] }[]
): Promise<void> {
  for (const payload of payloads) {
    const response = await fetch(otlpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`OTLP export rejected: status ${response.status}`);
    }
  }
}

/**
 * Poll the decision metrics until every trace has been decided (the collector
 * buffers each trace for `decision_wait` before voting), then return the final
 * snapshot. Falls back to the last snapshot if the deadline is reached.
 */
async function awaitDecisions(args: {
  metricsUrl: string;
  policyName: string;
  totalSent: number;
  log: (message: string) => void;
}): Promise<DecisionMetrics> {
  const decisionWaitMs = CollectorTailSamplingPolicy.decisionWaitSeconds * 1000;
  // First decisions cannot land before `decision_wait` elapses.
  await delay(decisionWaitMs);

  const deadline = Date.now() + decisionWaitMs + 30_000;
  let latest: DecisionMetrics = new Map();
  while (Date.now() < deadline) {
    latest = await scrapeMetrics(args.metricsUrl);
    if (decidedCount(latest, args.policyName) >= args.totalSent) {
      return latest;
    }
    await delay(1000);
  }
  args.log(
    `decision wait reached deadline; decided ${decidedCount(latest, args.policyName)}/${args.totalSent}`
  );
  return latest;
}

async function captureLogs(
  containerName: string,
  log: (message: string) => void
): Promise<void> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", [
      "logs",
      containerName,
    ]);
    log(`--- collector logs ---\n${stdout}\n${stderr}\n----------------------`);
  } catch {
    // Best-effort diagnostics only.
  }
}
