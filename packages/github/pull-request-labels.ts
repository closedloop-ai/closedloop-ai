import "server-only";
import type { Octokit } from "@octokit/rest";
import {
  batchPullRequestLabels,
  normalizePullRequestLabelName,
  type PullRequestLabelSpec,
  pullRequestLabelsToAdd,
} from "@repo/api/src/types/pull-request-label";
import {
  emptyPullRequestLabelSyncResult,
  type PullRequestLabelSyncResult,
  PullRequestLabelSyncStatus,
} from "@repo/api/src/types/pull-request-label-sync-status";
import { log } from "@repo/observability/log";
import { z } from "zod";

/**
 * ISS-4664: apply an artifact's Closedloop tags to its pull request as GitHub
 * labels, creating any label the repository does not have yet.
 *
 * Two invariants drive the design:
 *  - **Create-if-missing is idempotent.** A concurrent delivery may create the
 *    same label first, so a 422 `already_exists` from `createLabel` counts as
 *    success rather than an error.
 *  - **Reconciliation never clobbers manual labels.** We read the PR's current
 *    labels, compute additions only, and write through the additive
 *    `POST /issues/{n}/labels` endpoint — never the replacing `PUT`. A label a
 *    human added by hand is therefore left alone, and a re-delivered webhook
 *    computes an empty addition set and performs no write at all.
 */

/** Page size and page bound for the label reads (100 is GitHub's maximum). */
const LABEL_PAGE_SIZE = 100;
const MAX_LABEL_PAGES = 5;

const LABEL_ALREADY_EXISTS_STATUS = 422;

/**
 * ISS-4764: `PullRequestLabelSyncStatus` and `PullRequestLabelSyncResult` are
 * NOT declared here. They live in
 * `@repo/api/src/types/pull-request-label-sync-status` so `apps/api` and the
 * shared web/desktop link-PR dialog can read them without pulling in this
 * `server-only`, Octokit-typed module. Import them from there, not from here —
 * a re-export would make this a barrel file (Biome `noBarrelFile`).
 */

/**
 * Outcome of ensuring the repository's labels exist. `created` is the subset
 * this pass actually created; `failed` is the subset a non-conflict provider
 * error left uncreated. A label in `failed` must NOT be sent to `addLabels`:
 * the add endpoint 422s the ENTIRE batch on a single unknown label, so one
 * transient create failure would otherwise drop every valid label too.
 */
export type EnsureRepositoryLabelsResult = {
  created: string[];
  failed: string[];
};

export type PullRequestLabelTarget = {
  owner: string;
  repo: string;
  pullNumber: number;
};

/**
 * Read the labels currently on a pull request (bounded pagination). Returns
 * `null` when GitHub could not be read, so callers can distinguish "no labels"
 * from "unknown" instead of treating a failed read as an empty set — the latter
 * would make every desired label look missing and re-add manually removed ones.
 */
export async function listPullRequestLabelNames(
  octokit: Octokit,
  target: PullRequestLabelTarget
): Promise<string[] | null> {
  const names: string[] = [];
  try {
    for (let page = 1; page <= MAX_LABEL_PAGES; page++) {
      const { data } = await octokit.rest.issues.listLabelsOnIssue({
        owner: target.owner,
        repo: target.repo,
        issue_number: target.pullNumber,
        per_page: LABEL_PAGE_SIZE,
        page,
      });
      names.push(...data.map((label) => label.name));
      if (data.length < LABEL_PAGE_SIZE) {
        break;
      }
    }
    return names;
  } catch (error) {
    log.warn("[pull-request-labels] Failed to read pull request labels", {
      owner: target.owner,
      repo: target.repo,
      pullNumber: target.pullNumber,
      error: errorMessage(error),
    });
    return null;
  }
}

