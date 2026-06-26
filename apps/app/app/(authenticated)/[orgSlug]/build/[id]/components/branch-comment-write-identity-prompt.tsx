"use client";

import { BranchViewCommentWriteIdentityStatus } from "@repo/api/src/types/branch-view";
import { Button } from "@repo/design-system/components/ui/button";
import { AlertCircle, Github } from "lucide-react";
import { useId } from "react";
import {
  type BranchViewIdentityPromptState,
  useBranchViewCommentIdentityBlockers,
} from "./branch-view-comment-identity-blocker-store";

/**
 * Compact Branch View recovery prompt shown only when the server identifies
 * the user's GitHub write identity as the effective comment-action blocker.
 */
export function BranchCommentWriteIdentityPrompt({
  prompt,
}: Readonly<{ prompt: BranchViewIdentityPromptState | null }>) {
  const identityPrompts = useBranchViewCommentIdentityBlockers();
  const promptInstanceId = useId();
  const promptKey = prompt
    ? `${prompt.connectHref}:${prompt.identityBlocker.status}:${promptInstanceId}`
    : null;
  const isConnecting =
    promptKey !== null && identityPrompts.connectAttemptKey === promptKey;
  const isConnectAttemptInProgress = identityPrompts.connectAttemptKey !== null;

  if (!prompt) {
    return null;
  }
  const reconnect =
    prompt.identityBlocker.status !==
    BranchViewCommentWriteIdentityStatus.Missing;
  const title = reconnect
    ? "Reconnect GitHub to comment"
    : "Connect GitHub to comment";
  let action = reconnect ? "Reconnect GitHub" : "Connect GitHub";
  if (isConnecting) {
    action = "Connecting...";
  }

  return (
    <div
      className="flex min-w-0 flex-col items-start gap-2 border-border border-t bg-muted/30 px-3 py-2 text-sm"
      data-testid="branch-view-github-identity-prompt"
    >
      <div className="flex min-w-0 items-center gap-2">
        <AlertCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 whitespace-normal text-muted-foreground"
          data-testid="branch-view-github-identity-prompt-title"
        >
          {title}
        </span>
      </div>
      <Button asChild className="h-8 shrink-0 gap-1.5" size="sm" type="button">
        <a
          aria-busy={isConnecting}
          aria-disabled={isConnectAttemptInProgress}
          data-comment-control="true"
          href={prompt.connectHref}
          onClick={(event) => {
            if (
              promptKey === null ||
              !identityPrompts.beginGitHubConnectAttempt(promptKey)
            ) {
              event.preventDefault();
            }
          }}
        >
          <Github className="h-3.5 w-3.5" />
          {action}
        </a>
      </Button>
    </div>
  );
}
