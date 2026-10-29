import { type Attribute, Mark, mergeAttributes, Node } from "@tiptap/core";

/**
 * The mark and node names `@liveblocks/react-tiptap` writes into every stored
 * document. Permanent (PLN-2099 E6): a schema without them makes y-prosemirror
 * drop comment anchors, the text they cover, and mentions for every user.
 */
export const LiveblocksSchemaName = {
  CommentMark: "liveblocksCommentMark",
  Mention: "liveblocksMention",
  GroupMention: "liveblocksGroupMention",
} as const;

export type LiveblocksSchemaName =
  (typeof LiveblocksSchemaName)[keyof typeof LiveblocksSchemaName];

const THREAD_ID_ATTRIBUTE = "data-lb-thread-id";

/**
 * `excludes: ""` is what lets y-prosemirror decode overlapping comment marks
 * (stored under hashed keys, `liveblocksCommentMark--<hash>`); without it
 * overlapping anchors drop.
 */
export const LiveblocksCommentMark = Mark.create({
  name: LiveblocksSchemaName.CommentMark,
  excludes: "",
  inclusive: false,
  keepOnSplit: true,

  parseHTML() {
    return [{ tag: `span[${THREAD_ID_ATTRIBUTE}]` }];
  },

  addAttributes() {
    return {
      orphan: {
        default: false,
        parseHTML: (element) => !!element.getAttribute("data-orphan"),
        renderHTML: (attributes) =>
          attributes.orphan ? { "data-orphan": "true" } : {},
      },
      threadId: {
        default: "",
        parseHTML: (element) => element.getAttribute(THREAD_ID_ATTRIBUTE),
        renderHTML: (attributes) => ({
          [THREAD_ID_ATTRIBUTE]: attributes.threadId,
        }),
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "lb-root lb-tiptap-thread-mark",
      }),
      0,
    ];
  },
});

const idAttribute: Attribute = {
  default: null,
  parseHTML: (element) => element.getAttribute("data-id"),
  renderHTML: (attributes) =>
    attributes.id ? { "data-id": attributes.id } : {},
};

const notificationIdAttribute: Attribute = {
  default: null,
  parseHTML: (element) => element.getAttribute("data-notification-id"),
  renderHTML: (attributes) =>
    attributes.notificationId
      ? { "data-notification-id": attributes.notificationId }
      : {},
};

const userIdsAttribute: Attribute = {
  default: undefined,
  parseHTML: (element) => parseUserIds(element.getAttribute("data-user-ids")),
  renderHTML: (attributes) =>
    Array.isArray(attributes.userIds)
      ? { "data-user-ids": JSON.stringify(attributes.userIds) }
      : {},
};

export const LiveblocksMentionNode = createMentionNode(
  LiveblocksSchemaName.Mention,
  "liveblocks-mention",
  { id: idAttribute, notificationId: notificationIdAttribute }
);

export const LiveblocksGroupMentionNode = createMentionNode(
  LiveblocksSchemaName.GroupMention,
  "liveblocks-group-mention",
  {
    id: idAttribute,
    userIds: userIdsAttribute,
    notificationId: notificationIdAttribute,
  }
);

/** Kept last in any extension list: their position decides mark rank. */
export const liveblocksSchemaExtensions = [
  LiveblocksCommentMark,
  LiveblocksMentionNode,
  LiveblocksGroupMentionNode,
];

function createMentionNode(
  name: LiveblocksSchemaName,
  tag: string,
  attributes: Record<string, Attribute>
) {
  return Node.create({
    name,
    group: "inline",
    inline: true,
    selectable: true,
    atom: true,
    priority: 101,

    parseHTML() {
      return [{ tag }];
    },

    renderHTML({ HTMLAttributes }) {
      return [tag, mergeAttributes(HTMLAttributes)];
    },

    addAttributes() {
      return attributes;
    },
  });
}

function parseUserIds(value: string | null): unknown[] | undefined {
  if (!value) {
    return;
  }
  try {
    const userIds: unknown = JSON.parse(value);
    return Array.isArray(userIds) ? userIds : undefined;
  } catch {
    return;
  }
}
