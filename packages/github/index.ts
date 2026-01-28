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

export type TriggerWorkflowDispatchOptions = {
  targetRepo: string;
  ref?: string;
  command: "plan" | "execute" | "answer" | "chat";
  commandArgs?: string;
  context: string;
  correlationId: string;
  sessionId?: string;
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
