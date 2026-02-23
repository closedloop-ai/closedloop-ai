import { SymphonyCommand } from "@repo/api/src/types/artifact";
import type { ExecutionResult } from "@repo/api/src/types/execution-result";
import {
  ExternalLinkType,
  type PreviewDeploymentMetadata,
} from "@repo/api/src/types/external-link";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { CONTENT_KEYS } from "../../extractors/keys";
import type { WorkflowHandler } from "./types";

/**
 * Metadata structure for GITHUB_PR_CREATED and GITHUB_PR_MERGED events.
 * Used for type-safe event data serialization in WorkstreamEvent.data.
 */
type PrEventMetadata = {
  prTitle: string;
  prUrl: string;
  artifactId: string;
  slug?: string;
  branch: string;
  prNumber: number;
  correlationId: string;
  runId: number;
};

/**
 * Handles successful execute workflow runs.
 *
 * Creates a PR record and ExternalLink/EntityLink entries when
 * the execution produced changes. Creates a no-changes event otherwise.
 *
 * NOTE: `tx` (the outer transaction) is not explicitly used here.
 * The handler doesn't need the passed-in tx because all database operations
 * (withDb() and withDb.tx() calls) automatically participate in the outer
 * transaction via AsyncLocalStorage propagation — nested withDb calls reuse
 * the outer tx. PR creation is logically independent (no existing artifact
 * content is being replaced), but all operations share the same transaction
 * and will roll back atomically on failure.
 */
export const executeSuccessHandler: WorkflowHandler = {
  async handle(_tx, ctx, bag): Promise<void> {
    const executionResult = bag.get(CONTENT_KEYS.executionResult);
    const { correlationId, workstreamId, repositoryId, runId } = ctx;

    if (!executionResult) {
      log.info(
        `[executeSuccessHandler] No execution result in bag for workflow run ${runId}, correlation ${correlationId}`
      );
      return;
    }

    // Check if execution actually produced changes and a PR
    if (!(executionResult.has_changes && executionResult.pr_url)) {
      log.info(
        `Execution completed with no changes for workflow run ${runId}, correlation ${correlationId}`
      );
      await withDb((db) =>
        db.workstreamEvent.create({
          data: {
            workstreamId,
            type: "GITHUB_ACTION_COMPLETED",
            actorType: "system",
            data: {
              correlationId,
              runId,
              command: SymphonyCommand.Execute,
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
        `[executeSuccessHandler] No repositoryId in context for correlation ${correlationId}`
      );
      return;
    }

    await createPullRequestRecords(
      ctx.artifactId,
      correlationId,
      workstreamId,
      repositoryId,
      runId,
      executionResult
    );

    log.info(
      `Successfully created PR record for workflow run ${runId}, PR #${parsePrNumber(executionResult)}`
    );
  },
};

function parsePrNumber(executionResult: ExecutionResult): number {
  return typeof executionResult.pr_number === "string"
    ? Number.parseInt(executionResult.pr_number, 10)
    : executionResult.pr_number;
}

async function createPullRequestRecords(
  artifactId: string,
  correlationId: string,
  workstreamId: string,
  repositoryId: string,
  runId: number,
  executionResult: ExecutionResult
): Promise<void> {
  // Convert pr_number from string to number (GitHub Actions outputs strings)
  const prNumber = parsePrNumber(executionResult);

  // Provide defaults for optional fields
  const prTitle =
    executionResult.pr_title ||
    `Symphony: ${executionResult.branch_name || `PR #${prNumber}`}`;
  const baseBranch =
    executionResult.base_branch || executionResult.base_ref || "main";

  await withDb.tx(async (tx) => {
    // Look up workstream to get organizationId for org-scoped queries
    const workstream = await tx.workstream.findUnique({
      where: { id: workstreamId },
      select: { organizationId: true },
    });

    if (!workstream) {
      throw new Error(
        `[executeSuccessHandler] Workstream ${workstreamId} not found for correlation ${correlationId}`
      );
    }

    // Query plan artifact scoped to organization for defense-in-depth
    const planArtifact = await tx.artifact.findUnique({
      where: { id: artifactId, organizationId: workstream.organizationId },
      select: {
        organizationId: true,
        projectId: true,
        generatedBy: true,
        slug: true,
      },
    });

    if (!planArtifact) {
      throw new Error(
        `[executeSuccessHandler] Implementation plan artifact ${artifactId} not found in organization for correlation ${correlationId}`
      );
    }

    // Create GitHubPullRequest record
    await tx.gitHubPullRequest.create({
      data: {
        workstreamId,
        organizationId: workstream.organizationId,
        repositoryId,
        artifactId,
        githubId: executionResult.github_id ?? prNumber,
        number: prNumber,
        title: prTitle,
        htmlUrl: executionResult.pr_url,
        headBranch: executionResult.branch_name,
        baseBranch,
        state: "OPEN",
      },
    });

    // Create ExternalLink for the PR
    const prLink = await tx.externalLink.create({
      data: {
        organizationId: planArtifact.organizationId,
        workstreamId,
        projectId: planArtifact.projectId,
        type: ExternalLinkType.PullRequest,
        title: prTitle,
        externalUrl: executionResult.pr_url,
        metadata: {
          number: prNumber,
          githubId: executionResult.github_id ?? prNumber,
          headBranch: executionResult.branch_name,
          baseBranch,
          state: "OPEN",
        },
      },
    });

    // Create EntityLink: plan artifact → PRODUCES → PR external link
    await tx.entityLink.create({
      data: {
        organizationId: planArtifact.organizationId,
        sourceId: artifactId,
        sourceType: "ARTIFACT",
        targetId: prLink.id,
        targetType: "EXTERNAL_LINK",
        linkType: "PRODUCES",
      },
    });

    // Create skeleton ExternalLink for preview deployment
    // This will be updated with the actual preview deployment information later
    const metadata: PreviewDeploymentMetadata = {
      ref: executionResult.branch_name,
      sha: executionResult.commit_sha ?? null,
      environment: "preview",
      state: null,
    };

    const previewLink = await tx.externalLink.create({
      data: {
        organizationId: planArtifact.organizationId,
        workstreamId,
        projectId: planArtifact.projectId,
        type: ExternalLinkType.PreviewDeployment,
        title: `Preview: ${executionResult.branch_name}`,
        externalUrl: "",
        metadata,
      },
    });

    // Create EntityLink: PR → PRODUCES → preview deployment
    await tx.entityLink.create({
      data: {
        organizationId: planArtifact.organizationId,
        sourceId: prLink.id,
        sourceType: "EXTERNAL_LINK",
        targetId: previewLink.id,
        targetType: "EXTERNAL_LINK",
        linkType: "PRODUCES",
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
          artifactId,
          slug: planArtifact.slug,
        } as PrEventMetadata,
      },
    });
  });
}
