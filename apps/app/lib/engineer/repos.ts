import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ConfiguredRepo, RepoSettings, ReposConfig } from "@/types/repos";

/**
 * Path to the repos config file
 */
const CACHE_DIR = join(process.cwd(), ".cache");
const REPOS_CONFIG_PATH = join(CACHE_DIR, "repos.json");

/**
 * Default repos — empty, user must configure manually
 */
const DEFAULT_REPOS: ConfiguredRepo[] = [];

/**
 * Default settings — empty; user must configure worktreeParentDir via setup dialog
 */
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

/**
 * Ensure the cache directory exists
 */
function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Load repos configuration from .cache/repos.json
 * Returns defaults on first run
 */
export function loadReposConfig(): ReposConfig {
  ensureCacheDir();

  if (!existsSync(REPOS_CONFIG_PATH)) {
    // Return defaults on first run
    const defaultConfig: ReposConfig = {
      repos: DEFAULT_REPOS,
      settings: DEFAULT_SETTINGS,
    };
    // Save defaults so they persist
    saveReposConfig(defaultConfig);
    return defaultConfig;
  }

  try {
    const content = readFileSync(REPOS_CONFIG_PATH, "utf-8");
    const config = JSON.parse(content) as ReposConfig;

    // Ensure all required fields exist
    return {
      repos: config.repos || DEFAULT_REPOS,
      settings: config.settings || DEFAULT_SETTINGS,
    };
  } catch (err) {
    console.error("[repos] Failed to load config:", err);
    return {
      repos: DEFAULT_REPOS,
      settings: DEFAULT_SETTINGS,
    };
  }
}

/**
 * Save repos configuration to .cache/repos.json
 */
export function saveReposConfig(config: ReposConfig): void {
  ensureCacheDir();

  try {
    writeFileSync(REPOS_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    console.error("[repos] Failed to save config:", err);
    throw new Error("Failed to save repos configuration");
  }
}

/**
 * Check if a path is in the configured repos
 */
export function isRepoAllowed(path: string): boolean {
  const config = loadReposConfig();

  // Expand both sides to absolute paths so ~/... and /Users/... both match
  const expandedPath = expandHome(path);

  return config.repos.some((repo) => expandHome(repo.path) === expandedPath);
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
 * Scans $HOME/.claude/plugins/cache/closedloop/experimental/ for the latest
 * semver version directory containing scripts/run-loop.sh.
 * Returns undefined if not found.
 */
export function getSymphonyScriptPath(): string | undefined {
  const pluginDir = join(
    homedir(),
    ".claude",
    "plugins",
    "cache",
    "closedloop",
    "experimental"
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
