import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { GatewayCheckResult as CheckResult } from "../../src/server/operations/health-check-types.js";
import type { McpDetectionResult } from "../../src/server/operations/mcp-detection.js";

/**
 * Shared fixtures for the gateway health-check suites (`health-check-mcp` and
 * `health-check-repair`). Extracted so the two do not keep two copies of the
 * plugin registry / captured-response scaffolding that must agree to be useful.
 */

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

export type CapturedResponse = {
  response: ServerResponse;
  chunks: string[];
  get statusCode(): number;
  get ended(): boolean;
};

export const unavailableMcp = async (): Promise<McpDetectionResult> => ({
  available: false,
  serverName: null,
  matchedUrl: null,
  checkedAt: "2026-04-12T00:00:00.000Z",
  closedloopAvailable: false,
});

/** Temp dirs created by these fixtures, drained by `cleanupTempDirs`. */
export const tempDirs: string[] = [];

export async function makeTempHome(): Promise<string> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "health-check-home-")
  );
  tempDirs.push(tempDir);
  process.env.HOME = tempDir;
  return tempDir;
}

export async function cleanupTempDirs(): Promise<void> {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

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
      // headers are irrelevant to these assertions
    },
    flushHeaders() {
      // no-op: nothing streams in these suites
    },
    socket: { setNoDelay() {} },
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

export function parsePayload(
  captured: CapturedResponse
): Record<string, unknown> {
  return JSON.parse(captured.chunks.join("")) as Record<string, unknown>;
}

export function getChecks(payload: Record<string, unknown>): CheckResult[] {
  if (!Array.isArray(payload.checks)) {
    throw new Error("health-check payload has no `checks` array");
  }
  return payload.checks as CheckResult[];
}

export function findPluginCheck(
  checks: CheckResult[],
  folder: string
): CheckResult | undefined {
  return checks.find((check) => check.id === `plugin-${folder}`);
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
