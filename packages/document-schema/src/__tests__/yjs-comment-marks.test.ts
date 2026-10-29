import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  prosemirrorToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import { describe, expect, it } from "vitest";
import { Doc, type XmlElement, type XmlFragment, type XmlText } from "yjs";
import { DOCUMENT_FRAGMENT_FIELD } from "../collaboration-field";
import {
  AnchorKind,
  applyCommentMark,
  commentMarkAttribute,
  fragmentPlainText,
  locateAnchor,
} from "../comment-anchor";
import { LiveblocksSchemaName } from "../liveblocks";
import { markdownToDocument } from "../markdown";
import {
  applyCommentMarkToRange,
  readCommentMarks,
  removeCommentMarks,
  renameCommentMarks,
  setCommentMarkOrphan,
} from "../yjs-comment-marks";

type Seeded = {
  fragment: XmlFragment;
  text: string;
  schemaDoc: ProseMirrorNode;
};

/** A Yjs fragment written by y-prosemirror from markdown, as the editor and seed-version write one. */
function seed(markdown: string): Seeded {
  const schemaDoc = markdownToDocument(markdown);
  const fragment = new Doc().getXmlFragment(DOCUMENT_FRAGMENT_FIELD);
  prosemirrorToYXmlFragment(schemaDoc, fragment);
  return { fragment, text: fragmentPlainText(fragment), schemaDoc };
}

type TextMark = { text: string; attrs: Record<string, unknown> };

/** Every comment mark y-prosemirror decodes back out of the fragment, per text node. */
function decodedMarks({ fragment, schemaDoc }: Seeded): TextMark[] {
  const root = yXmlFragmentToProseMirrorRootNode(
    fragment,
    schemaDoc.type.schema
  );
  const marks: TextMark[] = [];
  root.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === LiveblocksSchemaName.CommentMark) {
        marks.push({ text: node.text ?? "", attrs: mark.attrs });
      }
    }
  });
  return marks;
}

function rangeOf(text: string, quote: string) {
  const start = text.indexOf(quote);
  if (start === -1) {
    throw new Error(`"${quote}" is not in the fixture`);
  }
  return { start, end: start + quote.length };
}

