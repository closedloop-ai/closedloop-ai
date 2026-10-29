import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import type { RepositoryDefaultSource } from "@repo/api/src/types/repository-default-identity";
import { type TransactionClient, withDb } from "@repo/database";
import type { RepositoryInput } from "@/app/integrations/github/service/repository-sync";

/** Durable authority targets that consume webhook deliveries independently. */
export const RepositoryDefaultObservationTargetKind = {
  GitHubInstallationRepository: "github_installation_repository",
  PublicRepository: "public_repository",
  PullRequestDetail: "pull_request_detail",
} as const;

/**
 * Claims one exact webhook delivery for one authority target. Callers must run
 * this in the same transaction as the corresponding authority mutation.
 */
export async function claimRepositoryDefaultObservationReceipt(
  tx: {
    repositoryDefaultObservationReceipt: Pick<
      TransactionClient["repositoryDefaultObservationReceipt"],
      "createMany"
    >;
  },
  input: {
    organizationId: string;
    targetKind: string;
    targetId: string;
    source: RepositoryDefaultSource;
    observationKey: string;
    observedAt: Date;
  }
): Promise<boolean> {
  const result = await tx.repositoryDefaultObservationReceipt.createMany({
    data: [input],
    skipDuplicates: true,
  });
  return result.count === 1;
}

/**
 * Retain only installation-repository webhook observations whose delivery was
 * newly claimed. Unclaimed installations keep legacy metadata writes but omit
 * authority until an organization-scoped receipt can be recorded safely.
 */
export async function filterUnclaimedRepositoryWebhookObservations(
  tx: Pick<
    TransactionClient,
    "gitHubInstallation" | "repositoryDefaultObservationReceipt"
  >,
  installationId: string,
  repositories: RepositoryInput[]
): Promise<RepositoryInput[]> {
  const webhookRepositories = repositories.filter(
    (repository) =>
      repository.defaultAuthority?.provenance.mechanism ===
      GitHubFetchMechanism.Webhook
  );
  if (webhookRepositories.length === 0) {
    return repositories;
  }

  const installation = await tx.gitHubInstallation.findUnique({
    where: { id: installationId },
    select: { organizationId: true },
  });
  if (!installation?.organizationId) {
    return repositories.map(omitWebhookAuthority);
  }
  const organizationId = installation.organizationId;

  const receipts = webhookRepositories.map((repository) => {
    const provenance = repository.defaultAuthority?.provenance;
    if (!provenance) {
      throw new Error("Webhook repository authority lost its provenance");
    }
    return {
      organizationId,
      targetKind:
        RepositoryDefaultObservationTargetKind.GitHubInstallationRepository,
      targetId: installationRepositoryReceiptTarget(
        installationId,
        repository.githubRepoId
      ),
      source: provenance.source,
      observationKey: provenance.observationKey,
      observedAt: new Date(provenance.observedAt),
    };
  });
  const claimed =
    await tx.repositoryDefaultObservationReceipt.createManyAndReturn({
      data: receipts,
      skipDuplicates: true,
      select: { targetId: true, source: true, observationKey: true },
    });
  const claimedKeys = new Set(
    claimed.map((receipt) =>
      repositoryReceiptClaimKey(
        receipt.targetId,
        receipt.source,
        receipt.observationKey
      )
    )
  );
  return repositories.filter((repository) => {
    const provenance = repository.defaultAuthority?.provenance;
    if (provenance?.mechanism !== GitHubFetchMechanism.Webhook) {
      return true;
    }
    return claimedKeys.has(
      repositoryReceiptClaimKey(
        installationRepositoryReceiptTarget(
          installationId,
          repository.githubRepoId
        ),
        provenance.source,
        provenance.observationKey
      )
    );
  });
}

function omitWebhookAuthority(repository: RepositoryInput): RepositoryInput {
  const { defaultAuthority: _defaultAuthority, ...legacyRepository } =
    repository;
  return legacyRepository;
}

function installationRepositoryReceiptTarget(
  installationId: string,
  githubRepoId: string
): string {
  return `${installationId}:${githubRepoId}`;
}

function repositoryReceiptClaimKey(
  targetId: string,
  source: string,
  observationKey: string
): string {
  return `${targetId}\0${source}\0${observationKey}`;
}

/**
 * ISS-12780: how long a receipt is kept. GitHub redelivers a webhook delivery
 * only within 3 days of it ("You can redeliver webhook deliveries that occurred
 * in the past 3 days", docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks,
 * read 2026-10-20), and every receipt is claimed while its delivery is being
 * handled, so `createdAt` is never earlier than the delivery it records.
 * Unverified: whether a redelivery can itself be redelivered for another 3
 * days. A redelivery keeps the original GUID, so its duplicate claim leaves
 * `createdAt` at the first attempt, and a chain of redeliveries could outlive
 * the receipt. ISS-12841 tracks confirming that or refreshing the window on a
 * duplicate claim.
 */
export const REPOSITORY_DEFAULT_OBSERVATION_RECEIPT_RETENTION_MS = 259_200_000;

/** Deletes receipts older than the retention window, for the daily cron. */
export async function sweepExpiredRepositoryDefaultObservationReceipts(
  now: number = Date.now()
): Promise<{ deleted: number; cutoff: string }> {
  const cutoff = new Date(
    now - REPOSITORY_DEFAULT_OBSERVATION_RECEIPT_RETENTION_MS
  );
  const { count } = await withDb((db) =>
    db.repositoryDefaultObservationReceipt.deleteMany({
      where: { createdAt: { lt: cutoff } },
    })
  );
  return { deleted: count, cutoff: cutoff.toISOString() };
}
