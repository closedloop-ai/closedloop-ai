"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import {
  ReactNodeViewRenderer,
  NodeViewWrapper,
  type NodeViewProps,
} from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
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
}: NodeViewProps) {
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
        const { svg: renderedSvg } = await mermaid.render(id, node.attrs.content as string);
        setSvg(renderedSvg);
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to render diagram");
        setSvg("");
      }
    };

    void renderDiagram();
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
        className={`border rounded-md p-4 my-4 ${selected ? "ring-2 ring-blue-500" : ""}`}
        ref={containerRef}
      >
        {isEditing ? (
          <div className="space-y-2">
            <textarea
              className="w-full min-h-[200px] p-2 border rounded font-mono text-sm bg-muted"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              placeholder="Enter Mermaid diagram code..."
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
                onClick={handleSave}
              >
                Save
              </button>
              <button
                type="button"
                className="px-3 py-1 text-sm border rounded hover:bg-accent"
                onClick={handleCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-3 py-1 text-sm border border-destructive text-destructive rounded hover:bg-destructive/10"
                onClick={deleteNode}
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <div>
            {error ? (
              <div className="text-destructive text-sm">
                <div className="font-semibold">Mermaid Error:</div>
                <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-x-auto">
                  {error}
                </pre>
                <button
                  type="button"
                  className="mt-2 px-3 py-1 text-sm border rounded hover:bg-accent"
                  onClick={handleEdit}
                >
                  Edit Diagram
                </button>
              </div>
            ) : svg ? (
              <div className="relative group">
                <div
                  className="mermaid-diagram overflow-x-auto"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid generates safe SVG output
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
                <button
                  type="button"
                  className="absolute top-2 right-2 px-3 py-1 text-sm border rounded bg-background/80 hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={handleEdit}
                >
                  Edit
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-center min-h-[100px] text-muted-foreground">
                <button
                  type="button"
                  className="px-3 py-1 text-sm border rounded hover:bg-accent"
                  onClick={handleEdit}
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
          const codeElement = (node as HTMLElement).querySelector("code.language-mermaid");
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

  addProseMirrorPlugins() {
    return [MermaidTransformPlugin];
  },
});
