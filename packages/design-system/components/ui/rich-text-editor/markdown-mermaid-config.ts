// Custom markdown serializer configuration for Mermaid nodes
// This hooks into tiptap-markdown to properly serialize/deserialize Mermaid diagrams
export const mermaidMarkdownConfig = {
  // Serialize Mermaid node to markdown code fence
  toMarkdown: {
    mermaid(
      state: { write: (text: string) => void; text: (text: string, escape?: boolean) => void; closeBlock: (node: unknown) => void },
      node: { attrs: { content: string } }
    ) {
      state.write("```mermaid\n");
      state.text(node.attrs.content || "", false);
      state.write("\n```");
      state.closeBlock(node);
    },
  },
};
