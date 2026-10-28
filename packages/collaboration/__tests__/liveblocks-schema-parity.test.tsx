// @vitest-environment jsdom

import { GroupMentionNode, MentionNode } from "@liveblocks/react-tiptap";
import { createDocumentExtensions } from "@repo/document-schema/extensions";
import {
  LiveblocksCommentMark,
  LiveblocksGroupMentionNode,
  LiveblocksMentionNode,
  LiveblocksSchemaName,
  liveblocksSchemaExtensions,
} from "@repo/document-schema/liveblocks";
import { type AnyExtension, getSchema, Mark } from "@tiptap/core";
import type { MarkType, NodeType, Schema } from "@tiptap/pm/model";
import { describe, expect, it, vi } from "vitest";
import {
  findExtension,
  resolveLiveblocksExtensions,
} from "./support/liveblocks-extension-harness";

vi.mock("@liveblocks/react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...(await import("./support/liveblocks-extension-harness"))
    .liveblocksReactOverrides,
}));

vi.mock("@liveblocks/react/_private", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...(await import("./support/liveblocks-extension-harness"))
    .liveblocksReactPrivateOverrides,
}));

/**
 * y-prosemirror 1.3.7 never writes `ychange` into Yjs (`sync-plugin.js` skips
 * it), so the shared schema leaves it out (PLN-2188 Implementation Notes).
 */
const UNPERSISTED_LIVEBLOCKS_MARKS = new Set(["ychange"]);

const COMMENTS_EXTENSION = "liveblocksComments";

function buildSchema(extensions: AnyExtension[]): Schema {
  return getSchema([
    ...createDocumentExtensions({ undoRedo: false }),
    ...extensions,
  ]);
}

function attrsSummary(attrs: NodeType["spec"]["attrs"]) {
  return Object.entries(attrs ?? {}).map(([name, spec]) => ({
    name,
    hasDefault: "default" in spec,
    default: spec.default,
  }));
}

function nodeSummary(type: NodeType | undefined) {
  if (!type) {
    throw new Error("node type missing from schema");
  }
  const { atom, attrs, group, inline, selectable } = type.spec;
  return { atom, attrs: attrsSummary(attrs), group, inline, selectable };
}

function markSummary(type: MarkType | undefined) {
  if (!type) {
    throw new Error("mark type missing from schema");
  }
  const { attrs, excludes, inclusive } = type.spec;
  return { attrs: attrsSummary(attrs), excludes, inclusive };
}

function addedNames(schema: Schema, base: Schema) {
  return {
    marks: Object.keys(schema.marks).filter(
      (name) => !(name in base.marks || UNPERSISTED_LIVEBLOCKS_MARKS.has(name))
    ),
    nodes: Object.keys(schema.nodes).filter((name) => !(name in base.nodes)),
  };
}

function commentMarkExtension(extensions: AnyExtension[]): Mark {
  const comments = findExtension(extensions, COMMENTS_EXTENSION);
  const addExtensions = comments.config.addExtensions as
    | (() => AnyExtension[])
    | undefined;
  const comment = findExtension(
    addExtensions?.() ?? [],
    LiveblocksSchemaName.CommentMark
  );
  if (!(comment instanceof Mark)) {
    throw new Error("Liveblocks' comment extension is not a Tiptap mark");
  }
  return comment;
}

describe("shared Liveblocks schema matches @liveblocks/react-tiptap", () => {
  it("adds the same schema names as the Liveblocks extension", async () => {
    const base = buildSchema([]);
    const liveblocks = buildSchema(await resolveLiveblocksExtensions());
    const shared = buildSchema(liveblocksSchemaExtensions);

    expect(addedNames(shared, base)).toEqual(addedNames(liveblocks, base));
  });

  it.each([LiveblocksSchemaName.Mention, LiveblocksSchemaName.GroupMention])(
    "defines %s with the same node spec",
    async (name) => {
      const liveblocks = buildSchema(await resolveLiveblocksExtensions());
      const shared = buildSchema(liveblocksSchemaExtensions);

      expect(nodeSummary(shared.nodes[name])).toEqual(
        nodeSummary(liveblocks.nodes[name])
      );
    }
  );

  it("defines the comment mark with the same mark spec", async () => {
    const liveblocks = buildSchema(await resolveLiveblocksExtensions());
    const shared = buildSchema(liveblocksSchemaExtensions);

    expect(markSummary(shared.marks[LiveblocksSchemaName.CommentMark])).toEqual(
      markSummary(liveblocks.marks[LiveblocksSchemaName.CommentMark])
    );
  });

  // Extension priority and keepOnSplit never reach the built schema spec.
  it("keeps the mention priority and the comment mark's keepOnSplit", async () => {
    const comment = commentMarkExtension(await resolveLiveblocksExtensions());

    expect(LiveblocksMentionNode.config.priority).toBe(
      MentionNode.config.priority
    );
    expect(LiveblocksGroupMentionNode.config.priority).toBe(
      GroupMentionNode.config.priority
    );
    expect(LiveblocksCommentMark.config.keepOnSplit).toBe(
      comment.config.keepOnSplit
    );
  });
});
