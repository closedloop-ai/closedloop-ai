import { mergeAttributes, Node } from "@tiptap/core";
import { MermaidTransformPlugin } from "./mermaid-transform-plugin";

declare module "@tiptap/core" {
  // biome-ignore lint/style/useConsistentTypeDefinitions: type expansion require interface
  interface Commands<ReturnType> {
    mermaid: {
      setMermaid: (attrs: { content: string }) => ReturnType;
    };
  }
}

/**
 * The `mermaid` block node without a node view. The editor adds its React view
 * with `MermaidNode.extend({ addNodeView })`.
 */
export const MermaidNode = Node.create({
  name: "mermaid",

  group: "block",

  atom: true,

  addAttributes() {
    return {
      content: {
        default: "",
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-type=mermaid]",
      },
      {
        tag: "pre",
        getAttrs: (node) => {
          const codeElement = node.querySelector("code.language-mermaid");
          if (codeElement) {
            return { content: codeElement.textContent || "" };
          }
          return false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "mermaid" })];
  },

  addCommands() {
    return {
      setMermaid:
        (attrs) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs,
          });
        },
    };
  },

  renderMarkdown: (node: { attrs?: { content?: string } }) => {
    const content = node.attrs?.content || "";
    return `\`\`\`mermaid\n${content}\n\`\`\`\n\n`;
  },

  addProseMirrorPlugins() {
    return [MermaidTransformPlugin];
  },
});
