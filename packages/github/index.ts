import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { keys } from "./keys";

// Top-level regex for performance
const CORRELATION_ID_REGEX = /^(stage|prod):(.+)$/;

const config = keys();

// Parse dispatch repo into owner/repo
const [dispatchOwner, dispatchRepo] = config.SYMPHONY_DISPATCH_REPO.split("/");

/**
 * Create an authenticated Octokit instance using the GitHub App installation token.
 * This generates a fresh token for the symphony-cli repo where workflows run.
 */
async function getAuthenticatedOctokit(): Promise<Octokit> {
  const auth = createAppAuth({
    appId: config.SYMPHONY_APP_ID,
    privateKey: config.SYMPHONY_APP_PRIVATE_KEY,
  });

  // Get installation ID for the dispatch repo
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.SYMPHONY_APP_ID,
      privateKey: config.SYMPHONY_APP_PRIVATE_KEY,
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
  try {
    const octokit = await getAuthenticatedOctokit();

    // Prefix correlation ID with environment
    const prefixedCorrelationId = `${config.WEBAPP_ENV}:${opts.correlationId}`;

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
      },
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to trigger workflow dispatch:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
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

  const expectedSignature = createHmac("sha256", config.GITHUB_WEBHOOK_SECRET)
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
  return parsed.env === config.WEBAPP_ENV;
}
