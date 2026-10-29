import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import type { SharedBranchesListRequest } from "../../shared/shared-branches-contract.js";
import type {
  BranchListSnapshot,
  BranchListSnapshotRequest,
} from "../database/branch-list-snapshot-read.js";
import type { BranchReadFacadeMethods } from "../database/branch-read-facades.js";
import {
  readBranchTokenAggregateRows,
  readLocalBranchCommitRows,
  type readLocalBranchLinkRows,
  readLocalBranchPrRows,
} from "../database/branch-reads.js";
import { readBranchCanonicalActivityRowsForScope } from "./branch-empty-scope-reads.js";

type BranchListInputSource = {
  prisma: Parameters<typeof readLocalBranchLinkRows>[0];
} & Pick<BranchReadFacadeMethods, "readBranchCanonicalActivityRows">;

type BranchSnapshotKey = { repoFullName: string | null; branchName: string };

/** Select the atomic DB-host snapshot in server mode and legacy reads otherwise. */
export async function readBranchListInputs({
  source,
  request,
  branchKeys,
  denominatorKeys,
  eligibleBranchIds,
  denominatorEligibleBranchIds,
  readListSnapshot,
  initialRawLinkRows,
}: {
  source: BranchListInputSource;
  request: SharedBranchesListRequest;
  branchKeys: BranchSnapshotKey[];
  denominatorKeys: BranchSnapshotKey[];
  eligibleBranchIds: BranchListSnapshotRequest["eligibleBranchIds"];
  denominatorEligibleBranchIds: BranchListSnapshotRequest["denominatorEligibleBranchIds"];
  readListSnapshot:
    | ((request: BranchListSnapshotRequest) => Promise<BranchListSnapshot>)
    | undefined;
  initialRawLinkRows: Awaited<ReturnType<typeof readLocalBranchLinkRows>>;
}): Promise<BranchListSnapshot> {
  if (
    request.pageMode === BranchListPageMode.Server &&
    readListSnapshot !== undefined
  ) {
    return readListSnapshot({
      eligibleBranchIds,
      denominatorEligibleBranchIds,
    });
  }
  const [prRows, commitRows, tokenRows, activityRows] = await Promise.all([
    readLocalBranchPrRows(source.prisma),
    readLocalBranchCommitRows(source.prisma),
    readBranchTokenAggregateRows(source.prisma, branchKeys, denominatorKeys),
    readBranchCanonicalActivityRowsForScope(source, { branchKeys }),
  ]);
  return {
    linkRows: initialRawLinkRows,
    prRows,
    commitRows,
    tokenRows,
    activityRows,
    sessionBranchCountEntries: [],
  };
}
