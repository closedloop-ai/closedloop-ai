"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  type BranchSelectedPullRequestFile,
  BranchSelectedPullRequestFileCompleteness,
  type BranchSelectedPullRequestFiles,
  type BranchSelectedPullRequestFilesResponse,
  BranchSelectedPullRequestGrossTotalAvailability,
  BranchSelectedPullRequestReadAvailability,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import { formatNumber } from "@repo/app/shared/lib/format-utils";
import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { FileIcon } from "lucide-react";
import { useId, useState } from "react";
import { useBranchSelectedPullRequestDiff } from "../../hooks/use-branch-selected-pull-request-files";
import type { BranchesQueryIdentity } from "../../hooks/use-branches";
import { BranchFileDiffViewer } from "../diff/branch-file-diff-viewer";

export type BranchFilesChangedPanelProps = {
  branchId?: string;
  detail: BranchPageDetail;
  filesError?: boolean;
  filesLoading?: boolean;
  filesResponse?: BranchSelectedPullRequestFilesResponse;
  onRetry?: () => void;
  queryIdentity?: BranchesQueryIdentity;
};

/** Selected-PR file evidence with revision-pinned inline diffs. */
export function BranchFilesChangedPanel({
  branchId,
  detail,
  filesError = false,
  filesLoading = false,
  filesResponse,
  onRetry,
  queryIdentity,
}: BranchFilesChangedPanelProps) {
  const selected = detail.selectedPullRequest;

  return (
    <section aria-labelledby="selected-pr-files-title">
      <div className="bq-sec-head">
        <span className="bq-sec-title" id="selected-pr-files-title">
          Files changed
        </span>
        {filesResponse?.status ===
        BranchSelectedPullRequestReadAvailability.Available ? (
          <FilesSummary value={filesResponse.value} />
        ) : null}
        {selected ? (
          <Chip className="ml-auto" size="sm" variant="info">
            GitHub
          </Chip>
        ) : null}
      </div>
      <FilesBody
        branchId={branchId ?? detail.id}
        detail={detail}
        isError={filesError}
        isLoading={filesLoading}
        onRetry={onRetry}
        queryIdentity={queryIdentity}
        response={filesResponse}
      />
    </section>
  );
}

function FilesBody({
  branchId,
  detail,
  isError,
  isLoading,
  onRetry,
  queryIdentity,
  response,
}: {
  branchId: string;
  detail: BranchPageDetail;
  isError: boolean;
  isLoading: boolean;
  onRetry?: () => void;
  queryIdentity?: BranchesQueryIdentity;
  response: BranchSelectedPullRequestFilesResponse | undefined;
}) {
  const selected = detail.selectedPullRequest;
  if (selected === null) {
    return (
      <p className="py-1 text-muted-foreground text-xs">
        Changed files appear here once a pull request is opened on this branch.
      </p>
    );
  }
  if (selected === undefined) {
    return (
      <p className="py-1 text-muted-foreground text-xs">
        File evidence isn't available yet.
      </p>
    );
  }
  if (isLoading) {
    return <Skeleton className="mt-2 h-20 w-full" />;
  }
  if (
    isError ||
    !response ||
    response.status === BranchSelectedPullRequestReadAvailability.Unavailable
  ) {
    return (
      <div className="flex items-center justify-between gap-3 py-1">
        <p className="text-muted-foreground text-xs">
          File evidence is unavailable for pull request #{selected.number}.
        </p>
        {onRetry ? (
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            Retry
          </Button>
        ) : null}
      </div>
    );
  }
  if (response.value.files.length === 0) {
    const isCompleteKnownEmpty =
      response.value.coverage.completeness ===
        BranchSelectedPullRequestFileCompleteness.Complete &&
      response.value.counts.expected === 0 &&
      response.value.counts.loaded === 0;
    if (!isCompleteKnownEmpty) {
      return (
        <div className="py-1">
          <p className="text-muted-foreground text-xs">
            No verified file rows are available.
          </p>
          <FilesCoverageNote value={response.value} />
        </div>
      );
    }
    return (
      <p className="py-1 text-muted-foreground text-xs">
        This pull request has no changed files.
      </p>
    );
  }
  return (
    <div>
      <FilesCoverageNote value={response.value} />
      <div className="bq-files">
        {response.value.files.map((file) => (
          <FileRow
            branchId={branchId}
            file={file}
            files={response.value}
            key={file.path}
            queryIdentity={queryIdentity}
          />
        ))}
      </div>
    </div>
  );
}

