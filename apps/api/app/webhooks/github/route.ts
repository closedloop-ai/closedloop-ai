import type {
  InstallationCreatedEvent,
  InstallationDeletedEvent,
  InstallationRepositoriesAddedEvent,
  InstallationRepositoriesRemovedEvent,
  InstallationSuspendEvent,
  InstallationUnsuspendEvent,
  WorkflowRunCompletedEvent,
  WorkflowRunInProgressEvent,
  WorkflowRunRequestedEvent,
} from "@octokit/webhooks-types";
import { ArtifactStatus, ArtifactType } from "@repo/api/src/types/artifact";
import { getArtifactUrl, uploadArtifact } from "@repo/aws";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import {
  downloadWorkflowArtifacts,
  isCurrentEnvironment,
  parseCorrelationId,
  verifyWebhookSignature,
} from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import AdmZip from "adm-zip";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { githubService } from "@/app/integrations/github/service";

type WorkflowContext = {
  correlationId: string;
  artifactId: string;
  workstreamId: string;
  runId: number;
  command?: string;
  repositoryId?: string;
};

type WorkflowRunEvent =
  | WorkflowRunCompletedEvent
  | WorkflowRunInProgressEvent
  | WorkflowRunRequestedEvent;

type ZipContent = {
  planContent: string | null;
  questionsContent: string | null;
  executionResult: ExecutionResult | null;
  entries: { name: string; data: Buffer }[];
};

type ExecutionResult = {
  has_changes: boolean;
  pr_url: string;
  pr_number: string | number; // GitHub Actions outputs as string
  pr_title?: string; // Optional - may not be in workflow output
  branch_name: string;
  base_ref?: string; // Workflow uses base_ref, not base_branch
  base_branch?: string; // Legacy/alternative field name
  github_id?: number;
  commit_sha?: string;
};

/**
 * Parse execution result JSON safely.
 */
function parseExecutionResult(
  content: Buffer,
  entryName: string
): ExecutionResult | null {
  try {
    const jsonContent = content.toString("utf-8");
    const result = JSON.parse(jsonContent) as ExecutionResult;
    log.info(`Found execution result: ${entryName}, PR #${result.pr_number}`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error(`Failed to parse execution-result.json: ${message}`);
    return null;
  }
}

/**
 * Search a zip for plan, questions, or execution result files.
 * Returns the content if found, null otherwise.
 */
function findPlanInZip(zip: AdmZip): ZipContent {
  const entries: { name: string; data: Buffer }[] = [];
  let planContent: string | null = null;
  let questionsContent: string | null = null;
  let executionResult: ExecutionResult | null = null;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      continue;
    }

    const content = entry.getData();
    const name = entry.entryName;
    entries.push({ name, data: content });

    if (name.endsWith("implementation-plan.md")) {
      planContent = content.toString("utf-8");
      log.info(
        `Found implementation plan: ${name} (${planContent.length} chars)`
      );
    } else if (name.endsWith("open-questions.md")) {
      questionsContent = content.toString("utf-8");
      log.info(
        `Found questions file: ${name} (${questionsContent.length} chars)`
      );
    } else if (name.endsWith("execution-result.json")) {
      executionResult = parseExecutionResult(content, name);
    }
  }

  return { planContent, questionsContent, executionResult, entries };
}

/**
 * Upload entries to S3, optionally filtering out certain file types.
 */
async function uploadEntriesToS3(
  correlationId: string,
  entries: { name: string; data: Buffer }[],
  skipZips = false
): Promise<string[]> {
  const artifactKeys: string[] = [];
  for (const entry of entries) {
    if (skipZips && entry.name.endsWith(".zip")) {
      continue;
    }
    const s3Key = `plans/${correlationId}/${entry.name}`;
    await uploadArtifact(s3Key, entry.data);
    artifactKeys.push(s3Key);
  }
  return artifactKeys;
}

/**
 * Merge zip content results, preferring non-null values from new result.
 */
function mergeZipContent(
  current: Omit<ZipContent, "entries">,
  result: ZipContent
): Omit<ZipContent, "entries"> {
  return {
    planContent: result.planContent ?? current.planContent,
    questionsContent: result.questionsContent ?? current.questionsContent,
    executionResult: result.executionResult ?? current.executionResult,
  };
}

