"use client";

import type {
  BranchViewComment,
  BranchViewCommentIdentityBlocker,
  BranchViewCommentIdentityPromptEligibility,
} from "@repo/api/src/types/branch-view";
import { parseBranchViewCommentIdentityBlocker } from "@repo/app/github/lib/branch-view-comment-identity-blocker";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getBranchViewCommentUiId } from "../comment-context";

export type BranchViewIdentityPromptSurface =
  | "createConversation"
  | "createInline"
  | "reply"
  | "edit"
  | "delete"
  | "resolve"
  | "unresolve";
export type BranchViewIdentityActionPromptSurface = Exclude<
  BranchViewIdentityPromptSurface,
  "createConversation" | "createInline"
>;

export type BranchViewIdentityPromptState = {
  connectHref: string;
  identityBlocker: BranchViewCommentIdentityBlocker;
};

type StoredBlocker = BranchViewIdentityPromptState & {
  recordedAt: number;
  generation: number;
};

type BranchViewCommentIdentityBlockerContextValue = {
  beginGitHubConnectAttempt: (attemptKey: string) => boolean;
  connectAttemptKey: string | null;
  connectHref: string;
  connectGeneration: number;
  getActionPrompt: (
    comment: BranchViewComment,
    surfaces: BranchViewIdentityActionPromptSurface[]
  ) => BranchViewIdentityPromptState | null;
  getCreatePrompt: (
    surface: "createConversation" | "createInline",
    eligibility: BranchViewCommentIdentityPromptEligibility | undefined
  ) => BranchViewIdentityPromptState | null;
  recordIdentityBlocker: (input: {
    comment?: BranchViewComment;
    identityBlocker: BranchViewCommentIdentityBlocker;
    surface: BranchViewIdentityPromptSurface;
  }) => void;
};

const BranchViewCommentIdentityBlockerContext =
  createContext<BranchViewCommentIdentityBlockerContextValue | null>(null);

const GITHUB_CONNECT_ATTEMPT_TIMEOUT_MS = 15_000;

const FALLBACK_BRANCH_VIEW_COMMENT_IDENTITY_BLOCKERS: BranchViewCommentIdentityBlockerContextValue =
  {
    beginGitHubConnectAttempt: () => true,
    connectAttemptKey: null,
    connectGeneration: 0,
    connectHref: "#",
    getActionPrompt: () => null,
    getCreatePrompt: () => null,
    recordIdentityBlocker: () => {},
  };

/**
 * Shared Branch View identity-blocker state for legacy and feed-sidebar
 * comment surfaces. Local mutation blockers win over GET prompt projections.
 */
