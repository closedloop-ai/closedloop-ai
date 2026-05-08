/**
 * Represents a configured repository that the user has added
 */
export type ConfiguredRepo = {
  path: string; // e.g., "path/to/workspace/my-app"
  name: string; // basename of the path
  description?: string;
  addedAt: string; // ISO timestamp
  deployment?: DeploymentConfig;
};

/**
 * Global settings for repository management
 */
export type RepoSettings = {
  worktreeParentDir?: string; // Where worktrees are created.
  worktreeParentDirConfirmed?: boolean; // Whether the user has confirmed the worktree directory
};

/**
 * Complete repos configuration stored in ~/.closedloop-ai/repos.json
 */
export type ReposConfig = {
  repos: ConfiguredRepo[];
  settings: RepoSettings;
};

/**
 * Directory entry returned by the directories API
 */
export type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: true;
  isGitRepo: boolean;
};

/**
 * Supported deployment types — local dev server only
 */
export type DeploymentType = "local";

/**
 * Deployment configuration auto-detected or manually configured for a repo
 */
export type DeploymentConfig = {
  type: DeploymentType;
  command: string;
  detectedAt: string;
  port?: number;
  /** Additional ports for monorepo setups (e.g., turbo starting app:3010 + api:3002) */
  additionalPorts?: number[];
  healthCheckUrl?: string;
  teardownCommand?: string;
  statusCommand?: string;
  infoExtractionPattern?: string;
  /** Command to install dependencies before starting the dev server (e.g., "yarn install") */
  installCommand?: string;
};
