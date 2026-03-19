"use client";

import type { StubBranchViewData } from "../types";
import { BranchPrCommentsSection } from "./branch-pr-comments-section";
import { BranchPropertiesBar } from "./branch-properties-bar";
import { CommittedChangesSection } from "./committed-changes-section";
import { LocalChangesSection } from "./local-changes-section";

type BranchViewContentProps = {
  data: StubBranchViewData;
  onSelectComment: (id: string | null) => void;
  onSelectFile: (path: string) => void;
  selectedCommentId: string | null;
  selectedPath: string | null;
};

export function BranchViewContent({
  data,
  onSelectComment,
  onSelectFile,
  selectedCommentId,
  selectedPath,
}: Readonly<BranchViewContentProps>) {
  return (
    <div className="flex flex-col gap-5 px-6 py-8">
      <div className="flex flex-col gap-3">
        <h1 className="font-semibold text-2xl text-foreground tracking-tight [-webkit-font-smoothing:antialiased]">
          {data.prTitle}
        </h1>
        <BranchPropertiesBar data={data} />
      </div>

      <div className="flex flex-col gap-2">
        {data.isAuthor && data.localFiles.length > 0 ? (
          <LocalChangesSection
            files={data.localFiles}
            onSelectFile={onSelectFile}
            selectedPath={selectedPath}
          />
        ) : null}

        <CommittedChangesSection
          files={data.committedFiles}
          onSelectFile={onSelectFile}
          selectedPath={selectedPath}
        />

        <BranchPrCommentsSection
          comments={data.comments}
          onSelectComment={onSelectComment}
          selectedCommentId={selectedCommentId}
        />
      </div>
    </div>
  );
}
