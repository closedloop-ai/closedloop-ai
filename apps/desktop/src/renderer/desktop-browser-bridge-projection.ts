import { isRecord } from "@repo/lib/harness/type-guards";
import { FEATURE_FLAGS } from "../shared/feature-flags";
import { projectTranscriptPrepare } from "./desktop-browser-bridge-transcript";

/**
 * The wire-facing copy of the trusted preload API: only the explicitly selected
 * read methods, and for the two whole-record reads only the fields the mirrored
 * renderer actually consumes.
 */
export function selectReadOnlyDesktopApi(
  desktopApi: unknown
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const path of browserBridgeReadOnlyMethodPaths) {
    copyApiPath(desktopApi, selected, path.split("."));
  }
  for (const path of browserBridgeOptionalMethodPaths) {
    copyOptionalApiPath(desktopApi, selected, path.split("."));
  }
  copyCloudApiFetch(desktopApi, selected);
  // Optional like the paths above, but projected rather than copied: see
  // `projectTranscriptPrepare`.
  copyOptionalApiPath(
    desktopApi,
    selected,
    ["prepareTranscript"],
    projectTranscriptPrepare
  );
  copyApiValue(desktopApi, selected, ["macOSMajorVersion"]);
  copyApiValue(desktopApi, selected, ["platform"]);
  return selected;
}

export function resolveApiValue(
  value: unknown,
  path: string[]
): ResolvedApiValue {
  let current = value;
  let parent: unknown;
  for (const segment of path) {
    if (!(isRecord(current) && Object.hasOwn(current, segment))) {
      throw new Error("Desktop browser bridge API path is unavailable");
    }
    parent = current;
    current = current[segment];
  }
  return { parent, value: current };
}

function copyCloudApiFetch(
  source: unknown,
  target: Record<string, unknown>
): void {
  const resolved = resolveApiValue(source, ["cloudApiFetch"]);
  if (typeof resolved.value !== "function") {
    throw new Error("Desktop browser bridge cloud read API is missing");
  }
  const cloudApiFetch = resolved.value.bind(resolved.parent) as (
    request: Record<string, unknown>
  ) => Promise<unknown>;
  target.cloudApiFetch = (request: unknown) => {
    if (!(isRecord(request) && typeof request.path === "string")) {
      throw new Error("Desktop browser bridge cloud read is invalid");
    }
    const method =
      typeof request.method === "string" ? request.method.toUpperCase() : "GET";
    if (method !== "GET" || Object.hasOwn(request, "body")) {
      throw new Error("Desktop browser bridge permits cloud reads only");
    }
    if (isTranscriptCloudPath(request.path)) {
      throw new Error("Desktop browser bridge does not relay transcript reads");
    }
    return cloudApiFetch({ ...request, method });
  };
}

/**
 * `GET /agent-sessions/{id}/transcript` answers with short-lived SIGNED S3 URLs
 * for the raw transcript, and those must not reach browser JavaScript. The tab
 * reads transcripts through `prepareTranscript` instead, whose projection hands
 * it the prepared bytes and never a URL (ISS-12135). Deny the route explicitly:
 * the contract cannot rest on that projection while a generic GET relay stands
 * beside it.
 */
function isTranscriptCloudPath(path: string): boolean {
  // Test the pathname the request will actually resolve to. The main process
  // addresses the request with `new URL(path, origin)`, which collapses dot
  // segments (`foo/../transcript`, `%2e%2e`, a trailing `/.`) that a raw-string
  // test lets through. A path the URL parser rejects is left to the main
  // process, which answers it with its own "not a valid URL" error.
  let pathname: string;
  try {
    pathname = new URL(path, BRIDGE_PATH_RESOLUTION_ORIGIN).pathname;
  } catch {
    return false;
  }
  return TRANSCRIPT_CLOUD_PATH_PATTERN.test(pathname);
}

function copyApiPath(
  source: unknown,
  target: Record<string, unknown>,
  path: string[]
): void {
  const resolved = resolveApiValue(source, path);
  if (typeof resolved.value !== "function") {
    throw new Error(
      `Desktop browser bridge read API is missing: ${path.join(".")}`
    );
  }
  assignApiValue(
    target,
    path,
    projectApiMethod(path, resolved.value.bind(resolved.parent))
  );
}

/**
 * Copy a preload method the contract marks optional. An installed build may
 * predate the channel, and a missing one must leave the manifest entry absent
 * so the client's own optional-chained call site sees the same absence the
 * Electron renderer would, rather than failing the whole bridge handshake.
 */
