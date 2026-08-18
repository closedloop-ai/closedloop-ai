import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { CheckSeverity } from "@closedloop-ai/loops-api/compute-target";
import type { OperationDispatcher } from "../../src/server/operation-dispatcher.js";
import {
  _setRunCommandForTesting,
  registerHealthCheckRoutes,
} from "../../src/server/operations/health-check.js";
import type { McpDetectionResult } from "../../src/server/operations/mcp-detection.js";
import type { ProcessManager } from "../../src/server/process-manager.js";

/**
 * Shared harness for driving the real `GET /api/gateway/health-check` route.
 *
 * Extracted from `health-check-mcp.test.ts` (ISS-5369) so the app-version and
 * cascade suites drive the production route through the same helpers instead of
 * re-deriving a second copy of the dispatcher plumbing.
 */

export type CapturedResponse = {
  response: ServerResponse;
  chunks: string[];
  get statusCode(): number;
  get ended(): boolean;
};

export type CheckResultPayload = {
  id: string;
  label: string;
  required: boolean;
  passed: boolean;
  version?: string;
  error?: string;
  remediation?: string;
  enableAttempted?: boolean;
  enableOutcome?: "success" | "failed" | "timeout" | "skipped";
  enablePluginIds?: string[];
  updateAttempted?: boolean;
  updateOutcome?: "success" | "failed" | "timeout" | "skipped";
  updatePluginIds?: string[];
  remediationLinks?: Array<{ label: string; url: string }>;
  severity?: CheckSeverity;
  blockedBy?: string;
};

export const CLOSEDLOOP_PLUGINS = [
  { folder: "code", key: "code@closedloop-ai", label: "Symphony Plugin" },
  {
    folder: "self-learning",
    key: "self-learning@closedloop-ai",
    label: "Self-Learning Plugin",
  },
  { folder: "judges", key: "judges@closedloop-ai", label: "Judges Plugin" },
  {
    folder: "code-review",
    key: "code-review@closedloop-ai",
    label: "Code Review Plugin",
  },
  {
    folder: "platform",
    key: "platform@closedloop-ai",
    label: "Platform Plugin",
  },
] as const;

const tempDirs: string[] = [];

export const unavailableMcp = (): Promise<McpDetectionResult> =>
  Promise.resolve({
    available: false,
    serverName: null,
    matchedUrl: null,
    checkedAt: "2026-04-12T00:00:00.000Z",
    closedloopAvailable: false,
  });

export function makeResponse(): CapturedResponse {
  let statusCode = 0;
  const chunks: string[] = [];
  let ended = false;
  const response = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
    setHeader() {
      // no-op: the route only sets content-type.
    },
    flushHeaders() {
      // no-op: nothing streams on this route.
    },
    socket: {
      setNoDelay() {
        // no-op.
      },
    },
    write(chunk: unknown) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
      }
      return true;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
      }
      ended = true;
    },
  } as unknown as ServerResponse;

  return {
    response,
    chunks,
    get statusCode() {
      return statusCode;
    },
    get ended() {
      return ended;
    },
  };
}

export async function dispatchHealthCheck(
  dispatcher: OperationDispatcher,
  options: {
    expectedMcpUrl?: string;
    latestVersion?: string;
    pluginAutoUpdate?: boolean;
  } = {}
): Promise<CapturedResponse> {
  const captured = makeResponse();
  const query = new URLSearchParams();
  if (options.expectedMcpUrl) {
    query.set("expectedMcpUrl", options.expectedMcpUrl);
  }
  if (options.latestVersion !== undefined) {
    query.set("latestVersion", options.latestVersion);
  }
  if (options.pluginAutoUpdate) {
    query.set("pluginAutoUpdate", "1");
  }

  await dispatcher.dispatch({
    method: "GET",
    pathname: "/api/gateway/health-check",
    params: {},
    query,
    rawBody: Buffer.alloc(0),
    body: "",
    request: {} as IncomingMessage,
    response: captured.response,
  });
  return captured;
}

export function parsePayload(
  captured: CapturedResponse
): Record<string, unknown> {
  return JSON.parse(captured.chunks.join("")) as Record<string, unknown>;
}

export function getChecks(
  payload: Record<string, unknown>
): CheckResultPayload[] {
  if (!Array.isArray(payload.checks)) {
    throw new Error("health-check payload has no checks array");
  }
  return payload.checks as CheckResultPayload[];
}

export function findCheck(
  payload: Record<string, unknown>,
  id: string
): CheckResultPayload | undefined {
  return getChecks(payload).find((check) => check.id === id);
}

export function findAppVersion(
  payload: Record<string, unknown>
): CheckResultPayload | undefined {
  return findCheck(payload, "app-version");
}

export function findPluginCheck(
  checks: CheckResultPayload[],
  folder: string
): CheckResultPayload | undefined {
  return checks.find((check) => check.id === `plugin-${folder}`);
}

export async function makeTempHome(): Promise<string> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "health-check-home-")
  );
  tempDirs.push(tempDir);
  process.env.HOME = tempDir;
  return tempDir;
}