/**
 * Process a single artifact zip, handling nested zips.
 */
async function processArtifactZip(
  correlationId: string,
  artifactData: Buffer,
  artifactName: string,
  uploadToS3: boolean
): Promise<ZipContent & { artifactKeys: string[] }> {
  const outerZip = new AdmZip(artifactData);
  const outerEntries = outerZip.getEntries();
  const artifactKeys: string[] = [];

  log.info(
    `[processArtifactZip] "${artifactName}" contains ${outerEntries.length} files`
  );

  let content: Omit<ZipContent, "entries"> = {
    planContent: null,
    questionsContent: null,
    executionResult: null,
  };

  // Check for nested zips first (Symphony artifact structure)
  for (const entry of outerEntries) {
    const isNestedZip = entry.entryName.endsWith(".zip") && !entry.isDirectory;
    if (!isNestedZip) {
      continue;
    }

    log.info(`[processArtifactZip] Found nested zip: ${entry.entryName}`);
    const innerZip = new AdmZip(entry.getData());
    const result = findPlanInZip(innerZip);
    content = mergeZipContent(content, result);

    if (uploadToS3) {
      const keys = await uploadEntriesToS3(correlationId, result.entries);
      artifactKeys.push(...keys);
    }
  }

  // Also check outer zip directly (in case it's not nested)
  const needsDirectCheck = !(content.planContent || content.executionResult);
  if (needsDirectCheck) {
    const result = findPlanInZip(outerZip);
    content = mergeZipContent(content, result);

    if (uploadToS3) {
      const keys = await uploadEntriesToS3(correlationId, result.entries, true);
      artifactKeys.push(...keys);
    }
  }

  return { ...content, entries: [], artifactKeys };
}

/**
 * Download and extract workflow artifacts, optionally upload to S3.
 * Handles nested zips (GitHub wraps artifacts, Symphony may also zip).
 */
async function processArtifactUploads(
  correlationId: string,
  runId: number,
  uploadToS3: boolean
): Promise<{
  planContent: string | null;
  questionsContent: string | null;
  executionResult: ExecutionResult | null;
  artifactKeys: string[];
}> {
  log.info(
    `[processArtifactUploads] Downloading artifacts for run ${runId}, uploadToS3=${uploadToS3}`
  );

  const artifacts = await downloadWorkflowArtifacts(runId);
  let planContent: string | null = null;
  let questionsContent: string | null = null;
  let executionResult: ExecutionResult | null = null;
  const artifactKeys: string[] = [];

  log.info(`[processArtifactUploads] Downloaded ${artifacts.length} artifacts`);

  for (const artifact of artifacts) {
    const result = await processArtifactZip(
      correlationId,
      artifact.data,
      artifact.name,
      uploadToS3
    );

    planContent = result.planContent ?? planContent;
    questionsContent = result.questionsContent ?? questionsContent;
    executionResult = result.executionResult ?? executionResult;
    artifactKeys.push(...result.artifactKeys);
  }

  if (planContent || questionsContent || executionResult) {
    log.info(
      `[processArtifactUploads] Found content: plan=${!!planContent}, questions=${!!questionsContent}, execution=${!!executionResult}`
    );
  } else {
    log.warn(
      "[processArtifactUploads] No plan, questions, or execution result found in artifacts"
    );
  }

  return { planContent, questionsContent, executionResult, artifactKeys };
}

/**
 * Handle successful execution workflow - creates a PR record if changes were made.
 */
