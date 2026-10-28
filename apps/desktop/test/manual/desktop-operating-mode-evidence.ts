import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { SavedConfigManagedField } from "../../src/main/settings/saved-config.js";
import type { launchDesktopApp } from "../e2e/helpers/desktop-app.js";
import type { startAuthenticatedCloudRelay } from "../e2e/helpers/fake-cloud-relay.js";
import {
  INACTIVE_PROFILE_ID,
  MANUAL_ASSERTION_DEADLINE_MS,
  PROFILE_ID,
  relayLedger,
} from "./desktop-operating-mode-fixtures.js";

export async function measureGuestSessions(
  page: Awaited<ReturnType<typeof launchDesktopApp>>["page"],
  runs: number
): Promise<MeasurementSummary> {
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    await withDeadline(
      page.evaluate(() =>
        window.desktopApi.agentSessionsApi.list({ quality: "all", limit: 25 })
      ),
      MANUAL_ASSERTION_DEADLINE_MS,
      "projection_contract_failed: Sessions list exceeded 10 seconds"
    );
    samples.push(Number((performance.now() - started).toFixed(3)));
  }
  const warmSamples = samples.slice(1);
  return {
    allSamplesMs: samples,
    warmSamplesMs: warmSamples,
    medianMs: median(warmSamples),
    spreadMs: Number(
      (Math.max(...warmSamples) - Math.min(...warmSamples)).toFixed(3)
    ),
    assertionDeadlineMs: MANUAL_ASSERTION_DEADLINE_MS,
  };
}

export function recordPhase(
  filePath: string,
  phase: string,
  verdict: "passed" | "failed",
  evidence: Record<string, unknown>
): void {
  fs.appendFileSync(
    filePath,
    `${JSON.stringify({ at: new Date().toISOString(), phase, verdict, ...evidence })}\n`,
    "utf8"
  );
}

type MeasurementSummary = {
  allSamplesMs: number[];
  warmSamplesMs: number[];
  medianMs: number;
  spreadMs: number;
  assertionDeadlineMs: number;
};

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const result =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  return Number(result.toFixed(3));
}

export async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  failure: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(failure)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function readProjectionEvidence(
  profileDir: string,
  startedAt: number,
  endedAt: number
): {
  observedOps: string[];
  forbiddenListOps: string[];
  projectedListOps: string[];
} {
  const rows = readJsonl(path.join(profileDir, "db-ops.jsonl")).filter(
    (row) =>
      typeof row.ts === "number" && row.ts >= startedAt && row.ts <= endedAt
  );
  const observedOps = rows.flatMap((row) =>
    typeof row.op === "string" ? [row.op] : []
  );
  return {
    observedOps: [...new Set(observedOps)],
    forbiddenListOps: observedOps.filter((op) =>
      op.includes("syncSource.loadSyncedSessions")
    ),
    projectedListOps: observedOps.filter((op) =>
      op.includes("syncSource.projectSessionList")
    ),
  };
}

function readJsonl(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`projection_contract_failed: missing ${filePath}`);
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
    string,
    unknown
  >;
}

type ProjectionEvidence = ReturnType<typeof readProjectionEvidence>;
type Relay = Awaited<ReturnType<typeof startAuthenticatedCloudRelay>>;

export function assertAuthStatus(
  actual: string,
  expected: string,
  failureSignature: string
): void {
  if (actual !== expected) {
    throw new Error(`${failureSignature}: expected ${expected}, got ${actual}`);
  }
}

export function assertProjectionEvidence(evidence: ProjectionEvidence): void {
  if (evidence.forbiddenListOps.length > 0) {
    throw new Error(
      `projection_contract_failed: ${evidence.forbiddenListOps.join(",")}`
    );
  }
  if (evidence.projectedListOps.length === 0) {
    throw new Error(
      "projection_contract_failed: syncSource.projectSessionList was not observed"
    );
  }
}

export function assertNoRetainedSecrets(keys: readonly string[]): void {
  if (keys.length > 0) {
    throw new Error(
      `cleanup_replay_failed: retained credential fields ${keys.join(",")}`
    );
  }
}