export async function removeTempHomes(): Promise<void> {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function writePluginRegistry(
  homeDir: string,
  entries: Record<string, Record<string, unknown>[]>
): Promise<void> {
  const registryDir = path.join(homeDir, ".claude", "plugins");
  await fs.mkdir(registryDir, { recursive: true });
  await fs.writeFile(
    path.join(registryDir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: entries })
  );
}

export async function createInstallPath(
  homeDir: string,
  plugin: string
): Promise<string> {
  const installPath = path.join(
    homeDir,
    ".claude",
    "plugins",
    "cache",
    "closedloop-ai",
    plugin,
    "1.0.0"
  );
  await fs.mkdir(installPath, { recursive: true });
  return installPath;
}

export async function writeAllUserScopedPlugins(
  homeDir: string,
  overrides: Record<string, Record<string, unknown>[]> = {}
): Promise<Record<string, Record<string, unknown>[]>> {
  const entries: Record<string, Record<string, unknown>[]> = {};
  for (const plugin of CLOSEDLOOP_PLUGINS) {
    entries[plugin.key] = [
      {
        installPath: await createInstallPath(homeDir, plugin.folder),
        scope: "user",
        version: "1.0.0",
      },
    ];
  }
  await writePluginRegistry(homeDir, { ...entries, ...overrides });
  return { ...entries, ...overrides };
}

export function buildPluginListJson(
  overrides: Record<string, unknown>[] = []
): string {
  return JSON.stringify([
    ...CLOSEDLOOP_PLUGINS.map((plugin) => ({
      enabled: true,
      id: plugin.key,
      scope: "user",
      version: "1.0.0",
    })),
    ...overrides,
  ]);
}

/** Register the route with every binary resolving, via a real executable path. */
export function registerHealthCheckWithStubbedBinaries(
  dispatcher: OperationDispatcher,
  binaryOverrides: Record<string, string> = {}
): void {
  registerHealthCheckRoutes(
    dispatcher,
    {} as unknown as ProcessManager,
    () => os.tmpdir(),
    unavailableMcp,
    () => ({
      claude: "/usr/bin/true",
      codex: "/usr/bin/true",
      gh: "/usr/bin/true",
      git: "/usr/bin/true",
      python3: "/usr/bin/true",
      ...binaryOverrides,
    })
  );
}

export function registerHealthCheckWithPluginList(
  dispatcher: OperationDispatcher,
  pluginListJson: string | null | (() => string | null)
): void {
  _setRunCommandForTesting((_cmd, args) => {
    const invocation = args.join(" ");
    // `null` models a `claude plugin list` that cannot RUN, so BOTH forms must
    // reject. Since ISS-5810 the reader falls back to the plain listing when
    // `--json` fails, and letting the catch-all answer that call would feed the
    // parser unrelated output and misreport the failure as unreadable output.
    if (invocation === "plugin list --json" || invocation === "plugin list") {
      const currentList =
        typeof pluginListJson === "function"
          ? pluginListJson()
          : pluginListJson;
      if (currentList === null) {
        return Promise.reject(makeCommandError("plugin list failed"));
      }
      if (invocation === "plugin list") {
        return Promise.reject(makeCommandError("unknown option '--json'"));
      }
      return Promise.resolve({ stdout: currentList });
    }
    return Promise.resolve({ stdout: "1.0.0" });
  });
  registerHealthCheckWithStubbedBinaries(dispatcher);
}

export function registerHealthCheckWithAppVersion(
  dispatcher: OperationDispatcher,
  getAppVersion?: () => string | undefined,
  isPackagedBuild?: () => boolean
): void {
  registerHealthCheckRoutes(
    dispatcher,
    {} as unknown as ProcessManager,
    () => os.tmpdir(),
    unavailableMcp,
    undefined,
    getAppVersion,
    isPackagedBuild
  );
}

/**
 * The shape `defaultRunCommand` throws: a real Error so the value is
 * throw-safe, carrying the `code`/`stderr` fields the health-check catch
 * blocks read.
 */
function makeCommandError(message: string): Error {
  return Object.assign(new Error(message), { code: "EUNKNOWN", stderr: "" });
}

/**
 * Asserts the `mcpServers` map a health-check response carries against the two
 * stubs that were injected: `passingClaude` (available) and `failingCodex`.
 *
 * The passing stub is passed through byte-for-byte — a green MCP row carries no
 * repair verdict. The failing one is its stub PLUS the gateway's repairability
 * annotation (ISS-5435), which every failing row now gets and which must always
 * explain itself, so a red row is never a dead affordance.
 *
 * A helper rather than inline asserts because `health-check-mcp.test.ts` is
 * grandfathered over the line ceiling and must not grow.
 */
export function assertInjectedMcpServers(
  mcpServers: Record<string, unknown>,
  passingClaude: unknown,
  failingCodex: Record<string, unknown>
): void {
  assert.deepEqual(mcpServers.claude, passingClaude);
  const codex = mcpServers.codex as Record<string, unknown> & {
    repair?: { repairable: boolean; reason?: string };
  };
  assert.equal(codex.repair?.repairable, false);
  assert.ok(
    (codex.repair?.reason ?? "").length > 0,
    "a failing MCP row must explain why it cannot be repaired"
  );
  const { repair: _repair, ...withoutRepair } = codex;
  assert.deepEqual(withoutRepair, failingCodex);
}
