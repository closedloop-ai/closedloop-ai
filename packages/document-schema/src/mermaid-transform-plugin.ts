import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

// Plugin to transform codeBlock nodes with language="mermaid" into mermaid nodes
export const MermaidTransformPlugin = new Plugin({
  key: new PluginKey("mermaidTransform"),

  appendTransaction(transactions, _oldState, newState) {
    // Check if any transaction modified the document
    const docChanged = transactions.some(
      (transaction) => transaction.docChanged
    );
    if (!docChanged) {
      return null;
    }

    // Collect all mermaid code blocks that need to be transformed
    const replacements: Array<{
      pos: number;
      nodeSize: number;
      content: string;
    }> = [];

    newState.doc.descendants((node: ProseMirrorNode, pos: number) => {
      if (node.type.name === "codeBlock" && node.attrs.language === "mermaid") {
        replacements.push({
          pos,
          nodeSize: node.nodeSize,
          content: node.textContent,
        });
      }
      return true;
    });

    // If no replacements needed, return null
    if (replacements.length === 0) {
      return null;
    }

    // Apply replacements in reverse order to maintain valid positions
    const tr = newState.tr;
    const mermaidType = newState.schema.nodes.mermaid;

    if (!mermaidType) {
      return null;
    }

    // Process from end to start to maintain position validity
    for (let i = replacements.length - 1; i >= 0; i--) {
      const { pos, nodeSize, content } = replacements[i];
      const mermaidNode = mermaidType.create({ content });
      tr.replaceRangeWith(pos, pos + nodeSize, mermaidNode);
    }

    return tr;
  },
});
