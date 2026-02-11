"use client";

import { mergeAttributes, Node } from "@tiptap/core";
import {
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import mermaid from "mermaid";
import { useEffect, useRef, useState } from "react";
import { MermaidTransformPlugin } from "./mermaid-transform-plugin";

// Initialize mermaid with default config
mermaid.initialize({
  startOnLoad: false,
  theme: "default",
  securityLevel: "loose",
});

function MermaidComponent({
  node,
  updateAttributes,
  deleteNode,
  selected,
}: Readonly<NodeViewProps>) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(node.attrs.content as string);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const renderDiagram = async () => {
      if (!node.attrs.content || isEditing) {
        return;
      }

      try {
        const id = `mermaid-${Math.random().toString(36).substring(2, 11)}`;
        const { svg: renderedSvg } = await mermaid.render(
          id,
          node.attrs.content as string
        );
        setSvg(renderedSvg);
        setError("");
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to render diagram"
        );
        setSvg("");
      }
    };

    renderDiagram();
  }, [node.attrs.content, isEditing]);

  function handleEdit() {
    setIsEditing(true);
    setEditContent(node.attrs.content);
  }

  function handleSave() {
    updateAttributes({ content: editContent });
    setIsEditing(false);
  }

  function handleCancel() {
    setEditContent(node.attrs.content);
    setIsEditing(false);
  }

  return (
    <NodeViewWrapper className="mermaid-wrapper">
      <div
        className={`my-4 rounded-md border p-4 ${selected ? "ring-2 ring-blue-500" : ""}`}
        ref={containerRef}
      >
        {isEditing ? (
          <div className="space-y-2">
            <textarea
              className="min-h-[200px] w-full rounded border bg-muted p-2 font-mono text-sm"
              onChange={(e) => setEditContent(e.target.value)}
              placeholder="Enter Mermaid diagram code..."
              value={editContent}
            />
            <div className="flex gap-2">
              <button
                className="rounded bg-primary px-3 py-1 text-primary-foreground text-sm hover:bg-primary/90"
                onClick={handleSave}
                type="button"
              >
                Save
              </button>
              <button
                className="rounded border px-3 py-1 text-sm hover:bg-accent"
                onClick={handleCancel}
                type="button"
              >
                Cancel
              </button>
              <button
                className="rounded border border-destructive px-3 py-1 text-destructive text-sm hover:bg-destructive/10"
                onClick={deleteNode}
                type="button"
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <div>
            {!!error && (
              <div className="text-destructive text-sm">
                <div className="font-semibold">Mermaid Error:</div>
                <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">
                  {error}
                </pre>
                <button
                  className="mt-2 rounded border px-3 py-1 text-sm hover:bg-accent"
                  onClick={handleEdit}
                  type="button"
                >
                  Edit Diagram
                </button>
              </div>
            )}
            {!error && svg ? (
              <div className="group relative">
                <div
                  className="mermaid-diagram overflow-x-auto"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid generates safe SVG output
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
                <button
                  className="absolute top-2 right-2 rounded border bg-background/80 px-3 py-1 text-sm opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
                  onClick={handleEdit}
                  type="button"
                >
                  Edit
                </button>
              </div>
            ) : (
              <div className="flex min-h-[100px] items-center justify-center text-muted-foreground">
                <button
                  className="rounded border px-3 py-1 text-sm hover:bg-accent"
                  onClick={handleEdit}
                  type="button"
                >
                  Add Mermaid Diagram
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

declare module "@tiptap/core" {
  // biome-ignore lint/style/useConsistentTypeDefinitions: type expansion require interface
  interface Commands<ReturnType> {
    mermaid: {
      setMermaid: (attrs: { content: string }) => ReturnType;
    };
  }
}

export const MermaidExtension = Node.create({
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
        // Parse from code blocks with mermaid language
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

  addNodeView() {
    return ReactNodeViewRenderer(MermaidComponent);
  },

  renderMarkdown: (node: { attrs?: { content?: string } }) => {
    const content = node.attrs?.content || "";
    return `\`\`\`mermaid\n${content}\n\`\`\`\n\n`;
  },

  addProseMirrorPlugins() {
    return [MermaidTransformPlugin];
  },
});
