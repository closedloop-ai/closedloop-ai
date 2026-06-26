import type { ReactNode } from "react";

type DropdownItemProps = {
  children?: ReactNode;
  icon?: ReactNode;
  onSelect?: (event: Event) => void;
  "aria-label"?: string;
};

type ThreadMockProps = {
  thread: { id: string; comments?: { id: string }[] };
  commentDropdownItems?:
    | ReactNode
    | ((args: { comment: { id: string }; children: ReactNode }) => ReactNode);
};

export type LiveblocksUiMockOptions = {
  /**
   * Returns the `data-testid` to set on the rendered Thread div. Defaults
   * to a static `"lb-thread"`, matching `CommentCard` tests which only
   * render one thread at a time. `CommentStream` tests override this to
   * `lb-thread-${id}` so multiple threads can be addressed by id.
   */
  threadTestId?: (thread: { id: string }) => string;
};

/**
 * Factory for the shared `@liveblocks/react-ui` test double used by
 * `CommentCard` and `CommentStream` tests. We mock the package because
 * rendering a real `<Thread>` requires a full Liveblocks RoomProvider
 * context that's heavy to stand up for a unit test of our wrapper chrome.
 *
 * The mock renders `commentDropdownItems` so tests can exercise the
 * Copy Link dropdown item; it invokes the function form with the
 * thread's first comment (the root), matching production behavior.
 */
export function createLiveblocksUiMock(options: LiveblocksUiMockOptions = {}) {
  const threadTestId = options.threadTestId ?? (() => "lb-thread");
  return {
    Comment: {
      DropdownItem: ({
        children,
        icon,
        onSelect,
        "aria-label": ariaLabel,
      }: DropdownItemProps) => (
        <button
          aria-label={ariaLabel}
          onClick={() => onSelect?.(new Event("select"))}
          type="button"
        >
          {icon}
          {children}
        </button>
      ),
    },
    Thread: ({ thread, commentDropdownItems }: ThreadMockProps) => {
      const rootComment = thread.comments?.[0] ?? { id: "stub" };
      const items =
        typeof commentDropdownItems === "function"
          ? commentDropdownItems({ comment: rootComment, children: null })
          : commentDropdownItems;
      return (
        <div data-testid={threadTestId(thread)}>
          {thread.id}
          {items}
        </div>
      );
    },
  };
}