async function handleExecutionSuccess(
  ctx: WorkflowContext,
  executionResult: ExecutionResult
): Promise<void> {
  const { correlationId, workstreamId, repositoryId, runId } = ctx;

  // Check if execution actually produced changes and a PR
  if (!(executionResult.has_changes && executionResult.pr_url)) {
    log.info(
      `Execution completed with no changes for workflow run ${runId}, correlation ${correlationId}`
    );
    // Create event to indicate execution completed but no PR was needed
    await withDb((db) =>
      db.workstreamEvent.create({
        data: {
          workstreamId,
          type: "GITHUB_ACTION_COMPLETED",
          actorType: "system",
          data: {
            correlationId,
            runId,
            command: "execute",
            conclusion: "success",
            hasChanges: false,
            message: "Execution completed - no changes to commit",
          },
        },
      })
    );
    return;
  }

  if (!repositoryId) {
    log.error(
      `[handleExecutionSuccess] No repositoryId in context for correlation ${correlationId}`
    );
    return;
  }

  // Convert pr_number from string to number (GitHub Actions outputs strings)
  const prNumber =
    typeof executionResult.pr_number === "string"
      ? Number.parseInt(executionResult.pr_number, 10)
      : executionResult.pr_number;

  // Provide defaults for optional fields
  const prTitle =
    executionResult.pr_title ||
    `Symphony: ${executionResult.branch_name || `PR #${prNumber}`}`;
  const baseBranch =
    executionResult.base_branch || executionResult.base_ref || "main";

  await withDb.tx(async (tx) => {
    // Query plan artifact for organizationId, projectId, generatedBy
    const planArtifact = await tx.artifact.findUnique({
      where: { id: ctx.artifactId },
      select: {
        organizationId: true,
        projectId: true,
        generatedBy: true,
      },
    });

    if (!planArtifact) {
      throw new Error(
        `[handleExecutionSuccess] Implementation plan artifact ${ctx.artifactId} not found for correlation ${correlationId}`
      );
    }

    // Create GitHubPullRequest record
    await tx.gitHubPullRequest.create({
      data: {
        workstreamId,
        repositoryId,
        githubId: executionResult.github_id ?? prNumber,
        number: prNumber,
        title: prTitle,
        htmlUrl: executionResult.pr_url,
        headBranch: executionResult.branch_name,
        baseBranch,
        state: "OPEN",
      },
    });

    // Create Artifact record for the PR
    await tx.artifact.create({
      data: {
        organizationId: planArtifact.organizationId,
        workstreamId,
        projectId: planArtifact.projectId,
        type: ArtifactType.PullRequest,
        title: prTitle,
        externalUrl: executionResult.pr_url,
        status: ArtifactStatus.Review,
        generatedBy: planArtifact.generatedBy,
      },
    });

    // Create workstream event
    await tx.workstreamEvent.create({
      data: {
        workstreamId,
        type: "GITHUB_PR_CREATED",
        actorType: "system",
        data: {
          correlationId,
          prNumber,
          prUrl: executionResult.pr_url,
          prTitle,
          branch: executionResult.branch_name,
          runId,
        },
      },
    });
  });

  log.info(
    `Successfully created PR record for workflow run ${runId}, PR #${prNumber}`
  );
}

/**
 * Handle successful workflow completion.
 */
async function handleWorkflowSuccess(
  ctx: WorkflowContext,
  s3Configured: boolean
): Promise<void> {
  const { correlationId, artifactId, workstreamId, runId, command } = ctx;

  // Always download and extract artifacts (we need the plan content regardless of S3)
  const result = await processArtifactUploads(
    correlationId,
    runId,
    s3Configured
  );
  const { planContent, questionsContent, executionResult, artifactKeys } =
    result;

  // Handle execute command differently - create PR record instead of updating artifact
  if (command === "execute" && executionResult) {
    await handleExecutionSuccess(ctx, executionResult);
    return;
  }

  // TODO: Handle questionsContent with needs_answers status in future
  // For now, if we have questions but no plan, include them in the content
  const finalContent = planContent ?? questionsContent;

  log.info("[handleWorkflowSuccess] Updating artifact", {
    artifactId,
    hasContent: !!finalContent,
    contentLength: finalContent?.length ?? 0,
    command,
  });

  if (!artifactId) {
    log.error(
      "[handleWorkflowSuccess] No artifactId in context - cannot update artifact",
      {
        correlationId,
        workstreamId,
        command,
      }
    );
    return;
  }

  await withDb(async (db) => {
    // TODO: These artifact queries need to include the organizationId for proper isolation!
    // Verify artifact exists before updating
    const existingArtifact = await db.artifact.findUnique({
      where: { id: artifactId },
      select: { id: true, content: true },
    });

    if (!existingArtifact) {
      throw new Error(
        `Artifact ${artifactId} not found - cannot update with workflow results`
      );
    }

    log.info("[handleWorkflowSuccess] Found existing artifact", {
      artifactId,
      hasExistingContent: !!existingArtifact.content,
      existingContentLength: existingArtifact.content?.length ?? 0,
    });

    await db.artifact.update({
      where: { id: artifactId },
      data: {
        status: "DRAFT",
        content: finalContent || undefined,
        externalUrl:
          artifactKeys.length > 0
            ? getArtifactUrl(`plans/${correlationId}/`)
            : undefined,
      },
    });

    log.info("[handleWorkflowSuccess] Artifact updated successfully", {
      artifactId,
      newContentLength: finalContent?.length ?? 0,
    });

    await db.workstreamEvent.create({
      data: {
        workstreamId,
        type: "GITHUB_ACTION_COMPLETED",
        actorType: "system",
        data: {
          correlationId,
          artifactId,
          runId,
          conclusion: "success",
          artifactKeys,
        },
      },
    });
  });

  log.info(
    `Successfully processed workflow run ${runId} for correlation ${correlationId}`
  );
}

