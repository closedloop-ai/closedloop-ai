"use client";

import {
  type BranchViewData,
  type BranchViewFile,
  buildFileId,
  FileSection,
} from "../types";
import { BranchPrCommentsSection } from "./branch-pr-comments-section";
import { BranchPropertiesBar } from "./branch-properties-bar";
import { CommittedChangesSection } from "./committed-changes-section";
import { LocalChangesSection } from "./local-changes-section";

type BranchViewContentProps = {
  data: BranchViewData;
  localFiles: BranchViewFile[];
  onSelectComment: (id: string | null) => void;
  onSelectFile: (fileId: string) => void;
  selectedCommentId: string | null;
  selectedFileId: string | null;
};

export function BranchViewContent({
  data,
  localFiles,
  onSelectComment,
  onSelectFile,
  selectedCommentId,
  selectedFileId,
}: Readonly<BranchViewContentProps>) {
  return (
    <div className="flex flex-col gap-5 px-3 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-col gap-3">
        <h1 className="font-semibold text-2xl text-foreground tracking-tight [-webkit-font-smoothing:antialiased]">
          {data.prTitle}
        </h1>
        <BranchPropertiesBar data={data} />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        {data.isAuthor && localFiles.length > 0 ? (
          <LocalChangesSection
            files={localFiles}
            onSelectFile={(path) =>
              onSelectFile(buildFileId(FileSection.Local, path))
            }
            section={FileSection.Local}
            selectedFileId={selectedFileId}
          />
        ) : null}

        <CommittedChangesSection
          files={data.committedFiles}
          onSelectFile={(path) =>
            onSelectFile(buildFileId(FileSection.Committed, path))
          }
          section={FileSection.Committed}
          selectedFileId={selectedFileId}
        />

        <BranchPrCommentsSection
          comments={data.comments}
          externalLinkId={data.externalLinkId}
          onSelectComment={onSelectComment}
          selectedCommentId={selectedCommentId}
        />
      </div>
    </div>
  );
}