describe("applyCommentMarkToRange and readCommentMarks", () => {
  it("marks a range spanning formatted text nodes and reads it back as one range", () => {
    const doc = seed("Hello **bold** world");
    const range = rangeOf(doc.text, "lo bold wo");

    applyCommentMarkToRange(doc.fragment, range, "th_a");

    expect(readCommentMarks(doc.fragment)).toEqual([
      { threadId: "th_a", orphan: false, ...range },
    ]);
    expect(decodedMarks(doc)).toEqual([
      { text: "lo ", attrs: { orphan: false, threadId: "th_a" } },
      { text: "bold", attrs: { orphan: false, threadId: "th_a" } },
      { text: " wo", attrs: { orphan: false, threadId: "th_a" } },
    ]);
  });

  it("marks a range across textblocks and reads it back in the same coordinates", () => {
    const doc = seed("# Title\n\nfirst para\n\nsecond para");
    const range = rangeOf(doc.text, "para\nsecond");

    applyCommentMarkToRange(doc.fragment, range, "th_a");

    expect(readCommentMarks(doc.fragment)).toEqual([
      { threadId: "th_a", orphan: false, ...range },
    ]);
    expect(decodedMarks(doc).map(({ text }) => text)).toEqual([
      "para",
      "second",
    ]);
  });

  it("reads overlapping marks of two threads as two ranges, ordered by start", () => {
    const doc = seed("one two three four");
    const outer = rangeOf(doc.text, "two three");
    const inner = rangeOf(doc.text, "one two");

    applyCommentMarkToRange(doc.fragment, outer, "th_b");
    applyCommentMarkToRange(doc.fragment, inner, "th_a");

    expect(readCommentMarks(doc.fragment)).toEqual([
      { threadId: "th_a", orphan: false, ...inner },
      { threadId: "th_b", orphan: false, ...outer },
    ]);
  });

  it("keeps adjacent marks of two threads apart", () => {
    const doc = seed("one two");
    const first = rangeOf(doc.text, "one ");
    const second = rangeOf(doc.text, "two");

    applyCommentMarkToRange(doc.fragment, first, "th_a");
    applyCommentMarkToRange(doc.fragment, second, "th_b");

    expect(readCommentMarks(doc.fragment)).toEqual([
      { threadId: "th_a", orphan: false, ...first },
      { threadId: "th_b", orphan: false, ...second },
    ]);
  });

  it("orders ranges that start together by their end", () => {
    const doc = seed("one two three");
    const longer = rangeOf(doc.text, "one two");
    const shorter = rangeOf(doc.text, "one");

    applyCommentMarkToRange(doc.fragment, longer, "th_a");
    applyCommentMarkToRange(doc.fragment, shorter, "th_b");

    expect(readCommentMarks(doc.fragment)).toEqual([
      { threadId: "th_b", orphan: false, ...shorter },
      { threadId: "th_a", orphan: false, ...longer },
    ]);
  });

  it("reads a mark the match-based applyCommentMark wrote", () => {
    const doc = seed("say hello there");
    const location = locateAnchor(doc.fragment, "hello");
    if (location.kind !== AnchorKind.Unique) {
      throw new Error("expected a unique match");
    }

    doc.fragment.doc?.transact(() => {
      applyCommentMark(location.match, "hello", "th_a");
    });

    expect(readCommentMarks(doc.fragment)).toEqual([
      { threadId: "th_a", orphan: false, ...rangeOf(doc.text, "hello") },
    ]);
  });

  it("skips an attribute whose value is not a comment mark's", () => {
    const doc = seed("say hello there");
    const paragraph = doc.fragment.get(0) as XmlElement;
    const text = paragraph.get(0) as XmlText;
    doc.fragment.doc?.transact(() => {
      text.format(0, 3, {
        [`${LiveblocksSchemaName.CommentMark}--corrupt`]: { threadId: 7 },
      });
    });

    expect(readCommentMarks(doc.fragment)).toEqual([]);
  });

  it("refuses a range outside the text", () => {
    const doc = seed("short");

    expect(() =>
      applyCommentMarkToRange(doc.fragment, { start: 2, end: 9 }, "th_a")
    ).toThrow(RangeError);
    expect(() =>
      applyCommentMarkToRange(doc.fragment, { start: 3, end: 3 }, "th_a")
    ).toThrow(RangeError);
  });

  it("refuses a range that covers only a block separator", () => {
    const doc = seed("a\n\nb");
    expect(doc.text).toBe("a\nb");

    expect(() =>
      applyCommentMarkToRange(doc.fragment, { start: 1, end: 2 }, "th_a")
    ).toThrow(RangeError);
    expect(readCommentMarks(doc.fragment)).toEqual([]);
  });
});

describe("removeCommentMarks", () => {
  it("removes every listed thread's marks and leaves the others", () => {
    const doc = seed("alpha beta gamma");
    for (const [threadId, quote] of [
      ["th_a", "alpha"],
      ["th_b", "beta"],
      ["th_c", "gamma"],
    ] as const) {
      applyCommentMarkToRange(doc.fragment, rangeOf(doc.text, quote), threadId);
    }

    expect(
      removeCommentMarks(doc.fragment, ["th_b", "th_missing", "th_a"])
    ).toEqual(["th_b", "th_a"]);
    expect(readCommentMarks(doc.fragment)).toEqual([
      { threadId: "th_c", orphan: false, ...rangeOf(doc.text, "gamma") },
    ]);
  });
});

