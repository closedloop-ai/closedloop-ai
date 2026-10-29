import type { PushEvent } from "@octokit/webhooks-types";
import { GitHubProviderResultStatus } from "@repo/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  persist: vi.fn(),
  readWithInstallationClient: vi.fn(),
}));

vi.mock("@repo/github", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  compareBranchFileChangesWithProviderResult: mocks.compare,
}));

vi.mock("@/lib/github/installation-client", () => ({
  readWithInstallationClient: mocks.readWithInstallationClient,
}));

vi.mock("./branch-activity-producer", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  persistGitHubBranchActivity: mocks.persist,
}));

import { toSuccessfulGitHubProviderResultMock } from "@/__tests__/helpers/github-provider-result-mock";
import { capturePushBranchActivity } from "./push-loc-evidence";

const BEFORE_SHA = "1111111111111111111111111111111111111111";
const AFTER_SHA = "2222222222222222222222222222222222222222";
const MERGE_BASE_SHA = "3333333333333333333333333333333333333333";
const ZERO_SHA = "0".repeat(40);
const COMMIT_AT = "2026-08-12T10:00:00.000Z";

describe("capturePushBranchActivity", () => {
  beforeEach(() => {
    // The production module reaches the compare only through this helper, so
    // routing the callback here proves the compare is the read it performs.
    mocks.readWithInstallationClient.mockImplementation(
      (_installationId: string, read: (octokit: unknown) => unknown) => read({})
    );
    mocks.persist.mockResolvedValue({ status: "persisted" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sums a complete compare into the push's own line delta", async () => {
    mocks.compare.mockResolvedValue(
      comparedFiles([
        { additions: 10, deletions: 2 },
        { additions: 5, deletions: 1 },
      ])
    );

    await capturePushBranchActivity(captureInput());

    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        pushLineDelta: { linesAdded: 15, linesRemoved: 3 },
      })
    );
    // base then head, in that order: swapping them reverses the diff, so the
    // additions and deletions trade places and nothing else would notice.
    expect(mocks.compare).toHaveBeenCalledWith(
      expect.anything(),
      "closedloop-ai",
      "closedloop-ai",
      BEFORE_SHA,
      AFTER_SHA
    );
  });

  it.each([
    {
      name: "a truncated compare",
      compared: comparedFiles([{ additions: 10, deletions: 2 }], true),
    },
    {
      name: "a failed compare",
      compared: { status: GitHubProviderResultStatus.ProviderRepoNotFound },
    },
    {
      name: "a compare that named no files",
      compared: comparedFiles([]),
    },
    {
      name: "a compare carrying an impossible per-file count",
      compared: comparedFiles([
        { additions: 10, deletions: 2 },
        { additions: 1.5, deletions: 0 },
      ]),
    },
  ])(
    "records an unknown delta for $name, never a short sum",
    async ({ compared }) => {
      mocks.compare.mockResolvedValue(compared);

      await capturePushBranchActivity(captureInput());

      expect(mocks.persist).toHaveBeenCalledWith(
        expect.objectContaining({ pushLineDelta: null })
      );
    }
  );

  // A branch create sends the zero sha as `before`. Comparing against it 404s,
  // which would leave the first push of every branch permanently unmeasurable.
  it("compares a branch-create push against the repository default, not the zero sha", async () => {
    mocks.compare.mockResolvedValue(
      comparedFiles([{ additions: 7, deletions: 1 }])
    );

    await capturePushBranchActivity(
      captureInput({ before: ZERO_SHA } as Partial<PushEvent>)
    );

    expect(mocks.compare).toHaveBeenCalledWith(
      expect.anything(),
      "closedloop-ai",
      "closedloop-ai",
      "main",
      AFTER_SHA
    );
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        pushLineDelta: { linesAdded: 7, linesRemoved: 1 },
      })
    );
  });

  // The compare above ran against `main`, a MOVING ref, while the payload's
  // `before` is the all-zero sha. Handing the producer either would file these
  // totals under a range they were never computed over, and `main` can advance
  // between this deferred read and the write. The provider's merge base is the
  // commit the diff actually used and cannot go stale.
  it("hands the producer the compared merge base, not the ref or the payload sha", async () => {
    mocks.compare.mockResolvedValue(
      comparedFiles([{ additions: 7, deletions: 1 }])
    );

    await capturePushBranchActivity(
      captureInput({ before: ZERO_SHA } as Partial<PushEvent>)
    );

    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ pushBaseSha: MERGE_BASE_SHA })
    );
  });

  // An unusable delta does not make the range unknown: the compare still names
  // the base it read, and a row carrying a truthful range with a null delta is
  // the honest record. A failed compare read no range at all.
  it.each([
    { name: "a truncated compare", compared: comparedFiles([], true) },
    { name: "a compare that named no files", compared: comparedFiles([]) },
  ])("still reports the compared base for $name", async ({ compared }) => {
    mocks.compare.mockResolvedValue(compared);

    await capturePushBranchActivity(captureInput());

    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        pushBaseSha: MERGE_BASE_SHA,
        pushLineDelta: null,
      })
    );
  });

  it("reports no compared base when the compare failed", async () => {
    mocks.compare.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderRepoNotFound,
    });

    await capturePushBranchActivity(captureInput());

    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ pushBaseSha: undefined, pushLineDelta: null })
    );
  });

  it("does not read the compare for a zero-commit push", async () => {
    await capturePushBranchActivity(captureInput({ commits: [] }));

    expect(mocks.compare).not.toHaveBeenCalled();
    // The producer still runs and fails closed on the missing occurrence time;
    // the capture never decides on its own whether a row is written.
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ pushLineDelta: null })
    );
  });

  it("never rejects when the write fails", async () => {
    mocks.compare.mockResolvedValue(comparedFiles([]));
    mocks.persist.mockRejectedValue(new Error("database unavailable"));

    await expect(
      capturePushBranchActivity(captureInput())
    ).resolves.toBeUndefined();
  });
});

/**
 * `comparedFilesMock` pins `capped: false`, so the capped arm this suite exists
 * to cover has to build the value itself; the provider-result envelope around it
 * still comes from the shared helper.
 */
function comparedFiles(
  files: readonly { additions: number; deletions: number }[],
  capped = false
) {
  return toSuccessfulGitHubProviderResultMock({
    capped,
    mergeBaseSha: MERGE_BASE_SHA,
    files: files.map((file, index) => ({
      ...file,
      changes: file.additions + file.deletions,
      filename: `file-${index}.ts`,
      status: "modified",
    })),
  });
}

function captureInput(eventOverrides: Partial<PushEvent> = {}) {
  return {
    branchArtifactId: "019ff6d4-9f0b-70df-b07d-aa44ce3a432e",
    deliveryId: "push-delivery-1",
    event: {
      after: AFTER_SHA,
      before: BEFORE_SHA,
      commits: [{ timestamp: COMMIT_AT }],
      repository: {
        default_branch: "main",
        name: "closedloop-ai",
        owner: { login: "closedloop-ai" },
      },
      ...eventOverrides,
    } as unknown as PushEvent,
    installationId: "12345",
    organizationId: "019ff6d4-51f8-7ad0-8a95-40d1f06400dc",
  };
}
