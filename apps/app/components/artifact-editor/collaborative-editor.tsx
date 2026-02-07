import { OptionalArtifactRoom, Presence } from "@repo/collaboration";
import { useOrganizationUsers } from "@/hooks/queries/use-users";
import {
  EditorWithComments,
  type EditorWithCommentsProps,
} from "./editor-with-comments";

type CollaborativeEditorProps = Omit<EditorWithCommentsProps, "scrollMode"> & {
  showMetadataPanel: boolean;
  metadataPanel: React.ReactNode;
};

export function CollaborativeEditor({
  liveblocksRoomId,
  readOnly,
  showMetadataPanel,
  metadataPanel,
  ...props
}: Readonly<CollaborativeEditorProps>) {
  // Fetch organization users for @mentions in comments
  const { data: users } = useOrganizationUsers();

  return (
    <OptionalArtifactRoom roomId={liveblocksRoomId} users={users}>
      {/* Presence Indicators */}
      {!!liveblocksRoomId && <Presence />}

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
