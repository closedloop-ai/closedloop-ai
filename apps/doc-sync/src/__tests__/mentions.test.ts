import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import { LiveblocksSchemaName } from "@repo/document-schema/liveblocks";
import {
  DOC_SYNC_CALLBACK_MAX_ID_LENGTH,
  DocSyncMentionKind,
} from "@repo/realtime-contract/doc-sync-internal";
import { describe, expect, it } from "vitest";
import { Doc, XmlElement, XmlText } from "yjs";
import { currentMentions } from "../callbacks/mentions";

/** A paragraph of text and inline mention nodes, as y-prosemirror stores them. */
function paragraph(
  ...children: (string | { node: LiveblocksSchemaName; id: string })[]
): XmlElement {
  const element = new XmlElement("paragraph");
  element.insert(
    0,
    children.map((child) => {
      if (typeof child === "string") {
        const text = new XmlText();
        text.insert(0, child);
        return text;
      }
      const mention = new XmlElement(child.node);
      mention.setAttribute("id", child.id);
      return mention;
    })
  );
  return element;
}

function fragmentOf(...blocks: XmlElement[]) {
  const doc = new Doc();
  const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT_FIELD);
  fragment.insert(0, blocks);
  return fragment;
}

const user = (id: string) => ({ node: LiveblocksSchemaName.Mention, id });
const group = (id: string) => ({ node: LiveblocksSchemaName.GroupMention, id });

describe("currentMentions", () => {
  it("returns user and group mentions in document order, deduped by kind and id", () => {
    const list = new XmlElement("bulletList");
    const item = new XmlElement("listItem");
    item.insert(0, [paragraph("nested ", group("team-1"))]);
    list.insert(0, [item]);
    const fragment = fragmentOf(
      paragraph("hi ", user("u-1"), " and ", group("u-1")),
      list,
      paragraph(user("u-1"), user("u-2"))
    );

    expect(currentMentions(fragment, 10)).toEqual({
      mentions: [
        { kind: DocSyncMentionKind.User, id: "u-1" },
        { kind: DocSyncMentionKind.Group, id: "u-1" },
        { kind: DocSyncMentionKind.Group, id: "team-1" },
        { kind: DocSyncMentionKind.User, id: "u-2" },
      ],
      truncated: false,
    });
  });

  it("stops at the cap and sets truncated only when another distinct mention exists", () => {
    const fragment = fragmentOf(
      paragraph(user("u-1"), user("u-2"), user("u-1"))
    );

    expect(currentMentions(fragment, 2)).toEqual({
      mentions: [
        { kind: DocSyncMentionKind.User, id: "u-1" },
        { kind: DocSyncMentionKind.User, id: "u-2" },
      ],
      truncated: false,
    });
    expect(currentMentions(fragment, 1)).toEqual({
      mentions: [{ kind: DocSyncMentionKind.User, id: "u-1" }],
      truncated: true,
    });
  });

  it("leaves out a mention whose id the callback cannot carry and sets truncated", () => {
    const fragment = fragmentOf(
      paragraph(
        user("u".repeat(DOC_SYNC_CALLBACK_MAX_ID_LENGTH + 1)),
        group('team-"1"'),
        user("u-1")
      )
    );

    expect(currentMentions(fragment, 10)).toEqual({
      mentions: [{ kind: DocSyncMentionKind.User, id: "u-1" }],
      truncated: true,
    });
  });
});