/**
 * Create every label the repository is missing. Idempotent: labels that already
 * exist are skipped, and a concurrent create that loses the race (422
 * `already_exists`) is treated as success rather than a failure.
 *
 * Returns `{ created, failed }`, or `null` when the repository label read
 * failed (the caller should not attempt to apply labels blind, because an apply
 * against a missing label 422s the whole request). `failed` names a label a
 * NON-conflict provider error left uncreated — the caller must exclude those
 * from the add batch so one transient failure cannot reject every valid label.
 */
export async function ensureRepositoryLabelsExist(
  octokit: Octokit,
  repository: { owner: string; repo: string },
  labels: readonly PullRequestLabelSpec[]
): Promise<EnsureRepositoryLabelsResult | null> {
  if (labels.length === 0) {
    return { created: [], failed: [] };
  }

  const existing = await listRepositoryLabelNames(octokit, repository);
  if (existing === null) {
    return null;
  }

  const created: string[] = [];
  const failed: string[] = [];
  for (const label of pullRequestLabelsToAdd(existing, labels)) {
    const outcome = await createLabelTolerantOfConflict(
      octokit,
      repository,
      label
    );
    if (outcome === LabelCreateOutcome.Created) {
      created.push(label.name);
    } else if (outcome === LabelCreateOutcome.Failed) {
      failed.push(label.name);
    }
  }
  return { created, failed };
}

/**
 * Apply the tag-derived labels to a pull request, creating missing labels
 * first. Additive and idempotent — see the module header.
 */
export async function reconcilePullRequestLabels(
  octokit: Octokit,
  target: PullRequestLabelTarget,
  desiredLabels: readonly PullRequestLabelSpec[]
): Promise<PullRequestLabelSyncResult> {
  if (desiredLabels.length === 0) {
    return emptyPullRequestLabelSyncResult(PullRequestLabelSyncStatus.NoOp);
  }

  const currentNames = await listPullRequestLabelNames(octokit, target);
  if (currentNames === null) {
    return emptyPullRequestLabelSyncResult(PullRequestLabelSyncStatus.Failed);
  }

  const additions = pullRequestLabelsToAdd(currentNames, desiredLabels);
  if (additions.length === 0) {
    return emptyPullRequestLabelSyncResult(PullRequestLabelSyncStatus.NoOp);
  }

  const ensured = await ensureRepositoryLabelsExist(
    octokit,
    { owner: target.owner, repo: target.repo },
    additions
  );
  if (ensured === null) {
    return emptyPullRequestLabelSyncResult(PullRequestLabelSyncStatus.Failed);
  }

  // A label whose non-conflict create failed is still missing from the repo.
  // Sending it to the additive endpoint would 422 the ENTIRE batch and drop
  // every valid label, so exclude those names and add only the applicable set.
  const failedNames = new Set(
    ensured.failed.map(normalizePullRequestLabelName)
  );
  const applicable = additions.filter(
    (label) => !failedNames.has(normalizePullRequestLabelName(label.name))
  );
  if (applicable.length === 0) {
    // Nothing could be created and nothing already existed to add — surface
    // this as a failure rather than a silent no-op so callers can log/retry.
    return {
      status: PullRequestLabelSyncStatus.Failed,
      createdLabels: ensured.created,
      addedLabels: [],
      droppedLabels: [],
    };
  }

  // ISS-4762: apply the COMPLETE set in bounded provider batches instead of
  // truncating it. A 26-tag artifact used to lose its 26th tag permanently —
  // the ISS-4664 contract is that every tag reaches the PR, so the size of one
  // write must not be the size of the desired set.
  const added: string[] = [];
  for (const batch of batchPullRequestLabels(applicable)) {
    try {
      await octokit.rest.issues.addLabels({
        owner: target.owner,
        repo: target.repo,
        issue_number: target.pullNumber,
        labels: batch.map((label) => label.name),
      });
      added.push(...batch.map((label) => label.name));
    } catch (error) {
      log.warn("[pull-request-labels] Failed to add labels to pull request", {
        owner: target.owner,
        repo: target.repo,
        pullNumber: target.pullNumber,
        batchSize: batch.length,
        error: errorMessage(error),
      });
      // Report the batches that DID land rather than claiming none did; a later
      // pass recomputes additions from the PR's real labels and retries the rest.
      return {
        status: PullRequestLabelSyncStatus.Failed,
        createdLabels: ensured.created,
        addedLabels: added,
        droppedLabels: [],
      };
    }
  }

  // Any label a transient create failure dropped means the pass did not fully
  // converge; report Failed (retriable) even though the applicable subset was
  // applied, so a later delivery re-attempts the dropped labels.
  const status =
    ensured.failed.length > 0
      ? PullRequestLabelSyncStatus.Failed
      : PullRequestLabelSyncStatus.Applied;
  return {
    status,
    createdLabels: ensured.created,
    addedLabels: added,
    droppedLabels: [],
  };
}