export function assertNoForbiddenRequests(
  requests: readonly { method: string; pathname: string }[]
): void {
  if (requests.length === 0) {
    return;
  }
  throw new Error(
    `forbidden_egress_observed: ${requests.map((request) => `${request.method} ${request.pathname}`).join(",")}`
  );
}

export function assertRelayUnchanged(
  relay: Relay,
  baseline: ReturnType<typeof relayLedger>
): void {
  const current = relayLedger(relay);
  if (JSON.stringify(current) !== JSON.stringify(baseline)) {
    throw new Error("forbidden_egress_observed: relay traffic changed");
  }
}

export function assertOfflineRequestsDeferred(
  requests: readonly { method: string; pathname: string; statusCode?: number }[]
): void {
  if (requests.some((request) => request.statusCode !== 503)) {
    throw new Error(
      "offline_fallback_failed: fake cloud accepted a request while offline"
    );
  }
}

export function assertPreservedDatabaseState(
  before: unknown,
  after: unknown
): void {
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error("cleanup_replay_failed: preserved database state changed");
  }
}

export function readPreservedSettings(
  userDataDir: string
): Record<string, unknown> {
  const settings = readJsonFile(
    path.join(userDataDir, "desktop-settings.json")
  );
  const profiles = Array.isArray(settings.savedConfigs)
    ? settings.savedConfigs
    : [];
  const activeProfile = profiles.find(
    (profile) =>
      profile &&
      typeof profile === "object" &&
      Reflect.get(profile, "id") === settings.activeConfigId
  );
  return {
    activeConfigId: settings.activeConfigId,
    apiOrigin: settings.apiOrigin,
    cloudConnectionEnabled: settings.cloudConnectionEnabled,
    relayOrigin: settings.relayOrigin,
    sandboxBaseDirectory: settings.sandboxBaseDirectory,
    webAppOrigin: settings.webAppOrigin,
    activeProfile:
      activeProfile && typeof activeProfile === "object"
        ? {
            apiOrigin: Reflect.get(activeProfile, "apiOrigin"),
            relayOrigin: Reflect.get(activeProfile, "relayOrigin"),
            sandboxBaseDirectory: Reflect.get(
              activeProfile,
              "sandboxBaseDirectory"
            ),
            webAppOrigin: Reflect.get(activeProfile, "webAppOrigin"),
          }
        : null,
    profiles: profiles
      .filter((profile) => profile && typeof profile === "object")
      .map((profile) => ({
        id: Reflect.get(profile, "id"),
        apiOrigin: Reflect.get(profile, "apiOrigin"),
        relayOrigin: Reflect.get(profile, "relayOrigin"),
        webAppOrigin: Reflect.get(profile, "webAppOrigin"),
        sandboxBaseDirectory: Reflect.get(profile, "sandboxBaseDirectory"),
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id))),
  };
}

export function assertEqualNumber(
  actual: number,
  expected: number,
  failure: string
): void {
  if (actual !== expected) {
    throw new Error(failure);
  }
}

export function assertFreshSecrets(
  secrets: Record<string, unknown>,
  initialEncryptedKey: unknown
): void {
  if (
    Object.keys(secrets).some(
      (key) =>
        key.startsWith("profile:orphan-fixture") ||
        key.startsWith(`profile:${INACTIVE_PROFILE_ID}`)
    ) ||
    typeof secrets.encryptedApiKey !== "string" ||
    secrets.encryptedApiKey === initialEncryptedKey ||
    secrets.apiKeyProvenance !== "DESKTOP_MANAGED" ||
    typeof secrets[`profile:${PROFILE_ID}`] !== "string"
  ) {
    throw new Error(
      "fresh_key_provision_failed: fresh managed key was absent or an old copy returned"
    );
  }
}

/** Confirms both saved provenances lost every managed-key metadata field. */
export function assertNoManagedMetadata(userDataDir: string): void {
  const settings = readJsonFile(
    path.join(userDataDir, "desktop-settings.json")
  );
  const configs = Array.isArray(settings.savedConfigs)
    ? settings.savedConfigs
    : [];
  for (const config of configs) {
    if (!(config && typeof config === "object")) {
      continue;
    }
    for (const field of Object.values(SavedConfigManagedField)) {
      if (Object.hasOwn(config, field)) {
        throw new Error(`cleanup_replay_failed: retained ${field} metadata`);
      }
    }
  }
}