export function BranchViewCommentIdentityBlockerProvider({
  children,
  orgSlug,
  buildId,
}: Readonly<{ children: ReactNode; orgSlug: string; buildId: string }>) {
  const [blockers, setBlockers] = useState<Record<string, StoredBlocker>>({});
  const [connectGeneration, setConnectGeneration] = useState(0);
  const [connectAttemptKey, setConnectAttemptKey] = useState<string | null>(
    null
  );
  const connectAttemptKeyRef = useRef<string | null>(null);
  const returnPath = `/${orgSlug}/build/${buildId}`;
  const connectHref = `/api/integrations/github?returnTo=${encodeURIComponent(
    returnPath
  )}`;

  useEffect(() => {
    const search = globalThis.location?.search ?? "";
    if (!new URLSearchParams(search).has("github")) {
      return;
    }
    if (new URLSearchParams(search).get("github") !== "connected") {
      return;
    }
    setBlockers({});
    connectAttemptKeyRef.current = null;
    setConnectAttemptKey(null);
    setConnectGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    if (connectAttemptKey === null) {
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      if (connectAttemptKeyRef.current === connectAttemptKey) {
        connectAttemptKeyRef.current = null;
        setConnectAttemptKey(null);
      }
    }, GITHUB_CONNECT_ATTEMPT_TIMEOUT_MS);

    return () => globalThis.clearTimeout(timeout);
  }, [connectAttemptKey]);

  const beginGitHubConnectAttempt = useCallback((attemptKey: string) => {
    if (connectAttemptKeyRef.current !== null) {
      return false;
    }
    connectAttemptKeyRef.current = attemptKey;
    setConnectAttemptKey(attemptKey);
    return true;
  }, []);

  const recordIdentityBlocker = useCallback(
    (input: {
      comment?: BranchViewComment;
      identityBlocker: BranchViewCommentIdentityBlocker;
      surface: BranchViewIdentityPromptSurface;
    }) => {
      setBlockers((current) => ({
        ...current,
        [blockerKey(input.surface, input.comment)]: {
          connectHref,
          generation: connectGeneration,
          identityBlocker: input.identityBlocker,
          recordedAt: Date.now(),
        },
      }));
    },
    [connectGeneration, connectHref]
  );

  const getCreatePrompt = useCallback(
    (
      surface: "createConversation" | "createInline",
      eligibility: BranchViewCommentIdentityPromptEligibility | undefined
    ) => {
      const local = blockers[blockerKey(surface)];
      if (local && local.generation === connectGeneration) {
        return local;
      }
      return promptFromEligibility(connectHref, eligibility);
    },
    [blockers, connectGeneration, connectHref]
  );

  const getActionPrompt = useCallback(
    (
      comment: BranchViewComment,
      surfaces: BranchViewIdentityActionPromptSurface[]
    ) => {
      const local = surfaces
        .map((surface) => blockers[blockerKey(surface, comment)] ?? null)
        .filter((blocker): blocker is StoredBlocker => blocker !== null)
        .filter((blocker) => blocker.generation === connectGeneration)
        .sort((left, right) => right.recordedAt - left.recordedAt)[0];
      if (local) {
        return local;
      }
      for (const surface of surfaces) {
        const eligibility = comment.actionPromptEligibility?.[surface];
        const prompt = promptFromEligibility(connectHref, eligibility);
        if (prompt) {
          return prompt;
        }
      }
      return null;
    },
    [blockers, connectGeneration, connectHref]
  );

  const value = useMemo(
    () => ({
      beginGitHubConnectAttempt,
      connectAttemptKey,
      connectGeneration,
      connectHref,
      getActionPrompt,
      getCreatePrompt,
      recordIdentityBlocker,
    }),
    [
      beginGitHubConnectAttempt,
      connectAttemptKey,
      connectGeneration,
      connectHref,
      getActionPrompt,
      getCreatePrompt,
      recordIdentityBlocker,
    ]
  );

  return (
    <BranchViewCommentIdentityBlockerContext.Provider value={value}>
      {children}
    </BranchViewCommentIdentityBlockerContext.Provider>
  );
}

export function useBranchViewCommentIdentityBlockers(): BranchViewCommentIdentityBlockerContextValue {
  const value = useContext(BranchViewCommentIdentityBlockerContext);
  return value ?? FALLBACK_BRANCH_VIEW_COMMENT_IDENTITY_BLOCKERS;
}

/** Record identity-blocker API errors into the shared Branch View prompt store. */
export function recordBranchViewCommentIdentityBlocker(input: {
  comment: BranchViewComment;
  error: unknown;
  identityPrompts: {
    recordIdentityBlocker: (input: {
      comment?: BranchViewComment;
      identityBlocker: BranchViewCommentIdentityBlocker;
      surface: BranchViewIdentityPromptSurface;
    }) => void;
  };
  surface: BranchViewIdentityActionPromptSurface;
}): void {
  const identityBlocker = parseBranchViewCommentIdentityBlocker(input.error);
  if (!identityBlocker) {
    return;
  }
  input.identityPrompts.recordIdentityBlocker({
    comment: input.comment,
    identityBlocker,
    surface: input.surface,
  });
}

function promptFromEligibility(
  connectHref: string,
  eligibility: BranchViewCommentIdentityPromptEligibility | undefined
): BranchViewIdentityPromptState | null {
  if (eligibility?.prompt !== true) {
    return null;
  }
  return { connectHref, identityBlocker: eligibility.identityBlocker };
}

function blockerKey(
  surface: BranchViewIdentityPromptSurface,
  comment?: BranchViewComment
): string {
  return `${surface}:${comment ? getBranchViewCommentUiId(comment) : "create"}`;
}
