import { describe, expect, it } from "vitest";
import { createDocumentExtensions } from "../extensions";
import { InlineImageNode } from "../inline-image";
import { MermaidNode } from "../mermaid";

describe("createDocumentExtensions", () => {
  it("rejects a mermaid substitute with another name", () => {
    expect(() =>
      createDocumentExtensions({
        mermaidNode: MermaidNode.extend({ name: "diagram" }),
      })
    ).toThrow(
      `createDocumentExtensions expected a "${MermaidNode.name}" node, got "diagram"`
    );
  });

  it("rejects an inline image substitute with another name", () => {
    expect(() =>
      createDocumentExtensions({
        inlineImageNode: InlineImageNode.extend({ name: "picture" }),
      })
    ).toThrow(
      `createDocumentExtensions expected a "${InlineImageNode.name}" node, got "picture"`
    );
  });

  it("accepts substitutes that keep the base names", () => {
    const mermaidNode = MermaidNode.extend({});
    const inlineImageNode = InlineImageNode.extend({});

    const extensions = createDocumentExtensions({
      mermaidNode,
      inlineImageNode,
    });

    expect(extensions).toContain(mermaidNode);
    expect(extensions).toContain(inlineImageNode);
  });
});
