import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { log } from "@repo/observability/log";
import { keys } from "./keys";

// Top-level regex for performance
const CORRELATION_ID_REGEX = /^(local|stage|prod)-(.+)$/;

// Lazy config getter - only validates when actually called at runtime
let _config: ReturnType<typeof keys> | null = null;
function getConfig() {
  if (!_config) {
    _config = keys();
  }
  return _config;
}

// Lazy dispatch repo parser
function getDispatchRepo() {
  const config = getConfig();
  return config.GITHUB_APP_DISPATCH_REPO.split("/") as [string, string];
}

/**
 * Create an authenticated Octokit instance using the GitHub App installation token.
 * This generates a fresh token for the symphony-cli repo where workflows run.
 */
async function getAuthenticatedOctokit(): Promise<Octokit> {
  const config = getConfig();
  const [dispatchOwner, dispatchRepo] = getDispatchRepo();

  const auth = createAppAuth({
    appId: config.GITHUB_APP_ID,
    privateKey: config.GITHUB_APP_PRIVATE_KEY,
  });

  // Get installation ID for the dispatch repo
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.GITHUB_APP_ID,
      privateKey: config.GITHUB_APP_PRIVATE_KEY,
    },
  });

  const { data: installation } = await appOctokit.apps.getRepoInstallation({
    owner: dispatchOwner,
    repo: dispatchRepo,
  });

  // Create installation-authenticated Octokit
  const installationAuth = await auth({
    type: "installation",
    installationId: installation.id,
  });

  return new Octokit({
    auth: installationAuth.token,
  });
}

/**
 * Create an authenticated Octokit instance for a specific installation.
 */
async function getInstallationOctokit(
  installationId: number
): Promise<Octokit> {
  const config = getConfig();
  const auth = createAppAuth({
    appId: config.GITHUB_APP_ID,
    privateKey: config.GITHUB_APP_PRIVATE_KEY,
  });

  const installationAuth = await auth({
    type: "installation",
    installationId,
  });

  return new Octokit({
    auth: installationAuth.token,
  });
}

export type TriggerWorkflowDispatchOptions = {
  targetRepo: string;
  ref?: string;
  command: "plan" | "execute" | "answer" | "chat";
  commandArgs?: string;
  context: string;
  correlationId: string;
  sessionId?: string;
  committerName?: string;
  committerEmail?: string;
};

/**
 * Trigger the symphony-dispatch workflow.
 * Returns the workflow run ID if available (may be undefined due to async nature).
 */
