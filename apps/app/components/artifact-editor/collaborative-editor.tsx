import { OptionalArtifactRoom, Presence } from "@repo/collaboration";
import { useThreads } from "@repo/collaboration/hooks";
import { Suspense, useEffect } from "react";
import {
  EditorWithComments,
  type EditorWithCommentsProps,
} from "./editor-with-comments";

type CollaborativeEditorProps = Omit<EditorWithCommentsProps, "scrollMode"> & {
  showMetadataPanel: boolean;
  metadataPanel: React.ReactNode;
  onOpenThreadCountChange?: (count: number) => void;
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
  showMetadataPanel,
  metadataPanel,
  onOpenThreadCountChange,
  ...props
}: Readonly<CollaborativeEditorProps>) {
  return (
    <OptionalArtifactRoom roomId={liveblocksRoomId}>
      {/* Presence Indicators (suspends on useOthers/useSelf) */}
      {!!liveblocksRoomId && (
        <Suspense fallback={null}>
          <Presence />
        </Suspense>
      )}

      {/* Thread count reporter — suspends on useThreads */}
      {!!liveblocksRoomId && onOpenThreadCountChange && (
        <Suspense fallback={null}>
          <ThreadCountReporter onCountChange={onOpenThreadCountChange} />
        </Suspense>
      )}

      {/* Content Area with Optional Metadata Panel */}
      <div className="flex min-h-0 flex-1">
        <EditorWithComments
          liveblocksRoomId={liveblocksRoomId}
          readOnly={readOnly}
          scrollMode="outer"
          {...props}
        />

        {/* Metadata Panel */}
        {showMetadataPanel ? metadataPanel : null}
      </div>
    </OptionalArtifactRoom>
  );
}
