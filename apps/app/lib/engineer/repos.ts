import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ConfiguredRepo, RepoSettings, ReposConfig } from "@/types/repos";

/**
 * Global config directory: ~/.closedloop-ai/
 * Repos config is stored here so it persists across worktrees and checkouts.
 */
const CONFIG_DIR = join(homedir(), ".closedloop-ai");
const REPOS_CONFIG_PATH = join(CONFIG_DIR, "repos.json");

/**
 * Legacy location: {cwd}/.cache/repos.json
 * Checked on every load for migration, then deleted.
 */
const LEGACY_CONFIG_PATH = join(process.cwd(), ".cache", "repos.json");

/**
 * Previous global config location: ~/.claude/closedloop/repos.json
 * Migrated to ~/.closedloop-ai/repos.json on first load.
 */
const LEGACY_CLAUDE_CONFIG_PATH = join(
  homedir(),
  ".claude",
  "closedloop",
  "repos.json"
);

const DEFAULT_REPOS: ConfiguredRepo[] = [];
const DEFAULT_SETTINGS: RepoSettings = {};

/**
 * Expand ~ to home directory
 */
export function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/**
 * Contract home directory to ~
 */
export function contractHome(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Migrate repos from the legacy {cwd}/.cache/repos.json into the global config.
 * Merges repos (deduplicates by normalized path), prefers global settings,
 * then deletes the legacy file.
 */
function migrateLegacyConfig(global: ReposConfig): ReposConfig {
  if (!existsSync(LEGACY_CONFIG_PATH)) {
    return global;
  }

  let legacy: ReposConfig;
  try {
    const content = readFileSync(LEGACY_CONFIG_PATH, "utf-8");
    legacy = JSON.parse(content) as ReposConfig;
  } catch {
    // Corrupt file — just delete it
    removeLegacyConfig();
    return global;
  }

  const legacyRepos = legacy.repos ?? [];
  if (legacyRepos.length === 0) {
    removeLegacyConfig();
    return global;
  }

  // Deduplicate: only add legacy repos whose path isn't already in global
  const existingPaths = new Set(global.repos.map((r) => expandHome(r.path)));
  const mergedRepos = [...global.repos];
  let merged = false;
  for (const repo of legacyRepos) {
    if (!existingPaths.has(expandHome(repo.path))) {
      mergedRepos.push(repo);
      existingPaths.add(expandHome(repo.path));
      merged = true;
    }
  }

  // Merge settings: global wins, legacy fills gaps
  let mergedSettings = global.settings;
  if (legacy.settings) {
    mergedSettings = { ...legacy.settings, ...global.settings };
    merged = true;
  }

  if (merged) {
    console.log(
      `[repos] Migrated ${legacyRepos.length} repo(s) from legacy .cache/repos.json`
    );
  }

  removeLegacyConfig();
  return merged ? { repos: mergedRepos, settings: mergedSettings } : global;
}

function removeLegacyConfig(): void {
  try {
    rmSync(LEGACY_CONFIG_PATH, { force: true });
    // Clean up .cache dir if empty
    const cacheDir = join(process.cwd(), ".cache");
    if (existsSync(cacheDir) && readdirSync(cacheDir).length === 0) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Migrate repos.json from the previous global location (~/.claude/closedloop/)
 * into the new global config dir (~/.closedloop-ai/).
 * Only runs when the new config doesn't exist yet and the old one does.
 * Copies the file and cleans up the old directory if empty.
 */
function migrateLegacyClaudeConfig(global: ReposConfig): ReposConfig {
  if (existsSync(REPOS_CONFIG_PATH) || !existsSync(LEGACY_CLAUDE_CONFIG_PATH)) {
    return global;
  }

  try {
    const content = readFileSync(LEGACY_CLAUDE_CONFIG_PATH, "utf-8");
    const legacy = JSON.parse(content) as ReposConfig;

    ensureConfigDir();
    writeFileSync(REPOS_CONFIG_PATH, content);

    // Clean up legacy file and directory
    rmSync(LEGACY_CLAUDE_CONFIG_PATH, { force: true });
    const legacyDir = dirname(LEGACY_CLAUDE_CONFIG_PATH);
    if (existsSync(legacyDir) && readdirSync(legacyDir).length === 0) {
      rmSync(legacyDir, { recursive: true, force: true });
    }

    console.log(
      "[repos] Migrated config from ~/.claude/closedloop/ to ~/.closedloop-ai/"
    );

    return {
      repos: [...(legacy.repos ?? DEFAULT_REPOS)],
      settings: { ...(legacy.settings ?? DEFAULT_SETTINGS) },
    };
  } catch {
    return global;
  }
}

/**
 * Load repos configuration from ~/.closedloop-ai/repos.json.
 * On every load, checks for a legacy .cache/repos.json in the cwd and
 * migrates any repos from it before deleting the old file.
 */
export function loadReposConfig(): ReposConfig {
  ensureConfigDir();

  let config: ReposConfig;
  let needsSave = false;

  if (existsSync(REPOS_CONFIG_PATH)) {
    try {
      const content = readFileSync(REPOS_CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(content) as ReposConfig;
      config = {
        repos: [...(parsed.repos ?? DEFAULT_REPOS)],
        settings: { ...(parsed.settings ?? DEFAULT_SETTINGS) },
      };
    } catch (err) {
      console.error("[repos] Failed to load config:", err);
      config = {
        repos: [...DEFAULT_REPOS],
        settings: { ...DEFAULT_SETTINGS },
      };
      needsSave = true; // Overwrite corrupt file with healthy defaults
    }
  } else {
    config = {
      repos: [...DEFAULT_REPOS],
      settings: { ...DEFAULT_SETTINGS },
    };
    needsSave = true; // Create file on first load
  }

  // Migrate from ~/.claude/closedloop/repos.json (previous global location)
  config = migrateLegacyClaudeConfig(config);

  // Check for legacy file before migration (migration deletes it)
  const hadLegacyConfig = existsSync(LEGACY_CONFIG_PATH);
  config = migrateLegacyConfig(config);
  needsSave = needsSave || hadLegacyConfig;

  // Only write when something actually changed
  if (needsSave) {
    saveReposConfig(config);
  }

  return config;
}

/**
 * Save repos configuration to ~/.claude/closedloop/repos.json
 */
export function saveReposConfig(config: ReposConfig): void {
  ensureConfigDir();

  try {
    writeFileSync(REPOS_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    console.error("[repos] Failed to save config:", err);
    throw new Error("Failed to save repos configuration");
  }
}

/**
 * Check if candidatePath is a git worktree whose .git pointer resolves
 * under repoPath/.git/worktrees/. This proves actual git ownership,
 * not just a naming convention match.
 */
function isWorktreeOf(candidatePath: string, repoPath: string): boolean {
  try {
    const content = readFileSync(join(candidatePath, ".git"), "utf-8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(content);
    if (!match) {
      return false;
    }
    const gitdir = resolve(candidatePath, match[1]);
    return gitdir.startsWith(`${join(repoPath, ".git", "worktrees")}/`);
  } catch {
    return false;
  }
}

/**
 * Check if a path is in the configured repos or is a worktree derived from one.
 * Validates worktrees by checking the .git pointer file links back to the
 * allowed repo, not just by directory naming convention.
 */
export function isRepoAllowed(path: string): boolean {
  const config = loadReposConfig();
  const expandedPath = expandHome(path);
  const worktreeParent = config.settings.worktreeParentDir
    ? expandHome(config.settings.worktreeParentDir)
    : null;

  return config.repos.some((repo) => {
    const repoExpanded = expandHome(repo.path);
    const repoName = basename(repoExpanded);
    const repoParent = dirname(repoExpanded);
    const pathName = basename(expandedPath);
    const pathParent = dirname(expandedPath);

    // Exact match (dirname/basename normalizes trailing slashes)
    if (repoName === pathName && repoParent === pathParent) {
      return true;
    }

    // Worktree match: check parent dir (repo sibling OR configured worktreeParentDir),
    // name prefix filter, then validate actual git worktree linkage via .git pointer file
    const parentMatch =
      pathParent === repoParent ||
      (worktreeParent !== null && pathParent === worktreeParent);
    return (
      parentMatch &&
      pathName.startsWith(`${repoName}-`) &&
      isWorktreeOf(expandedPath, repoExpanded)
    );
  });
}

/**
 * Get the list of configured repos for UI
 */
export function getConfiguredReposList(): ConfiguredRepo[] {
  const config = loadReposConfig();
  return config.repos;
}

/**
 * Add a new repo to the configuration
 */
export function addRepo(
  path: string,
  description?: string
): { success: boolean; error?: string; repo?: ConfiguredRepo } {
  const config = loadReposConfig();

  // Normalize path
  const normalizedPath = path.startsWith("~/") ? path : contractHome(path);
  const expandedPath = expandHome(normalizedPath);

  // Check if repo already exists
  if (config.repos.some((r) => r.path === normalizedPath)) {
    return { success: false, error: "Repository already exists" };
  }

  // Check if path exists
  if (!existsSync(expandedPath)) {
    return { success: false, error: "Path does not exist" };
  }

  // Check if it's a git repo
  const gitDir = join(expandedPath, ".git");
  if (!existsSync(gitDir)) {
    return { success: false, error: "Not a git repository" };
  }

  const repo: ConfiguredRepo = {
    path: normalizedPath,
    name: basename(expandedPath),
    description,
    addedAt: new Date().toISOString(),
  };

  config.repos.push(repo);
  saveReposConfig(config);

  return { success: true, repo };
}

/**
 * Remove a repo from the configuration
 */
export function removeRepo(path: string): { success: boolean; error?: string } {
  const config = loadReposConfig();

  // Normalize path
  const normalizedPath = path.startsWith("~/") ? path : contractHome(path);

  const index = config.repos.findIndex((r) => r.path === normalizedPath);
  if (index === -1) {
    return { success: false, error: "Repository not found" };
  }

  config.repos.splice(index, 1);
  saveReposConfig(config);

  return { success: true };
}

/**
 * Update repo settings
 */
export function updateSettings(settings: Partial<RepoSettings>): {
  success: boolean;
  error?: string;
} {
  const config = loadReposConfig();

  config.settings = {
    ...config.settings,
    ...settings,
  };

  saveReposConfig(config);

  return { success: true };
}

/**
 * Get the worktree parent directory (expanded).
 * Throws if not yet configured — the UI setup dialog should prevent this.
 */
export function getWorktreeParentDir(): string {
  const config = loadReposConfig();
  if (!config.settings.worktreeParentDir) {
    throw new Error(
      "Worktree parent directory not configured. Please set it in the dashboard."
    );
  }
  return expandHome(config.settings.worktreeParentDir);
}

/**
 * Compare two semver version strings numerically.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) {
      return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
  }
  return 0;
}

/**
 * Find the latest semver version directory containing a given script
 * within a plugin cache directory.
 */
function findLatestPluginScript(
  pluginDir: string,
  scriptRelPath: string
): string | undefined {
  if (!existsSync(pluginDir)) {
    return undefined;
  }

  let entries: string[];
  try {
    entries = readdirSync(pluginDir);
  } catch {
    return undefined;
  }

  const versions = entries
    .filter((name) => /^\d+\.\d+\.\d+/.test(name))
    .filter((name) => existsSync(join(pluginDir, name, scriptRelPath)))
    .sort(compareSemver);

  if (versions.length === 0) {
    return undefined;
  }

  return join(pluginDir, versions.at(-1)!, scriptRelPath);
}

/**
 * Auto-discover the Symphony run-loop.sh script path.
 * Scans $HOME/.claude/plugins/cache/closedloop-ai/code/ for the latest
 * semver version directory containing scripts/run-loop.sh.
 * Returns undefined if not found.
 */
export const REQUIRED_SYMPHONY_PLUGINS = [
  "code@closedloop-ai",
  "self-learning@closedloop-ai",
  "judges@closedloop-ai",
  "code-review@closedloop-ai",
  "platform@closedloop-ai",
  "code-simplifier@claude-plugins-official",
] as const;

export type PluginCheckResult = {
  allInstalled: boolean;
  missing: string[];
  installed: Record<string, string>;
  reason: "ok" | "manifest_missing" | "manifest_malformed" | "plugins_missing";
};

/**
 * Read ~/.claude/plugins/installed_plugins.json and check for required plugins.
 * Returns which plugins are installed, which are missing, and why.
 */
export function checkRequiredPlugins(): PluginCheckResult {
  const manifestPath = join(
    homedir(),
    ".claude",
    "plugins",
    "installed_plugins.json"
  );

  if (!existsSync(manifestPath)) {
    return {
      allInstalled: false,
      missing: [...REQUIRED_SYMPHONY_PLUGINS],
      installed: {},
      reason: "manifest_missing",
    };
  }

  let manifest: { plugins?: Record<string, { version?: string }[]> };
  try {
    const content = readFileSync(manifestPath, "utf-8");
    manifest = JSON.parse(content);
  } catch {
    return {
      allInstalled: false,
      missing: [...REQUIRED_SYMPHONY_PLUGINS],
      installed: {},
      reason: "manifest_malformed",
    };
  }

  if (!manifest.plugins || typeof manifest.plugins !== "object") {
    return {
      allInstalled: false,
      missing: [...REQUIRED_SYMPHONY_PLUGINS],
      installed: {},
      reason: "manifest_malformed",
    };
  }

  const installed: Record<string, string> = {};
  const missing: string[] = [];

  for (const pluginKey of REQUIRED_SYMPHONY_PLUGINS) {
    const entries = manifest.plugins[pluginKey];
    if (Array.isArray(entries) && entries.length > 0) {
      const lastEntry = entries.at(-1)!;
      installed[pluginKey] = lastEntry.version ?? "installed";
    } else {
      missing.push(pluginKey);
    }
  }

  if (missing.length > 0) {
    return {
      allInstalled: false,
      missing,
      installed,
      reason: "plugins_missing",
    };
  }

  return { allInstalled: true, missing: [], installed, reason: "ok" };
}

export function getSymphonyScriptPath(): string | undefined {
  const pluginDir = join(
    homedir(),
    ".claude",
    "plugins",
    "cache",
    "closedloop-ai",
    "code"
  );
  return findLatestPluginScript(pluginDir, join("scripts", "run-loop.sh"));
}

/**
 * Auto-discover the self-learning process-chat-learnings.sh script path.
 * Scans $HOME/.claude/plugins/cache/closedloop-ai/self-learning/ for the latest
 * semver version directory containing scripts/process-chat-learnings.sh.
 * Returns undefined if not found.
 */
export function getSelfLearningScriptPath(): string | undefined {
  const pluginDir = join(
    homedir(),
    ".claude",
    "plugins",
    "cache",
    "closedloop-ai",
    "self-learning"
  );
  return findLatestPluginScript(
    pluginDir,
    join("scripts", "process-chat-learnings.sh")
  );
}

export type WorktreeWithPendingLearnings = {
  worktreeDir: string;
  claudeWorkDir: string;
  pendingCount: number;
};

/**
 * Scan all worktree directories for pending learning JSON files.
 * Returns an array of worktrees that have at least one pending learning.
 */
export function getWorktreesWithPendingLearnings(): WorktreeWithPendingLearnings[] {
  let worktreeParentDir: string;
  try {
    worktreeParentDir = getWorktreeParentDir();
  } catch {
    return [];
  }

  if (!existsSync(worktreeParentDir)) {
    return [];
  }

  const config = loadReposConfig();
  const repos = config.repos.map((r) => {
    const expanded = expandHome(r.path);
    return {
      name: basename(expanded),
      path: expanded,
      parent: dirname(expanded),
    };
  });

  let entries: string[];
  try {
    entries = readdirSync(worktreeParentDir);
  } catch {
    return [];
  }

  const results: WorktreeWithPendingLearnings[] = [];

  for (const entry of entries) {
    // Match worktree directories by name prefix, then validate git linkage
    const entryPath = join(worktreeParentDir, entry);
    const matchedRepo = repos.some((repo) => {
      if (entry === repo.name) {
        return repo.parent === worktreeParentDir;
      }
      return (
        entry.startsWith(`${repo.name}-`) && isWorktreeOf(entryPath, repo.path)
      );
    });
    if (!matchedRepo) {
      continue;
    }

    const worktreeDir = entryPath;
    const pendingDir = join(
      worktreeDir,
      ".closedloop-ai",
      "work",
      ".learnings",
      "pending"
    );

    if (!existsSync(pendingDir)) {
      continue;
    }

    try {
      const files = readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
      if (files.length > 0) {
        // Derive claudeWorkDir by going up 2 levels from pendingDir (.learnings/pending)
        const claudeWorkDir = join(pendingDir, "..", "..");
        results.push({
          worktreeDir,
          claudeWorkDir,
          pendingCount: files.length,
        });
      }
    } catch {
      // Skip directories we can't read
    }
  }

  return results;
}