async function listRepositoryLabelNames(
  octokit: Octokit,
  repository: { owner: string; repo: string }
): Promise<string[] | null> {
  const names: string[] = [];
  try {
    for (let page = 1; page <= MAX_LABEL_PAGES; page++) {
      const { data } = await octokit.rest.issues.listLabelsForRepo({
        owner: repository.owner,
        repo: repository.repo,
        per_page: LABEL_PAGE_SIZE,
        page,
      });
      names.push(...data.map((label) => label.name));
      if (data.length < LABEL_PAGE_SIZE) {
        break;
      }
    }
    return names;
  } catch (error) {
    log.warn("[pull-request-labels] Failed to read repository labels", {
      owner: repository.owner,
      repo: repository.repo,
      error: errorMessage(error),
    });
    return null;
  }
}

/**
 * Three-way outcome of a single label create, so the caller can tell a genuine
 * failure apart from the benign already-exists race:
 *  - `Created`   — this call created the label.
 *  - `Exists`    — GitHub reported it already exists (a concurrent create won
 *                  the race, or the bounded repo-label read did not reach it);
 *                  the label IS present, so it is safe to apply.
 *  - `Failed`    — a non-conflict provider error left it uncreated; it must be
 *                  excluded from the add batch (see `reconcilePullRequestLabels`).
 */
const LabelCreateOutcome = {
  Created: "created",
  Exists: "exists",
  Failed: "failed",
} as const;
type LabelCreateOutcome =
  (typeof LabelCreateOutcome)[keyof typeof LabelCreateOutcome];

/**
 * Create one label. Rethrows nothing — a non-conflict failure is logged and
 * reported as `Failed` so a single bad label cannot abort the whole pass, but
 * the caller learns the label is still missing rather than mistaking it for an
 * already-existing one.
 */
async function createLabelTolerantOfConflict(
  octokit: Octokit,
  repository: { owner: string; repo: string },
  label: PullRequestLabelSpec
): Promise<LabelCreateOutcome> {
  try {
    await octokit.rest.issues.createLabel({
      owner: repository.owner,
      repo: repository.repo,
      name: label.name,
      color: label.color,
      description: label.description,
    });
    return LabelCreateOutcome.Created;
  } catch (error) {
    if (statusOf(error) === LABEL_ALREADY_EXISTS_STATUS) {
      return LabelCreateOutcome.Exists;
    }
    log.warn("[pull-request-labels] Failed to create repository label", {
      owner: repository.owner,
      repo: repository.repo,
      label: normalizePullRequestLabelName(label.name),
      error: errorMessage(error),
    });
    return LabelCreateOutcome.Failed;
  }
}

function statusOf(error: unknown): number | null {
  const parsed = providerErrorStatusSchema.safeParse(error);
  return parsed.success ? parsed.data.status : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Octokit surfaces the HTTP status on the thrown `RequestError`. */
const providerErrorStatusSchema = z.object({ status: z.number() });
