"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { PermalinkResolution } from "./use-thread-permalink-scroll";

export type CommentPermalinkContextValue = {
  /**
   * Liveblocks thread id to scroll into view + highlight on initial
   * mount. Sourced from the `?thread=<id>` query parameter by the
   * provider's caller. `undefined` when no permalink is being resolved.
   */
  scrollToThreadId: string | undefined;
  /**
   * Per-thread permalink-URL factory for the current artifact, or
   * `undefined` when the artifact has no canonical route prefix (e.g.
   * TEMPLATE). Used by `CommentCard` to render its Copy Link button.
   */
  buildPermalinkUrl: ((threadId: string) => string) | undefined;
  /**
   * Whether the "Comment not found" banner is showing. Flipped on
   * `onPermalinkResolved("not-found")` and cleared by `dismissBanner`.
   */
  bannerVisible: boolean;
  dismissBanner: () => void;
  /** Fired after a successful Copy Link click — shows the toast. */
  onPermalinkCopied: () => void;
  /**
   * Invoked once per `scrollToThreadId` after `useThreadPermalinkScroll`
   * settles resolution.
   */
  onPermalinkResolved: (resolution: PermalinkResolution) => void;
};

const NOOP_VALUE: CommentPermalinkContextValue = {
  scrollToThreadId: undefined,
  buildPermalinkUrl: undefined,
  bannerVisible: false,
  dismissBanner: () => undefined,
  onPermalinkCopied: () => undefined,
  onPermalinkResolved: () => undefined,
};

const CommentPermalinkContext =
  createContext<CommentPermalinkContextValue>(NOOP_VALUE);

/**
 * Consumer hook. Returns no-op defaults when no `CommentPermalinkProvider`
 * is mounted — tests and any non-artifact use of `CommentCard` /
 * `CommentStream` work without wrapping.
 */
export function useCommentPermalink(): CommentPermalinkContextValue {
  return useContext(CommentPermalinkContext);
}

export type CommentPermalinkProviderProps = {
  /**
   * The `?thread=<id>` value from the artifact URL, or `undefined` /
   * empty string when not present. The provider normalizes empty to
   * `undefined`.
   */
  scrollToThreadId: string | undefined;
  /**
   * `buildPermalinkUrl` factory from `useCommentPermalinkBuilder` (or
   * any equivalent). `undefined` disables the Copy Link affordance on
   * cards (e.g. unsupported document type, missing org slug).
   */
  buildPermalinkUrl: ((threadId: string) => string) | undefined;
  children: ReactNode;
};

/**
 * Single owner of the artifact-page permalink concern. Provides the
 * scroll target, URL builder, copy-toast feedback, and missing-thread
 * banner state to all `CommentCard` / `CommentStream` /
 * `MissingThreadBanner` instances inside it.
 */
export function CommentPermalinkProvider({
  scrollToThreadId: rawScrollToThreadId,
  buildPermalinkUrl,
  children,
}: Readonly<CommentPermalinkProviderProps>) {
  const scrollToThreadId = rawScrollToThreadId || undefined;
  const [bannerVisible, setBannerVisible] = useState(false);

  // Reset the banner whenever the permalink target changes — otherwise a
  // stale "Comment not found" banner from a prior failed lookup lingers
  // across navigations, including ones that successfully resolve.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollToThreadId is the intentional trigger, not a read dep
  useEffect(() => {
    setBannerVisible(false);
  }, [scrollToThreadId]);

  const dismissBanner = useCallback(() => setBannerVisible(false), []);
  const onPermalinkCopied = useCallback(() => {
    toast.success("Link copied");
  }, []);
  const onPermalinkResolved = useCallback((resolution: PermalinkResolution) => {
    if (resolution === PermalinkResolution.NotFound) {
      setBannerVisible(true);
    }
  }, []);

  const value = useMemo<CommentPermalinkContextValue>(
    () => ({
      scrollToThreadId,
      buildPermalinkUrl,
      bannerVisible,
      dismissBanner,
      onPermalinkCopied,
      onPermalinkResolved,
    }),
    [
      scrollToThreadId,
      buildPermalinkUrl,
      bannerVisible,
      dismissBanner,
      onPermalinkCopied,
      onPermalinkResolved,
    ]
  );

  return (
    <CommentPermalinkContext.Provider value={value}>
      {children}
    </CommentPermalinkContext.Provider>
  );
}