/**
 * Handle failed workflow completion.
 * IMPORTANT: We NEVER overwrite artifact content with error messages.
 * Errors are tracked via GitHubActionRun status and workstream events.
 * The UI shows failures via the status banner.
 */
async function handleWorkflowFailure(
  ctx: WorkflowContext,
  htmlUrl: string
): Promise<void> {
  const { correlationId, artifactId, workstreamId, runId, command } = ctx;

  await withDb(async (db) => {
    // Only create the event - NEVER overwrite artifact content with error messages
    await db.workstreamEvent.create({
      data: {
        workstreamId,
        type: "GITHUB_ACTION_COMPLETED",
        actorType: "system",
        data: {
          correlationId,
          artifactId,
          runId,
          command,
          conclusion: "failure",
          htmlUrl,
        },
      },
    });
  });

  log.error(`Workflow run ${runId} failed for correlation ${correlationId}`, {
    htmlUrl,
    artifactId,
    command,
  });
}

function isGitHubConfigured(): boolean {
  // Check env vars directly to avoid build-time validation errors
  return Boolean(
    process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY &&
      process.env.GITHUB_APP_WEBHOOK_SECRET &&
      process.env.GITHUB_APP_DISPATCH_REPO
  );
}

function isS3Configured(): boolean {
  // Check env vars directly to avoid build-time validation errors
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.S3_BUCKET_NAME
  );
}

async function validateRequest(request: Request) {
  const body = await request.text();
  const headerPayload = await headers();
  const signature = headerPayload.get("x-hub-signature-256");
  const eventType = headerPayload.get("x-github-event");

  return { body, signature, eventType };
}

/**
 * Find the GitHubActionRun by correlation ID in triggerData.
 * @param correlationId - The correlation ID to search for
 * @param activeOnly - If true, only find runs that are still in progress (PENDING, QUEUED, RUNNING)
 *                     If false, find any run regardless of status (for replay support)
 */