function copyOptionalApiPath(
  source: unknown,
  target: Record<string, unknown>,
  path: string[],
  project: (method: (...args: unknown[]) => unknown) => unknown = (method) =>
    projectApiMethod(path, method)
): void {
  let resolved: ResolvedApiValue;
  try {
    resolved = resolveApiValue(source, path);
  } catch {
    return;
  }
  if (typeof resolved.value !== "function") {
    return;
  }
  assignApiValue(target, path, project(resolved.value.bind(resolved.parent)));
}

function copyApiValue(
  source: unknown,
  target: Record<string, unknown>,
  path: string[]
): void {
  const resolved = resolveApiValue(source, path);
  assignApiValue(target, path, resolved.value);
}

function assignApiValue(
  target: Record<string, unknown>,
  path: string[],
  value: unknown
): void {
  let current = target;
  for (const segment of path.slice(0, -1)) {
    const child = current[segment];
    if (isRecord(child)) {
      current = child;
      continue;
    }
    const next: Record<string, unknown> = {};
    current[segment] = next;
    current = next;
  }
  const leaf = path.at(-1);
  if (!leaf) {
    throw new Error("Desktop browser bridge API path is empty");
  }
  current[leaf] = value;
}

/**
 * `getRuntimeStatus` and `getSettings` answer with the WHOLE trusted record, and
 * the mirrored renderer reads a fraction of it. Both are typed
 * `Promise<unknown>`, so the field set is an allowlist derived from what the
 * renderer actually consumes rather than something a type could enforce.
 *
 * It is an allowlist, NOT a category ban, and the difference is load-bearing.
 * Path-shaped values the mirrored UI renders still cross — the global and
 * per-profile `sandboxBaseDirectory`, each always-allow rule's own `scopePath`,
 * and `fileAccessBlocks[].path` — because withholding them would blank the very
 * surfaces this mirror exists to show. What is withheld is what nothing reads.
 */
function projectApiMethod(
  path: string[],
  method: (...args: unknown[]) => unknown
): (...args: unknown[]) => unknown {
  const project = browserBridgeRecordProjections.get(path.join("."));
  if (!project) {
    return method;
  }
  return async (...args: unknown[]) => project(await method(...args));
}

/**
 * The settings record, narrowed at BOTH levels.
 *
 * An outer-level allowlist alone is not data minimization for a field whose
 * value is itself a record: `savedConfigs` is on the list because the Gateway
 * Profiles card renders it, and allowing the key let each saved profile cross
 * whole — its gateway public key, onboarding state, port and compute metadata
 * included, none of which any mirrored surface reads. The nested set is derived
 * the same way the outer one is: from what the renderer actually consumes.
 */
function projectSettings(value: unknown): Record<string, unknown> | null {
  const settings = projectRecord(value, BROWSER_BRIDGE_SETTINGS_KEYS);
  if (settings === null || !Array.isArray(settings.savedConfigs)) {
    return settings;
  }
  // An entry that is not a record contributes an empty one rather than crossing
  // untouched: falling back to the raw value would make a malformed profile the
  // one shape this projection does not narrow.
  settings.savedConfigs = settings.savedConfigs.map(
    (config) => projectRecord(config, BROWSER_BRIDGE_SAVED_CONFIG_KEYS) ?? {}
  );
  return settings;
}

function projectRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (allowedKeys.has(key)) {
      projected[key] = value[key];
    }
  }
  return projected;
}

const browserBridgeReadOnlyMethodPaths = [
  "agentSessionsApi.analytics",
  "agentSessionsApi.detail",
  "agentSessionsApi.list",
  "agentSessionsApi.pageData",
  "agentSessionsApi.usage",
  "branchesApi.analytics",
  "branchesApi.cohortAnalytics",
  "branchesApi.detail",
  "branchesApi.list",
  "branchesApi.pageData",
  "branchesApi.trace",
  "branchesApi.usage",
  "db.getAgentHierarchy",
  "db.getAgents",
  "db.getAnalytics",
  "db.getDashboardSummary",
  "db.getEventCountByType",
  "db.getEventFeed",
  "db.getEvents",
  "db.getEventsWithSession",
  "db.getInsights",
  "db.getKanbanPages",
  "db.getPrList",
  "db.getPrSessions",
  "db.getPrStats",
  "db.getSession",
  "db.getSessionDetails",
  "db.getSessions",
  "db.getSessionsPage",
  "db.getSessionsWithDetails",
  "db.getTokenAnalytics",
  "getAllFlags",
  "getDesktopAuthState",
  "getDesktopIdentity",
  "getGitHubIntegrationStatus",
  "getRuntimeStatus",
  "getSettings",
  // ISS-5489's consent record. No longer load-bearing for the mirror's STACK —
  // the read source stopped consulting consent on 2026-09-25, so a settled null
  // can no longer flip this mirror into Cloud mode — but it still has to cross
  // the bridge: the takeover gate and the Settings sync panel both read it, and
  // a mirror without it renders a device whose sync level cannot be seen or
  // changed.
  "getSyncConsentRecord",
  "onDbChanged",
  "onDesktopAuthStateChanged",
  "onFlagsChanged",
] as const;
// Optional in the preload contract (an older build may predate the channel), so
// these are copied only when the host actually exposes them.
const browserBridgeOptionalMethodPaths = [
  // ISS-9857: an installed build whose preload predates the events-page
  // channel must still mirror every read it does have; the local source then
  // omits `eventsPage` and the transcript panel offers no continuation.
  "agentSessionsApi.eventsPage",
  // ISS-10737: same version-skew reason — a preload predating the
  // invocation-tree channel still mirrors every read it does have, and the
  // local source then omits `sessionInvocationTree`.
  "agentSessionsApi.invocationTree",
  // ISS-12135: aborts the main-process download behind a bridged
  // `prepareTranscript`. `forceArchiveTranscript` stays off the bridge: it
  // queues an upload, which is a write.
  "cancelTranscriptPrepare",
  "onSyncConsentRecordChanged",
] as const;
const TRANSCRIPT_CLOUD_PATH_PATTERN =
  /^\/agent-sessions\/[^/]+\/transcript\/?$/;
