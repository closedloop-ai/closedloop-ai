"use client";

import { TraceCommentKind } from "@repo/api/src/types/comment";
// Cross-slice: the org member list behind @-mentions is owned by the users slice.
import { OrgMentionComposer } from "@repo/app/users/components/org-mention-composer";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { Label } from "@repo/design-system/components/ui/label";
import { MessageCircleIcon } from "lucide-react";
import { useState } from "react";
import { useCanFlagParsingBug } from "../../data-source/parsing-bug-flag-provider";
import type { TraceSelectionDraft } from "./session-trace-contract";

export function TraceDraftComposer({
  draft,
  onCancel,
  onSubmit,
}: Readonly<{
  draft: TraceSelectionDraft;
  onCancel: () => void;
  onSubmit: (payload: {
    body: string;
    mentions?: string[];
    kind?: TraceCommentKind;
  }) => void;
}>) {
  const [mode, setMode] = useState(draft.mode);
  // FEA-4171: when checked, the comment is classified as a parsing/data bug and
  // feeds the golden-dataset CANDIDATE pipeline (it is never auto-promoted).
  // FEA-4347: the flag is an internal data-quality affordance, so it is shown
  // only to Closedloop staff; customers get a plain comment composer. The staff
  // signal is injected per surface (web / desktop) and defaults to hidden.
  const canFlagParsingBug = useCanFlagParsingBug();
  const [isParsingBug, setIsParsingBug] = useState(false);
  const parsingBugId = `st-parsing-bug-${draft.anchor.turnId}-${draft.anchor.row}`;
  const style = {
    left: `${draft.position.x}px`,
    top: `${draft.position.y}px`,
  };

  if (mode === "affordance") {
    return (
      <button
        className="st-comment-pop"
        data-comment-control="true"
        onClick={() => setMode("composer")}
        style={style}
        type="button"
      >
        <MessageCircleIcon aria-hidden className="size-3.5" />
        Comment
      </button>
    );
  }

  return (
    <div
      className="st-comment-pop st-comment-compose"
      data-comment-control="true"
      style={style}
    >
      <div className="st-comment-quote">{draft.anchor.selectedText}</div>
      <OrgMentionComposer
        onCancel={onCancel}
        onSubmit={(payload) =>
          onSubmit({
            ...payload,
            ...(canFlagParsingBug && isParsingBug
              ? { kind: TraceCommentKind.ParsingBug }
              : {}),
          })
        }
        placeholder="Comment on this passage..."
        submitLabel="Comment"
      />
      {canFlagParsingBug ? (
        <div className="flex items-center gap-2" data-comment-control="true">
          <Checkbox
            checked={isParsingBug}
            data-comment-control="true"
            id={parsingBugId}
            onCheckedChange={(checked) => setIsParsingBug(checked === true)}
          />
          <Label className="cursor-pointer text-sm" htmlFor={parsingBugId}>
            Flag as parsing/data bug
          </Label>
        </div>
      ) : null}
    </div>
  );
}
