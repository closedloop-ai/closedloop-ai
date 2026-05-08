import type { Liveblocks } from "@liveblocks/node";
import { describe, expect, it, vi } from "vitest";
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  XmlElement,
  XmlText,
} from "yjs";
import { anchorThreadToText, hashOfJSON } from "../yjs-anchor";

const MARK_KEY_PATTERN = /^liveblocksCommentMark--[A-Za-z0-9+/=]{8}$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDoc(...blocks: { tag: string; textSegments: string[] }[]): Doc {
  const ydoc = new Doc();
  const frag = ydoc.getXmlFragment("default");

  ydoc.transact(() => {
    for (const block of blocks) {
      const el = new XmlElement(block.tag);
      for (const segment of block.textSegments) {
        const txt = new XmlText();
        txt.insert(0, segment);
        el.insert(el.length, [txt]);
      }
      frag.insert(frag.length, [el]);
    }
  });

  return ydoc;
}

function createMockLiveblocks(ydoc: Doc) {
  const binary = encodeStateAsUpdate(ydoc);
  return {
    getYjsDocumentAsBinaryUpdate: vi.fn().mockResolvedValue(binary.buffer),
    sendYjsBinaryUpdate: vi.fn().mockResolvedValue(undefined),
  } as unknown as Liveblocks;
}

/**
 * Apply the diff sent to sendYjsBinaryUpdate on top of the original doc state
 * and return the resulting document for inspection.
 */
function applyDiff(originalDoc: Doc, mockLiveblocks: Liveblocks): Doc {
  const sentUpdate = vi.mocked(mockLiveblocks.sendYjsBinaryUpdate).mock
    .calls[0][1] as Uint8Array;
  const resultDoc = new Doc();
  applyUpdate(resultDoc, encodeStateAsUpdate(originalDoc));
  applyUpdate(resultDoc, sentUpdate);
  return resultDoc;
}

/**
 * Collect all formatting attribute keys from every delta entry across all
 * XmlText nodes in a document's "default" fragment.
 */
function collectAllAttrKeys(doc: Doc): string[] {
  const frag = doc.getXmlFragment("default");
  const keys: string[] = [];

  for (let i = 0; i < frag.length; i++) {
    const el = frag.get(i) as XmlElement;
    for (let j = 0; j < el.length; j++) {
      const node = el.get(j);
      if (node instanceof XmlText) {
        const delta = node.toDelta() as {
          insert: string;
          attributes?: Record<string, unknown>;
        }[];
        for (const entry of delta) {
          if (entry.attributes) {
            keys.push(...Object.keys(entry.attributes));
          }
        }
      }
    }
  }

  return keys;
}

// ---------------------------------------------------------------------------
// hashOfJSON
// ---------------------------------------------------------------------------

describe("hashOfJSON", () => {
  it("produces consistent 8-char output for a known input", () => {
    const input = {
      type: "liveblocksCommentMark",
      attrs: { orphan: false, threadId: "th_abc" },
    };
    const result = hashOfJSON(input);
    // Base64 of 6 bytes is exactly 8 characters (with padding)
    expect(result).toHaveLength(8);
    // Same input always produces the same hash
    expect(hashOfJSON(input)).toBe(result);
  });

  it("produces the same hash on repeated calls with identical input", () => {
    const input = {
      type: "liveblocksCommentMark",
      attrs: { orphan: false, threadId: "th_abc" },
    };
    expect(hashOfJSON(input)).toBe(hashOfJSON(input));
  });

  it("produces a different hash when attribute key order differs (lib0.encodeAny is order-sensitive)", () => {
    const ordered = { orphan: false, threadId: "th_abc" };
    const reversed = { threadId: "th_abc", orphan: false };
    expect(hashOfJSON(ordered)).not.toBe(hashOfJSON(reversed));
  });
});

// ---------------------------------------------------------------------------
// anchorThreadToText
// ---------------------------------------------------------------------------