export async function triggerWorkflowDispatch(
  opts: TriggerWorkflowDispatchOptions
): Promise<{ success: boolean; error?: string }> {
  const config = getConfig();
  const [dispatchOwner, dispatchRepo] = getDispatchRepo();

  // Prefix correlation ID with environment
  const prefixedCorrelationId = `${config.WEBAPP_ENV}-${opts.correlationId}`;

  // Log dispatch attempt (excluding context which can be verbose)
  log.info("[github/dispatch] Triggering workflow dispatch", {
    dispatchRepo: `${dispatchOwner}/${dispatchRepo}`,
    targetRepo: opts.targetRepo,
    ref: opts.ref || "main",
    command: opts.command,
    commandArgs: opts.commandArgs || "(none)",
    correlationId: prefixedCorrelationId,
    sessionId: opts.sessionId || "(none)",
    contextLength: opts.context?.length || 0,
  });

  try {
    const octokit = await getAuthenticatedOctokit();

    await octokit.actions.createWorkflowDispatch({
      owner: dispatchOwner,
      repo: dispatchRepo,
      workflow_id: "symphony-dispatch.yml",
      ref: "main", // The branch where the workflow file lives
      inputs: {
        target_repo: opts.targetRepo,
        ref: opts.ref || "main",
        command: opts.command,
        command_args: opts.commandArgs || "",
        context: opts.context,
        correlation_id: prefixedCorrelationId,
        session_id: opts.sessionId || "",
        environment: config.WEBAPP_ENV === "prod" ? "prod" : "stage",
        committer_name: opts.committerName || "",
        committer_email: opts.committerEmail || "",
      },
    });

    log.info("[github/dispatch] Successfully triggered workflow", {
      correlationId: prefixedCorrelationId,
      targetRepo: opts.targetRepo,
      command: opts.command,
    });

    return { success: true };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    log.error("[github/dispatch] Failed to trigger workflow", {
      correlationId: prefixedCorrelationId,
      targetRepo: opts.targetRepo,
      command: opts.command,
      error: errorMessage,
    });
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Verify GitHub webhook signature using HMAC SHA-256.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string
): boolean {
  if (!signature.startsWith("sha256=")) {
    return false;
  }

  const config = getConfig();
  const expectedSignature = createHmac(
    "sha256",
    config.GITHUB_APP_WEBHOOK_SECRET
  )
    .update(payload)
    .digest("hex");

  const providedSignature = signature.slice(7); // Remove "sha256=" prefix

  // Use timing-safe comparison to prevent timing attacks
  try {
    return timingSafeEqual(
      Buffer.from(expectedSignature, "hex"),
      Buffer.from(providedSignature, "hex")
    );
  } catch {
    return false;
  }
}

/**
 * Get workflow run details including inputs (for workflow_dispatch events).
 */
export async function getWorkflowRunInputs(
  runId: number
): Promise<Record<string, string> | null> {
  const [dispatchOwner, dispatchRepo] = getDispatchRepo();
  const octokit = await getAuthenticatedOctokit();

  const { data: run } = await octokit.actions.getWorkflowRun({
    owner: dispatchOwner,
    repo: dispatchRepo,
    run_id: runId,
  });

  // For workflow_dispatch events, inputs are available in the response
  // Cast to access the inputs field which exists for workflow_dispatch runs
  const runData = run as typeof run & {
    inputs?: Record<string, string> | null;
  };

  if (run.event !== "workflow_dispatch" || !runData.inputs) {
    return null;
  }

  return runData.inputs;
}

/**
 * Download artifacts from a workflow run.
 */
export async function downloadWorkflowArtifacts(
  runId: number,
  artifactName?: string
): Promise<{ name: string; data: Buffer }[]> {
  const [dispatchOwner, dispatchRepo] = getDispatchRepo();
  const octokit = await getAuthenticatedOctokit();

  // List artifacts for the run
  const { data: artifactsList } =
    await octokit.actions.listWorkflowRunArtifacts({
      owner: dispatchOwner,
      repo: dispatchRepo,
      run_id: runId,
    });

  const artifacts: { name: string; data: Buffer }[] = [];

  for (const artifact of artifactsList.artifacts) {
    // Skip if filtering by name and doesn't match
    if (artifactName && artifact.name !== artifactName) {
      continue;
    }

    // Download the artifact
    const { data } = await octokit.actions.downloadArtifact({
      owner: dispatchOwner,
      repo: dispatchRepo,
      artifact_id: artifact.id,
      archive_format: "zip",
    });

    artifacts.push({
      name: artifact.name,
      data: Buffer.from(data as ArrayBuffer),
    });
  }

  return artifacts;
}

/**
 * Fetch repository info from GitHub.
 * Returns the repo data needed to create a Repository record.
 */
export async function getRepositoryInfo(fullName: string): Promise<{
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
} | null> {
  const [owner, name] = fullName.split("/");
  if (!(owner && name)) {
    return null;
  }

  try {
    const octokit = await getAuthenticatedOctokit();
    const { data: repo } = await octokit.repos.get({ owner, repo: name });

    return {
      githubId: repo.id,
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
    };
  } catch (error) {
    log.error("[github/repo] Failed to fetch repository info", {
      fullName,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return null;
  }
}

/**
 * Parse correlation ID to extract environment prefix and actual ID.
 */
export function parseCorrelationId(correlationId: string): {
  env: string;
  id: string;
} | null {
  const match = correlationId.match(CORRELATION_ID_REGEX);
  if (!match) {
    return null;
  }
  return {
    env: match[1],
    id: match[2],
  };
}

/**
 * Check if a correlation ID belongs to the current environment.
 */
export function isCurrentEnvironment(correlationId: string): boolean {
  const parsed = parseCorrelationId(correlationId);
  if (!parsed) {
    return false;
  }
  const config = getConfig();
  return parsed.env === config.WEBAPP_ENV;
}

/**
 * Delete (uninstall) a GitHub App installation.
 * This requires JWT authentication (app-level), not installation token.
 * @see https://docs.github.com/en/rest/apps/apps#delete-an-installation-for-the-authenticated-app
 */
export async function deleteInstallation(
  installationId: number
): Promise<{ success: boolean; error?: string }> {
  const config = getConfig();

  try {
    // Create app-level authenticated Octokit (JWT, not installation token)
    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.GITHUB_APP_ID,
        privateKey: config.GITHUB_APP_PRIVATE_KEY,
      },
    });

    await appOctokit.apps.deleteInstallation({
      installation_id: installationId,
    });

    log.info("[github/app] Deleted installation", { installationId });
    return { success: true };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    log.error("[github/app] Failed to delete installation", {
      installationId,
      error: errorMessage,
    });
    return { success: false, error: errorMessage };
  }
}

