import { Editor } from "@tiptap/core";
import type { TagParseRule } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { createDocumentExtensions } from "../extensions";
import { MermaidNode } from "../mermaid";
import {
  documentSchema,
  htmlElement,
  parseHtml,
  serializeHtml,
} from "./fixtures/schema-dom";

const MERMAID_SOURCE = "graph TD; A-->B";

function mermaidPreRule(): TagParseRule {
  const rule = documentSchema.nodes.mermaid?.spec.parseDOM?.find(
    (candidate) => candidate.tag === "pre"
  );
  if (!rule?.getAttrs) {
    throw new Error("mermaid node has no pre parse rule");
  }
  return rule;
}

function renderMarkdown(node: { attrs?: { content?: string } }): string {
  const render = MermaidNode.config.renderMarkdown;
  if (typeof render !== "function") {
    throw new Error("mermaid node has no renderMarkdown");
  }
  return Reflect.apply(render, undefined, [node]);
}

describe("MermaidNode parseHTML", () => {
  it("parses a mermaid div's content and renders it back", () => {
    const doc = parseHtml(
      `<div data-type="mermaid" content="${MERMAID_SOURCE}"></div>`
    );

    expect(doc.firstChild?.toJSON()).toEqual({
      type: MermaidNode.name,
      attrs: { content: MERMAID_SOURCE },
    });
    expect(serializeHtml(doc)).toBe(
      `<div content="${MERMAID_SOURCE}" data-type="mermaid"></div>`
    );
  });

  it("defaults a mermaid div without content to empty", () => {
    const doc = parseHtml('<div data-type="mermaid"></div>');

    expect(doc.firstChild?.toJSON()).toEqual({
      type: MermaidNode.name,
      attrs: { content: "" },
    });
    expect(serializeHtml(doc)).toBe(
      '<div content="" data-type="mermaid"></div>'
    );
  });

  it("reads a pre's language-mermaid code as content", () => {
    const pre = htmlElement(
      `<pre><code class="language-mermaid">${MERMAID_SOURCE}</code></pre>`
    );

    expect(mermaidPreRule().getAttrs?.(pre)).toEqual({
      content: MERMAID_SOURCE,
    });
  });

  it("reads an empty language-mermaid code as empty content", () => {
    const pre = htmlElement(
      '<pre><code class="language-mermaid"></code></pre>'
    );

    expect(mermaidPreRule().getAttrs?.(pre)).toEqual({ content: "" });
  });

  it("rejects a pre without language-mermaid code", () => {
    const pre = htmlElement('<pre><code class="language-js">x</code></pre>');

    expect(mermaidPreRule().getAttrs?.(pre)).toBe(false);
  });

  it("leaves a mermaid pre to the code block in the full schema", () => {
    // Pins current behavior; looks odd because the mermaid node declares a
    // `pre` rule, but codeBlock's rule is tried first, so HTML parsing yields
    // a mermaid-language code block. Markdown reaches the mermaid node through
    // MermaidTransformPlugin instead.
    const doc = parseHtml(
      `<pre><code class="language-mermaid">${MERMAID_SOURCE}</code></pre>`
    );

    expect(doc.firstChild?.toJSON()).toEqual({
      type: "codeBlock",
      attrs: { language: "mermaid" },
      content: [{ type: "text", text: MERMAID_SOURCE }],
    });
  });
});

describe("MermaidNode renderMarkdown", () => {
  it("wraps content in a mermaid fence", () => {
    expect(renderMarkdown({ attrs: { content: MERMAID_SOURCE } })).toBe(
      `\`\`\`mermaid\n${MERMAID_SOURCE}\n\`\`\`\n\n`
    );
  });

  it.each([
    { label: "no attrs", node: {} },
    { label: "empty content", node: { attrs: { content: "" } } },
  ])("writes an empty fence for $label", ({ node }) => {
    expect(renderMarkdown(node)).toBe("```mermaid\n\n```\n\n");
  });
});

describe("MermaidNode setMermaid", () => {
  it("inserts a mermaid atom with the given content", () => {
    const editor = new Editor({
      extensions: createDocumentExtensions({ undoRedo: false }),
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    try {
      expect(editor.commands.setMermaid({ content: MERMAID_SOURCE })).toBe(
        true
      );
      const mermaid = editor.state.doc.firstChild;

      expect(mermaid?.toJSON()).toEqual({
        type: MermaidNode.name,
        attrs: { content: MERMAID_SOURCE },
      });
      expect(mermaid?.type.spec.atom).toBe(true);
    } finally {
      editor.destroy();
    }
  });
});
