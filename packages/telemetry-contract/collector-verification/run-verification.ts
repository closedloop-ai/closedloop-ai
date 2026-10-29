import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { CollectorTailSamplingPolicy } from "../collector-tail-sampling-policy";
import {
  buildVerificationCollectorConfig,
  DEFAULT_VERIFICATION_ENDPOINTS,
  VERIFICATION_EXPORT_FLUSH_INTERVAL_MS,
} from "./otelcol-config";
import { buildScenarioTraces, type ScenarioCounts } from "./synthetic-otlp";
import {
  type DecisionMetrics,
  evaluateLegs,
  parseDecisionMetrics,
  settleExportedScenarioCounts,
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

// The decision metric increments before the exporter's buffered write reaches
// disk, so the legs are scored off a settled read rather than the first one
// (ISS-9913). Two unchanged reads 500ms apart is a 1s quiet window — 10x the
// flush cadence pinned on the exporter — and the read cap bounds the wait at
// ~20s, well inside the run's existing budget. Exhausting that cap throws
// `InconclusiveVerificationError`, as does a settled read that did not parse
// cleanly: neither is ground truth, and scoring one would report a draining
// buffer or a corrupt record as a policy regression.
const EXPORT_SETTLE_POLL_MS = 5 * VERIFICATION_EXPORT_FLUSH_INTERVAL_MS;
const EXPORT_SETTLE_STABLE_READS = 2;
const EXPORT_SETTLE_MAX_READS = 40;

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
 * Run the full verification. Resolves with a structured report; rejects on
 * orchestration failure (Docker/IO) and on an export file that could not serve
 * as ground truth (`InconclusiveVerificationError`), never on a failing leg —
 * inspect `report.evaluation.pass` for the verdict.
 */
export async function runVerification(
  options: RunVerificationOptions = {}
): Promise<VerificationReport> {
  const log = options.log ?? (() => undefined);
  const image = options.image ?? OTELCOL_IMAGE;
  const counts = options.counts ?? DEFAULT_COUNTS;

  // Synthetic traffic is a pure value — build it up front so `totalSent` stays
  // trace-based even when a trace is exported across multiple payloads.
  const { payloads, payloadDelaysMs, manifest, totalSent } =
    buildScenarioTraces(counts, {
      baseTimeUnixNano:
        options.baseTimeUnixNano ?? BigInt(Date.now()) * 1_000_000n,
    });

  // The bind-mount source is anchored at $HOME, not the caller's cwd or the
  // checkout (ISS-9883). A VM-backed daemon (Dory, colima, Docker Desktop) sees
  // only the host dirs shared into its VM; $HOME is the one they share by
  // default and a /private/tmp worktree is not, where the mount came up empty.
  // Everything in it is generated below, so nothing ties it to the repo.
  const scratchParent = verificationScratchParent();
  mkdirSync(scratchParent, { recursive: true });
  const workDir = mkdtempSync(join(scratchParent, "tail-sampling-verify-"));
  const configPath = join(workDir, "config.yaml");
  const outputDir = join(workDir, "output");
  const exportFileHostPath = join(outputDir, "traces.json");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(configPath, buildVerificationCollectorConfig());
  writeFileSync(exportFileHostPath, "");
  // Finding a file at the probed path proves nothing on its own: the image
  // ships its own /etc/otelcol-contrib/config.yaml, so a runtime that serves
  // `docker cp` from the image layer on a created container would hand back
  // the stock file and the probe would pass over an unshared mount. The probe
  // reads this per-run token back instead, which only the mounted host dir has.
  const probeToken = randomUUID();
  writeFileSync(join(workDir, BIND_MOUNT_PROBE_FILE), probeToken);
  // The container may run as a different uid and must write traces.json into the
  // bind mount, so the output dir is world-writable. The parent only needs to be
  // traversable — keep it 0o755 so other local processes cannot delete its files.
  chmodSync(workDir, 0o755);
  chmodSync(outputDir, 0o777);

  // Ephemeral host ports avoid "address already in use" when runs overlap (CI
  // shards, a dev `verify:` run, repeated invocations); the actual ports are
  // resolved from Docker after start.
  const containerName = `tail-sampling-verify-${process.pid}`;
  let created = false;
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
    try {
      await execFileAsync("docker", [
        "create",
        "--name",
        containerName,
        "-p",
        `127.0.0.1::${DEFAULT_VERIFICATION_ENDPOINTS.otlpHttpPort}`,
        "-p",
        `127.0.0.1::${DEFAULT_VERIFICATION_ENDPOINTS.metricsPort}`,
        ...posixUserArgs(),
        "-v",
        `${workDir}:${CONTAINER_CONFIG_DIR}:ro`,
        "-v",
        `${outputDir}:/output`,
        image,
      ]);
    } catch (error) {
      throw classifyCreateFailure(error, workDir);
    }
    created = true;
    await assertBindMountVisible({
      containerName,
      hostPath: workDir,
      containerPath: `${CONTAINER_CONFIG_DIR}/${BIND_MOUNT_PROBE_FILE}`,
      token: probeToken,
    });
    await execFileAsync("docker", ["start", containerName]);
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

    await sendPayloads(otlpUrl, payloads, payloadDelaysMs, log);
    log(
      `sent ${payloads.length} synthetic payloads for ${totalSent} traces; awaiting decisions…`
    );

    const metrics = await awaitDecisions({
      metricsUrl,
      policyName: CollectorTailSamplingPolicy.policyNames.baseline,
      totalSent,
      log,
    });

    const fileRetention = await settleExportedScenarioCounts({
      readExportFile: () => readFileSync(exportFileHostPath, "utf-8"),
      wait: () => delay(EXPORT_SETTLE_POLL_MS),
      stableReads: EXPORT_SETTLE_STABLE_READS,
      maxReads: EXPORT_SETTLE_MAX_READS,
    });
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
    if (created) {
      await execFileAsync("docker", ["rm", "-f", containerName]).catch(
        () => undefined
      );
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function sendPayloads(
  otlpUrl: string,
  payloads: readonly { resourceSpans: readonly unknown[] }[],
  payloadDelaysMs: readonly number[],
  log: (message: string) => void
): Promise<void> {
  for (const [index, payload] of payloads.entries()) {
    const delayBeforeMs = payloadDelaysMs[index] ?? 0;
    if (delayBeforeMs > 0) {
      log(`waiting ${delayBeforeMs}ms before synthetic payload ${index + 1}`);
      await delay(delayBeforeMs);
    }
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

/** Where otelcol-contrib reads `config.yaml` from by default. */
const CONTAINER_CONFIG_DIR = "/etc/otelcol-contrib";

/** Carries the per-run probe token; otelcol reads only `config.yaml` beside it. */
const BIND_MOUNT_PROBE_FILE = "bind-mount-probe";

/** Parent of each run's scratch dir; see the anchor note in `runVerification`. */
function verificationScratchParent(): string {
  return join(homedir(), ".cache");
}

/**
 * Pre-flight on a created, not yet started, container: copy this run's probe
 * token back out through the daemon. A daemon that cannot see the host path
 * mounts an empty dir in its place, so the daemon reports the file missing;
 * a runtime that serves the copy from the image layer instead hands back
 * something that is not the token. Either way the run refuses with the real
 * cause instead of otelcol's "cannot resolve the configuration". Only those
 * two results are an unshared mount; any other `docker cp` failure is a failed
 * probe carrying the raw Docker error. The output mount lives inside the same
 * host dir, so one probe covers both.
 */
export async function assertBindMountVisible(args: {
  readonly containerName: string;
  readonly hostPath: string;
  readonly containerPath: string;
  /** Written into the bind source by the caller; the probe requires it back. */
  readonly token: string;
  readonly dockerCp?: (source: string) => Promise<string>;
}): Promise<void> {
  const dockerCp =
    args.dockerCp ??
    (async (source: string) =>
      (await execFileAsync("docker", ["cp", source, "-"])).stdout);
  const source = `${args.containerName}:${args.containerPath}`;
  let readBack: string;
  try {
    readBack = await dockerCp(source);
  } catch (error) {
    const missing = dockerErrorDetail(error).match(DOCKER_CP_MISSING_FILE);
    if (missing?.[1] === args.containerPath) {
      throw new BindMountNotVisibleError(
        args.hostPath,
        `${args.containerPath} is missing inside the container, so otelcol would boot with an empty config dir and fail with a misleading "cannot resolve the configuration"`,
        error
      );
    }
    throw new Error(
      `bind-mount probe \`docker cp ${source} -\` failed: ${dockerErrorDetail(error)}`,
      { cause: error }
    );
  }
  if (!readBack.includes(args.token)) {
    throw new BindMountNotVisibleError(
      args.hostPath,
      `${args.containerPath} came back without this run's probe token, so the daemon served a file from the image layer rather than the mounted dir`
    );
  }
}

/**
 * The Docker daemon cannot see a bind-mount source. The `verify:` CLI exits 1
 * on it: nothing was verified, and the fix is on the caller's machine.
 */
export class BindMountNotVisibleError extends Error {
  constructor(hostPath: string, symptom: string, cause?: unknown) {
    super(
      [
        `the Docker daemon cannot see the bind-mount source ${hostPath} (${symptom}).`,
        "The daemon runs in a VM that shares only selected host directories (Dory, colima, Docker Desktop) and this path is not one of them.",
        `Remedy: share ${dirname(hostPath)}, or a parent of it such as your home directory, with the Docker VM, then re-run.`,
        ...(cause === undefined
          ? []
          : [`docker said: ${dockerErrorDetail(cause)}`]),
      ].join("\n"),
      { cause }
    );
    this.name = "BindMountNotVisibleError";
  }
}

// The daemon's own wording when `docker cp` finds no file at the source path;
// the capture is the path, compared against the probed one. An older CLI that
// rewrote the daemon's 404 as "No such container:path" is deliberately NOT
// matched: that 404 also covers a missing container, so it proves nothing.
const DOCKER_CP_MISSING_FILE = /Could not find the file (\S+) in container/;

// A daemon refusing the bind itself at `docker create`: Docker Desktop's file
// sharing check ("Mounts denied: ... is not shared from the host") and a
// daemon that looked for the source and could not find it. Every mount in the
// create call lives under the scratch dir, so either names ours.
const DOCKER_CREATE_MOUNT_REJECTED =
  /Mounts denied|bind source path does not exist/i;

function dockerErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message.trim() : String(error);
}

/** A `docker create` failure that names the bind mount as unshared, else the raw error. */
function classifyCreateFailure(error: unknown, hostPath: string): unknown {
  return DOCKER_CREATE_MOUNT_REJECTED.test(dockerErrorDetail(error))
    ? new BindMountNotVisibleError(
        hostPath,
        "docker create rejected the bind mount",
        error
      )
    : error;
}
