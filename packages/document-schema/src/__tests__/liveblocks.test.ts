import { describe, expect, it } from "vitest";
import { LiveblocksSchemaName } from "../liveblocks";
import {
  documentSchema,
  parseHtml,
  serializeHtml,
} from "./fixtures/schema-dom";

function firstInline(html: string) {
  const inline = parseHtml(html).firstChild?.firstChild;
  if (!inline) {
    throw new Error("parsed document has no inline content");
  }
  return inline;
}

describe("LiveblocksCommentMark", () => {
  it("keeps the stored mark spec and attr defaults", () => {
    const mark = documentSchema.marks[LiveblocksSchemaName.CommentMark];

    expect(mark?.spec.excludes).toBe("");
    expect(mark?.spec.inclusive).toBe(false);
    expect(mark?.create().attrs).toEqual({ orphan: false, threadId: "" });
  });

  it("parses a thread span into a non-orphan comment mark", () => {
    const text = firstInline('<p><span data-lb-thread-id="t1">a</span></p>');

    expect(text.marks.map((mark) => mark.toJSON())).toEqual([
      {
        type: LiveblocksSchemaName.CommentMark,
        attrs: { orphan: false, threadId: "t1" },
      },
    ]);
  });

  it("reads any non-empty data-orphan as orphan and renders it back as true", () => {
    const doc = parseHtml(
      '<p><span data-lb-thread-id="t1" data-orphan="x">a</span></p>'
    );

    expect(doc.firstChild?.firstChild?.marks[0]?.attrs.orphan).toBe(true);
    expect(serializeHtml(doc)).toBe(
      '<p><span data-orphan="true" data-lb-thread-id="t1" class="lb-root lb-tiptap-thread-mark">a</span></p>'
    );
  });

  it("reads an empty data-orphan as not orphan", () => {
    // Pins current behavior; looks odd because the attribute is present but
    // `!!""` is false, so `data-orphan=""` parses as a live anchor.
    const doc = parseHtml(
      '<p><span data-lb-thread-id="t1" data-orphan="">a</span></p>'
    );

    expect(doc.firstChild?.firstChild?.marks[0]?.attrs.orphan).toBe(false);
    expect(serializeHtml(doc)).toBe(
      '<p><span data-lb-thread-id="t1" class="lb-root lb-tiptap-thread-mark">a</span></p>'
    );
  });
});

describe("LiveblocksMentionNode", () => {
  it.each([LiveblocksSchemaName.Mention, LiveblocksSchemaName.GroupMention])(
    "keeps %s an inline selectable atom",
    (name) => {
      const spec = documentSchema.nodes[name]?.spec;

      expect(spec).toMatchObject({
        group: "inline",
        inline: true,
        selectable: true,
        atom: true,
      });
    }
  );

  it("round-trips id and notification id", () => {
    const html =
      '<p><liveblocks-mention data-id="u1" data-notification-id="n1"></liveblocks-mention></p>';
    const doc = parseHtml(html);

    expect(doc.firstChild?.firstChild?.toJSON()).toEqual({
      type: LiveblocksSchemaName.Mention,
      attrs: { id: "u1", notificationId: "n1" },
    });
    expect(serializeHtml(doc)).toBe(html);
  });

  it("renders no data attributes when id and notification id are null", () => {
    const html = "<p><liveblocks-mention></liveblocks-mention></p>";
    const doc = parseHtml(html);

    expect(doc.firstChild?.firstChild?.attrs).toEqual({
      id: null,
      notificationId: null,
    });
    expect(serializeHtml(doc)).toBe(html);
  });
});

describe("LiveblocksGroupMentionNode", () => {
  it("round-trips a JSON array of user ids", () => {
    const doc = parseHtml(
      `<p><liveblocks-group-mention data-id="g" data-user-ids='["a","b"]'></liveblocks-group-mention></p>`
    );

    expect(doc.firstChild?.firstChild?.toJSON()).toEqual({
      type: LiveblocksSchemaName.GroupMention,
      attrs: { id: "g", userIds: ["a", "b"], notificationId: null },
    });
    expect(serializeHtml(doc)).toBe(
      '<p><liveblocks-group-mention data-id="g" data-user-ids="[&quot;a&quot;,&quot;b&quot;]"></liveblocks-group-mention></p>'
    );
  });

  it.each([
    { label: "an empty value", userIds: "" },
    { label: "invalid JSON", userIds: "nope" },
    { label: "a JSON non-array", userIds: "{}" },
  ])("drops user ids given $label", ({ userIds }) => {
    const doc = parseHtml(
      `<p><liveblocks-group-mention data-user-ids="${userIds}"></liveblocks-group-mention></p>`
    );
    const mention = doc.firstChild?.firstChild;

    expect(mention?.attrs.userIds).toBeUndefined();
    expect(serializeHtml(doc)).toBe(
      "<p><liveblocks-group-mention></liveblocks-group-mention></p>"
    );
  });
});