describe("renameCommentMarks", () => {
  it("moves each mapped thread's marks to its new id, keeping the orphan flag", () => {
    const doc = seed("alpha beta gamma");
    applyCommentMarkToRange(doc.fragment, rangeOf(doc.text, "alpha"), "lb_a");
    applyCommentMarkToRange(doc.fragment, rangeOf(doc.text, "beta"), "lb_b");
    applyCommentMarkToRange(doc.fragment, rangeOf(doc.text, "gamma"), "th_c");
    setCommentMarkOrphan(doc.fragment, "lb_b");

    expect(
      renameCommentMarks(
        doc.fragment,
        new Map([
          ["lb_a", "th_a"],
          ["lb_b", "th_b"],
          ["lb_missing", "th_x"],
        ])
      )
    ).toEqual(["lb_a", "lb_b"]);
    expect(decodedMarks(doc)).toEqual([
      { text: "alpha", attrs: { orphan: false, threadId: "th_a" } },
      { text: "beta", attrs: { orphan: true, threadId: "th_b" } },
      { text: "gamma", attrs: { orphan: false, threadId: "th_c" } },
    ]);
  });

  it.each([
    [
      "a chain",
      [
        ["th_a", "th_b"],
        ["th_b", "th_c"],
      ],
      ["th_b", "th_c"],
    ],
    [
      "a swap",
      [
        ["th_a", "th_b"],
        ["th_b", "th_a"],
      ],
      ["th_b", "th_a"],
    ],
  ] as const)(
    "keeps both marks of overlapping threads renamed in %s",
    (_, mapping, [first, second]) => {
      const doc = seed("one two three");
      const firstRange = rangeOf(doc.text, "one two");
      const secondRange = rangeOf(doc.text, "two three");
      applyCommentMarkToRange(doc.fragment, firstRange, "th_a");
      applyCommentMarkToRange(doc.fragment, secondRange, "th_b");

      expect(renameCommentMarks(doc.fragment, new Map(mapping))).toEqual([
        "th_a",
        "th_b",
      ]);
      expect(readCommentMarks(doc.fragment)).toEqual([
        { threadId: first, orphan: false, ...firstRange },
        { threadId: second, orphan: false, ...secondRange },
      ]);
    }
  );
});

describe("setCommentMarkOrphan", () => {
  it("rewrites the thread's mark under the orphan key, which y-prosemirror decodes as orphan", () => {
    const doc = seed("alpha beta");
    applyCommentMarkToRange(doc.fragment, rangeOf(doc.text, "alpha"), "th_a");
    applyCommentMarkToRange(doc.fragment, rangeOf(doc.text, "beta"), "th_b");

    expect(setCommentMarkOrphan(doc.fragment, "th_a")).toBe(true);

    const paragraph = doc.fragment.get(0) as XmlElement;
    const [alpha] = (paragraph.get(0) as XmlText).toDelta() as {
      attributes?: Record<string, unknown>;
    }[];
    expect(Object.keys(alpha?.attributes ?? {})).toEqual([
      commentMarkAttribute("th_a", true).key,
    ]);
    expect(decodedMarks(doc)).toEqual([
      { text: "alpha", attrs: { orphan: true, threadId: "th_a" } },
      { text: "beta", attrs: { orphan: false, threadId: "th_b" } },
    ]);
  });

  it("uses the key y-prosemirror itself writes for an orphaned mark", () => {
    const { schema } = markdownToDocument("x").type;
    const mark = schema.marks[LiveblocksSchemaName.CommentMark]?.create({
      orphan: true,
      threadId: "th_a",
    });
    const written = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("x", mark ? [mark] : [])]),
    ]);
    const fragment = new Doc().getXmlFragment(DOCUMENT_FRAGMENT_FIELD);
    prosemirrorToYXmlFragment(written, fragment);

    const paragraph = fragment.get(0) as XmlElement;
    const [op] = (paragraph.get(0) as XmlText).toDelta() as {
      attributes?: Record<string, unknown>;
    }[];
    expect(Object.keys(op?.attributes ?? {})).toEqual([
      commentMarkAttribute("th_a", true).key,
    ]);
  });

  it("is false for a thread with no live mark", () => {
    const doc = seed("alpha");

    expect(setCommentMarkOrphan(doc.fragment, "th_none")).toBe(false);
  });
});
