import { useThreads } from "@repo/collaboration/hooks";
import { Suspense, useEffect } from "react";
import {
  EditorWithComments,
  type EditorWithCommentsProps,
} from "./editor-with-comments";

type CollaborativeEditorProps = Omit<EditorWithCommentsProps, "scrollMode"> & {
  onOpenThreadCountChange?: (count: number) => void;
};

/**
 * Reports the number of unresolved comment threads to the parent.
 * Must be rendered inside a Liveblocks RoomProvider (via OptionalDocumentRoom).
 */
function ThreadCountReporter({
  onCountChange,
}: {
  onCountChange: (count: number) => void;
}) {
  const { threads } = useThreads();
  const unresolvedCount = threads.filter((t) => !t.resolved).length;

  useEffect(() => {
    onCountChange(unresolvedCount);
  }, [unresolvedCount, onCountChange]);

  return null;
}

/**
 * Collaborative editor with optional Liveblocks comment threads.
 * When `liveblocksRoomId` is provided, this component must be rendered
 * inside an `OptionalDocumentRoom` (or equivalent Liveblocks RoomProvider).
 */
export function CollaborativeEditor({
  liveblocksRoomId,
  readOnly,
  onOpenThreadCountChange,
  showComments,
  ...props
}: Readonly<CollaborativeEditorProps>) {
  return (
    <>
      {/* Thread count reporter — suspends on useThreads */}
      {!!liveblocksRoomId && onOpenThreadCountChange && (
        <Suspense fallback={null}>
          <ThreadCountReporter onCountChange={onOpenThreadCountChange} />
        </Suspense>
      )}

      <EditorWithComments
        liveblocksRoomId={liveblocksRoomId}
        readOnly={readOnly}
        scrollMode="outer"
        showComments={showComments}
        {...props}
      />
    </>
  );
}
