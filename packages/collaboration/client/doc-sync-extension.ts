"use client";

import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import { LiveblocksCommentMark } from "@repo/document-schema/liveblocks";
import { Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { useContext, useLayoutEffect, useMemo, useRef } from "react";
import { ANONYMOUS_USER_NAME } from "../shared/presence-utils";
import { getConsistentColor } from "../shared/user-colors";
import {
  type DocSyncConfig,
  DocSyncConfigContext,
  type DocSyncResolvedUser,
} from "./doc-sync-config";
import { createDocSyncMentionPicker } from "./doc-sync-mention-picker";
import {
  DocSyncGroupMentionNode,
  DocSyncMentionNode,
} from "./doc-sync-mention-views";
import { useDocSyncRoom } from "./doc-sync-room";
import "./doc-sync-carets.css";

/**
 * The bundle for `TiptapEditorCore`'s collaboration slot on doc-sync (PLN-2189
 * T-2.3): the Y.Doc binding on {@link DOCUMENT_FRAGMENT_FIELD}, peer carets,
 * the Liveblocks comment mark and mention nodes, so stored anchors and
 * mentions survive (PLN-2099 E6), and the body mention picker (T-2.7). `null`
 * until the room exists.
 */
export function useDocSyncExtension(): Extension | null {
  const room = useDocSyncRoom()?.room ?? null;
  const config = useContext(DocSyncConfigContext);
  const configRef = useRef<DocSyncConfig | null>(config);
  useLayoutEffect(() => {
    configRef.current = config;
  }, [config]);
  const selfId = config?.self?.id;
  const selfColor = config?.self?.color;

  return useMemo(() => {
    if (!room) {
      return null;
    }
    const resolveUser = (id: string) => configRef.current?.resolveUser(id);
    return Extension.create({
      name: "docSyncCollaboration",
      addExtensions() {
        return [
          Collaboration.configure({
            document: room.ydoc,
            field: DOCUMENT_FRAGMENT_FIELD,
          }),
          CollaborationCaret.configure({
            provider: room.provider,
            user: selfId ? { id: selfId, color: selfColor } : {},
            render: (user) => renderPeerCaret(peerUserId(user), resolveUser),
            selectionRender: (user) => peerSelection(peerUserId(user)),
          }),
          LiveblocksCommentMark,
          DocSyncMentionNode,
          DocSyncGroupMentionNode,
          createDocSyncMentionPicker(() => configRef.current),
        ];
      },
    });
  }, [room, selfId, selfColor]);
}

function peerUserId(user: Record<string, unknown>): string | undefined {
  return typeof user.id === "string" && user.id ? user.id : undefined;
}

/**
 * The caret DOM `yCursorPlugin` mounts. The peer's own awareness supplies only
 * its id; the label's name and avatar and the colour are resolved here.
 */
function renderPeerCaret(
  userId: string | undefined,
  resolveUser: (id: string) => DocSyncResolvedUser | undefined
): HTMLElement {
  const doc = globalThis.document;
  const resolved = userId ? resolveUser(userId) : undefined;
  const caret = doc.createElement("span");
  caret.classList.add("collaboration-carets__caret", DOC_SYNC_CARET_CLASS);
  if (userId) {
    caret.style.setProperty(PEER_COLOR_PROPERTY, getConsistentColor(userId));
  }
  const label = doc.createElement("div");
  label.classList.add("collaboration-carets__label");
  if (resolved?.avatarUrl) {
    const avatar = doc.createElement("img");
    avatar.classList.add("collaboration-carets__avatar");
    avatar.alt = "";
    avatar.src = resolved.avatarUrl;
    label.append(avatar);
  }
  label.append(doc.createTextNode(resolved?.name ?? ANONYMOUS_USER_NAME));
  caret.append(label);
  return caret;
}

function peerSelection(userId: string | undefined) {
  return {
    nodeName: "span",
    class: `collaboration-carets__selection ${DOC_SYNC_CARET_SELECTION_CLASS}`,
    ...(userId && {
      style: `${PEER_COLOR_PROPERTY}: ${getConsistentColor(userId)}`,
    }),
  };
}

const PEER_COLOR_PROPERTY = "--doc-sync-peer-color";

/** Scopes `doc-sync-carets.css` away from the Liveblocks carets' classes. */
export const DOC_SYNC_CARET_CLASS = "doc-sync-caret";
export const DOC_SYNC_CARET_SELECTION_CLASS = "doc-sync-caret-selection";
