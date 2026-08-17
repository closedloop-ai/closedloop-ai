import fs, { constants } from "node:fs/promises";
import path from "node:path";
import { resolveBinaryFromLoginShell } from "../shell-path.js";
import {
  CLOSEDLOOP_USER_PLUGINS,
  type ClosedloopUserPlugin,
  type PluginRemediationDeadline,
} from "./health-check-plugin-enable.js";
import { CLOSEDLOOP_MARKETPLACE_NAME } from "./health-check-types.js";

/**
 * Where the PUBLISHED Closedloop plugin versions come from, split out of
 * `health-check.ts` (ISS-5435).
 *
 * Two sources, in preference order: the locally-configured marketplace checkout
 * (the exact tree `claude plugin update` installs from, so a staleness verdict
 * against it is actionable), else the manifests published on GitHub. Neither
 * belongs in the 2,000-line sweep module — the sweep only asks "what is the
 * latest version?" and this answers it. The deadline-bounded command primitive
 * is handed in as a runtime, exactly as `PluginEnableRuntime` does, so this
 * module never imports back into its caller.
 */

export type PluginManifest = {
  plugin: ClosedloopUserPlugin;
  latestVersion?: string;
  error?: "manifest_unavailable";
};

export type ClaudeMarketplaceListEntry = {
  name?: unknown;
  source?: unknown;
  path?: unknown;
  installLocation?: unknown;
};

/** The deadline-bounded primitives this module needs from the sweep. */
export type PluginManifestRuntime = {
  hasDeadlineExpired: (deadline: PluginRemediationDeadline) => boolean;
  runCommandWithinDeadline: (
    cmd: string,
    args: string[],
    options?: { deadline?: PluginRemediationDeadline; timeoutMs?: number }
  ) => Promise<{ stdout: string }>;
  boundedTimeoutMs: (
    deadline: PluginRemediationDeadline | undefined,
    maxTimeoutMs: number
  ) => number;
  runValueWithinDeadline: <T>(
    run: (timeoutMs: number) => Promise<T>,
    deadline: PluginRemediationDeadline,
    createTimeoutValue: (startedAt: number) => T,
    maxTimeoutMs?: number
  ) => Promise<T>;
};

/**
 * Every plugin reported as "latest version unknown". Unknown is not
 * out-of-date, and the caller renders it as such.
 */
export function createUnavailablePluginManifests(): PluginManifest[] {
  return CLOSEDLOOP_USER_PLUGINS.map((plugin) => ({
    plugin,
    error: "manifest_unavailable",
  }));
}

export async function fetchPluginManifests(options: {
  claudeOverride?: string;
  remediationDeadline?: PluginRemediationDeadline;
  preferConfiguredMarketplace: boolean;
  runtime: PluginManifestRuntime;
}): Promise<PluginManifest[]> {
  if (
    options.remediationDeadline &&
    options.runtime.hasDeadlineExpired(options.remediationDeadline)
  ) {
    return createUnavailablePluginManifests();
  }
  if (options.preferConfiguredMarketplace) {
    const configuredMarketplaceManifests = options.remediationDeadline
      ? await options.runtime.runValueWithinDeadline(
          () =>
            readConfiguredMarketplaceManifests(
              options.runtime,
              options.claudeOverride,
              options.remediationDeadline
            ),
          options.remediationDeadline,
          createUnavailablePluginManifests,
          options.remediationDeadline.timeoutMs
        )
      : await readConfiguredMarketplaceManifests(
          options.runtime,
          options.claudeOverride,
          options.remediationDeadline
        );
    if (configuredMarketplaceManifests) {
      return configuredMarketplaceManifests;
    }
  }

  const timeoutMs = options.runtime.boundedTimeoutMs(
    options.remediationDeadline,
    3000
  );
  if (timeoutMs <= 0) {
    return createUnavailablePluginManifests();
  }

  const results = await Promise.allSettled(
    CLOSEDLOOP_USER_PLUGINS.map((plugin) =>
      fetch(
        `https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main/plugins/${plugin.folder}/.claude-plugin/plugin.json`,
        { signal: AbortSignal.timeout(timeoutMs) }
      )
    )
  );

  return Promise.all(
    CLOSEDLOOP_USER_PLUGINS.map(
      async (plugin, index): Promise<PluginManifest> => {
        const result = results[index];
        if (result.status === "rejected" || !result.value.ok) {
          return { plugin, error: "manifest_unavailable" };
        }
        try {
          const body = (await result.value.json()) as { version?: unknown };
          return typeof body.version === "string"
            ? { plugin, latestVersion: body.version }
            : { plugin, error: "manifest_unavailable" };
        } catch {
          return { plugin, error: "manifest_unavailable" };
        }
      }
    )
  );
}

