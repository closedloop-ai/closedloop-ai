/** Focused ISS-9541 measurement of one maximum-size selected-PR acquisition batch. */
import { SelectedPullRequestEvidenceAvailability } from "@repo/api/src/types/selected-pull-request-evidence";
import type { SelectedPullRequestOctokit } from "@repo/github/selected-pull-request-client";
import { getSelectedPullRequestEvidence } from "@repo/github/selected-pull-request-evidence";
import { test } from "vitest";
import {
  SELECTED_PULL_REQUEST_CONTENT_MAX_ACTIVE,
  SELECTED_PULL_REQUEST_CONTENT_MAX_STARTS,
  SELECTED_PULL_REQUEST_EVIDENCE_MAX_STARTS,
  SelectedPullRequestAcquisitionDenialReason,
  SelectedPullRequestEvidenceAcquisitionBudget,
} from "./selected-pull-request-evidence-acquisition-budget";

const KEY = {
  organizationId: "org-perf",
  userId: "user-perf",
  repositoryFullName: "closedloop-ai/closedloop-ai",
  pullRequestNumber: 8947,
};
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);
const REPRESENTATIVE_FILES = Array.from({ length: 100 }, (_, index) => ({
  additions: 2,
  changes: 3,
  deletions: 1,
  filename: `src/representative-${index}.ts`,
  patch: "@@ -1 +1 @@",
  status: "modified",
}));

test("selected pull request evidence acquisition at the production batch limits", {
  timeout: 0,
}, async ({ bench }) => {
  verifyBatch(await runRepresentativeBatch());
  const result = await bench("maximum admitted acquisition batch", () =>
    runRepresentativeBatch()
  ).run({
    iterations: 100,
    retainSamples: true,
    time: 0,
    warmupIterations: 10,
    warmupTime: 0,
  });
  const samples = result.latency.samples ?? [];
  console.info(
    JSON.stringify({
      batch: {
        contentMaxActive: SELECTED_PULL_REQUEST_CONTENT_MAX_ACTIVE,
        contentStarts: SELECTED_PULL_REQUEST_CONTENT_MAX_STARTS,
        evidenceStarts: SELECTED_PULL_REQUEST_EVIDENCE_MAX_STARTS,
      },
      distributionMs: distributionOf(samples),
      meanMs: result.latency.mean,
      samples: result.latency.samplesCount,
    })
  );
});

async function runRepresentativeBatch(): Promise<AcquisitionBatchResult> {
  const provider = createRepresentativeProvider();
  const budget = new SelectedPullRequestEvidenceAcquisitionBudget<
    Awaited<ReturnType<typeof getSelectedPullRequestEvidence>>
  >({ now: () => 1_000_000 });
  let evidenceStarts = 0;
  for (
    let index = 0;
    index < SELECTED_PULL_REQUEST_EVIDENCE_MAX_STARTS;
    index += 1
  ) {
    const result = await budget.acquireEvidence(
      KEY,
      new AbortController().signal,
      (signal) =>
        getSelectedPullRequestEvidence(
          provider.octokit,
          "closedloop-ai",
          "closedloop-ai",
          KEY.pullRequestNumber,
          signal
        )
    );
    if (
      result.admitted &&
      result.value.status === SelectedPullRequestEvidenceAvailability.Available
    ) {
      evidenceStarts += 1;
    }
  }
  const evidenceStop = await budget.acquireEvidence(
    KEY,
    new AbortController().signal,
    (signal) =>
      getSelectedPullRequestEvidence(
        provider.octokit,
        "closedloop-ai",
        "closedloop-ai",
        KEY.pullRequestNumber,
        signal
      )
  );

  let contentStarts = 0;
  let contentConcurrencyStopReason: SelectedPullRequestAcquisitionDenialReason | null =
    null;
  let peakActiveContent = 0;
  for (
    let index = 0;
    index < SELECTED_PULL_REQUEST_CONTENT_MAX_STARTS;
    index += SELECTED_PULL_REQUEST_CONTENT_MAX_ACTIVE
  ) {
    const permits = Array.from(
      { length: SELECTED_PULL_REQUEST_CONTENT_MAX_ACTIVE },
      () => budget.acquireContent(KEY)
    );
    peakActiveContent = Math.max(
      peakActiveContent,
      permits.filter((permit) => permit.admitted).length
    );
    const concurrentStop = budget.acquireContent(KEY);
    contentConcurrencyStopReason = concurrentStop.admitted
      ? null
      : concurrentStop.reason;
    if (concurrentStop.admitted) {
      concurrentStop.release();
    }
    for (const permit of permits) {
      if (permit.admitted) {
        contentStarts += 1;
        permit.release();
      }
    }
  }
  const contentStop = budget.acquireContent(KEY);
  return {
    contentConcurrencyStopReason,
    contentStarts,
    contentStopReason: contentStop.admitted ? null : contentStop.reason,
    evidenceStarts,
    evidenceStopReason: evidenceStop.admitted ? null : evidenceStop.reason,
    peakActiveContent,
    providerRequestCount: provider.requestCount(),
  };
}

