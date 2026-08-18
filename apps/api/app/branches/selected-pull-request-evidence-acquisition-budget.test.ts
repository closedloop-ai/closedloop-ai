import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SELECTED_PULL_REQUEST_CONTENT_MAX_ACTIVE,
  SELECTED_PULL_REQUEST_CONTENT_MAX_STARTS,
  SELECTED_PULL_REQUEST_EVIDENCE_MAX_STARTS,
  SelectedPullRequestAcquisitionDenialReason,
  SelectedPullRequestEvidenceAcquisitionBudget,
} from "./selected-pull-request-evidence-acquisition-budget";

const KEY = {
  organizationId: "org-1",
  userId: "user-1",
  repositoryFullName: "ClosedLoop-AI/Symphony-Alpha",
  pullRequestNumber: 5180,
};

const ISOLATION_CASES = [
  {
    name: "organization",
    left: KEY,
    right: { ...KEY, organizationId: "org-2" },
  },
  {
    name: "canonical repository",
    left: KEY,
    right: {
      ...KEY,
      repositoryFullName: "closedloop-ai/another-repository",
    },
  },
  {
    name: "delimiter-like principal content",
    left: { ...KEY, organizationId: "org|user", userId: "principal" },
    right: { ...KEY, organizationId: "org", userId: "user|principal" },
  },
] as const;

