import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  SelectedPullRequestContentNotApplicableReason,
  SelectedPullRequestContentReferenceAvailability,
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestFileCompleteness,
  SelectedPullRequestFilePartialReason,
  SelectedPullRequestFileStatus,
  SelectedPullRequestPatchAvailability,
  SelectedPullRequestPatchOmissionReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { getSelectedPullRequestEvidence } from "../selected-pull-request-evidence";
import {
  BASE_SHA,
  HEAD_SHA,
  MERGE_BASE_SHA,
  makeFile,
  makeFiles,
  mockCompareCommitsWithBasehead,
  mockGet,
  mockListFiles,
  mockStableMetadata,
  mockThirtyFullPages,
  OWNER,
  octokit,
  PULL_NUMBER,
  REPO,
  resetEvidenceMocks,
} from "./selected-pull-request-evidence-fixtures";

describe("getSelectedPullRequestEvidence acquisition and completeness", () => {
  beforeEach(() => {
    resetEvidenceMocks();
  });

  it("returns complete immutable evidence and normalizes rename and omitted patch behavior", async () => {
    mockStableMetadata(2);
    mockListFiles.mockResolvedValueOnce({
      data: [
        makeFile({ patch: "@@ -1 +1 @@", status: "modified" }),
        makeFile({
          filename: "src/new-name.ts",
          patch: undefined,
          previous_filename: "src/old-name.ts",
          status: "renamed",
        }),
      ],
    });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      ` ${OWNER} `,
      `${REPO}.git`,
      PULL_NUMBER
    );

    expect(result.status).toBe(
      SelectedPullRequestEvidenceAvailability.Available
    );
    if (result.status !== SelectedPullRequestEvidenceAvailability.Available) {
      return;
    }
    expect(result.value.identity.repositoryFullName).toBe("acme/widgets");
    expect(result.value.revision).toEqual({
      baseSha: MERGE_BASE_SHA,
      headSha: HEAD_SHA,
    });
    expect(result.value.coverage).toEqual({
      completeness: SelectedPullRequestFileCompleteness.Complete,
      reasons: [],
    });
    expect(result.value.files[1]).toEqual(
      expect.objectContaining({
        path: "src/new-name.ts",
        previousPath: "src/old-name.ts",
        status: SelectedPullRequestFileStatus.Renamed,
        patch: {
          availability: SelectedPullRequestPatchAvailability.Omitted,
          reason: SelectedPullRequestPatchOmissionReason.ProviderOmitted,
        },
        baseContent: {
          availability:
            SelectedPullRequestContentReferenceAvailability.Available,
          path: "src/old-name.ts",
          ref: MERGE_BASE_SHA,
        },
        headContent: {
          availability:
            SelectedPullRequestContentReferenceAvailability.Available,
          path: "src/new-name.ts",
          ref: HEAD_SHA,
        },
      })
    );
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenNthCalledWith(1, {
      owner: "acme",
      repo: "widgets",
      pull_number: PULL_NUMBER,
      request: { signal: expect.any(AbortSignal) },
    });
    expect(mockCompareCommitsWithBasehead).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      basehead: `${BASE_SHA}...${HEAD_SHA}`,
      request: { signal: expect.any(AbortSignal) },
    });
    expect(mockListFiles).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      pull_number: PULL_NUMBER,
      page: 1,
      per_page: 100,
      request: { signal: expect.any(AbortSignal) },
    });
  });

  it("preserves filename whitespace in PR evidence and content references", async () => {
    const filename = " src/new-name.ts ";
    const previousFilename = " src/old-name.ts ";
    mockStableMetadata(1);
    mockListFiles.mockResolvedValueOnce({
      data: [
        makeFile({
          filename,
          previous_filename: previousFilename,
          status: "renamed",
        }),
      ],
    });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        files: [
          {
            path: filename,
            previousPath: previousFilename,
            baseContent: { path: previousFilename },
            headContent: { path: filename },
          },
        ],
      },
    });
  });

  it("preserves an empty provider patch as available evidence", async () => {
    mockStableMetadata(1);
    mockListFiles.mockResolvedValueOnce({ data: [makeFile({ patch: "" })] });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        files: [
          {
            patch: {
              availability: SelectedPullRequestPatchAvailability.Available,
              patch: "",
            },
          },
        ],
      },
    });
  });

  it("paginates until a terminal page and reconciles provider counts", async () => {
    mockStableMetadata(101);
    mockListFiles
      .mockResolvedValueOnce({ data: makeFiles(100, 0) })
      .mockResolvedValueOnce({ data: makeFiles(1, 100) });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: {
          expected: 101,
          normalizedReturned: 101,
          providerReturned: 101,
        },
        pagination: { pagesFetched: 2, reachedProviderMaximum: false },
        coverage: {
          completeness: SelectedPullRequestFileCompleteness.Complete,
          reasons: [],
        },
      },
    });
  });

  it("reports exactly 3000 expected files as complete at the provider maximum", async () => {
    mockStableMetadata(3000);
    mockThirtyFullPages();

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: { expected: 3000, normalizedReturned: 3000 },
        pagination: { pagesFetched: 30, reachedProviderMaximum: true },
        coverage: {
          completeness: SelectedPullRequestFileCompleteness.Complete,
          reasons: [],
        },
      },
    });
  });

  it("reports more than 3000 expected files as capped partial evidence", async () => {
    mockStableMetadata(3001);
    mockThirtyFullPages();

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: { expected: 3001, normalizedReturned: 3000 },
        coverage: {
          completeness: SelectedPullRequestFileCompleteness.Partial,
          reasons: [
            SelectedPullRequestFilePartialReason.ProviderCapped,
            SelectedPullRequestFilePartialReason.CountMismatch,
          ],
        },
      },
    });
  });

  it("reports unknown expected count at 3000 as capped partial evidence", async () => {
    mockStableMetadata(null);
    mockThirtyFullPages();

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        coverage: {
          completeness: SelectedPullRequestFileCompleteness.Partial,
          reasons: [SelectedPullRequestFilePartialReason.ProviderCapped],
        },
      },
    });
  });

  it("returns partial evidence when known and normalized counts disagree", async () => {
    mockStableMetadata(2);
    mockListFiles.mockResolvedValueOnce({ data: [makeFile()] });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        coverage: {
          completeness: SelectedPullRequestFileCompleteness.Partial,
          reasons: [SelectedPullRequestFilePartialReason.CountMismatch],
        },
      },
    });
  });

  it("rejects duplicate provider paths instead of treating repeated pages as complete", async () => {
    const repeatedPage = makeFiles(100, 0);
    mockStableMetadata(200);
    mockListFiles
      .mockResolvedValueOnce({ data: repeatedPage })
      .mockResolvedValueOnce({ data: repeatedPage })
      .mockResolvedValueOnce({ data: [] });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: {
          expected: 200,
          normalizedReturned: 100,
          providerReturned: 200,
        },
        coverage: {
          completeness: SelectedPullRequestFileCompleteness.Partial,
          reasons: [
            SelectedPullRequestFilePartialReason.CountMismatch,
            SelectedPullRequestFilePartialReason.MalformedFile,
          ],
        },
      },
    });
  });

  it("omits malformed rows and marks unknown statuses partial", async () => {
    mockStableMetadata(4);
    mockListFiles.mockResolvedValueOnce({
      data: [
        makeFile(),
        makeFile({ additions: -1, filename: "bad.ts" }),
        makeFile({ filename: "future.ts", status: "future_status" }),
        makeFile({ filename: "rename-without-source.ts", status: "renamed" }),
      ],
    });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: { expected: 4, normalizedReturned: 2, providerReturned: 4 },
        coverage: {
          completeness: SelectedPullRequestFileCompleteness.Partial,
          reasons: [
            SelectedPullRequestFilePartialReason.CountMismatch,
            SelectedPullRequestFilePartialReason.MalformedFile,
          ],
        },
      },
    });
    if (result.status === SelectedPullRequestEvidenceAvailability.Available) {
      expect(result.value.files[1]?.status).toBe(
        SelectedPullRequestFileStatus.Unknown
      );
    }
  });

  it("preserves absent provider line counts as null without marking evidence partial", async () => {
    mockStableMetadata(1);
    mockListFiles.mockResolvedValueOnce({
      data: [makeFile({ additions: null, changes: null, deletions: null })],
    });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        files: [{ additions: null, changes: null, deletions: null }],
        coverage: {
          completeness: SelectedPullRequestFileCompleteness.Complete,
          reasons: [],
        },
      },
    });
  });

  it("drops the base reference for an added file and the head reference for a removed file", async () => {
    mockStableMetadata(2);
    mockListFiles.mockResolvedValueOnce({
      data: [
        makeFile({ filename: "src/added.ts", status: "added" }),
        makeFile({ filename: "src/removed.ts", status: "removed" }),
      ],
    });

    const result = await getSelectedPullRequestEvidence(
      octokit,
      OWNER,
      REPO,
      PULL_NUMBER
    );

    expect(result.status).toBe(
      SelectedPullRequestEvidenceAvailability.Available
    );
    if (result.status !== SelectedPullRequestEvidenceAvailability.Available) {
      return;
    }
    expect(result.value.files[0]?.baseContent).toEqual({
      availability:
        SelectedPullRequestContentReferenceAvailability.NotApplicable,
      reason: SelectedPullRequestContentNotApplicableReason.AddedFile,
    });
    expect(result.value.files[0]?.headContent).toEqual({
      availability: SelectedPullRequestContentReferenceAvailability.Available,
      path: "src/added.ts",
      ref: HEAD_SHA,
    });
    expect(result.value.files[1]?.baseContent).toEqual({
      availability: SelectedPullRequestContentReferenceAvailability.Available,
      path: "src/removed.ts",
      ref: MERGE_BASE_SHA,
    });
    expect(result.value.files[1]?.headContent).toEqual({
      availability:
        SelectedPullRequestContentReferenceAvailability.NotApplicable,
      reason: SelectedPullRequestContentNotApplicableReason.RemovedFile,
    });
  });
});
