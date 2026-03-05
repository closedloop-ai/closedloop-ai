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
 * Global config directory: ~/.claude/closedloop/
 * Repos config is stored here so it persists across worktrees and checkouts.
 */
const CONFIG_DIR = join(homedir(), ".claude", "closedloop");
const REPOS_CONFIG_PATH = join(CONFIG_DIR, "repos.json");

/**
 * Legacy location: {cwd}/.cache/repos.json
 * Checked on every load for migration, then deleted.
 */
const LEGACY_CONFIG_PATH = join(process.cwd(), ".cache", "repos.json");

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
 * Load repos configuration from ~/.claude/closedloop/repos.json.
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

    // Worktree match: same parent dir, name prefix filter, then validate
    // actual git worktree linkage via .git pointer file
    return (
      pathParent === repoParent &&
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
 * Auto-discover the Symphony run-loop.sh script path.
 * Scans $HOME/.claude/plugins/cache/closedloop-ai/code/ for the latest
 * semver version directory containing scripts/run-loop.sh.
 * Returns undefined if not found.
 */
export function getSymphonyScriptPath(): string | undefined {
  const pluginDir = join(
    homedir(),
    ".claude",
    "plugins",
    "cache",
    "closedloop-ai",
    "code"
  );

  if (!existsSync(pluginDir)) {
    return undefined;
  }

  let entries: string[];
  try {
    entries = readdirSync(pluginDir);
  } catch {
    return undefined;
  }

  // Filter to directories that look like semver versions and have run-loop.sh
  const versions = entries
    .filter((name) => /^\d+\.\d+\.\d+/.test(name))
    .filter((name) =>
      existsSync(join(pluginDir, name, "scripts", "run-loop.sh"))
    )
    .sort((a, b) => {
      // Compare semver parts numerically
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) {
          return (pa[i] ?? 0) - (pb[i] ?? 0);
        }
      }
      return 0;
    });

  if (versions.length === 0) {
    return undefined;
  }

  // Take the latest version
  const latest = versions.at(-1)!;
  return join(pluginDir, latest, "scripts", "run-loop.sh");
}
