import { useThreads } from "@repo/collaboration/hooks";
import { Suspense, useEffect } from "react";
import {
  EditorWithComments,
  type EditorWithCommentsProps,
} from "./editor-with-comments";

type CollaborativeEditorProps = Omit<EditorWithCommentsProps, "scrollMode"> & {
  onOpenThreadCountChange?: (count: number) => void;
  showComments?: boolean;
};

/**
 * Reports the number of unresolved comment threads to the parent.
 * Must be rendered inside a Liveblocks RoomProvider (via OptionalArtifactRoom).
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
