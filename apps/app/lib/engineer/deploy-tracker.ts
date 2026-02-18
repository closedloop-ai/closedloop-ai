/**
 * Track deployment state for tickets.
 * Uses localStorage to persist state across page refreshes.
 * Follows the same pattern as pr-tracker.ts.
 */

const STORAGE_KEY = "symphony-deploy-info";

export type DeployInfo = {
  ticketId: string;
  worktreePath: string;
  repoName: string;
  deployedUrl?: string;
  deployedAt?: string;
  serviceId?: string;
  status: "deploying" | "deployed" | "failed" | "torn-down";
  pid?: number;
  lastHealthCheck?: string;
  healthCheckFailed?: boolean;
  consecutiveFailures?: number;
};

/**
 * Get all deployments
 */
export function getDeployments(): Record<string, DeployInfo> {
  if (globalThis.window === undefined) {
    return {};
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return {};
    }
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

/**
 * Get deployment info for a specific ticket
 */
export function getDeployment(ticketId: string): DeployInfo | null {
  const deployments = getDeployments();
  return deployments[ticketId] || null;
}

/**
 * Save deployment info for a ticket
 */
export function saveDeployment(ticketId: string, info: DeployInfo): void {
  if (globalThis.window === undefined) {
    return;
  }

  const deployments = getDeployments();
  deployments[ticketId] = info;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(deployments));
}

/**
 * Update partial deployment info for a ticket
 */
export function updateDeployment(
  ticketId: string,
  partial: Partial<DeployInfo>
): void {
  if (globalThis.window === undefined) {
    return;
  }

  const deployments = getDeployments();
  const existing = deployments[ticketId];
  if (!existing) {
    return;
  }

  deployments[ticketId] = { ...existing, ...partial };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(deployments));
}

/**
 * Clear deployment info for a ticket
 */
export function clearDeployment(ticketId: string): void {
  if (globalThis.window === undefined) {
    return;
  }

  const deployments = getDeployments();
  delete deployments[ticketId];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(deployments));
}

/**
 * Find any active deployment for a given repo name (from a different ticket).
 * Used to detect conflicts when multiple worktrees target the same repo.
 */
export function getActiveDeploymentForRepo(
  repoName: string
): DeployInfo | null {
  const deployments = getDeployments();
  for (const info of Object.values(deployments)) {
    if (info.repoName === repoName && info.status === "deployed") {
      return info;
    }
  }
  return null;
}
