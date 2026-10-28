import type { TraceTextAnchor } from "@repo/api/src/types/comment";
import {
  type CommentAnchor,
  type CommentAnchorByKind,
  type CommentAnchorTrace,
  traceTextAnchorToCommentAnchor,
} from "@repo/api/src/types/comment-anchor";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import type { CommentThreadDto } from "@repo/api/src/types/comment-thread-dto";
import {
  anchorPreviewText,
  isAnchorRevealable,
} from "../components/comments/comments-pane-model";

/** Where an anchor points, as a surface shows it. */
export type ResolvedCommentAnchor = {
  /** The quoted text or `path:line`; null for the whole artifact. */
  label: string | null;
  /** The provider's own page for the thread, when it has one. */
  linkOut: string | null;
};

/**
 * One anchor kind on one surface (PLN-2162 M2.5): `capture` turns the
 * surface's current selection into an anchor, `resolve` says where an anchor
 * points, and `reveal` takes the viewer there. A kind with no `reveal` is
 * shown but cannot be revealed here.
 */
export type CommentAnchorAdapter<
  Kind extends CommentAnchorKind = CommentAnchorKind,
> = {
  kind: Kind;
  capture: () => CommentAnchorByKind[Kind] | null;
  resolve: (
    anchor: CommentAnchorByKind[Kind],
    thread: CommentThreadDto
  ) => ResolvedCommentAnchor;
  reveal?: (anchor: CommentAnchorByKind[Kind]) => void;
};

/** Any one kind's adapter, kept as a union so each stays typed to its kind. */
export type AnyCommentAnchorAdapter = {
  [Kind in CommentAnchorKind]: CommentAnchorAdapter<Kind>;
}[CommentAnchorKind];

export type CommentAnchorRegistry = {
  /** The pane's `revealableAnchorKinds`. */
  revealableAnchorKinds: readonly CommentAnchorKind[];
  capture: (kind: CommentAnchorKind) => CommentAnchor | null;
  /** Null for a thread with no anchor, or a kind this surface has no adapter for. */
  resolve: (thread: CommentThreadDto) => ResolvedCommentAnchor | null;
  /**
   * Reveals the thread's anchor; false when this surface cannot (no adapter,
   * no `reveal`, or a placement the server no longer holds), so the pane keeps
   * its unsupported-anchor state.
   */
  reveal: (thread: CommentThreadDto) => boolean;
};

export function createCommentAnchorRegistry(
  adapters: readonly AnyCommentAnchorAdapter[]
): CommentAnchorRegistry {
  const byKind = new Map<CommentAnchorKind, AnyCommentAnchorAdapter>(
    adapters.map((adapter) => [adapter.kind, adapter])
  );
  const revealableAnchorKinds = adapters.flatMap((adapter) =>
    adapter.reveal ? [adapter.kind] : []
  );
  return {
    revealableAnchorKinds,
    capture: (kind) => byKind.get(kind)?.capture() ?? null,
    resolve: (thread) => {
      const anchor = thread.anchor;
      if (!anchor) {
        return null;
      }
      return withAdapter(byKind, anchor, (adapter, typed) =>
        adapter.resolve(typed, thread)
      );
    },
    reveal: (thread) => {
      const anchor = thread.anchor;
      if (!(anchor && isAnchorRevealable(thread, revealableAnchorKinds))) {
        return false;
      }
      return (
        withAdapter(byKind, anchor, (adapter, typed) => {
          adapter.reveal?.(typed);
          return true;
        }) ?? false
      );
    },
  };
}

/** The whole artifact: nothing to capture beyond the kind, nothing to reveal. */
export function createArtifactAnchorAdapter(): CommentAnchorAdapter<
  typeof CommentAnchorKind.Artifact
> {
  return {
    kind: CommentAnchorKind.Artifact,
    capture: () => ({ kind: CommentAnchorKind.Artifact }),
    resolve: () => ({ label: null, linkOut: null }),
  };
}

/**
 * A Session trace row. The host injects its trace's selection capture
 * (`resolveTraceSelection`) and jump (`useTraceJump().jumpToRow`), both owned
 * by the agents slice, which `shared/` does not import. The jump also gets the
 * whole anchor, for a host that reveals a placement rather than a row.
 */
export function createTraceAnchorAdapter({
  captureSelection,
  jumpToRow,
}: {
  captureSelection: () => TraceTextAnchor | null;
  jumpToRow: (row: number, anchor: CommentAnchorTrace) => void;
}): CommentAnchorAdapter<typeof CommentAnchorKind.Trace> {
  return {
    kind: CommentAnchorKind.Trace,
    capture: () => {
      const selection = captureSelection();
      return selection ? traceTextAnchorToCommentAnchor(selection) : null;
    },
    resolve: (anchor) => ({
      label: anchorPreviewText(anchor),
      linkOut: null,
    }),
    reveal: (anchor) => jumpToRow(anchor.row, anchor),
  };
}

/**
 * A GitHub `path:line`: never captured here (GitHub threads are written on
 * GitHub) and revealed only by its link-out.
 */
export function createCodeAnchorAdapter(): CommentAnchorAdapter<
  typeof CommentAnchorKind.Code
> {
  return {
    kind: CommentAnchorKind.Code,
    capture: () => null,
    resolve: (anchor, thread) => ({
      label: anchorPreviewText(anchor),
      linkOut: thread.provider.linkOut ?? null,
    }),
  };
}

function withAdapter<Result>(
  byKind: ReadonlyMap<CommentAnchorKind, AnyCommentAnchorAdapter>,
  anchor: CommentAnchor,
  use: (adapter: CommentAnchorAdapter, anchor: CommentAnchor) => Result
): Result | null {
  const adapter = byKind.get(anchor.kind);
  // The map is keyed by each adapter's own kind, so this adapter takes this anchor.
  return adapter ? use(adapter as CommentAnchorAdapter, anchor) : null;
}
