"use client";

import { Chip } from "@repo/design-system/components/ui/chip";
import {
  type DiffHunk,
  UnifiedDiff,
} from "@repo/design-system/components/ui/primitives/unified-diff";
import { FileIcon } from "lucide-react";
import { useId, useState } from "react";
import {
  fileCountLabel,
  PrototypeFileCompleteness,
  type PrototypeGrossTotal,
  PrototypeGrossTotalAvailability,
} from "../file-coverage-fixtures";
import type { BranchDetail } from "../mock";
import { SectionHead } from "./detail-panels";

/** Files changed prototype panel with production-parity coverage semantics. */
export function BranchFilesChangedPanel({ detail }: { detail: BranchDetail }) {
  const coverageNoteId = useId();
  const titleId = useId();
  const incomplete =
    detail.fileCoverage.completeness === PrototypeFileCompleteness.Incomplete;
  const additions = formatGrossTotal(
    detail.fileCoverage.grossTotals.additions,
    incomplete
  );
  const deletions = formatGrossTotal(
    detail.fileCoverage.grossTotals.deletions,
    incomplete
  );
  const hasCoverageNote =
    detail.fileCoverage.completeness !== PrototypeFileCompleteness.Complete;

  return (
    <section aria-labelledby={titleId}>
      <SectionHead
        count={
          <span className="flex items-center gap-2">
            <span
              aria-describedby={hasCoverageNote ? coverageNoteId : undefined}
            >
              {fileCountLabel(detail.fileCoverage)}
            </span>
            {additions || deletions ? (
              <span
                aria-describedby={hasCoverageNote ? coverageNoteId : undefined}
                className="font-mono"
              >
                {additions ? (
                  <b className="text-success">+{additions}</b>
                ) : null}{" "}
                {deletions ? (
                  <b className="text-destructive">−{deletions}</b>
                ) : null}
              </span>
            ) : null}
          </span>
        }
        title={<span id={titleId}>Files changed</span>}
        trailing={
          <Chip
            size="sm"
            variant={detail.filesSource === "github" ? "info" : "muted"}
          >
            {detail.filesSource === "github" ? "GitHub" : "Local"}
          </Chip>
        }
      />
      <FilesCoverageNote detail={detail} id={coverageNoteId} />
      <div className="flex flex-col">
        {detail.files.map((file) => (
          <FileRow file={file} key={file.path} />
        ))}
        {detail.fileCoverage.completeness ===
          PrototypeFileCompleteness.Complete &&
        detail.fileCoverage.counts.expected === 0 &&
        detail.files.length === 0 ? (
          <p className="py-1 text-muted-foreground text-xs">
            This pull request has no changed files.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function FileRow({ file }: { file: BranchDetail["files"][number] }) {
  const [open, setOpen] = useState(false);
  const diffId = useId();

  return (
    <div>
      <button
        aria-controls={diffId}
        aria-expanded={open}
        className="flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <FileIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {file.path}
        </span>
        <span className="shrink-0 pl-2 font-mono text-xs">
          <b className="text-success">+{file.additions}</b>{" "}
          <b className="text-destructive">−{file.deletions}</b>
        </span>
      </button>
      {open ? (
        <div className="pb-2" id={diffId}>
          <UnifiedDiff hunks={fileDiffFixture(file)} />
        </div>
      ) : null}
    </div>
  );
}

function FilesCoverageNote({
  detail,
  id,
}: {
  detail: BranchDetail;
  id: string;
}) {
  if (detail.fileCoverage.completeness === PrototypeFileCompleteness.Complete) {
    return null;
  }
  if (
    detail.fileCoverage.completeness === PrototypeFileCompleteness.Incomplete
  ) {
    return (
      <p className="pb-2 text-muted-foreground text-xs" id={id}>
        * The file list and totals include only the verified rows shown here.
      </p>
    );
  }
  return (
    <p className="pb-2 text-muted-foreground text-xs" id={id}>
      File completeness and totals are unavailable. Verified file rows are still
      shown.
    </p>
  );
}

function formatGrossTotal(
  total: PrototypeGrossTotal,
  incomplete: boolean
): string | null {
  if (total.availability === PrototypeGrossTotalAvailability.Unavailable) {
    return null;
  }
  return `${total.value}${incomplete ? "*" : ""}`;
}

function fileDiffFixture(file: BranchDetail["files"][number]): DiffHunk[] {
  return [
    {
      oldStart: 1,
      newStart: 1,
      oldLines: 2,
      newLines: 2,
      lines: [
        ` export const filePath = "${file.path}";`,
        '-const state = "before";',
        '+const state = "after";',
      ],
    },
  ];
}