function verifyBatch(result: AcquisitionBatchResult): void {
  if (
    result.evidenceStarts !== SELECTED_PULL_REQUEST_EVIDENCE_MAX_STARTS ||
    result.evidenceStopReason !==
      SelectedPullRequestAcquisitionDenialReason.EvidenceBudgetExhausted ||
    result.peakActiveContent !== SELECTED_PULL_REQUEST_CONTENT_MAX_ACTIVE ||
    result.contentConcurrencyStopReason !==
      SelectedPullRequestAcquisitionDenialReason.ContentConcurrencyExhausted ||
    result.contentStarts !== SELECTED_PULL_REQUEST_CONTENT_MAX_STARTS ||
    result.contentStopReason !==
      SelectedPullRequestAcquisitionDenialReason.ContentBudgetExhausted ||
    result.providerRequestCount !==
      SELECTED_PULL_REQUEST_EVIDENCE_MAX_STARTS * 5
  ) {
    throw new Error(
      `Representative acquisition batch drifted: ${JSON.stringify(result)}`
    );
  }
}

function distributionOf(samples: readonly number[]): {
  max: number | null;
  min: number | null;
  p50: number | null;
  p95: number | null;
} {
  if (samples.length === 0) {
    return { max: null, min: null, p50: null, p95: null };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    max: sorted.at(-1) ?? null,
    min: sorted[0] ?? null,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(sorted: readonly number[], proportion: number) {
  const index = Math.ceil(sorted.length * proportion) - 1;
  return sorted[index] ?? null;
}

function createRepresentativeProvider(): {
  octokit: SelectedPullRequestOctokit;
  requestCount: () => number;
} {
  let requests = 0;
  const octokit: SelectedPullRequestOctokit = {
    rest: {
      pulls: {
        get: () => {
          requests += 1;
          return Promise.resolve({
            data: {
              base: { sha: BASE_SHA },
              changed_files: REPRESENTATIVE_FILES.length,
              head: { sha: HEAD_SHA },
              html_url:
                "https://github.com/closedloop-ai/closedloop-ai/pull/8947",
              id: 8947,
              number: KEY.pullRequestNumber,
            },
          });
        },
        listFiles: ({ page }) => {
          requests += 1;
          return Promise.resolve({
            data: page === 1 ? REPRESENTATIVE_FILES : [],
          });
        },
      },
      repos: {
        compareCommitsWithBasehead: () => {
          requests += 1;
          return Promise.resolve({
            data: { merge_base_commit: { sha: MERGE_BASE_SHA } },
          });
        },
      },
    },
  };
  return { octokit, requestCount: () => requests };
}

type AcquisitionBatchResult = {
  contentConcurrencyStopReason: SelectedPullRequestAcquisitionDenialReason | null;
  contentStarts: number;
  contentStopReason: SelectedPullRequestAcquisitionDenialReason | null;
  evidenceStarts: number;
  evidenceStopReason: SelectedPullRequestAcquisitionDenialReason | null;
  peakActiveContent: number;
  providerRequestCount: number;
};
