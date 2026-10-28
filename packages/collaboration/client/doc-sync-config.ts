"use client";

import { createContext, type ReactNode } from "react";

/**
 * An org member the body mention picker can offer. Structural, so
 * `@repo/app`'s `MentionUser` satisfies it without this package importing it,
 * and it carries every field the comment composer's matching reads.
 */
export type DocSyncMentionCandidate = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl?: string | null;
  active: boolean;
};

export type DocSyncResolvedUser = { name: string; avatarUrl?: string };

/**
 * What a `DocSyncRoom` needs from the host app (PLN-2189 T-2.1): token minting
 * and identity. Names and avatars come from the org user list, never from a
 * peer's awareness state.
 *
 * `fetchToken` resolves with the raw `POST /doc-sync/token` body, which the
 * room validates, and rejects with the API client's error: one carrying a
 * numeric `status` is classified by it (4xx stops, anything else retries).
 */
export type DocSyncConfig = {
  fetchToken: (room: string) => Promise<unknown>;
  self: { id: string; color: string } | null;
  resolveUser: (id: string) => DocSyncResolvedUser | undefined;
  mentionCandidates: readonly DocSyncMentionCandidate[];
  /** The body picker's row cap: the comment composer's, so both pickers agree. */
  maxMentionSuggestions: number;
  /**
   * The comment composer's suggestion list (PLN-2189 T-2.8), which this
   * package cannot import from `@repo/app`.
   */
  renderMentionSuggestions: (
    props: DocSyncMentionSuggestionsProps
  ) => ReactNode;
};

/** What the body mention picker hands the host's suggestion list. */
export type DocSyncMentionSuggestionsProps = {
  suggestions: readonly DocSyncMentionCandidate[];
  activeIndex: number;
  anchorRect: DOMRect;
  onSelect: (candidate: DocSyncMentionCandidate) => void;
  /** The element the list renders into, so it counts as inside the picker. */
  container: HTMLElement;
};

export const DocSyncConfigContext = createContext<DocSyncConfig | null>(null);
