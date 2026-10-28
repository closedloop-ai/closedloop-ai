"use client";

import { useCallback, useState } from "react";
import type {
  CommentsPaneDraft,
  CommentsPaneDrafts,
} from "./comments-pane-model";

/**
 * Host-side draft store for the pane. It lives above the rail, so closing the
 * rail or switching tabs unmounts the pane but not the typing; a new
 * `identity` (another artifact, session or branch) starts empty.
 */
export function useCommentsPaneDrafts(identity: string) {
  const [state, setState] = useState<{
    drafts: CommentsPaneDrafts;
    identity: string;
    generation: number;
  }>({ drafts: {}, identity, generation: 0 });
  const changed = state.identity !== identity;
  if (changed) {
    setState({ drafts: {}, identity, generation: state.generation + 1 });
  }
  const generation = changed ? state.generation + 1 : state.generation;
  // Bound to the identity VISIT it was handed out for, not the identity value:
  // a write that settles after the host moved away must not touch the drafts,
  // even once the host is back on the same entity (A → B → A).
  const onDraftChange = useCallback(
    (key: string, draft: CommentsPaneDraft | null) => {
      setState((current) => {
        if (current.generation !== generation) {
          return current;
        }
        const { [key]: _dropped, ...rest } = current.drafts;
        return {
          ...current,
          drafts: draft === null ? rest : { ...rest, [key]: draft },
        };
      });
    },
    [generation]
  );
  return {
    drafts: state.identity === identity ? state.drafts : {},
    onDraftChange,
  };
}