/**
 * Get the latest deployment status for a given ref (branch) in a repository.
 * Queries the GitHub Deployments API and returns the most recent deployment status.
 */
export async function getLatestDeploymentStatusForRef(
  repoFullName: string,
  ref: string,
  options?: {
    installationId?: number;
    environment?: string | null;
  }
): Promise<{
  url: string | null;
  state: string | null;
  environment: string | null;
  updatedAt: string | null;
} | null> {
  const [owner, repo] = repoFullName.split("/");
  if (!(owner && repo)) {
    return null;
  }

  try {
    const octokit =
      options?.installationId !== undefined
        ? await getInstallationOctokit(options.installationId)
        : await getAuthenticatedOctokit();
    const environment =
      options?.environment === null ? undefined : options?.environment;

    // Get the most recent deployment for this ref
    const { data: deployments } = await octokit.repos.listDeployments({
      owner,
      repo,
      ref,
      per_page: 5,
      ...(environment ? { environment } : {}),
    });

    if (deployments.length === 0) {
      return null;
    }

    for (const deployment of deployments) {
      const { data: statuses } = await octokit.repos.listDeploymentStatuses({
        owner,
        repo,
        deployment_id: deployment.id,
        per_page: 1,
      });

      if (statuses.length > 0) {
        const status = statuses[0];
        return {
          url: status.environment_url || status.target_url || null,
          state: status.state,
          environment: deployment.environment,
          updatedAt: status.updated_at,
        };
      }
    }

    // Deployment exists but no status yet
    const deployment = deployments[0];
    return {
      url: null,
      state: "pending",
      environment: deployment.environment,
      updatedAt: deployment.updated_at,
    };
  } catch (error) {
    log.error("[github/deployments] Failed to fetch deployment status", {
      repoFullName,
      ref,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return null;
  }
}

/**
 * Get branches for a GitHub repository using GitHub GraphQL API.
 * Fetches up to 100 branches, sorted by committedDate descending.
 * Returns the top `limit` branches with the default branch pinned at position 0.
 *
 * @param installationId - GitHub installation ID (numeric)
 * @param owner - Repository owner (org or user)
 * @param name - Repository name
 * @param limit - Maximum number of branches to return (default: 20)
 */
export async function getRepositoryBranches(
  installationId: number,
  owner: string,
  name: string,
  limit = 20
): Promise<Array<{ name: string; committedDate: string; isDefault: boolean }>> {
  const config = getConfig();

  try {
    // Create installation-authenticated Octokit
    const auth = createAppAuth({
      appId: config.GITHUB_APP_ID,
      privateKey: config.GITHUB_APP_PRIVATE_KEY,
    });

    const installationAuth = await auth({
      type: "installation",
      installationId,
    });

    const octokit = new Octokit({
      auth: installationAuth.token,
    });

    // GitHub GraphQL query to fetch branches with committedDate
    // We fetch up to 100 branches (GitHub's default page size) and sort/limit server-side
    const query = `
      query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          defaultBranchRef {
            name
          }
          refs(refPrefix: "refs/heads/", first: 100, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) {
            nodes {
              name
              target {
                ... on Commit {
                  committedDate
                }
              }
            }
          }
        }
      }
    `;

    const response = await octokit.graphql<{
      repository: {
        defaultBranchRef: { name: string } | null;
        refs: {
          nodes: Array<{
            name: string;
            target: { committedDate?: string };
          }>;
        };
      };
    }>(query, {
      owner,
      name,
    });

    const defaultBranch = response.repository.defaultBranchRef?.name ?? "main";

    const branches = response.repository.refs.nodes
      .map((node) => ({
        name: node.name,
        committedDate: node.target.committedDate ?? new Date(0).toISOString(),
        isDefault: node.name === defaultBranch,
      }))
      .sort(
        (a, b) =>
          new Date(b.committedDate).getTime() -
          new Date(a.committedDate).getTime()
      );

    // Pin default branch at position 0
    const defaultBranchIndex = branches.findIndex((b) => b.isDefault);
    if (defaultBranchIndex > 0) {
      const [defaultBranchObj] = branches.splice(defaultBranchIndex, 1);
      branches.unshift(defaultBranchObj);
    } else if (defaultBranchIndex === -1) {
      // Default branch wasn't in the top 100 by commit date — add it explicitly
      branches.unshift({
        name: defaultBranch,
        committedDate: new Date(0).toISOString(),
        isDefault: true,
      });
    }

    // Return top `limit` branches
    return branches.slice(0, limit);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    log.error("[github/branches] Failed to fetch branches", {
      installationId,
      owner,
      name,
      error: errorMessage,
    });
    throw new Error(`Failed to fetch branches: ${errorMessage}`);
  }
}