async function readConfiguredMarketplaceManifests(
  runtime: PluginManifestRuntime,
  claudeOverride?: string,
  deadline?: PluginRemediationDeadline
): Promise<PluginManifest[] | null> {
  const root = await resolveConfiguredMarketplaceRoot(
    runtime,
    claudeOverride,
    deadline
  );
  if (!root) {
    return null;
  }

  let marketplacePlugins: Record<string, unknown>[];
  try {
    const marketplaceJson = JSON.parse(
      await fs.readFile(
        path.join(root, ".claude-plugin", "marketplace.json"),
        "utf-8"
      )
    ) as { plugins?: unknown };
    marketplacePlugins = Array.isArray(marketplaceJson.plugins)
      ? marketplaceJson.plugins.filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null
        )
      : [];
  } catch {
    return CLOSEDLOOP_USER_PLUGINS.map((plugin) => ({
      plugin,
      error: "manifest_unavailable",
    }));
  }

  return Promise.all(
    CLOSEDLOOP_USER_PLUGINS.map(async (plugin): Promise<PluginManifest> => {
      const marketplaceEntry = marketplacePlugins.find(
        (entry) => entry.name === plugin.folder
      );
      const source =
        typeof marketplaceEntry?.source === "string"
          ? marketplaceEntry.source
          : undefined;
      if (!source) {
        return { plugin, error: "manifest_unavailable" };
      }

      try {
        const pluginJsonPath = path.resolve(
          root,
          source,
          ".claude-plugin",
          "plugin.json"
        );
        const body = JSON.parse(await fs.readFile(pluginJsonPath, "utf-8")) as {
          version?: unknown;
        };
        return typeof body.version === "string"
          ? { plugin, latestVersion: body.version }
          : { plugin, error: "manifest_unavailable" };
      } catch {
        return { plugin, error: "manifest_unavailable" };
      }
    })
  );
}

/**
 * Marketplace source types that expose a local on-disk checkout we can read
 * plugin manifests from. `directory` marketplaces point straight at a folder;
 * `github`/`git` marketplaces are cloned locally to `installLocation`. For all
 * three, that local checkout is the exact source `claude plugin update` installs
 * from, so comparing against it keeps the staleness verdict actionable. (FEA-2751)
 */
const MARKETPLACE_SOURCES_WITH_LOCAL_CHECKOUT = new Set([
  "directory",
  "github",
  "git",
]);

/**
 * Resolve the local checkout path for the Closedloop marketplace, if one exists.
 * `directory` marketplaces expose it via `path`; cloned `github`/`git`
 * marketplaces expose it via `installLocation`.
 */
function resolveMarketplaceCheckoutPath(
  marketplace: ClaudeMarketplaceListEntry
): string | undefined {
  if (
    typeof marketplace.source !== "string" ||
    !MARKETPLACE_SOURCES_WITH_LOCAL_CHECKOUT.has(marketplace.source)
  ) {
    return undefined;
  }
  if (typeof marketplace.path === "string" && marketplace.path.length > 0) {
    return marketplace.path;
  }
  if (
    typeof marketplace.installLocation === "string" &&
    marketplace.installLocation.length > 0
  ) {
    return marketplace.installLocation;
  }
  return undefined;
}

async function resolveConfiguredMarketplaceRoot(
  runtime: PluginManifestRuntime,
  claudeOverride?: string,
  deadline?: PluginRemediationDeadline
): Promise<string | null> {
  const resolved = await resolveBinaryFromLoginShell("claude", claudeOverride);
  if (resolved.source === "override_invalid") {
    return null;
  }

  try {
    const { stdout } = await runtime.runCommandWithinDeadline(
      resolved.path,
      ["plugin", "marketplace", "list", "--json"],
      { deadline }
    );
    const entries = JSON.parse(stdout) as unknown;
    if (!Array.isArray(entries)) {
      return null;
    }

    const marketplace = entries.find(
      (entry): entry is ClaudeMarketplaceListEntry => {
        if (typeof entry !== "object" || entry === null) {
          return false;
        }
        const record = entry as ClaudeMarketplaceListEntry;
        return record.name === CLOSEDLOOP_MARKETPLACE_NAME;
      }
    );
    if (!marketplace) {
      return null;
    }

    const checkoutRoot = resolveMarketplaceCheckoutPath(marketplace);
    if (!(checkoutRoot && path.isAbsolute(checkoutRoot))) {
      return null;
    }

    // Only treat the local checkout as authoritative when it actually exists.
    // Otherwise return null so the caller falls back to the GitHub manifest
    // fetch, rather than reporting an unverifiable version. (FEA-2751)
    try {
      await fs.access(
        path.join(checkoutRoot, ".claude-plugin", "marketplace.json"),
        constants.F_OK
      );
    } catch {
      return null;
    }

    return checkoutRoot;
  } catch {
    return null;
  }
}
