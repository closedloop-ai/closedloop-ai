import { describe, expect, it } from "vitest";
import { Doc, XmlElement, type XmlFragment, XmlText } from "yjs";
import { DOCUMENT_FRAGMENT_FIELD } from "../collaboration-field";
import {
  AnchorKind,
  applyCommentMark,
  fragmentPlainText,
  hashOfJSON,
  locateAnchor,
} from "../comment-anchor";

/** What y-prosemirror 1.3.7's own `hashOfJSON` returns for the mark below; a stored key, so permanent. */
const Y_PROSEMIRROR_HASH = "hVKfAnOa";
const STORED_MARK_JSON = {
  type: "liveblocksCommentMark",
  attrs: { orphan: false, threadId: "th_abc" },
};

type Block =
  | { tag: string; segments: string[] }
  | { tag: string; children: Block[] };

function buildFragment(...blocks: Block[]): XmlFragment {
  const fragment = new Doc().getXmlFragment(DOCUMENT_FRAGMENT_FIELD);
  fragment.doc?.transact(() => {
    fragment.insert(0, blocks.map(buildElement));
  });
  return fragment;
}

function buildElement(block: Block): XmlElement {
  const element = new XmlElement(block.tag);
  if ("segments" in block) {
    element.insert(
      0,
      block.segments.map((segment) => {
        const text = new XmlText();
        text.insert(0, segment);
        return text;
      })
    );
  } else {
    element.insert(0, block.children.map(buildElement));
  }
  return element;
}

type DeltaEntry = { insert: string; attributes?: Record<string, unknown> };

function deltas(fragment: XmlFragment): DeltaEntry[][] {
  const paragraph = fragment.get(0) as XmlElement;
  return paragraph
    .toArray()
    .map((node) => (node as XmlText).toDelta() as DeltaEntry[]);
}

describe("hashOfJSON", () => {
  it("matches y-prosemirror's hash of a stored comment mark", () => {
    expect(hashOfJSON(STORED_MARK_JSON)).toBe(Y_PROSEMIRROR_HASH);
  });

  it("produces a different hash when attribute key order differs (lib0.encodeAny is order-sensitive)", () => {
    const ordered = { orphan: false, threadId: "th_abc" };
    const reversed = { threadId: "th_abc", orphan: false };
    expect(hashOfJSON(ordered)).not.toBe(hashOfJSON(reversed));
  });
});

describe("locateAnchor", () => {
  it("finds a unique match and its offset", () => {
    const fragment = buildFragment(
      { tag: "paragraph", segments: ["intro"] },
      { tag: "paragraph", segments: ["say hello there"] }
    );

    const location = locateAnchor(fragment, "hello");

    expect(location.kind).toBe(AnchorKind.Unique);
    expect(location.kind === AnchorKind.Unique && location.match.offset).toBe(
      4
    );
  });

  it("is not_found when the text is absent", () => {
    const fragment = buildFragment({ tag: "paragraph", segments: ["hello"] });

    expect(locateAnchor(fragment, "absent")).toEqual({
      kind: AnchorKind.NotFound,
    });
  });

  it("is ambiguous with the count across blocks and within one", () => {
    const fragment = buildFragment(
      { tag: "paragraph", segments: ["same and same"] },
      { tag: "paragraph", segments: ["same"] }
    );

    expect(locateAnchor(fragment, "same")).toEqual({
      kind: AnchorKind.Ambiguous,
      matchCount: 3,
    });
  });

  it("matches across two formatted text nodes of one block", () => {
    const fragment = buildFragment({
      tag: "paragraph",
      segments: ["Hello ", "world"],
    });

    const location = locateAnchor(fragment, "Hello world");

    expect(
      location.kind === AnchorKind.Unique && location.match.textNodes
    ).toHaveLength(2);
  });
});

describe("applyCommentMark", () => {
  it("writes exactly liveblocksCommentMark--<hash> with { orphan: false, threadId } on every overlapping node", () => {
    const fragment = buildFragment({
      tag: "paragraph",
      segments: ["Hello ", "world!"],
    });
    const location = locateAnchor(fragment, "lo wor");
    if (location.kind !== AnchorKind.Unique) {
      throw new Error("expected a unique match");
    }

    fragment.doc?.transact(() => {
      applyCommentMark(location.match, "lo wor", "th_abc");
    });

    const markValue = { orphan: false, threadId: "th_abc" };
    const key = `liveblocksCommentMark--${Y_PROSEMIRROR_HASH}`;
    expect(deltas(fragment)).toEqual([
      [{ insert: "Hel" }, { insert: "lo ", attributes: { [key]: markValue } }],
      [{ insert: "wor", attributes: { [key]: markValue } }, { insert: "ld!" }],
    ]);
  });
});

describe("fragmentPlainText", () => {
  it("joins every leaf block's text in document order, nested blocks included", () => {
    const fragment = buildFragment(
      { tag: "heading", segments: ["Title"] },
      {
        tag: "bulletList",
        children: [
          {
            tag: "listItem",
            children: [{ tag: "paragraph", segments: ["one ", "bold"] }],
          },
          {
            tag: "listItem",
            children: [{ tag: "paragraph", segments: ["two"] }],
          },
        ],
      }
    );

    expect(fragmentPlainText(fragment)).toBe("Title\none bold\ntwo");
  });

  it("is empty for an empty fragment", () => {
    expect(fragmentPlainText(buildFragment())).toBe("");
  });

  it("counts an empty paragraph once whether it was created empty or emptied", () => {
    const createdEmpty = buildFragment(
      { tag: "paragraph", segments: ["a"] },
      { tag: "paragraph", segments: [] },
      { tag: "paragraph", segments: ["b"] }
    );
    const emptied = buildFragment(
      { tag: "paragraph", segments: ["a"] },
      { tag: "paragraph", segments: [""] },
      { tag: "paragraph", segments: ["b"] }
    );

    expect(fragmentPlainText(createdEmpty)).toBe("a\n\nb");
    expect(fragmentPlainText(emptied)).toBe("a\n\nb");
  });
});
