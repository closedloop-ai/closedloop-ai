import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type InstalledPluginsFile = {
  version?: number;
  plugins?: Record<string, InstalledPluginEntry[]>;
};

type InstalledPluginEntry = {
  installPath?: string;
  version?: string;
  scope?: string;
  projectPath?: string;
  enabled?: boolean;
};

/**
 * Why a plugin's enabled state could not be read (ISS-5810).
 *
 * These three are NOT interchangeable — they have different remedies, and
 * collapsing them into one "unknown" is what put System Check in a closed loop:
 * every read failure produced the same `claude plugin enable` instruction, and
 * that command FAILS by design when the plugin is already enabled. Keep them
 * distinct so a row can state what actually could not be read.
 */
export const PluginEnabledUnverifiedReason = {
  /** `claude plugin list` could not be RUN (unresolvable binary, spawn error, timeout, non-zero exit). */
  CommandFailed: "command_failed",
  /** It ran, but its output could not be interpreted — an unknown or future CLI shape. */
  Unreadable: "unreadable",
  /** It ran and parsed, but reported no user-scoped enabled state for this plugin. */
  EnabledStateMissing: "enabled_state_missing",
} as const;
export type PluginEnabledUnverifiedReason =
  (typeof PluginEnabledUnverifiedReason)[keyof typeof PluginEnabledUnverifiedReason];

export type PluginInstallStatus = {
  pluginRef: string;
  hasValidUserScopedEntry: boolean;
  hasUserScopedEntry: boolean;
  hasExistingUserInstallPath: boolean;
  hasAnyInstallPath: boolean;
  disabled: boolean;
  enabledStateUnverified: boolean;
  /**
   * Set exactly when `enabledStateUnverified` is true. Callers pick the row's
   * error and remediation from this, never from the bare boolean.
   */
  enabledStateUnverifiedReason?: PluginEnabledUnverifiedReason;
  hasProjectScopedEntry: boolean;
  projectScopedPaths: string[];
  selectedUserVersion?: string;
};

export const CLOSEDLOOP_REQUIRED_PLUGIN_IDS = [
  "code@closedloop-ai",
  "code-review@closedloop-ai",
  "judges@closedloop-ai",
  "platform@closedloop-ai",
  "self-learning@closedloop-ai",
] as const;

export type PluginEnabledState = boolean | "unknown";

export type ClaudePluginInventoryEntry = {
  id: string;
  version?: string;
  enabled: PluginEnabledState;
  installPath?: string;
  /**
   * `user` / `project` as the CLI reported it, or `undefined` when the output
   * carried no scope at all. Undefined is NOT "user" — an entry we cannot place
   * in a scope cannot prove a user-scoped install (ISS-5810).
   */
  scope?: string;
  projectPath?: string;
};

/**
 * A completed attempt to read the Claude plugin inventory (ISS-5810).
 *
 * The old reader returned `string | null`, so "the command never ran" and "the
 * command ran and we could not read its output" arrived as the same `null` and
 * produced the same unusable remediation. This type keeps them apart all the
 * way to the check row.
 */
export type PluginListRead =
  | {
      status: "ok";
      source: "json" | "text";
      entries: ClaudePluginInventoryEntry[];
    }
  | { status: "command_failed"; detail?: string }
  | { status: "unreadable"; detail?: string };

/**
 * The statuses of a read that did NOT produce an inventory. Derived from
 * `PluginListRead` so a new failure member reaches every consumer that has to
 * state which failure it was, instead of being folded into one "unavailable".
 */
export type PluginListReadFailureStatus = Exclude<
  PluginListRead["status"],
  "ok"
>;

export function getPluginCacheRoot(override?: string): string {
  return (
    override ??
    path.join(os.homedir(), ".claude", "plugins", "cache", "closedloop-ai")
  );
}