function FileRow({
  branchId,
  file,
  files,
  queryIdentity,
}: {
  branchId: string;
  file: BranchSelectedPullRequestFile;
  files: BranchSelectedPullRequestFiles;
  queryIdentity?: BranchesQueryIdentity;
}) {
  const [open, setOpen] = useState(false);
  const diffId = useId();
  const diffQuery = useBranchSelectedPullRequestDiff(
    {
      branchId,
      repositoryFullName: files.identity.repositoryFullName,
      pullRequestNumber: files.identity.number,
      path: file.path,
      baseSha: files.revision.baseSha,
      headSha: files.revision.headSha,
    },
    { enabled: open },
    queryIdentity
  );
  const diff =
    diffQuery.data?.status ===
    BranchSelectedPullRequestReadAvailability.Available
      ? diffQuery.data.value.diff
      : undefined;
  const diffError =
    diffQuery.isError ||
    diffQuery.data?.status ===
      BranchSelectedPullRequestReadAvailability.Unavailable
      ? (diffQuery.error ?? new Error("Selected pull request diff unavailable"))
      : null;

  return (
    <div>
      <button
        aria-controls={diffId}
        aria-expanded={open}
        className="bq-file bq-file-button"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <FileIcon aria-hidden className="bq-file-ic size-3.5" />
        <span className="bq-file-path font-mono">{file.path}</span>
        <span className="shrink-0 pl-2 font-mono text-xs tabular-nums">
          <b className="bq-add">
            {file.additions === null ? "—" : `+${formatNumber(file.additions)}`}
          </b>{" "}
          <b className="bq-del">
            {file.deletions === null ? "—" : `−${formatNumber(file.deletions)}`}
          </b>
        </span>
      </button>
      {open ? (
        <div id={diffId}>
          <BranchFileDiffViewer
            diffData={diff}
            diffError={diffError}
            isDiffLoading={diffQuery.isLoading}
          />
        </div>
      ) : null}
    </div>
  );
}

function FilesSummary({ value }: { value: BranchSelectedPullRequestFiles }) {
  const incomplete =
    value.coverage.completeness ===
    BranchSelectedPullRequestFileCompleteness.Incomplete;
  const additions = formatGrossTotal(value.grossTotals.additions, incomplete);
  const deletions = formatGrossTotal(value.grossTotals.deletions, incomplete);
  return (
    <span className="bq-sec-count flex items-center gap-2 tabular-nums">
      {fileCountLabel(value)}
      {additions || deletions ? (
        <span className="font-mono">
          {additions ? <b className="bq-add">+{additions}</b> : null}{" "}
          {deletions ? <b className="bq-del">−{deletions}</b> : null}
        </span>
      ) : null}
    </span>
  );
}

function fileCountLabel(value: BranchSelectedPullRequestFiles): string {
  if (
    value.coverage.completeness ===
    BranchSelectedPullRequestFileCompleteness.Incomplete
  ) {
    return value.counts.expected === null
      ? `${formatNumber(value.counts.loaded)} ${fileNoun(value.counts.loaded)} shown*`
      : `${formatNumber(value.counts.loaded)} of ${formatNumber(value.counts.expected)} ${fileNoun(value.counts.expected)} shown*`;
  }
  if (
    value.coverage.completeness ===
    BranchSelectedPullRequestFileCompleteness.Unavailable
  ) {
    return `${formatNumber(value.counts.loaded)} verified ${fileNoun(value.counts.loaded)}`;
  }
  return `${formatNumber(value.counts.loaded)} ${fileNoun(value.counts.loaded)}`;
}

function FilesCoverageNote({
  value,
}: {
  value: BranchSelectedPullRequestFiles;
}) {
  if (
    value.coverage.completeness ===
    BranchSelectedPullRequestFileCompleteness.Complete
  ) {
    return null;
  }
  if (
    value.coverage.completeness ===
    BranchSelectedPullRequestFileCompleteness.Incomplete
  ) {
    return (
      <p className="pb-2 text-muted-foreground text-xs">
        * The file list and totals include only the verified rows shown here.
      </p>
    );
  }
  return (
    <p className="pb-2 text-muted-foreground text-xs">
      File completeness and totals are unavailable. Verified file rows are still
      shown.
    </p>
  );
}

function formatGrossTotal(
  total: BranchSelectedPullRequestFiles["grossTotals"]["additions"],
  incomplete: boolean
): string | null {
  if (
    total.availability ===
    BranchSelectedPullRequestGrossTotalAvailability.Unavailable
  ) {
    return null;
  }
  return `${formatNumber(total.value)}${incomplete ? "*" : ""}`;
}

function fileNoun(count: number): "file" | "files" {
  return count === 1 ? "file" : "files";
}