describe("anchorThreadToText", () => {
  describe("single-node paragraph", () => {
    it("applies a liveblocksCommentMark-- key with the correct value", async () => {
      const ydoc = buildDoc({
        tag: "paragraph",
        textSegments: ["Hello world"],
      });
      const mockLiveblocks = createMockLiveblocks(ydoc);

      await anchorThreadToText(
        mockLiveblocks,
        "room-1",
        "th_xyz",
        "Hello world"
      );

      expect(mockLiveblocks.sendYjsBinaryUpdate).toHaveBeenCalledOnce();

      const resultDoc = applyDiff(ydoc, mockLiveblocks);
      const attrKeys = collectAllAttrKeys(resultDoc);

      const markKeys = attrKeys.filter((k) =>
        k.startsWith("liveblocksCommentMark--")
      );
      expect(markKeys).toHaveLength(1);
      const [markKey] = markKeys;
      // Key should be liveblocksCommentMark--<8-char hash>
      expect(MARK_KEY_PATTERN.test(markKey as string)).toBe(true);

      // Verify the mark value contains the correct threadId
      const frag = resultDoc.getXmlFragment("default");
      const el = frag.get(0) as XmlElement;
      const textNode = el.get(0) as XmlText;
      const delta = textNode.toDelta() as {
        insert: string;
        attributes?: Record<string, unknown>;
      }[];
      const markEntry = delta.find(
        (e) => e.attributes?.[markKey as string] !== undefined
      );
      expect(markEntry).toBeDefined();
      expect(markEntry?.attributes?.[markKey as string]).toEqual({
        orphan: false,
        threadId: "th_xyz",
      });
    });
  });

  describe("paragraph with multiple XmlText nodes (bold boundary)", () => {
    it("applies the mark to all overlapping text segments", async () => {
      // Simulate "Hello " (plain) + "world" (bold) where anchor spans both
      const ydoc = buildDoc({
        tag: "paragraph",
        textSegments: ["Hello ", "world"],
      });
      const mockLiveblocks = createMockLiveblocks(ydoc);

      await anchorThreadToText(
        mockLiveblocks,
        "room-1",
        "th_bold",
        "Hello world"
      );

      expect(mockLiveblocks.sendYjsBinaryUpdate).toHaveBeenCalledOnce();

      const resultDoc = applyDiff(ydoc, mockLiveblocks);
      const attrKeys = collectAllAttrKeys(resultDoc);

      const markKeys = attrKeys.filter((k) =>
        k.startsWith("liveblocksCommentMark--")
      );
      // Both text nodes should carry the mark -- at least 2 keyed entries
      expect(markKeys.length).toBeGreaterThanOrEqual(2);

      // All mark keys should be the same key (same thread)
      const uniqueKeys = [...new Set(markKeys)];
      expect(uniqueKeys).toHaveLength(1);
    });
  });

  describe("single XmlText with inline formatting (code mark)", () => {
    it("anchors at the correct offset despite XML tags in toString()", async () => {
      // Simulate a paragraph like: "Hello `World` suffix"
      // In TipTap/Yjs, this is ONE XmlText node with formatting attributes.
      // XmlText.toString() returns "Hello <code>World</code> suffix" (with XML tags),
      // but node.length and format() use plain text offsets.
      const ydoc = new Doc();
      const frag = ydoc.getXmlFragment("default");

      ydoc.transact(() => {
        const el = new XmlElement("paragraph");
        const txt = new XmlText();
        txt.insert(0, "Hello ");
        txt.insert(6, "World", { code: true });
        txt.insert(11, " suffix");
        el.insert(0, [txt]);
        frag.insert(frag.length, [el]);
      });

      const mockLiveblocks = createMockLiveblocks(ydoc);

      await anchorThreadToText(mockLiveblocks, "room-1", "th_fmt", "suffix");

      const resultDoc = applyDiff(ydoc, mockLiveblocks);
      const el = resultDoc.getXmlFragment("default").get(0) as XmlElement;
      const textNode = el.get(0) as XmlText;
      const delta = textNode.toDelta() as {
        insert: string;
        attributes?: Record<string, unknown>;
      }[];

      // Find the delta entry that contains "suffix"
      const suffixEntry = delta.find((e) => e.insert.includes("suffix"));
      expect(suffixEntry).toBeDefined();

      // It should have the mark attribute
      const markKey = Object.keys(suffixEntry?.attributes ?? {}).find((k) =>
        k.startsWith("liveblocksCommentMark--")
      );
      expect(markKey).toBeDefined();

      // The "Hello " and "World" segments should NOT have the mark
      const helloEntry = delta.find((e) => e.insert.includes("Hello"));
      const helloHasMark = Object.keys(helloEntry?.attributes ?? {}).some((k) =>
        k.startsWith("liveblocksCommentMark--")
      );
      expect(helloHasMark).toBe(false);
    });
  });

  describe("error cases", () => {
    it("throws status 400 when anchor text is not found in any block", async () => {
      const ydoc = buildDoc({
        tag: "paragraph",
        textSegments: ["Hello world"],
      });
      const mockLiveblocks = createMockLiveblocks(ydoc);

      await expect(
        anchorThreadToText(mockLiveblocks, "room-1", "th_xyz", "not present")
      ).rejects.toMatchObject({ status: 400 });
    });

    it("throws status 400 when anchor text appears more than once in the same block", async () => {
      const ydoc = buildDoc({
        tag: "paragraph",
        textSegments: ["foo bar foo"],
      });
      const mockLiveblocks = createMockLiveblocks(ydoc);

      await expect(
        anchorThreadToText(mockLiveblocks, "room-1", "th_xyz", "foo")
      ).rejects.toMatchObject({ status: 400 });
    });

    it("throws status 400 when anchor text appears once in block A and once in block B", async () => {
      const ydoc = buildDoc(
        { tag: "paragraph", textSegments: ["duplicate text here"] },
        { tag: "paragraph", textSegments: ["duplicate text here"] }
      );
      const mockLiveblocks = createMockLiveblocks(ydoc);

      await expect(
        anchorThreadToText(
          mockLiveblocks,
          "room-1",
          "th_xyz",
          "duplicate text here"
        )
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe("multi-block document", () => {
    it("succeeds when anchor text appears only in the second block", async () => {
      const ydoc = buildDoc(
        { tag: "paragraph", textSegments: ["First paragraph content"] },
        { tag: "paragraph", textSegments: ["Second paragraph content"] }
      );
      const mockLiveblocks = createMockLiveblocks(ydoc);

      await anchorThreadToText(
        mockLiveblocks,
        "room-1",
        "th_second",
        "Second paragraph content"
      );

      expect(mockLiveblocks.sendYjsBinaryUpdate).toHaveBeenCalledOnce();

      const resultDoc = applyDiff(ydoc, mockLiveblocks);
      const frag = resultDoc.getXmlFragment("default");

      // First block should have no marks
      const firstEl = frag.get(0) as XmlElement;
      const firstText = firstEl.get(0) as XmlText;
      const firstDelta = firstText.toDelta() as {
        insert: string;
        attributes?: Record<string, unknown>;
      }[];
      const firstHasMark = firstDelta.some(
        (e) =>
          e.attributes &&
          Object.keys(e.attributes).some((k) =>
            k.startsWith("liveblocksCommentMark--")
          )
      );
      expect(firstHasMark).toBe(false);

      // Second block should carry the mark
      const secondEl = frag.get(1) as XmlElement;
      const secondText = secondEl.get(0) as XmlText;
      const secondDelta = secondText.toDelta() as {
        insert: string;
        attributes?: Record<string, unknown>;
      }[];
      const secondHasMark = secondDelta.some(
        (e) =>
          e.attributes &&
          Object.keys(e.attributes).some((k) =>
            k.startsWith("liveblocksCommentMark--")
          )
      );
      expect(secondHasMark).toBe(true);
    });
  });
});