export function compareSemverDescending(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (partsB[index] ?? 0) - (partsA[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function findPluginVersions(pluginDir: string): string[] {
  try {
    return readdirSync(pluginDir)
      .filter((entry) => /^\d+\.\d+\.\d+/.test(entry))
      .sort((a, b) => compareSemverDescending(a, b));
  } catch {
    return [];
  }
}

export function findPluginScript(
  pluginName: string,
  scriptName: string,
  cacheRoot?: string
): string | null {
  const pluginDir = path.join(getPluginCacheRoot(cacheRoot), pluginName);
  if (!existsSync(pluginDir)) {
    return null;
  }

  const versions = findPluginVersions(pluginDir);
  for (const version of versions) {
    const scriptPath = path.join(pluginDir, version, "scripts", scriptName);
    if (existsSync(scriptPath)) {
      return scriptPath;
    }
  }

  return null;
}

export function isPluginInstalled(
  pluginName: string,
  registryPath?: string
): boolean {
  return getPluginInstallStatus(pluginName, registryPath)
    .hasValidUserScopedEntry;
}

function getDefaultRegistryPath(): string {
  return path.join(
    os.homedir(),
    ".claude",
    "plugins",
    "installed_plugins.json"
  );
}

function readInstalledPluginsFile(
  registryPath?: string
): InstalledPluginsFile | null {
  try {
    return JSON.parse(
      readFileSync(registryPath ?? getDefaultRegistryPath(), "utf-8")
    ) as InstalledPluginsFile;
  } catch {
    return null;
  }
}

function readStringField(
  record: Record<string, unknown>,
  field: string
): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseEnabledField(value: unknown): PluginEnabledState {
  return typeof value === "boolean" ? value : "unknown";
}

function normalizePluginInventoryEntry(
  value: unknown
): ClaudePluginInventoryEntry | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = readStringField(record, "id") ?? readStringField(record, "name");
  if (!id) {
    return null;
  }

  return {
    id,
    enabled: parseEnabledField(record.enabled),
    ...(readStringField(record, "version")
      ? { version: readStringField(record, "version") }
      : {}),
    ...(readStringField(record, "installPath")
      ? { installPath: readStringField(record, "installPath") }
      : {}),
    ...(readStringField(record, "scope")
      ? { scope: readStringField(record, "scope") }
      : {}),
    ...(readStringField(record, "projectPath")
      ? { projectPath: readStringField(record, "projectPath") }
      : {}),
  };
}

function extractPluginListEntries(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as { installed?: unknown; plugins?: unknown };
  const entries = record.installed ?? record.plugins;
  return Array.isArray(entries) ? entries : null;
}

/**
 * Decode a parsed `claude plugin list --json` payload, or `null` when the
 * payload is not an inventory we can read.
 *
 * A NON-EMPTY container none of whose members decode is `null`, not an empty
 * inventory (ISS-5810 review): `[1]` and `[{"id":null}]` are valid JSON in an
 * unknown member shape, and reporting them as a successful empty read makes
 * "the CLI listed nothing" indistinguishable from "we could not read what the
 * CLI listed" — a lie the caller cannot detect, and one that also bypasses the
 * registry-proven-disabled precedence. A genuinely empty `[]` still decodes as
 * an empty inventory, because that IS a readable answer.
 */
function decodePluginListContainer(
  parsed: unknown
): ClaudePluginInventoryEntry[] | null {
  const entries = extractPluginListEntries(parsed);
  if (!entries) {
    return null;
  }
  const decoded = entries.flatMap((entry) => {
    const normalized = normalizePluginInventoryEntry(entry);
    return normalized ? [normalized] : [];
  });
  if (entries.length > 0 && decoded.length === 0) {
    return null;
  }
  return decoded;
}

/**
 * Parse `claude plugin list --json` output into canonical inventory entries.
 * Missing `enabled` fields are preserved as `unknown`, which health checks
 * treat as not ready for required slash-command plugins.
 *
 * Undecodable output yields an empty array here; callers that must tell an
 * empty inventory apart from an unreadable one use `interpretPluginListOutput`,
 * which keeps that distinction in its status.
 */
export function parseClaudePluginListJson(
  output: string
): ClaudePluginInventoryEntry[] {
  return decodePluginListContainer(JSON.parse(output) as unknown) ?? [];
}

/**
 * A plugin header line in the human-readable listing: the plugin id at the
 * start of the line, after optional indentation and an optional bullet glyph.
 *
 * EVERY plugin's header matches, not just `@closedloop-ai` (ISS-5810 review).
 * The id pattern is only what closes the previous record — a parser that
 * ignored third-party headers left the previous Closedloop record open, so the
 * NEXT plugin's `Scope:` and `Status:` lines were applied to it and a disabled
 * `code@closedloop-ai` followed by an enabled `context7@claude-plugins-official`
 * read as enabled. Filtering to Closedloop entries happens after parsing, on
 * the id, where it cannot corrupt a neighbouring record.
 */
const TEXT_PLUGIN_HEADER_REGEX =
  /^\s*(?:[^\w\s]\s*)?([A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+)(?=\s|$)/;
const TEXT_STATUS_ENABLED_REGEX = /Status:\s*(?:(?:✔|✓|\[x\])\s*)?enabled/i;
const TEXT_STATUS_DISABLED_REGEX = /Status:\s*(?:(?:✘|x|\[ \])\s*)?disabled/i;
const TEXT_SCOPE_REGEX = /Scope:\s*(\w+)/i;

/**
 * Parse human-readable `claude plugin list` output. This is a compatibility
 * fallback for CLI builds where JSON output is unavailable or malformed.
 *
 * Every plugin header closes the record before it, third-party plugins
 * included, so no plugin's fields can ever be attributed to another's entry.
 * Non-Closedloop plugins are returned too; callers select by id.
 */
export function parseClaudePluginListText(
  output: string
): ClaudePluginInventoryEntry[] {
  const entries: ClaudePluginInventoryEntry[] = [];
  let current: ClaudePluginInventoryEntry | null = null;

  for (const line of output.split(/\r?\n/)) {
    const idMatch = TEXT_PLUGIN_HEADER_REGEX.exec(line);
    if (idMatch?.[1]) {
      if (current) {
        entries.push(current);
      }
      current = { id: idMatch[1], enabled: "unknown" };
    }

    if (!current) {
      continue;
    }

    const scopeMatch = TEXT_SCOPE_REGEX.exec(line);
    if (scopeMatch?.[1]) {
      current.scope = scopeMatch[1].toLowerCase();
    }

    if (TEXT_STATUS_ENABLED_REGEX.test(line)) {
      current.enabled = true;
    } else if (TEXT_STATUS_DISABLED_REGEX.test(line)) {
      current.enabled = false;
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

/**
 * Rank an entry by how well it answers a USER-SCOPE question. Lower wins.
 * An unscoped entry outranks a project-scoped one because the human-readable
 * listing on some CLI builds carries no `Scope:` line at all, while a
 * project-scoped entry is positively about a different install.
 */
function userScopePreferenceRank(entry: ClaudePluginInventoryEntry): number {
  if (entry.scope === "user") {
    return 0;
  }
  return entry.scope === undefined ? 1 : 2;
}

/**
 * Convert inventory entries to an ID-keyed map for health-check lookups.
 *
 * The CLI can list the SAME id at more than one scope, and every consumer of
 * this map asks a user-scope question, so scope decides which duplicate wins
 * rather than input order (ISS-5810 review). Plain last-write-wins let an
 * enabled project-scoped entry displace a still-disabled user-scoped one and
 * report the enable as successful. Ties keep the first entry seen.
 */
export function toPluginInventoryMap(
  entries: ClaudePluginInventoryEntry[]
): Map<string, ClaudePluginInventoryEntry> {
  const map = new Map<string, ClaudePluginInventoryEntry>();
  for (const entry of entries) {
    const existing = map.get(entry.id);
    if (
      !existing ||
      userScopePreferenceRank(entry) < userScopePreferenceRank(existing)
    ) {
      map.set(entry.id, entry);
    }
  }
  return map;
}

/**
 * Whether an inventory entry PROVES the plugin is enabled for the user-scoped
 * install. An entry the CLI places at project scope is about a different
 * install and proves nothing here, so it must never satisfy this predicate
 * (ISS-5810 review). An entry with no scope at all is accepted, because the
 * human-readable listing on some CLI builds carries no scope.
 */
export function isUserScopeEnabled(
  entry: ClaudePluginInventoryEntry | undefined
): boolean {
  return entry?.enabled === true && entry.scope !== "project";
}

function parsePluginListEntries(
  listJson: string
): ClaudePluginInventoryEntry[] | null {
  try {
    return decodePluginListContainer(JSON.parse(listJson) as unknown);
  } catch {
    return null;
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function entryHasExistingInstallPath(
  entry: Pick<InstalledPluginEntry, "installPath">
): boolean {
  return Boolean(entry.installPath && existsSync(entry.installPath));
}

function isUserScopedRegistryEntry(entry: InstalledPluginEntry): boolean {
  return (
    entry.scope === "user" ||
    (entry.scope === undefined && entryHasExistingInstallPath(entry))
  );
}

/**
 * Classify a Closedloop plugin install across the registry and optional
 * `claude plugin list --json` snapshot. A valid install must be user scoped,
 * point at an existing install path, and have no disabled signal. Legacy
 * registry entries that predate `scope` are treated as user-scoped when their
 * install path still exists.
 */
export function getPluginInstallStatus(
  pluginName: string,
  registryPath?: string,
  listJson?: string | null
): PluginInstallStatus {
  return getPluginInstallStatusFromRead(
    pluginName,
    toPluginListRead(listJson),
    registryPath
  );
}

/**
 * Read installed plugin versions from the manifest.
 * Returns a map of "name@closedloop-ai" -> version string.
 */
export function getInstalledPluginVersions(
  registryPath?: string
): Record<string, string> {
  try {
    const data = readInstalledPluginsFile(registryPath);
    const result: Record<string, string> = {};
    if (!data?.plugins) {
      return result;
    }
    for (const [key, entries] of Object.entries(data.plugins)) {
      if (
        !(key.endsWith("@closedloop-ai") && entries) ||
        entries.length === 0
      ) {
        continue;
      }
      const pluginName = key.replace(/@closedloop-ai$/, "");
      const status = getPluginInstallStatus(pluginName, registryPath);
      if (status.hasValidUserScopedEntry) {
        result[key] = status.selectedUserVersion ?? "installed";
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** Semver pattern that also accepts pre-release / build metadata suffixes (AC-049 sandbox). */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+([-+][\w.]+)?$/;
const MAX_VERSION_LENGTH = 64;

function isValidSemver(value: string): boolean {
  return value.length <= MAX_VERSION_LENGTH && SEMVER_PATTERN.test(value);
}

/**
 * Return the installed version string for the `code@closedloop-ai` plugin.
 *
 * Resolution order:
 *  1. `CL_PLUGIN_VERSION` environment variable (AC-049 sandbox override).
 *  2. `getInstalledPluginVersions()` registry lookup for `code@closedloop-ai`.
 *
 * The resolved string is validated against a semver pattern and a 64-character
 * maximum length. Returns `'unknown'` on any failure.
 *
 * @param cacheRoot - Optional registry path override (forwarded to
 *   `getInstalledPluginVersions` for testability).
 */
export function getCodePluginVersion(cacheRoot?: string): string {
  try {
    // AC-049 sandbox: allow env-var override for controlled test environments.
    const envVersion = process.env.CL_PLUGIN_VERSION;
    if (envVersion) {
      return isValidSemver(envVersion) ? envVersion : "unknown";
    }

    const version = getInstalledPluginVersions(cacheRoot)["code@closedloop-ai"];
    if (!(version && isValidSemver(version))) {
      return "unknown";
    }
    return version;
  } catch {
    return "unknown";
  }
}

/**
 * Normalize the legacy `string | null | undefined` inventory argument into a
 * `PluginListRead`.
 *
 * `null` means the command never produced output, which is `command_failed`.
 * A non-JSON string is retried against the human-readable parser before it is
 * called unreadable, so a CLI build without `--json` still yields a verified
 * answer instead of the closed loop (ISS-5810).
 */
function toPluginListRead(
  listJson: string | null | undefined
): PluginListRead | undefined {
  if (listJson === undefined) {
    return;
  }
  if (listJson === null) {
    return { status: "command_failed" };
  }
  return interpretPluginListOutput(listJson);
}

/**
 * Interpret output from a `claude plugin list` invocation that RAN.
 *
 * The single interpreter for both callers — the legacy `string` argument on
 * `getPluginInstallStatus` and the health check's live reader. Keeping one
 * implementation is deliberate: two near-identical parsers on the "same"
 * surface are exactly how a local path and a production path silently diverge.
 *
 * JSON is preferred, then the human-readable listing. Anything else is
 * `unreadable` — a STATED unknown. The Claude CLI ships on its own cadence, so
 * an unrecognized or future shape must never crash and must never be mistaken
 * for an empty-but-valid inventory.
 */
export function interpretPluginListOutput(stdout: string): PluginListRead {
  const jsonEntries = parsePluginListEntries(stdout);
  if (jsonEntries) {
    return { status: "ok", source: "json", entries: jsonEntries };
  }

  const textEntries = parseClaudePluginListText(stdout);
  if (textEntries.length > 0) {
    return { status: "ok", source: "text", entries: textEntries };
  }

  return { status: "unreadable" };
}

type EnabledStateVerdict = {
  disabled: boolean;
  unverifiedReason?: PluginEnabledUnverifiedReason;
};

/**
 * Decide what a completed inventory read proves about one plugin's enabled
 * state, given whether the local registry says it is installed at user scope.
 *
 * The read is authoritative when it succeeded: an entry the CLI reports as
 * user-scoped and enabled is PROOF of enabled, and an entry it reports as
 * disabled is PROOF of disabled. Only genuinely unreadable outcomes produce an
 * unverified reason, and each names what could not be read.
 */
function classifyEnabledState(
  read: PluginListRead | undefined,
  userListEntries: ClaudePluginInventoryEntry[],
  hasExistingUserInstallPath: boolean,
  registryDisabled: boolean
): EnabledStateVerdict {
  if (!read) {
    // No inventory was requested — registry-only classification, unchanged.
    return { disabled: registryDisabled };
  }

  if (read.status === "ok") {
    return classifyReadInventory(userListEntries, hasExistingUserInstallPath);
  }

  // Evidence outranks not-determinable (ISS-5389): the local registry can still
  // PROVE the plugin is switched off even when the CLI read failed, and that is
  // a directly actionable finding — do not downgrade it to unknown.
  if (registryDisabled) {
    return { disabled: true };
  }
  if (!hasExistingUserInstallPath) {
    return { disabled: false };
  }
  // `read.status` is narrowed to the two failure members, each of which is also
  // a `PluginEnabledUnverifiedReason`. A new failure member added to
  // `PluginListRead` without a matching reason fails `tsc` here.
  const unverifiedReason: PluginEnabledUnverifiedReason = read.status;
  return { disabled: false, unverifiedReason };
}

/**
 * Classify from an inventory read that SUCCEEDED. The entries are authoritative
 * here: an entry the CLI reports as user-scoped and enabled is proof of
 * enabled, and one it reports as disabled is proof of disabled.
 */
function classifyReadInventory(
  userListEntries: ClaudePluginInventoryEntry[],
  hasExistingUserInstallPath: boolean
): EnabledStateVerdict {
  if (userListEntries.some((entry) => entry.enabled === false)) {
    return { disabled: true };
  }
  if (userListEntries.some((entry) => entry.enabled === true)) {
    return { disabled: false };
  }

  // The read succeeded but proves nothing about this plugin at user scope. When
  // the registry says it IS installed there, the two sources disagree — state
  // that rather than guessing. This also covers a CLI that exits 0 with an
  // empty inventory, which would otherwise silently read as "not installed".
  if (hasExistingUserInstallPath) {
    return {
      disabled: false,
      unverifiedReason: PluginEnabledUnverifiedReason.EnabledStateMissing,
    };
  }
  return { disabled: false };
}

/**
 * Classify a Closedloop plugin install across the local registry and a
 * completed `claude plugin list` read.
 *
 * A valid install must be user scoped, point at an existing install path, and
 * be positively confirmed enabled by a successful read (or have no read
 * requested at all). Legacy registry entries that predate `scope` are treated
 * as user-scoped when their install path still exists.
 */
export function getPluginInstallStatusFromRead(
  pluginName: string,
  read?: PluginListRead,
  registryPath?: string
): PluginInstallStatus {
  const pluginRef = `${pluginName}@closedloop-ai`;
  const data = readInstalledPluginsFile(registryPath);
  const registryEntries = data?.plugins?.[pluginRef] ?? [];
  const userRegistryEntries = registryEntries.filter(isUserScopedRegistryEntry);
  const projectRegistryEntries = registryEntries.filter(
    (entry) => entry.scope === "project"
  );
  const existingUserEntries = userRegistryEntries.filter(
    entryHasExistingInstallPath
  );
  const hasExistingUserInstallPath = existingUserEntries.length > 0;

  const listEntries = read?.status === "ok" ? read.entries : [];
  const matchingListEntries = listEntries.filter(
    (entry) => entry.id === pluginRef
  );
  const userListEntries = matchingListEntries.filter(
    (entry) => entry.scope === "user"
  );
  const projectListEntries = matchingListEntries.filter(
    (entry) => entry.scope === "project"
  );

  const verdict = classifyEnabledState(
    read,
    userListEntries,
    hasExistingUserInstallPath,
    existingUserEntries.some((entry) => entry.enabled === false)
  );
  const enabledStateUnverified = verdict.unverifiedReason !== undefined;
  const selectedUserEntry = [...existingUserEntries]
    .reverse()
    .find((entry) => entry.enabled !== false);
  const hasProjectScopedEntry =
    projectRegistryEntries.length > 0 || projectListEntries.length > 0;
  const projectScopedPaths = uniqueStrings([
    ...projectRegistryEntries
      .map((entry) => entry.projectPath ?? "")
      .filter(Boolean),
    ...projectListEntries
      .map((entry) => entry.projectPath ?? "")
      .filter(Boolean),
  ]);

  return {
    pluginRef,
    hasValidUserScopedEntry:
      hasExistingUserInstallPath &&
      !verdict.disabled &&
      !enabledStateUnverified,
    hasUserScopedEntry: userRegistryEntries.length > 0,
    hasExistingUserInstallPath,
    hasAnyInstallPath: registryEntries.some(entryHasExistingInstallPath),
    disabled: verdict.disabled,
    enabledStateUnverified,
    ...(verdict.unverifiedReason
      ? { enabledStateUnverifiedReason: verdict.unverifiedReason }
      : {}),
    hasProjectScopedEntry,
    projectScopedPaths,
    selectedUserVersion: selectedUserEntry?.version,
  };
}
