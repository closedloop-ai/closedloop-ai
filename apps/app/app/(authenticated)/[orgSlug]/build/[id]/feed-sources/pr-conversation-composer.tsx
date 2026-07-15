"use client";

import { parseBranchViewCommentIdentityBlocker } from "@repo/app/github/lib/branch-view-comment-identity-blocker";
import { Button } from "@repo/design-system/components/ui/button";
import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";
import { AtSign, GithubIcon, Loader2, Paperclip } from "lucide-react";
import { useState } from "react";
import { useBranchViewContext } from "../branch-view-context";
import { handleBranchViewCommentActionResult } from "../components/branch-comment-action-result";
import { BranchCommentWriteIdentityPrompt } from "../components/branch-comment-write-identity-prompt";
import { useBranchViewCommentIdentityBlockers } from "../components/branch-view-comment-identity-blocker-store";

/**
 * Sticky bottom composer mounted as the PR source's `Composer`. Shows a
 * "syncs to GitHub · PR #N" hint, an autosize textarea, a placeholder
 * tools row (paperclip + at-sign, no behavior this round), and the
 * submit button.
 */
export function PrConversationComposer() {
  const ctx = useBranchViewContext();
  const identityPrompts = useBranchViewCommentIdentityBlockers();
  const [draft, setDraft] = useState("");
  const createPrompt = identityPrompts.getCreatePrompt(
    "createConversation",
    ctx.data.commentPromptEligibility?.createConversation
  );

  if (!ctx.canCreateConversationComment) {
    return <BranchCommentWriteIdentityPrompt prompt={createPrompt} />;
  }

  function submit(): void {
    const body = draft.trim();
    if (body.length === 0) {
      return;
    }
    ctx.mutations.createConversation.mutate(
      { body },
      {
        onError: (error) => {
          const identityBlocker = parseBranchViewCommentIdentityBlocker(error);
          if (identityBlocker) {
            identityPrompts.recordIdentityBlocker({
              identityBlocker,
              surface: "createConversation",
            });
          }
        },
        onSuccess: (result) => {
          handleBranchViewCommentActionResult(result);
          if (result.success) {
            setDraft("");
          }
        },
      }
    );
  }

  const isPending = ctx.mutations.createConversation.isPending;

  return (
    <>
      <BranchCommentWriteIdentityPrompt prompt={createPrompt} />
      <CommentComposer
        ariaLabel="Add a PR comment"
        containerClassName="border-border border-t bg-background p-3"
        helperText={
          <div className="mb-1 flex items-center gap-1.5 text-muted-foreground text-xs">
            <GithubIcon className="h-3 w-3" />
            <span>Comments here sync to GitHub · PR #{ctx.prNumber}</span>
          </div>
        }
        isPending={isPending}
        leadingActions={
          <>
            <Button
              aria-disabled
              aria-label="Attach file (coming soon)"
              className="h-7 w-7"
              size="icon"
              tabIndex={-1}
              type="button"
              variant="ghost"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </Button>
            <Button
              aria-disabled
              aria-label="Mention (coming soon)"
              className="h-7 w-7"
              size="icon"
              tabIndex={-1}
              type="button"
              variant="ghost"
            >
              <AtSign className="h-3.5 w-3.5" />
            </Button>
          </>
        }
        minHeightClassName="min-h-[64px]"
        onSubmit={submit}
        onValueChange={setDraft}
        placeholder="Comment on this PR…"
        submitLabel={
          <>
            {isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Comment
          </>
        }
        value={draft}
      />
    </>
  );
}