async function findActionRunByCorrelationId(
  correlationId: string,
  activeOnly = true
) {
  const actionRuns = await withDb((db) =>
    db.gitHubActionRun.findMany({
      where: {
        workflowName: "symphony-dispatch",
        ...(activeOnly
          ? { status: { in: ["PENDING", "QUEUED", "RUNNING"] } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    })
  );

  return actionRuns.find((run) => {
    const data = run.triggerData as { correlationId?: string } | null;
    return data?.correlationId === correlationId;
  });
}

/**
 * Handle workflow status updates (requested, in_progress).
 */
async function handleWorkflowStatusUpdate(
  correlationId: string,
  action: "requested" | "in_progress",
  runId: number,
  htmlUrl: string
): Promise<Response> {
  const parsed = parseCorrelationId(correlationId);
  if (!parsed) {
    log.warn("[webhook/github] Invalid correlation ID format", {
      correlationId,
      action,
    });
    return NextResponse.json({
      message: "Invalid correlation ID format",
      ok: true,
    });
  }

  const actionRun = await findActionRunByCorrelationId(correlationId);
  if (!actionRun) {
    log.info("[webhook/github] No GitHubActionRun found for status update", {
      correlationId,
      action,
      runId,
    });
    return NextResponse.json({
      message: `No matching action run found for correlation ${correlationId}`,
      ok: true,
    });
  }

  const newStatus = action === "requested" ? "QUEUED" : "RUNNING";

  await withDb((db) =>
    db.gitHubActionRun.update({
      where: { id: actionRun.id },
      data: {
        runId: BigInt(runId),
        status: newStatus,
        htmlUrl,
        ...(action === "in_progress" ? { startedAt: new Date() } : {}),
      },
    })
  );

  log.info("[webhook/github] Updated GitHubActionRun status", {
    actionRunId: actionRun.id,
    correlationId,
    newStatus,
    runId,
  });

  return NextResponse.json({ result: "status_updated", ok: true });
}

async function processWorkflowCompletion(
  event: WorkflowRunCompletedEvent,
  correlationId: string,
  s3Configured: boolean
): Promise<Response> {
  const runId = event.workflow_run.id;

  // Find GitHubActionRun by correlation ID in triggerData
  // Use activeOnly=false to support replay of completed events (idempotent processing)
  const actionRun = await findActionRunByCorrelationId(correlationId, false);

  if (!actionRun) {
    log.info("[webhook/github] No GitHubActionRun found", {
      runId,
      correlationId,
      reason:
        "No matching action run in database - may be manual run or different environment",
    });
    return NextResponse.json({
      message: "No matching action run found",
      ok: true,
    });
  }

  const triggerData = actionRun.triggerData as {
    correlationId: string;
    artifactId: string;
    command?: string;
  };

  log.info("[webhook/github] Found matching GitHubActionRun", {
    actionRunId: actionRun.id,
    workstreamId: actionRun.workstreamId,
    correlationId: triggerData.correlationId,
    command: triggerData.command,
  });

  const conclusion = event.workflow_run.conclusion;
  const ctx: WorkflowContext = {
    correlationId: triggerData.correlationId,
    artifactId: triggerData.artifactId,
    workstreamId: actionRun.workstreamId,
    repositoryId: actionRun.repositoryId,
    command: triggerData.command,
    runId,
  };

  // Use transaction to ensure artifact content and status are updated atomically.
  // This prevents race condition where frontend sees SUCCESS before content is ready.
  await withDb.tx(async (tx) => {
    // 1. Process the result (updates artifact content)
    if (conclusion === "success") {
      await handleWorkflowSuccess(ctx, s3Configured);
    } else {
      await handleWorkflowFailure(ctx, event.workflow_run.html_url);
    }

    // 2. Update GitHubActionRun status (done last so frontend sees content first)
    await tx.gitHubActionRun.update({
      where: { id: actionRun.id },
      data: {
        runId: BigInt(runId),
        status: conclusion === "success" ? "SUCCESS" : "FAILURE",
        conclusion,
        htmlUrl: event.workflow_run.html_url,
        completedAt: new Date(),
      },
    });
  });

  return NextResponse.json({ result: "processed", ok: true });
}

/**
 * Handle GitHub App installation created event.
 * Upserts installation record and syncs repositories.
 */
async function handleInstallationCreated(
  event: InstallationCreatedEvent
): Promise<void> {
  const { installation, repositories = [], sender } = event;

  log.info("[handleInstallationCreated] Processing installation", {
    installationId: installation.id,
    accountLogin: installation.account.login,
    accountType: installation.target_type,
    repositoryCount: repositories.length,
    senderLogin: sender.login,
  });

  // Upsert installation record
  // On reinstall, preserve organizationId only if the installation is still ACTIVE (Q-003)
  // If the installation was UNINSTALLED (user disconnected), we need fresh claim via OAuth
  const existingInstallation =
    await githubService.findInstallationByInstallationId(installation.id);

  // Only preserve org link if the installation was ACTIVE or SUSPENDED (not UNINSTALLED)
  const shouldPreserveOrg =
    existingInstallation?.organizationId &&
    existingInstallation.status !== GitHubInstallationStatus.UNINSTALLED;

  const upsertedInstallation = await githubService.upsertInstallation(
    installation.id,
    {
      accountId: installation.account.id,
      accountLogin: installation.account.login,
      accountType: installation.target_type,
      senderLogin: sender.login,
      senderId: sender.id,
      // Set PENDING_CLAIM if not preserving org link
      status: shouldPreserveOrg ? undefined : "PENDING_CLAIM",
      permissions: installation.permissions,
      events: installation.events,
      repositorySelection: installation.repository_selection,
      // Preserve organizationId only if installation wasn't explicitly disconnected
      organizationId: shouldPreserveOrg
        ? (existingInstallation.organizationId ?? undefined)
        : undefined,
    }
  );

  log.info("[handleInstallationCreated] Upserted installation", {
    installationId: upsertedInstallation.id,
    status: upsertedInstallation.status,
    organizationId: upsertedInstallation.organizationId,
  });

  // Sync repositories
  if (repositories.length > 0) {
    const repositoryInputs = repositories.map((repo) =>
      toRepositoryInput(repo, installation.account.login)
    );

    await githubService.syncRepositories(
      upsertedInstallation.id,
      repositoryInputs
    );
  }
}

/**
 * Handle GitHub App installation deleted event.
 * Updates the installation status to UNINSTALLED.
 */
async function handleInstallationDeleted(
  event: InstallationDeletedEvent
): Promise<void> {
  const { installation } = event;

  log.info("[handleInstallationDeleted] Processing installation deletion", {
    installationId: installation.id,
    accountLogin: installation.account.login,
  });

  const existingInstallation =
    await githubService.findInstallationByInstallationId(installation.id);

  if (!existingInstallation) {
    log.warn("[handleInstallationDeleted] Installation not found", {
      installationId: installation.id,
    });
    return;
  }

  // Clear organizationId when installation is deleted - ensures clean state for reconnection
  await withDb((db) =>
    db.gitHubInstallation.update({
      where: { id: existingInstallation.id },
      data: {
        status: GitHubInstallationStatus.UNINSTALLED,
        organizationId: null,
      },
    })
  );

  log.info("[handleInstallationDeleted] Marked installation as uninstalled", {
    installationId: existingInstallation.id,
    previousOrganizationId: existingInstallation.organizationId,
  });
}

/**
 * Handle GitHub App installation suspended event.
 * Updates the installation status to SUSPENDED and sets suspendedAt/suspendedBy fields.
 */
async function handleInstallationSuspended(
  event: InstallationSuspendEvent
): Promise<void> {
  const { installation, sender } = event;

  log.info("[handleInstallationSuspended] Processing installation suspension", {
    installationId: installation.id,
    accountLogin: installation.account.login,
    suspendedBy: sender.login,
  });

  const existingInstallation =
    await githubService.findInstallationByInstallationId(installation.id);

  if (!existingInstallation) {
    log.warn("[handleInstallationSuspended] Installation not found", {
      installationId: installation.id,
    });
    return;
  }

  await githubService.updateInstallationStatus(
    existingInstallation.id,
    GitHubInstallationStatus.SUSPENDED,
    {
      suspendedAt: new Date(),
      suspendedBy: sender.login,
    }
  );
}

/**
 * Handle GitHub App installation unsuspended event.
 * Determines new status based on current state and clears suspension fields.
 */
async function handleInstallationUnsuspended(
  event: InstallationUnsuspendEvent
): Promise<void> {
  const { installation } = event;

  log.info(
    "[handleInstallationUnsuspended] Processing installation unsuspension",
    {
      installationId: installation.id,
      accountLogin: installation.account.login,
    }
  );

  const existingInstallation =
    await githubService.findInstallationByInstallationId(installation.id);

  if (!existingInstallation) {
    log.warn("[handleInstallationUnsuspended] Installation not found", {
      installationId: installation.id,
    });
    return;
  }

  // Determine the new status:
  // - REMOVED stays REMOVED (user explicitly disconnected)
  // - Unclaimed installations go to PENDING_CLAIM
  // - Claimed installations go to ACTIVE
  let newStatus: GitHubInstallationStatus;
  if (existingInstallation.status === GitHubInstallationStatus.REMOVED) {
    newStatus = GitHubInstallationStatus.REMOVED;
  } else if (existingInstallation.organizationId === null) {
    newStatus = GitHubInstallationStatus.PENDING_CLAIM;
  } else {
    newStatus = GitHubInstallationStatus.ACTIVE;
  }

  await githubService.updateInstallationStatus(
    existingInstallation.id,
    newStatus,
    {
      suspendedAt: null,
      suspendedBy: null,
    }
  );
}

/**
 * Convert webhook repository data to RepositoryInput format.
 */
function toRepositoryInput(
  repo: { id: number; full_name: string; name: string; private: boolean },
  fallbackOwner: string
): {
  githubRepoId: number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
} {
  const [owner] = repo.full_name.split("/");
  return {
    githubRepoId: repo.id,
    fullName: repo.full_name,
    name: repo.name,
    owner: owner || fallbackOwner,
    private: repo.private,
  };
}

/**
 * Handle GitHub App installation_repositories added event.
 * Syncs the added repositories to the database.
 */
async function handleInstallationRepositoriesAdded(
  event: InstallationRepositoriesAddedEvent
): Promise<void> {
  const { installation, repositories_added } = event;

  log.info(
    "[handleInstallationRepositoriesAdded] Processing repositories added",
    {
      installationId: installation.id,
      repositoryCount: repositories_added.length,
    }
  );

  if (repositories_added.length === 0) {
    return;
  }

  const existingInstallation =
    await githubService.findInstallationByInstallationId(installation.id);

  if (!existingInstallation) {
    log.warn("[handleInstallationRepositoriesAdded] Installation not found", {
      installationId: installation.id,
    });
    return;
  }

  const repositoryInputs = repositories_added.map((repo) =>
    toRepositoryInput(repo, installation.account.login)
  );

  await githubService.addRepositories(
    existingInstallation.id,
    repositoryInputs
  );
}

/**
 * Handle GitHub App installation_repositories removed event.
 * Removes the specified repositories from the database.
 */
async function handleInstallationRepositoriesRemoved(
  event: InstallationRepositoriesRemovedEvent
): Promise<void> {
  const { installation, repositories_removed } = event;

  log.info(
    "[handleInstallationRepositoriesRemoved] Processing repositories removed",
    {
      installationId: installation.id,
      repositoryCount: repositories_removed.length,
    }
  );

  if (repositories_removed.length === 0) {
    return;
  }

  const existingInstallation =
    await githubService.findInstallationByInstallationId(installation.id);

  if (!existingInstallation) {
    log.warn("[handleInstallationRepositoriesRemoved] Installation not found", {
      installationId: installation.id,
    });
    return;
  }

  const githubRepoIds = repositories_removed.map((repo) => repo.id);
  await githubService.removeRepositories(
    existingInstallation.id,
    githubRepoIds
  );
}

export const POST = async (request: Request): Promise<Response> => {
  log.info("[webhook/github] Received webhook request");

  if (!isGitHubConfigured()) {
    log.warn("[webhook/github] GitHub not configured, rejecting request");
    return NextResponse.json({ message: "GitHub not configured", ok: false });
  }

  const s3Configured = isS3Configured();

  try {
    const { body, signature, eventType } = await validateRequest(request);

    log.info("[webhook/github] Validating request", { eventType });

    if (!signature) {
      log.warn("[webhook/github] Missing signature header, rejecting");
      return NextResponse.json(
        { message: "Missing signature", ok: false },
        { status: 401 }
      );
    }

    if (!verifyWebhookSignature(body, signature)) {
      log.warn("[webhook/github] Invalid signature, rejecting");
      return NextResponse.json(
        { message: "Invalid signature", ok: false },
        { status: 401 }
      );
    }

    // Route by event type
    switch (eventType) {
      case "workflow_run": {
        const event: WorkflowRunEvent = JSON.parse(body);

        log.info("[webhook/github] Parsed workflow_run event", {
          action: event.action,
          workflowName: event.workflow.name,
          workflowPath: event.workflow.path,
          runId: event.workflow_run.id,
          conclusion:
            event.action === "completed"
              ? (event as WorkflowRunCompletedEvent).workflow_run.conclusion
              : null,
          htmlUrl: event.workflow_run.html_url,
        });

        if (!event.workflow.path.includes("symphony-dispatch")) {
          log.info("[webhook/github] Ignoring non-symphony-dispatch workflow", {
            workflowName: event.workflow.name,
            workflowPath: event.workflow.path,
            reason: "Not a symphony-dispatch workflow",
          });
          return NextResponse.json({
            message: `Ignoring workflow: ${event.workflow.name}`,
            ok: true,
          });
        }

        // Extract correlation ID from run name (workflow YAML sets run-name: ${{ inputs.correlation_id }})
        const correlationId = event.workflow_run.name;

        log.info("[webhook/github] Extracted correlation ID from run name", {
          runName: correlationId,
          runId: event.workflow_run.id,
          action: event.action,
        });

        // Check if this is for our environment
        if (!isCurrentEnvironment(correlationId)) {
          log.info(
            "[webhook/github] Event for different environment, ignoring",
            {
              correlationId,
              currentEnv: process.env.WEBAPP_ENV,
              action: event.action,
            }
          );
          return NextResponse.json({
            message: "Event for different environment, ignoring",
            ok: true,
          });
        }

        // Route by action type
        switch (event.action) {
          case "requested":
          case "in_progress": {
            return await handleWorkflowStatusUpdate(
              correlationId,
              event.action,
              event.workflow_run.id,
              event.workflow_run.html_url
            );
          }

          case "completed":
            log.info(
              "[webhook/github] Processing symphony-dispatch completion",
              {
                runId: event.workflow_run.id,
                correlationId,
                conclusion: (event as WorkflowRunCompletedEvent).workflow_run
                  .conclusion,
              }
            );
            return await processWorkflowCompletion(
              event as WorkflowRunCompletedEvent,
              correlationId,
              s3Configured
            );

          default: {
            // TypeScript exhaustiveness check - this should never happen
            const unhandledAction = (event as { action: string }).action;
            log.info("[webhook/github] Ignoring unhandled action", {
              action: unhandledAction,
              reason: "Not a tracked action type",
            });
            return NextResponse.json({
              message: `Ignoring action: ${unhandledAction}`,
              ok: true,
            });
          }
        }
      }

      case "installation": {
        const event = JSON.parse(body) as { action: string };

        log.info("[webhook/github] Received installation event", {
          action: event.action,
        });

        switch (event.action) {
          case "created":
            await handleInstallationCreated(event as InstallationCreatedEvent);
            return NextResponse.json({
              message: "Installation created successfully",
              ok: true,
            });

          case "deleted":
            await handleInstallationDeleted(event as InstallationDeletedEvent);
            return NextResponse.json({
              message: "Installation deleted successfully",
              ok: true,
            });

          case "suspend":
            await handleInstallationSuspended(
              event as InstallationSuspendEvent
            );
            return NextResponse.json({
              message: "Installation suspended successfully",
              ok: true,
            });

          case "unsuspend":
            await handleInstallationUnsuspended(
              event as InstallationUnsuspendEvent
            );
            return NextResponse.json({
              message: "Installation unsuspended successfully",
              ok: true,
            });

          default:
            return NextResponse.json({
              message: `Installation action '${event.action}' acknowledged`,
              ok: true,
            });
        }
      }

      case "installation_repositories": {
        const event = JSON.parse(body) as { action: string };

        log.info("[webhook/github] Received installation_repositories event", {
          action: event.action,
        });

        switch (event.action) {
          case "added":
            await handleInstallationRepositoriesAdded(
              event as InstallationRepositoriesAddedEvent
            );
            return NextResponse.json({
              message: "Repositories added successfully",
              ok: true,
            });

          case "removed":
            await handleInstallationRepositoriesRemoved(
              event as InstallationRepositoriesRemovedEvent
            );
            return NextResponse.json({
              message: "Repositories removed successfully",
              ok: true,
            });

          default:
            return NextResponse.json({
              message: `Installation repositories action '${event.action}' acknowledged`,
              ok: true,
            });
        }
      }

      default: {
        log.info("[webhook/github] Ignoring unsupported event type", {
          eventType,
          reason: "Event type not supported",
        });
        return NextResponse.json({
          message: `Ignoring event type: ${eventType}`,
          ok: true,
        });
      }
    }
  } catch (error) {
    const message = parseError(error);
    log.error("[webhook/github] Unhandled error processing webhook", {
      error: message,
    });

    return NextResponse.json(
      { message: "Something went wrong", ok: false },
      { status: 500 }
    );
  }
};
