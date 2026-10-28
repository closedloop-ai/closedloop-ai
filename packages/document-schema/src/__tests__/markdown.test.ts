import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { marked } from "marked";
import { describe, expect, it } from "vitest";
import { InlineImageNode } from "../inline-image";
import { LiveblocksSchemaName } from "../liveblocks";
import { markdownToDocument } from "../markdown";

const MERMAID_SOURCE = "graph TD; A-->B";

function lastBlock(doc: ProseMirrorNode) {
  const last = doc.lastChild;
  if (!last) {
    throw new Error("document has no blocks");
  }
  return last;
}

describe("markdownToDocument", () => {
  it("runs with no DOM", () => {
    expect(typeof document).toBe("undefined");
    expect(typeof window).toBe("undefined");
    expect(markdownToDocument("plain").textContent).toBe("plain");
  });

  it("turns a mermaid fence into a mermaid node", () => {
    const doc = markdownToDocument(
      `Intro\n\n\`\`\`mermaid\n${MERMAID_SOURCE}\n\`\`\`\n\nOutro`
    );

    expect(doc.toJSON().content[1]).toEqual({
      type: "mermaid",
      attrs: { content: MERMAID_SOURCE },
    });
  });

  it.each([
    { block: "codeBlock", markdown: "```js\nconst a = 1;\n```" },
    { block: "table", markdown: "| a | b |\n|---|---|\n| 1 | 2 |" },
    { block: "mermaid", markdown: `\`\`\`mermaid\n${MERMAID_SOURCE}\n\`\`\`` },
  ])(
    "appends an empty paragraph after a trailing $block",
    ({ block, markdown }) => {
      const doc = markdownToDocument(markdown);

      expect(doc.child(doc.childCount - 2).type.name).toBe(block);
      expect(lastBlock(doc).type.name).toBe("paragraph");
      expect(lastBlock(doc).childCount).toBe(0);
    }
  );

  it("fills a ragged table row with empty cells", () => {
    const doc = markdownToDocument("| a | b |\n|---|---|\n| 1 |\n");
    const table = doc.firstChild;

    expect(table?.type.name).toBe("table");
    expect(table?.child(1).childCount).toBe(2);
    expect(table?.child(1).child(1).textContent).toBe("");
  });

  it("keeps a non-attachment image as text", () => {
    const doc = markdownToDocument("![external](https://example.com/a.png)");

    expect(doc.firstChild?.toJSON()).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "![external](https://example.com/a.png)" },
      ],
    });
  });

  it("turns a table cell's saved <br> into a hard break", () => {
    const doc = markdownToDocument("| h |\n| --- |\n| a<br>b |\n");
    const cell = doc.firstChild?.child(1).child(0);

    expect(cell?.firstChild?.toJSON()).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "a" },
        { type: "hardBreak" },
        { type: "text", text: "b" },
      ],
    });
    expect(typeof window).toBe("undefined");
  });

  it("turns a legacy attachment <img> into an inline image", () => {
    const src = "attachment://00000000-0000-4000-8000-000000000001";
    const doc = markdownToDocument(`<img src="${src}">`);

    expect(doc.firstChild?.firstChild?.toJSON()).toMatchObject({
      type: InlineImageNode.name,
      attrs: { src },
    });
  });

  it("parses each HTML snippet on its own across one document", () => {
    const src = "attachment://00000000-0000-4000-8000-000000000002";
    const doc = markdownToDocument(
      `| h |\n| --- |\n| r1<br>x1 |\n| r2<br>x2 |\n\n<img src="${src}">`
    );
    const cellParagraph = (row: number) =>
      doc.firstChild?.child(row).child(0).firstChild?.toJSON();

    for (const row of [1, 2]) {
      expect(cellParagraph(row)).toEqual({
        type: "paragraph",
        content: [
          { type: "text", text: `r${row}` },
          { type: "hardBreak" },
          { type: "text", text: `x${row}` },
        ],
      });
    }
    expect(doc.child(1).firstChild?.toJSON()).toMatchObject({
      type: InlineImageNode.name,
      attrs: { src },
    });
  });

  it("registers nothing on the process-wide marked singleton", () => {
    const before = marked.defaults.extensions;
    const tokenizerCount = () =>
      (marked.defaults.extensions?.block?.length ?? 0) +
      (marked.defaults.extensions?.inline?.length ?? 0);
    const countBefore = tokenizerCount();

    for (let call = 0; call < 3; call++) {
      markdownToDocument(`| a |\n|---|\n| ${call}<br>x |\n\n- [ ] task`);
    }

    expect(tokenizerCount()).toBe(countBefore);
    expect(marked.defaults.extensions).toBe(before);
  });

  it("carries the three Liveblocks names in its schema", () => {
    const { schema } = markdownToDocument("").type;

    expect(schema.marks[LiveblocksSchemaName.CommentMark]).toBeDefined();
    expect(schema.nodes[LiveblocksSchemaName.Mention]).toBeDefined();
    expect(schema.nodes[LiveblocksSchemaName.GroupMention]).toBeDefined();
  });
});