// Only the resolved pathname is read; the host never reaches a request.
const BRIDGE_PATH_RESOLUTION_ORIGIN = "http://desktop-browser-bridge.invalid";

/**
 * Every runtime-status field a renderer surface reads. Deliberately absent:
 * `sandboxBaseDirectory` (a filesystem root no consumer reads), `relayOrigin`,
 * `apiOrigin`, `commandsPaused`, `connectionEnabled` and `dashboardReady`.
 *
 * Dropping a member here is not neutral: `use-runtime-status-poll` degrades an
 * absent field to a settled `null`, so the mirror would report "no import
 * running" rather than "not mirrored".
 */
const BROWSER_BRIDGE_RUNTIME_STATUS_KEYS: ReadonlySet<string> = new Set([
  "agentMonitor",
  "cloudReadReadiness",
  "cloudStatus",
  "cloudSync",
  "connectionSecurity",
  "fileAccessBlocks",
  "gatewayHealthy",
  "ingest",
  "isPackaged",
  "maintenance",
  "port",
  "serverAlive",
]);

/**
 * Settings the mirrored renderer reads by name. The Labs, Security and Data
 * Collection cards index the record by FLAG KEY, so the registry supplies that
 * half rather than a hand-copied list that would silently drop a new flag's row.
 * Deliberately absent: `binaryPaths` (the configured CLI locations),
 * `defaultApprovalTier` and `autoApprovalRules` — none of which any renderer
 * surface reads off this record. `alwaysAllowRules` and `sandboxBaseDirectory`
 * ARE read, by the Approvals panel and the sandbox cards, and therefore cross.
 */
const BROWSER_BRIDGE_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "activeConfigId",
  "alwaysAllowRules",
  "apiOrigin",
  // ISS-12135: read by the invite spotlight (`invite-spotlight-settings-answers.ts`).
  "inviteSpotlightAnsweredOrganizationIds",
  "relayOrigin",
  "sandboxBaseDirectory",
  "savedConfigs",
  "webAppOrigin",
  ...FEATURE_FLAGS.map((flag) => flag.key),
]);

/**
 * Every field of a SAVED GATEWAY PROFILE the mirrored renderer READS — each one
 * with a live read site, not merely a member of `GatewayProfileRowData`:
 * `gateway-profile-row.tsx` renders `name`, `relayOrigin`, `apiOrigin`,
 * `webAppOrigin` and `sandboxBaseDirectory`, and `gateway-profiles-card.tsx`
 * matches on `id` and branches on `hasCloudApiKey`.
 *
 * The type is the wrong oracle here, and `apiKeySource` is why: it is declared
 * on that type and read by nothing, so deriving this set from the declaration
 * put a field on the wire for a consumer that does not exist. Deliberately
 * absent for the same reason: the profile's gateway public key and connection
 * secrets, its onboarding state, its port, and its compute-target metadata.
 */
const BROWSER_BRIDGE_SAVED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "apiOrigin",
  "hasCloudApiKey",
  "id",
  "name",
  "relayOrigin",
  "sandboxBaseDirectory",
  "webAppOrigin",
]);

const browserBridgeRecordProjections = new Map<
  string,
  (value: unknown) => unknown
>([
  [
    "getRuntimeStatus",
    (value) => projectRecord(value, BROWSER_BRIDGE_RUNTIME_STATUS_KEYS),
  ],
  ["getSettings", projectSettings],
]);

type ResolvedApiValue = { parent: unknown; value: unknown };
