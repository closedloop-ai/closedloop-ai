import assert from "node:assert/strict";
import { BranchCloudHydrationStatus } from "@repo/api/src/types/branch";
import { RepositoryDefaultReason } from "@repo/api/src/types/repository-default-identity";
import { describe, test } from "vitest";
import {
  BranchDefaultEligibilityUnavailableError,
  createBranchDefaultEligibilityDiagnostic,
} from "../src/main/branch/branch-default-eligibility-diagnostic.js";
import {
  BranchSourcePersistentCategory,
  branchSourcePersistentLogMessage,
} from "../src/main/branch/branch-read-boundaries.js";
import { getSharedBranchUsage } from "../src/main/branch/shared-branches-api.js";
import { SHARED_BRANCHES_SOURCE_ERROR_CODE } from "../src/shared/shared-branches-contract.js";
import { link, makeSource } from "./shared-branches-test-helpers.js";

const RAW_CREDENTIAL = "ghp_never-persist-this-credential";
const RAW_PRIVATE_ERROR = [
  "private-owner/sensitive-repository",
  `Bearer ${RAW_CREDENTIAL}`,
  "api_key=never-persist-this-api-key",
  "arbitrary upstream authority failure detail",
  'provider_body={"secret":"never-persist"}',
].join(" ");
const RAW_PRIVATE_ERROR_RE =
  /Bearer|ghp_never-persist-this-credential|api_key|provider_body/;

describe("Branch default eligibility diagnostics", () => {
  test("deduplicates reasons in canonical vocabulary order", () => {
    const diagnostic = createBranchDefaultEligibilityDiagnostic({
      status: BranchCloudHydrationStatus.NotConnected,
      reasons: [
        RepositoryDefaultReason.Unknown,
        RepositoryDefaultReason.Malformed,
        RepositoryDefaultReason.Unknown,
        RepositoryDefaultReason.NotReported,
      ],
    });

    assert.deepEqual(diagnostic.repositoryDefaultReasons, [
      RepositoryDefaultReason.NotReported,
      RepositoryDefaultReason.Malformed,
      RepositoryDefaultReason.Unknown,
    ]);
  });

  test("formats only bounded vocabulary and keeps the renderer-facing error generic", async () => {
    assert.match(RAW_CREDENTIAL, RAW_PRIVATE_ERROR_RE);
    let thrown: unknown;
    try {
      await getSharedBranchUsage(makeSource({ links: [link({})] }));
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error);
    assert.equal(thrown.message, SHARED_BRANCHES_SOURCE_ERROR_CODE);
    const unavailable = thrown.cause;
    assert.ok(unavailable instanceof BranchDefaultEligibilityUnavailableError);
    const message = branchSourcePersistentLogMessage(
      "getSharedBranchUsage",
      unavailable
    );

    assert.ok(
      message.includes(BranchSourcePersistentCategory.EligibilityUnavailable)
    );
    assert.ok(message.includes(BranchCloudHydrationStatus.NotConnected));
    assert.ok(message.includes(RepositoryDefaultReason.Unknown));
    assert.doesNotMatch(message, RAW_PRIVATE_ERROR_RE);
    assert.ok(message.length < 512);

    const generic = branchSourcePersistentLogMessage(
      RAW_PRIVATE_ERROR,
      new Error(RAW_PRIVATE_ERROR)
    );
    assert.equal(
      generic,
      `operation=unknown category=${BranchSourcePersistentCategory.SourceFailure}`
    );
    assert.doesNotMatch(generic, RAW_PRIVATE_ERROR_RE);
  });
});
