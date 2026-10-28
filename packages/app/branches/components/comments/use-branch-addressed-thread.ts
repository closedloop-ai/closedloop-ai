"use client";

import type { BranchSelectedPullRequestIdentity } from "@repo/api/src/types/branch-associated-pull-request";
import { ThreadSource } from "@repo/api/src/types/comment";
import type { CommentThreadDto } from "@repo/api/src/types/comment-thread-dto";
import {
  type CommentsPaneBranchScope,
  threadInBranchScope,
} from "@repo/app/shared/components/comments/comments-pane-model";
import { useEffect, useRef } from "react";

type AddressedThreadInput = Readonly<{
  /** The thread a `?comment=` link addressed, or null/undefined for none. */
  addressedThreadId: string | null | undefined;
  /**
   * Whether the tab on screen has a collection at all. `scopeForTab` is the one
   * place that decides which tabs those are; Details and Activity have none, so
   * an address cannot be shown there.
   */
  scoped: boolean;
  /** The scope the shared pane filters `threads` by before it lists them. */
  branchScope: CommentsPaneBranchScope;
  /** The threads the pane is handed, before that scope filters them. */
  threads: readonly CommentThreadDto[];
  open: boolean;
  /**
   * Shows the pane for this visit without saving it: the reader followed a
   * link, they did not ask for the pane (ISS-12300 D6).
   */
  onReveal: () => void;
  onSelect: (threadId: string) => void;
  /** Selects a pull request on Branch details, as its selector does. */
  onSelectPullRequest?: (selection: BranchSelectedPullRequestIdentity) => void;
}>;

/**
 * ISS-10980: open the Branch comments pane on the thread a `?comment=` link
 * named, and select it so the shared pane scrolls to it and marks it.
 *
 * THREE steps, not one, because the pane reads nothing while it is closed: the
 * reveal cannot wait for the thread to be listed, or an address arriving at a
 * closed pane would deadlock — closed, so no read; not listed, so no reveal.
 * It opens on the address alone. Once the read lands, a GitHub thread on
 * another pull request is still filtered out by the selected-PR scope, so its
 * own pull request is selected first (whitlockk, #8619). The thread is selected
 * only once it is in scope, since the shared pane scrolls on selection and a
 * card that is not rendered cannot be scrolled to.
 *
 * The reveal and the PR switch are keyed on the address so a reader who closes
 * the pane or picks another pull request is not fought on every later render.
 * Their keys are cleared whenever the address is absent, which is what lets
 * the SAME link reveal again after the reader navigates away and back.
 */
export function useBranchAddressedThread({
  addressedThreadId,
  scoped,
  branchScope,
  threads,
  open,
  onReveal,
  onSelect,
  onSelectPullRequest,
}: AddressedThreadInput): void {
  const addressed = scoped ? (addressedThreadId ?? null) : null;
  const addressedThread =
    addressed === null
      ? null
      : (threads.find((thread) => thread.id === addressed) ?? null);
  const inScope =
    addressedThread !== null &&
    threadInBranchScope(addressedThread, branchScope);
  const owningPullRequest =
    addressedThread === null || inScope
      ? null
      : owningPullRequestOf(addressedThread, branchScope);
  const owningRepository = owningPullRequest?.repositoryFullName ?? null;
  const owningNumber = owningPullRequest?.pullRequestNumber ?? null;
  const revealedAddress = useRef<string | null>(null);
  const switchedAddress = useRef<string | null>(null);
  useEffect(() => {
    if (!addressed) {
      revealedAddress.current = null;
      switchedAddress.current = null;
      return;
    }
    if (revealedAddress.current === addressed) {
      return;
    }
    revealedAddress.current = addressed;
    if (!open) {
      onReveal();
    }
  }, [addressed, open, onReveal]);
  useEffect(() => {
    if (
      !addressed ||
      owningRepository === null ||
      owningNumber === null ||
      switchedAddress.current === addressed
    ) {
      return;
    }
    switchedAddress.current = addressed;
    onSelectPullRequest?.({
      pullRequestNumber: owningNumber,
      repositoryFullName: owningRepository,
    });
  }, [addressed, owningRepository, owningNumber, onSelectPullRequest]);
  useEffect(() => {
    if (addressed && inScope) {
      onSelect(addressed);
    }
  }, [addressed, inScope, onSelect]);
}

/**
 * The pull request a GitHub thread names, when the selected-PR scope is what
 * hides it. Null while Branch details has not reported its selection yet, so a
 * thread on the default pull request is not switched to explicitly before that
 * selection lands, and null when the thread does not name both halves of the
 * identity the selector takes (an older server omits them).
 */
function owningPullRequestOf(
  thread: CommentThreadDto,
  scope: CommentsPaneBranchScope
): BranchSelectedPullRequestIdentity | null {
  const { pullRequestNumber, repositoryFullName } = thread.provider;
  if (
    thread.source !== ThreadSource.Github ||
    scope.tab !== "details" ||
    scope.selectedPullRequestKey === null ||
    pullRequestNumber === undefined ||
    repositoryFullName === undefined
  ) {
    return null;
  }
  return { pullRequestNumber, repositoryFullName };
}