describe("SelectedPullRequestEvidenceAcquisitionBudget", () => {
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
  });

  it("admits N evidence starts and rejects N+1 with a positive retry", async () => {
    const budget = createBudget<string>();

    for (
      let index = 0;
      index < SELECTED_PULL_REQUEST_EVIDENCE_MAX_STARTS;
      index += 1
    ) {
      await expect(
        acquireResolvedEvidence(budget, `evidence-${index}`)
      ).resolves.toEqual({
        admitted: true,
        value: `evidence-${index}`,
      });
    }
    await expect(
      acquireResolvedEvidence(budget, "over budget")
    ).resolves.toEqual({
      admitted: false,
      reason:
        SelectedPullRequestAcquisitionDenialReason.EvidenceBudgetExhausted,
      retryAfterSeconds: 60,
    });
  });

  it("keeps evidence exhausted before the window boundary and resets exactly at it", async () => {
    const budget = createBudget<string>({ evidenceMaxStarts: 1 });
    await expect(acquireResolvedEvidence(budget, "first")).resolves.toEqual({
      admitted: true,
      value: "first",
    });

    now += 59_999;
    await expect(
      acquireResolvedEvidence(budget, "before boundary")
    ).resolves.toEqual({
      admitted: false,
      reason:
        SelectedPullRequestAcquisitionDenialReason.EvidenceBudgetExhausted,
      retryAfterSeconds: 1,
    });

    now += 1;
    await expect(
      acquireResolvedEvidence(budget, "at boundary")
    ).resolves.toEqual({
      admitted: true,
      value: "at boundary",
    });
  });

  it("coalesces a generation and isolates principals and pull requests", async () => {
    const budget = createBudget<string>();
    const first = deferred<string>();
    const firstFactory = vi.fn(() => first.promise);
    const joinedFactory = vi.fn(() => Promise.resolve("not used"));

    const original = budget.acquireEvidence(
      KEY,
      new AbortController().signal,
      firstFactory
    );
    const joined = budget.acquireEvidence(
      { ...KEY, repositoryFullName: "closedloop-ai/symphony-alpha" },
      new AbortController().signal,
      joinedFactory
    );
    const otherUser = budget.acquireEvidence(
      { ...KEY, userId: "user-2" },
      new AbortController().signal,
      async () => "other user"
    );
    const otherPullRequest = budget.acquireEvidence(
      { ...KEY, pullRequestNumber: 5205 },
      new AbortController().signal,
      async () => "other PR"
    );

    first.resolve("shared");
    await expect(Promise.all([original, joined])).resolves.toEqual([
      { admitted: true, value: "shared" },
      { admitted: true, value: "shared" },
    ]);
    await expect(otherUser).resolves.toEqual({
      admitted: true,
      value: "other user",
    });
    await expect(otherPullRequest).resolves.toEqual({
      admitted: true,
      value: "other PR",
    });
    expect(firstFactory).toHaveBeenCalledOnce();
    expect(joinedFactory).not.toHaveBeenCalled();
  });

  it.each(
    ISOLATION_CASES
  )("keeps evidence isolated when only $name differs", async ({
    left,
    right,
  }) => {
    const budget = createBudget<string>();
    const leftResult = deferred<string>();
    const rightResult = deferred<string>();
    const leftFactory = vi.fn(() => leftResult.promise);
    const rightFactory = vi.fn(() => rightResult.promise);

    const leftRead = budget.acquireEvidence(
      left,
      new AbortController().signal,
      leftFactory
    );
    const rightRead = budget.acquireEvidence(
      right,
      new AbortController().signal,
      rightFactory
    );

    expect(leftFactory).toHaveBeenCalledOnce();
    expect(rightFactory).toHaveBeenCalledOnce();
    leftResult.resolve("left");
    rightResult.resolve("right");
    await expect(Promise.all([leftRead, rightRead])).resolves.toEqual([
      { admitted: true, value: "left" },
      { admitted: true, value: "right" },
    ]);
  });

  it.each(
    ISOLATION_CASES
  )("keeps content permits isolated when only $name differs", ({
    left,
    right,
  }) => {
    const budget = createBudget<string>({ contentMaxActive: 1 });
    const leftPermit = budget.acquireContent(left);
    const rightPermit = budget.acquireContent(right);

    expect(leftPermit.admitted).toBe(true);
    expect(rightPermit.admitted).toBe(true);
    if (leftPermit.admitted) {
      leftPermit.release();
    }
    if (rightPermit.admitted) {
      rightPermit.release();
    }
  });

  it("coalesces repository aliases for evidence and content accounting", async () => {
    const budget = createBudget<string>({ contentMaxActive: 1 });
    const evidenceResult = deferred<string>();
    const canonicalFactory = vi.fn(() => evidenceResult.promise);
    const aliasFactory = vi.fn(async () => "not used");
    const canonicalRead = budget.acquireEvidence(
      KEY,
      new AbortController().signal,
      canonicalFactory
    );
    const aliasRead = budget.acquireEvidence(
      { ...KEY, repositoryFullName: "closedloop-ai/symphony-alpha" },
      new AbortController().signal,
      aliasFactory
    );

    evidenceResult.resolve("shared");
    await expect(Promise.all([canonicalRead, aliasRead])).resolves.toEqual([
      { admitted: true, value: "shared" },
      { admitted: true, value: "shared" },
    ]);
    expect(aliasFactory).not.toHaveBeenCalled();

    const canonicalPermit = budget.acquireContent(KEY);
    const aliasPermit = budget.acquireContent({
      ...KEY,
      repositoryFullName: "closedloop-ai/symphony-alpha",
    });
    expect(canonicalPermit.admitted).toBe(true);
    expect(aliasPermit).toEqual(
      expect.objectContaining({
        admitted: false,
        reason:
          SelectedPullRequestAcquisitionDenialReason.ContentConcurrencyExhausted,
      })
    );
    if (canonicalPermit.admitted) {
      canonicalPermit.release();
    }
  });

  it("keeps shared work alive until the last subscriber cancels", async () => {
    const budget = createBudget<string>();
    const first = deferred<string>();
    const firstCaller = new AbortController();
    const secondCaller = new AbortController();
    let sharedSignal: AbortSignal | undefined;

    const firstRead = budget.acquireEvidence(
      KEY,
      firstCaller.signal,
      (signal) => {
        sharedSignal = signal;
        return first.promise;
      }
    );
    const secondRead = budget.acquireEvidence(
      KEY,
      secondCaller.signal,
      async () => "not used"
    );

    firstCaller.abort();
    await expect(firstRead).rejects.toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(false);

    secondCaller.abort();
    await expect(secondRead).rejects.toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(true);
    first.reject(new DOMException("provider canceled", "AbortError"));
  });

  it("keeps canceled provider work retiring until it settles", async () => {
    const budget = createBudget<string>({ evidenceMaxStarts: 2 });
    const canceled = deferred<string>();
    const caller = new AbortController();
    const replacementFactory = vi.fn(async () => "replacement");
    const canceledRead = budget.acquireEvidence(
      KEY,
      caller.signal,
      () => canceled.promise
    );

    caller.abort();
    await expect(canceledRead).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      budget.acquireEvidence(
        KEY,
        new AbortController().signal,
        replacementFactory
      )
    ).resolves.toEqual({
      admitted: false,
      reason: SelectedPullRequestAcquisitionDenialReason.EvidenceRetiring,
      retryAfterSeconds: 1,
    });
    expect(replacementFactory).not.toHaveBeenCalled();

    canceled.reject(new DOMException("provider canceled", "AbortError"));
    await expect(canceled.promise).rejects.toMatchObject({
      name: "AbortError",
    });

    await expect(
      budget.acquireEvidence(
        KEY,
        new AbortController().signal,
        replacementFactory
      )
    ).resolves.toEqual({ admitted: true, value: "replacement" });
    await expect(
      acquireResolvedEvidence(budget, "over budget")
    ).resolves.toEqual(
      expect.objectContaining({
        admitted: false,
        reason:
          SelectedPullRequestAcquisitionDenialReason.EvidenceBudgetExhausted,
      })
    );
  });

  it("does not evict a retiring provider flight at the entry cap", async () => {
    const budget = createBudget<string>({ maxEntries: 1 });
    const canceled = deferred<string>();
    const caller = new AbortController();
    const canceledRead = budget.acquireEvidence(
      KEY,
      caller.signal,
      () => canceled.promise
    );

    caller.abort();
    await expect(canceledRead).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      budget.acquireEvidence(
        { ...KEY, userId: "user-2" },
        new AbortController().signal,
        async () => "must not start"
      )
    ).resolves.toEqual({
      admitted: false,
      reason: SelectedPullRequestAcquisitionDenialReason.CapacityExhausted,
      retryAfterSeconds: 1,
    });

    canceled.reject(new DOMException("provider canceled", "AbortError"));
    await expect(canceled.promise).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(
      budget.acquireEvidence(
        { ...KEY, userId: "user-2" },
        new AbortController().signal,
        async () => "after retirement"
      )
    ).resolves.toEqual({ admitted: true, value: "after retirement" });
  });

  it("cleans up a synchronous factory throw and preserves the consumed start", async () => {
    const budget = createBudget<string>({ evidenceMaxStarts: 2 });

    await expect(
      budget.acquireEvidence(KEY, new AbortController().signal, () => {
        throw new Error("synchronous factory failure");
      })
    ).rejects.toThrow("synchronous factory failure");
    await expect(acquireResolvedEvidence(budget, "recovered")).resolves.toEqual(
      {
        admitted: true,
        value: "recovered",
      }
    );
    await expect(
      acquireResolvedEvidence(budget, "over budget")
    ).resolves.toEqual(expect.objectContaining({ admitted: false }));
  });

  it("reclaims idle saturation across principals before window expiry", async () => {
    const budget = createBudget<string>({
      evidenceMaxStarts: 1,
      maxEntries: 1,
    });
    await acquireResolvedEvidence(budget, "first");

    await expect(
      budget.acquireEvidence(
        { ...KEY, userId: "user-2" },
        new AbortController().signal,
        async () => "after idle reclaim"
      )
    ).resolves.toEqual({ admitted: true, value: "after idle reclaim" });
  });

  it("returns capacity exhaustion while every retained entry is active", async () => {
    const budget = createBudget<string>({ maxEntries: 1 });
    const activePermit = budget.acquireContent(KEY);
    if (!activePermit.admitted) {
      throw new Error("Expected active content permit");
    }

    const denial = await budget.acquireEvidence(
      { ...KEY, userId: "user-2" },
      new AbortController().signal,
      async () => "blocked"
    );
    expect(denial).toEqual({
      admitted: false,
      reason: SelectedPullRequestAcquisitionDenialReason.CapacityExhausted,
      retryAfterSeconds: 1,
    });

    activePermit.release();
    await expect(
      budget.acquireEvidence(
        { ...KEY, userId: "user-2" },
        new AbortController().signal,
        async () => "after release"
      )
    ).resolves.toEqual({ admitted: true, value: "after release" });
  });

  it("bounds active content, releases idempotently, and counts N/N+1 starts", () => {
    const budget = createBudget<string>();
    const held = Array.from(
      { length: SELECTED_PULL_REQUEST_CONTENT_MAX_ACTIVE },
      () => budget.acquireContent(KEY)
    );
    const concurrent = budget.acquireContent(KEY);

    expect(concurrent).toEqual({
      admitted: false,
      reason:
        SelectedPullRequestAcquisitionDenialReason.ContentConcurrencyExhausted,
      retryAfterSeconds: 1,
    });
    for (const admission of held) {
      if (!admission.admitted) {
        throw new Error("Expected content admission");
      }
      admission.release();
      admission.release();
    }
    for (
      let index = SELECTED_PULL_REQUEST_CONTENT_MAX_ACTIVE;
      index < SELECTED_PULL_REQUEST_CONTENT_MAX_STARTS;
      index += 1
    ) {
      const admission = budget.acquireContent(KEY);
      if (!admission.admitted) {
        throw new Error(`Expected content admission ${index + 1}`);
      }
      admission.release();
    }
    expect(budget.acquireContent(KEY)).toEqual({
      admitted: false,
      reason: SelectedPullRequestAcquisitionDenialReason.ContentBudgetExhausted,
      retryAfterSeconds: 60,
    });
  });

  it("keeps content budgets isolated and resets them at the exact boundary", () => {
    const budget = createBudget<string>({ contentMaxStarts: 1 });
    const first = budget.acquireContent(KEY);
    const other = budget.acquireContent({ ...KEY, pullRequestNumber: 5205 });
    if (!(first.admitted && other.admitted)) {
      throw new Error("Expected isolated content admissions");
    }
    first.release();
    other.release();
    expect(budget.acquireContent(KEY).admitted).toBe(false);

    now += 60_000;
    const reset = budget.acquireContent(KEY);
    expect(reset.admitted).toBe(true);
    if (reset.admitted) {
      reset.release();
    }
  });

  function createBudget<Evidence>(
    options: ConstructorParameters<
      typeof SelectedPullRequestEvidenceAcquisitionBudget<Evidence>
    >[0] = {}
  ) {
    return new SelectedPullRequestEvidenceAcquisitionBudget<Evidence>({
      now: () => now,
      ...options,
    });
  }
});

function acquireResolvedEvidence(
  budget: SelectedPullRequestEvidenceAcquisitionBudget<string>,
  value: string
) {
  return budget.acquireEvidence(
    KEY,
    new AbortController().signal,
    async () => value
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}
