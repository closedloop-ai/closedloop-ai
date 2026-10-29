"use client";

import { cn } from "@repo/design-system/lib/utils";
import {
  LiveblocksGroupMentionNode,
  LiveblocksMentionNode,
  LiveblocksSchemaName,
} from "@repo/document-schema/liveblocks";
import {
  NodeViewWrapper,
  type ReactNodeViewProps,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import { useContext } from "react";
import { ANONYMOUS_USER_NAME } from "../shared/presence-utils";
import { DocSyncConfigContext } from "./doc-sync-config";

/**
 * The shared mention nodes with node views that render what
 * `@liveblocks/react-tiptap`'s do: `@` plus the user's name (`Anonymous` when
 * unknown), or `@` plus the group id, which has no resolver here as on
 * Liveblocks. Users resolve through the org user list.
 */
export const DocSyncMentionNode = LiveblocksMentionNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(DocSyncMentionView, {
      contentDOMElementTag: "span",
    });
  },
});

export const DocSyncGroupMentionNode = LiveblocksGroupMentionNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(DocSyncMentionView, {
      contentDOMElementTag: "span",
    });
  },
});

function DocSyncMentionView({ node, selected }: ReactNodeViewProps) {
  const resolveUser = useContext(DocSyncConfigContext)?.resolveUser;
  const id: unknown = node.attrs.id;
  const mentionId = typeof id === "string" && id ? id : undefined;
  const isGroup = node.type.name === LiveblocksSchemaName.GroupMention;
  const label = isGroup
    ? mentionId
    : ((mentionId && resolveUser?.(mentionId)?.name) ?? ANONYMOUS_USER_NAME);
  return (
    <NodeViewWrapper
      as="span"
      className={cn(
        "lb-root lb-mention lb-tiptap-mention",
        selected && "lb-mention-selected"
      )}
    >
      <span className="lb-mention-symbol">@</span>
      <span className={cn("lb-name", isGroup ? "lb-group" : "lb-user")}>
        {label}
      </span>
    </NodeViewWrapper>
  );
}
